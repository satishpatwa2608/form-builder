import { orgLog } from '../logs/org-log';
import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { AuthContext } from '../auth/auth-context';
import { APP_CONFIG, type AppConfig } from '../config';
import { Invitation, Membership, Organization, type InvitationDocument, type MembershipDocument, type OrganizationDocument } from '../orgs/org.schemas';
import { PLANS, PLAN_IDS, type CountedResource, type PlanId, type PlanLimits } from './plans';
import { FormFieldStat, FormStat, UsageMonth, type FormFieldStatDocument, type FormStatDocument, type UsageMonthDocument } from './usage.schema';

/** 402 with a message the studio shows as-is. */
export class PlanLimitException extends HttpException {
  constructor(message: string) {
    super({ statusCode: HttpStatus.PAYMENT_REQUIRED, message, code: 'PLAN_LIMIT' }, HttpStatus.PAYMENT_REQUIRED);
  }
}

const LABEL: Record<CountedResource, string> = { forms: 'forms', members: 'members', connectors: 'connectors', gateways: 'gateways', customDomains: 'custom domains', extensions: 'extensions (your own code)' };
const month = (d = new Date()) => d.toISOString().slice(0, 7);
const day = (d = new Date()) => d.toISOString().slice(0, 10);

/**
 * Plans, quotas and usage. The org's plan is set by billing (or an operator);
 * every limited action asks here first. Counting reads the live collections,
 * so a limit can never drift from reality.
 */
