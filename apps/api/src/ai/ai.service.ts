import { BadRequestException, ForbiddenException, HttpException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { PermissionService } from '../access/permission.service';
import { actorOf, AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import { installationBox, type SecretBox } from '../common/crypto';
import { APP_CONFIG, type AppConfig } from '../config';
import { Organization, type OrganizationDocument } from '../orgs/org.schemas';
import { PlansService } from '../plans/plans.service';
import { ANTHROPIC_KEY, FORM_DRAFTER, FORM_DRAFTER_FOR_KEY, type DrafterForKey, type FormDrafter } from './drafter';
import { DRAFT_LIMITS, readDraft } from './form-draft';

const TIMEOUT_MS = 60_000;

/**
 * "Describe it, and the form is drafted." Each organisation that wants it puts in its own AI service key (it pays
 * for what it uses) and turns it on; an installation may also have a key of its own, used with a monthly
 * allowance by plan for organisations without one. Each use is in the audit log. Only the description goes to the
 * service: never responses, records, connector data or credentials. What comes back is a draft to read and
 * change, checked like any form, never published by this.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly box: SecretBox;

  constructor(
    @Inject(FORM_DRAFTER) private readonly drafter: FormDrafter | null,
    @Inject(FORM_DRAFTER_FOR_KEY) private readonly drafterFor: DrafterForKey,
    @Inject(APP_CONFIG) config: AppConfig,
    @InjectModel(Organization.name) private readonly orgs: Model<OrganizationDocument>,
    private readonly plans: PlansService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
  ) {
    this.box = installationBox(config);
  }

  private async aiOf(orgId: string) {
    return (await this.orgs.findOne({ id: orgId }).select('ai').lean())?.ai;
  }

  /** Whether the box is shown, whose key is used, and (on the installation's key) how much of the allowance is left. */
  async status(auth: AuthContext) {
    const ai = await this.aiOf(auth.orgId);
    const ownKey = ai?.key ? { hint: ai.keyHint, setAt: ai.keySetAt } : null;
    const usage = await this.plans.aiDraftsUsed(auth.orgId);
    return { available: !!ownKey || !!this.drafter, enabled: !!ai?.drafting && (!!ownKey || !!this.drafter), ownKey, used: usage.used, limit: ownKey ? null : usage.limit };
  }

  /** The organisation's own key: checked with the service (a call that costs nothing), then kept sealed. */
  async setKey(auth: AuthContext, key: string) {
    const k = key.trim();
    if (!ANTHROPIC_KEY.test(k)) throw new BadRequestException({ message: 'That is not an Anthropic API key: it starts with sk-ant-', errors: [{ field: 'key', message: 'That is not an Anthropic API key: it starts with sk-ant-' }] });
    let accepted = false;
    try {
      accepted = (await this.drafterFor(k).check?.(AbortSignal.timeout(15_000))) ?? true;
    } catch {
      throw new ServiceUnavailableException('The AI service could not be reached to check the key. Try again in a moment.');
    }
    if (!accepted) throw new BadRequestException({ message: 'The AI service did not accept that key', errors: [{ field: 'key', message: 'The AI service did not accept that key' }] });
    await this.orgs.updateOne({ id: auth.orgId }, { $set: { 'ai.key': this.box.seal(k), 'ai.keyHint': k.slice(-4), 'ai.keySetAt': new Date() } });
    await this.audit.record(actorOf(auth), { action: 'org.ai_key_set', targetType: 'organization', targetId: auth.orgId, after: { hint: k.slice(-4) } });
    return this.status(auth);
  }

  async removeKey(auth: AuthContext) {
    await this.orgs.updateOne({ id: auth.orgId }, { $set: { 'ai.key': '', 'ai.keyHint': '', 'ai.keySetAt': null, ...(this.drafter ? {} : { 'ai.drafting': false }) } });
    await this.audit.record(actorOf(auth), { action: 'org.ai_key_removed', targetType: 'organization', targetId: auth.orgId });
    return this.status(auth);
  }

  async draftForm(auth: AuthContext, body: { description: string; folderId: string }) {
    const description = body.description.trim();
    if (description.length < 10) throw new BadRequestException('Say in a sentence or two what the form is for');
    if (description.length > DRAFT_LIMITS.description) throw new BadRequestException(`Keep it under ${DRAFT_LIMITS.description} characters`);
    // Only someone who could make a form in that folder may use it for one.
    await this.permissions.assert(auth, 'form.edit', { type: 'form', id: '', folderPath: (await this.permissions.folderRef(auth.orgId, body.folderId)).folderPath });
    const ai = await this.aiOf(auth.orgId);
    const own = ai?.key ? this.drafterFor(this.box.open(ai.key)) : null;
    const drafter = own ?? this.drafter;
    if (!drafter) throw new ServiceUnavailableException("Drafting forms from a description needs your organisation's AI key (Organisation settings)");
    if (!ai?.drafting) throw new ForbiddenException('An admin has not turned on drafting forms from a description (Organisation settings)');
    // On the organisation's own key it pays, so no allowance; on the installation's, the plan's.
    const reserved = own ? null : await this.plans.reserveAiDraft(auth.orgId);
    if (!own && !reserved) throw new HttpException({ statusCode: 429, message: "This month's drafts from a description are used up. Start from a template or a blank form instead.", code: 'QUOTA' }, 429);

    let reply: string;
    const started = Date.now();
    try {
      reply = await drafter.draft(description, AbortSignal.timeout(TIMEOUT_MS));
    } catch (e) {
      // Nothing was drafted, so it does not count.
      if (reserved) await this.plans.releaseAiDraft(auth.orgId, reserved.month);
      const timedOut = e instanceof Error && e.name === 'TimeoutError';
      const refused = own && [401, 403].includes((e as { status?: number }).status ?? 0);
      this.logger.warn(`AI draft failed: ${timedOut ? 'timed out' : (e as Error).message}`);
      if (refused) throw new ServiceUnavailableException("The AI service refused your organisation's key. An admin can check it in Organisation settings.");
      throw new ServiceUnavailableException(timedOut ? 'The AI service took too long. Try again in a moment.' : 'The AI service could not be reached. Try again in a moment.');
    }
    const draft = readDraft(reply);
    if (!draft.fields.length && reserved) await this.plans.releaseAiDraft(auth.orgId, reserved.month);
    await this.audit.record(actorOf(auth), {
      action: 'form.ai_drafted',
      targetType: 'organization',
      targetId: auth.orgId,
      after: { description: description.slice(0, 500), questions: draft.fields.length, leftOut: draft.leftOut.length, ms: Date.now() - started, key: own ? 'organisation' : 'installation' },
    });
    const used = reserved ? (draft.fields.length ? reserved.used : reserved.used - 1) : (await this.plans.aiDraftsUsed(auth.orgId)).used;
    return { name: draft.title, description: draft.description, fields: draft.fields, leftOut: draft.leftOut, used, limit: reserved ? reserved.limit : null };
  }
}
