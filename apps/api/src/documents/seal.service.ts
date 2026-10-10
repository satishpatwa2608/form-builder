import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Logger, Put } from '@nestjs/common';
import { InjectModel, Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument, Model } from 'mongoose';
import { z } from 'zod';
import { actorOf, AuditService } from '../audit/audit.service';
import { Auth, type AuthContext } from '../auth/auth-context';
import { RequirePermission } from '../auth/auth.guard';
import { KEY_PROVIDER, openWith, sealWith, type KeyProvider } from '../common/key-provider';
import { ZodBody } from '../common/zod-body';
import { orgLog } from '../logs/org-log';
import { Organization, type OrganizationDocument } from '../orgs/org.schemas';
import { identityFromFile, newSealIdentity, SealFileError, sealInfo, sealPdf, type SealIdentity, type SealInfo } from './pdf-seal';

/**
 * The certificate(s) an organisation's PDFs are sealed with. One is made for every organisation the first time
 * it seals something; the organisation may add its own, from a certificate authority, which is then used
 * instead. Both are kept sealed (their keys never leave the server, and are never returned by the API).
 */
@Schema({ timestamps: true, collection: 'org_seals', minimize: false })
export class OrgSeal {
  @Prop({ required: true, unique: true }) orgId: string;
  /** The certificate made here, and the wrapped key that opens it. */
  @Prop({ type: String, default: '' }) auto: string;
  @Prop({ type: String, default: '' }) autoKey: string;
  /** The organisation's own, when it has added one. */
  @Prop({ type: String, default: '' }) own: string;
  @Prop({ type: String, default: '' }) ownKey: string;
}
export type OrgSealDocument = HydratedDocument<OrgSeal>;
export const OrgSealSchema = SchemaFactory.createForClass(OrgSeal);

/** What an admin is shown: whose certificate seals their PDFs, and until when. Never the key. */
export interface SealView extends SealInfo {
  /** The organisation's own certificate, not the one made for it here. */
  own: boolean;
  /** Its own certificate has run out, so the one made here is being used until a new one is added. */
  ownRanOut?: string;
}

@Injectable()
export class SealService {
  private readonly logger = new Logger(SealService.name);
  /** Opened certificates, for a few minutes: opening one costs a key-service call, and a batch seals a thousand PDFs. */
  private readonly held = new Map<string, { identity: SealIdentity; own: boolean; ownRanOut?: string; until: number }>();

  constructor(
    @InjectModel(OrgSeal.name) private readonly seals: Model<OrgSealDocument>,
    @InjectModel(Organization.name) private readonly orgs: Model<OrganizationDocument>,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    private readonly audit: AuditService,
  ) {}

  private context(orgId: string) {
    return { orgId, purpose: 'pdf-seal' };
  }
  private async wrap(orgId: string, identity: SealIdentity) {
    const { plain, wrapped } = await this.keys.newDataKey(this.context(orgId));
    return { sealed: sealWith(plain, identity), key: wrapped };
  }
  private async open(orgId: string, sealed: string, key: string): Promise<SealIdentity> {
    return openWith<SealIdentity>(await this.keys.unwrap(key, this.context(orgId)), sealed);
  }

