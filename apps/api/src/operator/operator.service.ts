import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AuditEntry, type AuditEntryDocument } from '../audit/audit.schema';
import { AuditService } from '../audit/audit.service';
import { User, type UserDocument } from '../auth/auth.schemas';
import type { AuthContext } from '../auth/auth-context';
import { newId } from '../common/crypto';
import { APP_CONFIG, isOperator, type AppConfig } from '../config';
import { Form, type FormDocument } from '../forms/form.schema';
import { Job, type JobDocument } from '../jobs/job.schema';
import { Invitation, Membership, Organization, type InvitationDocument, type MembershipDocument, type OrganizationDocument } from '../orgs/org.schemas';
import { OrgsService } from '../orgs/orgs.service';
import { PLAN_IDS, PLANS, type PlanId } from '../plans/plans';
import { PlansService } from '../plans/plans.service';
import { UsageMonth, type UsageMonthDocument } from '../plans/usage.schema';

export interface CustomerRow {
  id: string;
  name: string;
  plan: PlanId;
  planName: string;
  createdAt: Date | null;
  /** People who own it now. */
  owners: { name: string; email: string }[];
  /** Addresses invited as owner that have not accepted yet. */
  invitedOwners: string[];
  members: number;
  memberLimit: number | null;
  forms: number;
  responsesThisMonth: number;
  /** When anything was last done in it (the newest entry of its audit trail). */
  lastActiveAt: Date | null;
  /** Background work of theirs that gave up after its tries in the last 30 days (a count only: what it was is theirs). */
  failedWork: number;
}

/**
 * For the people who run the installation: which customers there are, and
 * the two things that are theirs to do for a customer, adding it and setting
 * its plan. It shows how big and how busy an organisation is and who owns it;
 * it never opens a customer's forms, responses or settings. Looking inside
 * still takes an invitation from the customer.
 */
@Injectable()
export class OperatorService {
  private readonly logger = new Logger(OperatorService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly orgsService: OrgsService,
    private readonly plans: PlansService,
    private readonly audit: AuditService,
    @InjectModel(Organization.name) private readonly orgs: Model<OrganizationDocument>,
    @InjectModel(Membership.name) private readonly memberships: Model<MembershipDocument>,
    @InjectModel(Invitation.name) private readonly invitations: Model<InvitationDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(Form.name) private readonly forms: Model<FormDocument>,
    @InjectModel(UsageMonth.name) private readonly months: Model<UsageMonthDocument>,
    @InjectModel(AuditEntry.name) private readonly entries: Model<AuditEntryDocument>,
    @InjectModel(Job.name) private readonly jobs: Model<JobDocument>,
  ) {}

  /** Not an operator: there is nothing here, said the same way as a page that does not exist. */
  async assertOperator(auth: AuthContext) {
    const me = await this.users.findOne({ id: auth.userId }).select('email emailVerifiedAt').lean();
    if (!me?.emailVerifiedAt || !isOperator(this.config, me.email)) throw new NotFoundException('Not found');
    return me;
  }

