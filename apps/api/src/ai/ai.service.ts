import { BadRequestException, ForbiddenException, HttpException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { PermissionService } from '../access/permission.service';
import { actorOf, AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import { Organization, type OrganizationDocument } from '../orgs/org.schemas';
import { PlansService } from '../plans/plans.service';
import { FORM_DRAFTER, type FormDrafter } from './drafter';
import { DRAFT_LIMITS, readDraft } from './form-draft';

const TIMEOUT_MS = 60_000;

/**
 * "Describe it, and the form is drafted." Off unless the installation has an AI service and the organisation
 * turned it on; a monthly allowance by plan; each use in the audit log. Only the description goes to the
 * service: never responses, records, connector data or credentials. What comes back is a draft to read and
 * change, checked like any form, never published by this.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    @Inject(FORM_DRAFTER) private readonly drafter: FormDrafter | null,
    @InjectModel(Organization.name) private readonly orgs: Model<OrganizationDocument>,
    private readonly plans: PlansService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
  ) {}

  /** Whether the box is shown, and how much of the allowance is left. */
  async status(auth: AuthContext) {
    const org = await this.orgs.findOne({ id: auth.orgId }).select('ai').lean();
    return { available: !!this.drafter, enabled: !!org?.ai?.drafting, ...(await this.plans.aiDraftsUsed(auth.orgId)) };
  }

  async draftForm(auth: AuthContext, body: { description: string; folderId: string }) {
    const description = body.description.trim();
    if (description.length < 10) throw new BadRequestException('Say in a sentence or two what the form is for');
    if (description.length > DRAFT_LIMITS.description) throw new BadRequestException(`Keep it under ${DRAFT_LIMITS.description} characters`);
    // Only someone who could make a form in that folder may use the allowance for one.
    await this.permissions.assert(auth, 'form.edit', { type: 'form', id: '', folderPath: (await this.permissions.folderRef(auth.orgId, body.folderId)).folderPath });
    if (!this.drafter) throw new ServiceUnavailableException('Drafting forms from a description is not set up on this installation');
    if (!(await this.orgs.findOne({ id: auth.orgId }).select('ai').lean())?.ai?.drafting) throw new ForbiddenException('An admin has not turned on drafting forms from a description (Organisation settings)');
    const reserved = await this.plans.reserveAiDraft(auth.orgId);
    if (!reserved) throw new HttpException({ statusCode: 429, message: "This month's drafts from a description are used up. Start from a template or a blank form instead.", code: 'QUOTA' }, 429);

    let reply: string;
    const started = Date.now();
    try {
      reply = await this.drafter.draft(description, AbortSignal.timeout(TIMEOUT_MS));
    } catch (e) {
      // Nothing was drafted, so it does not count.
      await this.plans.releaseAiDraft(auth.orgId, reserved.month);
      const timedOut = e instanceof Error && e.name === 'TimeoutError';
      this.logger.warn(`AI draft failed: ${timedOut ? 'timed out' : (e as Error).message}`);
      throw new ServiceUnavailableException(timedOut ? 'The AI service took too long. Try again in a moment.' : 'The AI service could not be reached. Try again in a moment.');
    }
    const draft = readDraft(reply);
    if (!draft.fields.length) await this.plans.releaseAiDraft(auth.orgId, reserved.month);
    await this.audit.record(actorOf(auth), {
      action: 'form.ai_drafted',
      targetType: 'organization',
      targetId: auth.orgId,
      after: { description: description.slice(0, 500), questions: draft.fields.length, leftOut: draft.leftOut.length, ms: Date.now() - started },
    });
    return { name: draft.title, description: draft.description, fields: draft.fields, leftOut: draft.leftOut, used: draft.fields.length ? reserved.used : reserved.used - 1, limit: reserved.limit };
  }
}