  /** The certificate to seal with now: the organisation's own while it is in date, otherwise the one made for it. */
  private async current(orgId: string) {
    const kept = this.held.get(orgId);
    if (kept && kept.until > Date.now()) return kept;
    let row = await this.seals.findOne({ orgId }).lean();
    if (!row?.auto) {
      const name = (await this.orgs.findOne({ id: orgId }).select('name').lean())?.name ?? '';
      const made = await this.wrap(orgId, await newSealIdentity(name));
      // Two requests making the first one at once: whichever is stored first is the certificate, for both.
      await this.seals.updateOne({ orgId, $or: [{ auto: '' }, { auto: { $exists: false } }] }, { $set: { auto: made.sealed, autoKey: made.key } }, { upsert: !row }).catch(() => undefined);
      row = await this.seals.findOne({ orgId }).lean();
    }
    let own = row!.own ? await this.open(orgId, row!.own, row!.ownKey) : undefined;
    let ownRanOut: string | undefined;
    if (own && new Date(sealInfo(own).validTo).getTime() < Date.now()) {
      ownRanOut = sealInfo(own).validTo;
      orgLog.error(orgId, 'signatures', `Your own certificate for sealing PDFs ran out on ${ownRanOut.slice(0, 10)}. PDFs are being sealed with the certificate made for you here until you add a new one.`, {});
      own = undefined;
    }
    const now = { identity: own ?? (await this.open(orgId, row!.auto, row!.autoKey)), own: !!own, ownRanOut, until: Date.now() + 5 * 60_000 };
    this.held.set(orgId, now);
    return now;
  }

  async view(orgId: string): Promise<SealView> {
    const now = await this.current(orgId);
    return { ...sealInfo(now.identity), own: now.own, ...(now.ownRanOut ? { ownRanOut: now.ownRanOut } : {}) };
  }

  /** The organisation adds its own certificate: a .pfx / .p12 with its password, or PEM text. */
  async setOwn(auth: AuthContext, file: Buffer, password: string): Promise<SealView> {
    let identity: SealIdentity;
    try {
      identity = await identityFromFile(file, password);
    } catch (e) {
      if (e instanceof SealFileError) throw new BadRequestException(e.message);
      this.logger.warn(`a certificate file could not be read: ${(e as Error).name}`);
      throw new BadRequestException('This is not a certificate file we can read. Use a .pfx or .p12 file, or PEM text with the certificate and its key.');
    }
    await this.current(auth.orgId); // so the one made here exists to fall back on
    const made = await this.wrap(auth.orgId, identity);
    await this.seals.updateOne({ orgId: auth.orgId }, { $set: { own: made.sealed, ownKey: made.key } });
    this.held.delete(auth.orgId);
    const info = sealInfo(identity);
    await this.audit.record(actorOf(auth), { action: 'org.seal_certificate_set', targetType: 'org', targetId: auth.orgId, after: { subject: info.subject, issuer: info.issuer, validTo: info.validTo, fingerprint: info.fingerprint } });
    return this.view(auth.orgId);
  }

  /** Back to the certificate made here. */
  async removeOwn(auth: AuthContext): Promise<SealView> {
    await this.seals.updateOne({ orgId: auth.orgId }, { $set: { own: '', ownKey: '' } });
    this.held.delete(auth.orgId);
    await this.audit.record(actorOf(auth), { action: 'org.seal_certificate_removed', targetType: 'org', targetId: auth.orgId });
    return this.view(auth.orgId);
  }

  /** Seals a PDF with the organisation's certificate. The last thing done to a document. */
  async seal(orgId: string, pdf: Buffer, reason: string): Promise<Buffer> {
    return sealPdf(pdf, (await this.current(orgId)).identity, { reason });
  }
}

const ownBody = z.object({ file: z.string().min(1).max(200_000), password: z.string().max(500).default('') });

/** Whose certificate seals the organisation's PDFs. For its admins. */
@Controller('org/seal')
export class SealController {
  constructor(private readonly seals: SealService) {}

  @Get()
  @RequirePermission('org.manage')
  view(@Auth() auth: AuthContext) {
    return this.seals.view(auth.orgId);
  }

  /** `file` is the certificate file's bytes as base64 (they are small); `password` opens it. */
  @Put()
  @RequirePermission('org.manage')
  set(@Auth() auth: AuthContext, @Body(new ZodBody(ownBody)) body: z.infer<typeof ownBody>) {
    return this.seals.setOwn(auth, Buffer.from(body.file, 'base64'), body.password);
  }

  @Delete()
  @HttpCode(200)
  @RequirePermission('org.manage')
  remove(@Auth() auth: AuthContext) {
    return this.seals.removeOwn(auth);
  }
}