  async list(auth: AuthContext): Promise<CustomerRow[]> {
    await this.assertOperator(auth);
    const orgs = await this.orgs.find({}).sort({ createdAt: -1 }).limit(1000).select('id name plan createdAt').lean<{ id: string; name: string; plan?: string; createdAt?: Date }[]>();
    const ids = orgs.map((o) => o.id);
    const month = new Date().toISOString().slice(0, 7);
    const [members, formCounts, usage, last, invited, failed] = await Promise.all([
      this.memberships.find({ orgId: { $in: ids }, status: 'ACTIVE' }).select('orgId userId role').lean(),
      this.forms.aggregate<{ _id: string; n: number }>([{ $match: { orgId: { $in: ids }, isDeleted: false } }, { $group: { _id: { orgId: '$orgId', code: '$code' } } }, { $group: { _id: '$_id.orgId', n: { $sum: 1 } } }]),
      this.months.find({ orgId: { $in: ids }, month }).select('orgId submissions').lean(),
      this.entries.aggregate<{ _id: string; at: Date }>([{ $match: { orgId: { $in: ids } } }, { $group: { _id: '$orgId', at: { $max: '$at' } } }]),
      this.invitations.find({ orgId: { $in: ids }, role: 'OWNER', acceptedAt: null, revokedAt: null, expiresAt: { $gt: new Date() } }).select('orgId email').lean(),
      this.jobs.aggregate<{ _id: string; n: number }>([{ $match: { orgId: { $in: ids }, status: 'FAILED', updatedAt: { $gte: new Date(Date.now() - 30 * 86_400_000) } } }, { $group: { _id: '$orgId', n: { $sum: 1 } } }]),
    ]);
    const owners = await this.users.find({ id: { $in: members.filter((m) => m.role === 'OWNER').map((m) => m.userId) } }).select('id name email').lean();
    const person = new Map(owners.map((u) => [u.id, { name: u.name, email: u.email }]));
    return orgs.map((o) => {
      const plan = (PLAN_IDS as readonly string[]).includes(o.plan ?? '') ? (o.plan as PlanId) : this.config.DEFAULT_PLAN;
      const mine = members.filter((m) => m.orgId === o.id);
      return {
        id: o.id,
        name: o.name,
        plan,
        planName: PLANS[plan].name,
        createdAt: o.createdAt ?? null,
        owners: mine.filter((m) => m.role === 'OWNER').flatMap((m) => (person.has(m.userId) ? [person.get(m.userId)!] : [])),
        invitedOwners: invited.filter((i) => i.orgId === o.id).map((i) => i.email),
        members: mine.length,
        memberLimit: PLANS[plan].limits.members,
        forms: formCounts.find((f) => f._id === o.id)?.n ?? 0,
        responsesThisMonth: usage.find((u) => u.orgId === o.id)?.submissions ?? 0,
        lastActiveAt: last.find((l) => l._id === o.id)?.at ?? null,
        failedWork: failed.find((f) => f._id === o.id)?.n ?? 0,
      };
    });
  }

  /** As the customer's own owner would act, for the one thing an operator does inside it: inviting its owner. */
  private asOwner(auth: AuthContext, orgId: string): AuthContext {
    return { ...auth, orgId, role: 'OWNER' };
  }

  /**
   * A new customer: its organisation on the plan bought, and an invitation to
   * the person who will own it. The operator is never a member of it. If the
   * invitation cannot be sent, nothing is left behind.
   */
  async create(auth: AuthContext, body: { name: string; plan: PlanId; ownerEmail: string }) {
    await this.assertOperator(auth);
    const orgId = newId();
    await this.orgs.create({ id: orgId, name: body.name, plan: body.plan, planChangedAt: new Date() });
    try {
      await this.orgsService.invite(this.asOwner(auth, orgId), { email: body.ownerEmail, role: 'OWNER' });
    } catch (e) {
      await this.invitations.deleteMany({ orgId });
      await this.orgs.deleteOne({ id: orgId });
      this.logger.warn(`a customer was not added: its owner could not be invited (${(e as Error).name})`);
      throw new BadRequestException("The invitation could not be sent to that address, so the customer was not added. Check the address, and that email is working.");
    }
    await this.audit.record({ orgId, actorId: auth.userId, ip: auth.ip, userAgent: auth.userAgent }, { action: 'org.created', targetType: 'organization', targetId: orgId, after: { name: body.name, plan: body.plan, by: 'operator' } });
    return this.list(auth);
  }

  /** Another invitation to own a customer: the first never arrived, or the owner has changed. */
  async inviteOwner(auth: AuthContext, orgId: string, email: string) {
    await this.assertOperator(auth);
    if (!(await this.orgs.exists({ id: orgId }))) throw new NotFoundException('There is no such customer');
    await this.orgsService.invite(this.asOwner(auth, orgId), { email, role: 'OWNER' }).catch((e: { status?: number; message?: string }) => {
      // "Already a member" and "no free seats" are the caller's to read; anything else is the email not going.
      if (e.status === 409 || e.status === 402 || e.status === 403) throw e;
      throw new BadRequestException('The invitation could not be sent to that address. Check the address, and that email is working.');
    });
    return this.list(auth);
  }

  async setPlan(auth: AuthContext, orgId: string, plan: PlanId) {
    await this.assertOperator(auth);
    const org = await this.orgs.findOne({ id: orgId }).select('plan').lean<{ plan?: string }>();
    if (!org) throw new NotFoundException('There is no such customer');
    await this.plans.setPlan(orgId, plan);
    // In the customer's own audit trail: their plan changed, and it was us who changed it.
    await this.audit.record({ orgId, actorId: auth.userId, ip: auth.ip, userAgent: auth.userAgent }, { action: 'org.plan_changed', targetType: 'organization', targetId: orgId, before: { plan: org.plan || this.config.DEFAULT_PLAN }, after: { plan, by: 'operator' } });
    return this.list(auth);
  }
}
