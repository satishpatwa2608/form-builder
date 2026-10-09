import { ForbiddenException, HttpException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { findStatus, formAvailability, workflowOf } from '@fb/engine';
import type { Model } from 'mongoose';
import { hashToken, randomToken } from '../common/crypto';
import { OrgMailService } from '../mail/org-mail.service';
import { Organization, type OrganizationDocument } from '../orgs/org.schemas';
import { Form, type FormDocument } from '../forms/form.schema';
import { FormSubmission, type FormSubmissionDocument } from '../work/schemas/form-submission.schema';
import { FormDefinitionService } from '../work/services/form-definition.service';
import { PortalPass, type PortalPassDocument } from './portal.schema';

const LINK_MS = 30 * 60_000;
const SESSION_MS = 12 * 3_600_000;
/** Links one address can be sent in an hour, so the form cannot be used to flood someone's mailbox. */
const LINKS_PER_HOUR = 5;
const EMAIL = /^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[^\s@<>]{2,}$/;
const formAppUrl = () => (process.env.FORM_APP_URL ?? 'http://localhost:5174').replace(/\/+$/, '');

export interface PortalSettings {
  enabled: boolean;
  title: string;
  intro: string;
}

/**
 * The requests portal: a page on the form app where the people an organisation
 * serves find its forms and follow what they have sent. They prove an email
 * address is theirs by opening a link sent to it; there are no passwords and
 * no accounts to manage.
 */
@Injectable()
export class PortalService {
  private readonly logger = new Logger(PortalService.name);

  constructor(
    @InjectModel(Organization.name) private readonly orgs: Model<OrganizationDocument>,
    @InjectModel(Form.name) private readonly forms: Model<FormDocument>,
    @InjectModel(FormSubmission.name) private readonly submissions: Model<FormSubmissionDocument>,
    @InjectModel(PortalPass.name) private readonly passes: Model<PortalPassDocument>,
    private readonly definitions: FormDefinitionService,
    private readonly mail: OrgMailService,
  ) {}

  private async org(orgId: string) {
    const org = await this.orgs.findOne({ id: orgId }).select('name portal').lean<{ name: string; portal?: Partial<PortalSettings> }>();
    if (!org?.portal?.enabled) throw new NotFoundException('This organisation has no requests portal.');
    return { name: org.name, title: org.portal.title || 'Requests', intro: org.portal.intro ?? '' };
  }

  /** What anyone sees: the portal's name and the forms the organisation lists on it that are open now. */
  async front(orgId: string) {
    const org = await this.org(orgId);
    const rows = await this.forms
      .find({ orgId, status: 'PUBLISHED', isDeleted: false, 'definition.listOnPortal': true, 'definition.access': 'PUBLIC' })
      .sort({ version: -1 })
      .limit(500)
      .lean();
    const seen = new Set<string>();
    const forms = rows
      .filter((r) => !seen.has(r.code) && seen.add(r.code))
      .map((r) => FormDefinitionService.toDefinition(r))
      .filter((d) => formAvailability(d) === 'OPEN')
      .map((d) => ({ code: d.code, name: d.name, description: d.description ?? '' }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { organisation: org.name, title: org.title, intro: org.intro, forms };
  }

  /**
   * Emails a sign-in link. The answer is the same whether or not the address
   * has ever sent anything, so the portal cannot be used to find out who has.
   */
  async sendLink(orgId: string, emailInput: unknown) {
    const org = await this.org(orgId);
    const email = typeof emailInput === 'string' ? emailInput.trim().toLowerCase() : '';
    if (!EMAIL.test(email)) throw new HttpException({ message: 'Enter your email address', errors: [{ field: 'email', message: 'Enter your email address' }] }, 400);
    const recent = await this.passes.countDocuments({ orgId, email, kind: 'LINK', createdAt: { $gt: new Date(Date.now() - 3_600_000) } });
    if (recent < LINKS_PER_HOUR) {
      const token = `fbportal_${randomToken()}`;
      await this.passes.create({ tokenHash: hashToken(token), orgId, email, kind: 'LINK', expiresAt: new Date(Date.now() + LINK_MS) });
      await this.mail
        .send(orgId, {
          to: email,
          subject: `Your link to ${org.name}: ${org.title}`.slice(0, 200),
          text: [
            `Open this link to see the requests you have sent to ${org.name}:`,
            '',
            `${formAppUrl()}/portal/${orgId}?key=${token}`,
            '',
            'It works once, for the next 30 minutes. If you did not ask for it, you can ignore this message: nobody can see anything without opening it.',
          ].join('\n'),
        })
        .catch((e: Error) => this.logger.warn(`could not email a portal link: ${e.name}`));
    }
    return { sent: true };
  }

  /** Exchanges an emailed link for a session. The link stops working the moment it is used. */
  async open(orgId: string, tokenInput: unknown) {
    await this.org(orgId);
    const token = typeof tokenInput === 'string' && /^fbportal_[A-Za-z0-9_-]{20,200}$/.test(tokenInput) ? tokenInput : '';
    // Taken in one step, so the same link opened twice at once gives one session.
    const link = token ? await this.passes.findOneAndDelete({ tokenHash: hashToken(token), orgId, kind: 'LINK', expiresAt: { $gt: new Date() } }).lean() : null;
    if (!link) throw new UnauthorizedException('This link has been used or has run out. Ask for a new one.');
    const session = `fbps_${randomToken()}`;
    const expiresAt = new Date(Date.now() + SESSION_MS);
    await this.passes.create({ tokenHash: hashToken(session), orgId, email: link.email, kind: 'SESSION', expiresAt });
    return { session, email: link.email, expiresAt };
  }

  private async session(orgId: string, header: string | undefined) {
    const token = /^Portal (fbps_[A-Za-z0-9_-]{20,200})$/.exec(header ?? '')?.[1];
    const pass = token ? await this.passes.findOne({ tokenHash: hashToken(token), kind: 'SESSION', expiresAt: { $gt: new Date() } }).lean() : null;
    if (!pass) throw new UnauthorizedException('Sign in again with a link sent to your email.');
    // A session is for one organisation's portal only.
    if (pass.orgId !== orgId) throw new ForbiddenException('Sign in again with a link sent to your email.');
    return pass;
  }

  async close(orgId: string, header: string | undefined) {
    const pass = await this.session(orgId, header);
    await this.passes.deleteOne({ tokenHash: pass.tokenHash });
  }

  /**
   * What this person has sent, newest first: the reference, which form, when,
   * and how far it has got. Never the answers: an address typed into a form
   * is not proof of who filled it in.
   */
  async requests(orgId: string, header: string | undefined) {
    await this.org(orgId);
    const pass = await this.session(orgId, header);
    const rows = await this.submissions.find({ orgId, requesterEmail: pass.email }).sort({ createdAt: -1 }).limit(200).select('formCode ref status createdAt statusChangedAt').lean<(FormSubmission & { createdAt: Date })[]>();
    const latest = await this.definitions.latestByCode(orgId);
    return {
      email: pass.email,
      requests: rows.map((r) => {
        const def = latest.get(r.formCode);
        const tracked = !!def?.workflow?.enabled;
        const status = def && tracked ? findStatus(workflowOf(def), r.status) : undefined;
        return {
          reference: r.ref,
          form: def?.name ?? r.formCode,
          sentAt: r.createdAt,
          // A form that does not track its responses has nothing to report beyond "received".
          status: status?.label ?? 'Received',
          open: tracked ? status?.category !== 'DONE' : false,
          updatedAt: r.statusChangedAt ?? r.createdAt,
        };
      }),
    };
  }
}