@Injectable()
export class PlansService {
  private readonly cache = new Map<string, { plan: PlanId; at: number }>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectModel(Organization.name) private readonly orgs: Model<OrganizationDocument>,
    @InjectModel(Membership.name) private readonly memberships: Model<MembershipDocument>,
    @InjectModel(Invitation.name) private readonly invitations: Model<InvitationDocument>,
    @InjectModel(UsageMonth.name) private readonly months: Model<UsageMonthDocument>,
    @InjectModel(FormStat.name) private readonly stats: Model<FormStatDocument>,
    @InjectModel(FormFieldStat.name) private readonly fieldStats: Model<FormFieldStatDocument>,
  ) {}

  async planOf(orgId: string): Promise<PlanId> {
    const hit = this.cache.get(orgId);
    if (hit && Date.now() - hit.at < 60_000) return hit.plan;
    const org = await this.orgs.findOne({ id: orgId }).select('plan').lean();
    const stored = (org as { plan?: string } | null)?.plan;
    const plan = (PLAN_IDS as readonly string[]).includes(stored ?? '') ? (stored as PlanId) : this.config.DEFAULT_PLAN;
    this.cache.set(orgId, { plan, at: Date.now() });
    return plan;
  }

  async limitsOf(orgId: string): Promise<PlanLimits> {
    return PLANS[await this.planOf(orgId)].limits;
  }

  /** Operators / billing webhooks only (never a user-facing route). */
  async setPlan(orgId: string, plan: PlanId) {
    await this.orgs.updateOne({ id: orgId }, { $set: { plan, planChangedAt: new Date() } });
    this.cache.delete(orgId);
  }

  private async count(orgId: string, what: CountedResource): Promise<number> {
    const db = this.orgs.db;
    switch (what) {
      case 'forms':
        return (await db.collection('forms').distinct('code', { orgId, isDeleted: false })).length;
      case 'members':
        return (await this.memberships.countDocuments({ orgId, status: { $ne: 'REMOVED' } })) + (await this.invitations.countDocuments({ orgId, acceptedAt: null, revokedAt: null, expiresAt: { $gt: new Date() } }));
      case 'connectors':
        return db.collection('connectors').countDocuments({ orgId, isDeleted: false });
      case 'gateways':
        return db.collection('gateways').countDocuments({ orgId, revokedAt: null });
      case 'extensions':
        return db.collection('extensions').countDocuments({ orgId, isDeleted: false });
      case 'customDomains': {
        const org = await this.orgs.findOne({ id: orgId }).select('domains').lean();
        return ((org as { domains?: unknown[] } | null)?.domains ?? []).length;
      }
    }
  }

  /** Before adding one more of something. */
  async assertCanAdd(orgId: string, what: CountedResource) {
    const plan = await this.planOf(orgId);
    const limit = PLANS[plan].limits[what];
    if (limit === null) return;
    if ((await this.count(orgId, what)) >= limit) {
      throw new PlanLimitException(limit === 0 ? `The ${PLANS[plan].name} plan doesn't include ${LABEL[what]}. Upgrade to add them.` : `The ${PLANS[plan].name} plan allows ${limit} ${LABEL[what]}. Upgrade or remove one first.`);
    }
  }

  async assertFeature(orgId: string, feature: 'removeBranding' | 'sso') {
    const plan = await this.planOf(orgId);
    if (!PLANS[plan].limits[feature]) throw new PlanLimitException(`The ${PLANS[plan].name} plan doesn't include ${feature === 'sso' ? 'single sign-on' : 'removing Form Builder branding'}.`);
  }

  /**
   * Take one response from the monthly quota, atomically (parallel submissions
   * can't overshoot). The respondent sees a neutral message; the org sees why
   * on its usage page. Give it back with releaseSubmission if the submit fails.
   */
  async reserveSubmission(orgId: string): Promise<string> {
    const m = month();
    const limit = (await this.limitsOf(orgId)).submissionsPerMonth;
    await this.months.updateOne({ orgId, month: m }, { $setOnInsert: { submissions: 0 } }, { upsert: true }).catch(() => undefined); // a racing insert is fine
    const res = await this.months.updateOne({ orgId, month: m, ...(limit === null ? {} : { submissions: { $lt: limit } }) }, { $inc: { submissions: 1 } });
    if (!res.modifiedCount) {
      orgLog.warn(orgId, 'submissions', 'A response was turned away: the plan\'s responses for this month are used up', { limit: limit ?? 0 });
      throw new HttpException({ statusCode: 429, message: "This form isn't accepting responses right now. Please try again later.", code: 'QUOTA' }, 429);
    }
    return m;
  }

  async releaseSubmission(orgId: string, reservedMonth: string) {
    await this.months.updateOne({ orgId, month: reservedMonth, submissions: { $gt: 0 } }, { $inc: { submissions: -1 } });
  }

  /** The form's own daily count, after a successful submit. */
  async recordSubmission(orgId: string, code: string) {
    // Analytics only: never fail (or undo) a stored submission over it.
    await this.stats.updateOne({ orgId, code, day: day() }, { $inc: { submissions: 1 } }, { upsert: true }).catch(() => undefined);
  }

  async recordEvent(orgId: string, code: string, type: 'view' | 'start', loadMs?: unknown) {
    const inc: Record<string, number> = { [type === 'view' ? 'views' : 'starts']: 1 };
    // A load time is counted when it is a believable one: a tab left open in the background reports minutes.
    if (type === 'view' && typeof loadMs === 'number' && Number.isFinite(loadMs) && loadMs > 0 && loadMs <= 60_000) {
      const ms = Math.round(loadMs);
      inc.loads = 1;
      inc.loadMsTotal = ms;
      if (ms < 1000) inc.loadUnder1s = 1;
      if (ms < 2000) inc.loadUnder2s = 1;
      if (ms < 4000) inc.loadUnder4s = 1;
    }
    await this.stats.updateOne({ orgId, code, day: day() }, { $inc: inc }, { upsert: true });
  }

  /**
   * One visit's part in the per-field counts, sent by the form page as the
   * person leaves or submits. `fields` are the form's own answer fields: a
   * name the form does not have is not counted.
   */
  async recordFields(orgId: string, code: string, fields: string[], visit: { answered: string[]; mistakes: string[]; leftAt?: string }) {
    const known = new Set(fields);
    const inc = new Map<string, { answered?: 1; mistakes?: 1; leftAt?: 1 }>();
    const add = (name: unknown, key: 'answered' | 'mistakes' | 'leftAt') => {
      if (typeof name === 'string' && known.has(name)) inc.set(name, { ...inc.get(name), [key]: 1 });
    };
    for (const name of visit.answered.slice(0, 500)) add(name, 'answered');
    for (const name of visit.mistakes.slice(0, 500)) add(name, 'mistakes');
    add(visit.leftAt, 'leftAt');
    if (!inc.size) return;
    const today = day();
    await this.fieldStats.bulkWrite(
      [...inc].map(([field, $inc]) => ({ updateOne: { filter: { orgId, code, day: today, field }, update: { $inc }, upsert: true } })),
      { ordered: false },
    );
  }

  /** Per field over the last `days` days, in the form's order: answered, mistakes, and where people left. */
  async fieldReport(orgId: string, code: string, days: number, fields: { name: string; label: string }[]) {
    const from = day(new Date(Date.now() - (days - 1) * 86_400_000));
    const [sums, funnel] = await Promise.all([
      this.fieldStats.aggregate<{ _id: string; answered: number; mistakes: number; leftAt: number }>([
        { $match: { orgId, code, day: { $gte: from } } },
        { $group: { _id: '$field', answered: { $sum: '$answered' }, mistakes: { $sum: '$mistakes' }, leftAt: { $sum: '$leftAt' } } },
      ]),
      this.formStats(orgId, code, days),
    ]);
    const by = new Map(sums.map((s) => [s._id, s]));
    const rows = fields.map((f) => ({ name: f.name, label: f.label, answered: by.get(f.name)?.answered ?? 0, mistakes: by.get(f.name)?.mistakes ?? 0, leftAt: by.get(f.name)?.leftAt ?? 0 }));
    return { days, starts: funnel.totals.starts, submissions: funnel.totals.submissions, fields: rows };
  }

  /** Plan, limits and what is used now, for the organisation's settings page. */
  async usage(auth: AuthContext) {
    const plan = await this.planOf(auth.orgId);
    const counted: CountedResource[] = ['forms', 'members', 'connectors', 'gateways', 'customDomains', 'extensions'];
    const counts = Object.fromEntries(await Promise.all(counted.map(async (k) => [k, await this.count(auth.orgId, k)] as const)));
    const submissions = (await this.months.findOne({ orgId: auth.orgId, month: month() }).lean())?.submissions ?? 0;
    return { plan, planName: PLANS[plan].name, limits: PLANS[plan].limits, usage: { ...counts, submissionsThisMonth: submissions }, month: month(), plans: PLANS };
  }

  /** Daily funnel for one form over the last `days` days (zero-filled). */
  async formStats(orgId: string, code: string, days: number) {
    const from = new Date(Date.now() - (days - 1) * 86_400_000);
    const rows = await this.stats.find({ orgId, code, day: { $gte: day(from) } }).lean();
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const series = Array.from({ length: days }, (_, i) => {
      const d = day(new Date(from.getTime() + i * 86_400_000));
      const r = byDay.get(d);
      return { day: d, views: r?.views ?? 0, starts: r?.starts ?? 0, submissions: r?.submissions ?? 0 };
    });
    const totals = series.reduce((t, r) => ({ views: t.views + r.views, starts: t.starts + r.starts, submissions: t.submissions + r.submissions }), { views: 0, starts: 0, submissions: 0 });
    const rate = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
    const sum = (key: 'loads' | 'loadMsTotal' | 'loadUnder1s' | 'loadUnder2s' | 'loadUnder4s') => rows.reduce((n, r) => n + (r[key] ?? 0), 0);
    const loads = sum('loads');
    // How quickly the form appeared for the people who opened it. Nothing to say until someone has.
    const speed = loads ? { loads, averageMs: Math.round(sum('loadMsTotal') / loads), under1s: rate(sum('loadUnder1s'), loads), under2s: rate(sum('loadUnder2s'), loads), under4s: rate(sum('loadUnder4s'), loads) } : null;
    return { days, series, totals, startRate: rate(totals.starts, totals.views), completionRate: rate(totals.submissions, totals.starts || totals.views), speed };
  }
}
