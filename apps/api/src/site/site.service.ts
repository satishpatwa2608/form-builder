import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { promises as dns } from 'node:dns';
import type { Model } from 'mongoose';
import { actorOf, AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import { APP_CONFIG, type AppConfig } from '../config';
import { randomToken } from '../common/crypto';
import { Organization, type OrganizationDocument } from '../orgs/org.schemas';
import { PLANS } from '../plans/plans';
import { PlansService } from '../plans/plans.service';

/** Looks up TXT records (swapped out in tests). */
export const DNS_TXT = Symbol('DNS_TXT');
export type TxtResolver = (name: string) => Promise<string[][]>;
export const systemTxtResolver: TxtResolver = (name) => dns.resolveTxt(name);

const LOGO = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
const LOGO_MAX_CHARS = 200_000; // ~150 KB image
const COLOR = /^#[0-9a-fA-F]{6}$/;
const HOST = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const TXT_PREFIX = '_formbuilder';
const HOST_CACHE_MAX = 5_000;

export interface BrandingInput {
  logo?: string;
  primaryColor?: string;
  hidePoweredBy?: boolean;
}

/** Branding and custom domains: how and where an org's public forms appear. */
@Injectable()
export class SiteService {
  private readonly hostCache = new Map<string, { orgId: string | null; at: number }>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DNS_TXT) private readonly resolveTxt: TxtResolver,
    private readonly audit: AuditService,
    private readonly plans: PlansService,
    @InjectModel(Organization.name) private readonly orgs: Model<OrganizationDocument>,
  ) {}

  private async org(orgId: string) {
    const org = await this.orgs.findOne({ id: orgId });
    if (!org) throw new NotFoundException('Organisation not found');
    return org;
  }

  // ---------------------------------------------------------------- branding

  async branding(auth: AuthContext) {
    const org = await this.orgs.findOne({ id: auth.orgId }).select('branding').lean();
    const b = org?.branding ?? { logo: '', primaryColor: '', hidePoweredBy: false };
    return { logo: b.logo, primaryColor: b.primaryColor, hidePoweredBy: b.hidePoweredBy, canHidePoweredBy: (await this.plans.limitsOf(auth.orgId)).removeBranding };
  }

  async updateBranding(auth: AuthContext, body: BrandingInput) {
    if (body.logo !== undefined && body.logo !== '' && (!LOGO.test(body.logo) || body.logo.length > LOGO_MAX_CHARS)) {
      throw new BadRequestException({ message: 'Invalid logo', errors: [{ field: 'logo', message: 'Use a PNG, JPEG or WebP image under 150 KB' }] });
    }
    if (body.primaryColor !== undefined && body.primaryColor !== '' && !COLOR.test(body.primaryColor)) {
      throw new BadRequestException({ message: 'Invalid colour', errors: [{ field: 'primaryColor', message: 'Use a colour like #1458e2' }] });
    }
    if (body.hidePoweredBy) await this.plans.assertFeature(auth.orgId, 'removeBranding');
    const set: Record<string, unknown> = {};
    for (const k of ['logo', 'primaryColor', 'hidePoweredBy'] as const) if (body[k] !== undefined) set[`branding.${k}`] = body[k];
    await this.orgs.updateOne({ id: auth.orgId }, { $set: set });
    // Never the logo bytes in the audit log.
    await this.audit.record(actorOf(auth), { action: 'org.branding_updated', targetType: 'organization', targetId: auth.orgId, after: { primaryColor: body.primaryColor, hidePoweredBy: body.hidePoweredBy, logoChanged: body.logo !== undefined } });
    return this.branding(auth);
  }

  /** What the public form page shows for an org. */
  async publicBranding(orgId: string) {
    const org = await this.orgs.findOne({ id: orgId }).select('name branding plan').lean();
    if (!org) throw new NotFoundException('Not found');
    const plan = await this.plans.planOf(orgId);
    return {
      name: org.name,
      logo: org.branding?.logo || null,
      primaryColor: org.branding?.primaryColor || null,
      poweredBy: !(org.branding?.hidePoweredBy && PLANS[plan].limits.removeBranding),
    };
  }

  // ---------------------------------------------------------------- custom domains

  private ownHosts() {
    return [this.config.APP_URL, this.config.API_URL, process.env.FORM_APP_URL ?? ''].filter(Boolean).map((u) => new URL(u).hostname);
  }

  private static view(d: { host: string; token: string; verifiedAt: Date | null }) {
    return { host: d.host, verified: !!d.verifiedAt, verifiedAt: d.verifiedAt, dns: { type: 'TXT', name: `${TXT_PREFIX}.${d.host}`, value: d.token }, cname: d.host };
  }

  async domains(auth: AuthContext) {
    return ((await this.org(auth.orgId)).domains ?? []).map(SiteService.view);
  }

  async addDomain(auth: AuthContext, rawHost: string) {
    const host = rawHost.trim().toLowerCase().replace(/\.$/, '');
    if (!HOST.test(host)) throw new BadRequestException({ message: 'Invalid domain', errors: [{ field: 'host', message: 'Use a host name like forms.example.com' }] });
    if (this.ownHosts().some((own) => host === own || host.endsWith(`.${own}`))) throw new BadRequestException('That domain belongs to Form Builder');
    const org = await this.org(auth.orgId);
    if (org.domains.some((d) => d.host === host)) throw new ConflictException('That domain is already added');
    await this.plans.assertCanAdd(auth.orgId, 'customDomains');
    org.domains.push({ host, token: `fb-verify=${randomToken()}`, verifiedAt: null, addedAt: new Date() });
    await org.save();
    await this.audit.record(actorOf(auth), { action: 'domain.added', targetType: 'domain', targetId: host });
    return this.domains(auth);
  }

  /** Checks the TXT record; a host can be verified by one org only. */
  async verifyDomain(auth: AuthContext, host: string) {
    const org = await this.org(auth.orgId);
    const d = org.domains.find((x) => x.host === host);
    if (!d) throw new NotFoundException('Domain not found');
    if (d.verifiedAt) return SiteService.view(d);
    let records: string[][] = [];
    try {
      records = await this.resolveTxt(`${TXT_PREFIX}.${host}`);
    } catch {
      records = [];
    }
    if (!records.some((chunks) => chunks.join('') === d.token)) {
      throw new BadRequestException(`The TXT record wasn't found yet. Add ${TXT_PREFIX}.${host} = ${d.token}; DNS changes can take a while to appear.`);
    }
    if (await this.orgs.exists({ id: { $ne: auth.orgId }, domains: { $elemMatch: { host, verifiedAt: { $ne: null } } } })) {
      throw new ConflictException('Another organisation already uses this domain');
    }
    d.verifiedAt = new Date();
    org.markModified('domains');
    await org.save();
    this.hostCache.delete(host);
    await this.audit.record(actorOf(auth), { action: 'domain.verified', targetType: 'domain', targetId: host });
    return SiteService.view(d);
  }

  async removeDomain(auth: AuthContext, host: string) {
    const res = await this.orgs.updateOne({ id: auth.orgId }, { $pull: { domains: { host } } });
    if (!res.modifiedCount) throw new NotFoundException('Domain not found');
    this.hostCache.delete(host);
    await this.audit.record(actorOf(auth), { action: 'domain.removed', targetType: 'domain', targetId: host });
    return this.domains(auth);
  }

  /** The runtime on a custom domain: which org is this host? Verified domains only. */
  async orgForHost(rawHost: string): Promise<string> {
    const host = rawHost.trim().toLowerCase();
    // Anything that isn't a host name is never looked up or cached (this is reachable anonymously).
    if (!HOST.test(host)) throw new NotFoundException('Unknown domain');
    const hit = this.hostCache.get(host);
    if (hit && Date.now() - hit.at < 60_000) {
      if (!hit.orgId) throw new NotFoundException('Unknown domain');
      return hit.orgId;
    }
    const org = await this.orgs.findOne({ domains: { $elemMatch: { host, verifiedAt: { $ne: null } } } }).select('id').lean();
    if (this.hostCache.size >= HOST_CACHE_MAX) this.hostCache.clear();
    this.hostCache.set(host, { orgId: org?.id ?? null, at: Date.now() });
    if (!org) throw new NotFoundException('Unknown domain');
    return org.id;
  }
}
