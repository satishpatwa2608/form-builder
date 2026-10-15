import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { newId as uuidv4 } from '../../common/crypto';
import apiResponse from '../response';
import { FormWorkSettings, FormWorkSettingsDocument, FormWorkView, FormWorkViewDocument } from '../schemas/form-record.schema';
import { FormSubmission, FormSubmissionDocument } from '../schemas/form-submission.schema';
import { FormRecordService, isRecordAdmin, openCondition, type InboxQuery } from './form-record.service';
import { FormDefinitionService } from './form-definition.service';
import { formShape } from '@fb/engine';
import { FormCalendarService } from './form-calendar.service';
import { PeopleService } from './people.service';

/** How many records one report reads at most (per part); past that it says it is partial. */
const REPORT_ROWS = 50_000;
const REPORT_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;

/** The middle value, in hours to one decimal; null with none. */
function median(ms: number[]): number | null {
  if (!ms.length) return null;
  const s = [...ms].sort((a, b) => a - b);
  const mid = s.length >> 1;
  const v = s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  return Math.round((v / 3_600_000) * 10) / 10;
}

type AuthUser = { uuid: string; orgId: string; name?: string; modules?: string[] };

export interface WorkViewDto {
  uuid: string;
  name: string;
  shared: boolean;
  ownerId: string;
  filters: Record<string, unknown>;
  mine: boolean;
}

/** Filters a view may keep (the Inbox query, minus paging). */
const VIEW_KEYS = ['formCode', 'status', 'priority', 'assignee', 'waiting', 'overdue', 'open', 'q', 'ff', 'sort'] as const;

const HOUR = 3_600_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The Work portal's views and dashboard. Everything goes through the Inbox
 * filter, so a dashboard number is exactly the list you get when you click it,
 * and nobody sees counts for items outside their teams.
 */
/** Inbox colour themes (the web app has the matching styles). */
const INBOX_THEMES = ['classic', 'ocean', 'sunset', 'forest', 'lavender', 'midnight'];

export interface WorkSettingsDto {
  inboxTheme: string;
}

@Injectable()
export class WorkPortalService {
  constructor(
    @InjectModel(FormWorkView.name) private readonly views: Model<FormWorkViewDocument>,
    @InjectModel(FormWorkSettings.name) private readonly settings: Model<FormWorkSettingsDocument>,
    @InjectModel(FormSubmission.name) private readonly records: Model<FormSubmissionDocument>,
    private readonly recordsService: FormRecordService,
    private readonly definitions: FormDefinitionService,
    private readonly calendars: FormCalendarService,
    private readonly people: PeopleService,
  ) {}

  // ---------------------------------------------------------------- saved views

  async listViews(user: AuthUser) {
    const rows = await this.views
      .find({ orgId: user.orgId, isDeleted: false, $or: [{ ownerId: user.uuid }, { shared: true }] })
      .sort({ name: 1 })
      .lean();
    // Plain objects (not lean documents): the API's declaration build needs nameable types.
    const views: WorkViewDto[] = rows.map((v) => ({ uuid: v.uuid, name: v.name, shared: v.shared, ownerId: v.ownerId, filters: v.filters ?? {}, mine: v.ownerId === user.uuid }));
    return apiResponse(true, 200, 'Views fetched', views);
  }

  /** `new` creates. Only Form admins save views; everyone can use the shared ones. */
  async saveView(user: AuthUser, id: string, body: { name?: unknown; shared?: unknown; filters?: unknown }) {
    if (!isRecordAdmin(user)) throw new ForbiddenException('Only Form admins can save views');
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 60) : '';
    if (!name) throw new BadRequestException('Name the view');
    const raw = (body?.filters && typeof body.filters === 'object' ? body.filters : {}) as Record<string, unknown>;
    const filters = Object.fromEntries(
      VIEW_KEYS.filter((k) => typeof raw[k] === 'string' || typeof raw[k] === 'boolean').map((k) => [k, typeof raw[k] === 'string' ? (raw[k] as string).slice(0, 2000) : raw[k]]),
    );
    // Check the filters are valid now, rather than when someone opens the view.
    await this.recordsService.inboxFilter(user, filters as InboxQuery);
    if (id === 'new') {
      const uuid = uuidv4();
      await this.views.create({ uuid, orgId: user.orgId, ownerId: user.uuid, name, shared: body.shared === true, filters });
    } else {
      const view = await this.views.findOne({ uuid: id, orgId: user.orgId, isDeleted: false });
      if (!view) throw new NotFoundException('View not found');
      if (view.ownerId !== user.uuid && !(view.shared && isRecordAdmin(user))) throw new ForbiddenException('Only its owner can change this view');
      view.set({ name, shared: body.shared === true, filters });
      view.markModified('filters');
      await view.save();
    }
    return this.listViews(user);
  }

  async removeView(user: AuthUser, id: string) {
    const view = await this.views.findOne({ uuid: id, orgId: user.orgId, isDeleted: false });
    if (!view) throw new NotFoundException('View not found');
    if (view.ownerId !== user.uuid && !(view.shared && isRecordAdmin(user))) throw new ForbiddenException('Only its owner can delete this view');
    view.set({ isDeleted: true });
    await view.save();
    return this.listViews(user);
  }

  // ---------------------------------------------------------------- settings

  async getSettings(user: AuthUser) {
    const row = await this.settings.findOne({ orgId: user.orgId }).lean();
    const settings: WorkSettingsDto = { inboxTheme: row?.inboxTheme || 'classic' };
    return apiResponse(true, 200, 'Work settings fetched', settings);
  }

  /** Form admins only (the route checks the module). */
  async saveSettings(user: AuthUser, body: { inboxTheme?: unknown }) {
    const theme = body?.inboxTheme;
    if (typeof theme !== 'string' || !INBOX_THEMES.includes(theme)) throw new BadRequestException('Unknown theme');
    await this.settings.updateOne({ orgId: user.orgId }, { $set: { inboxTheme: theme, updatedBy: user.uuid }, $setOnInsert: { orgId: user.orgId } }, { upsert: true });
    return this.getSettings(user);
  }

  // ---------------------------------------------------------------- dashboard

  /**
   * Personal cards (mine) and team numbers (everything the user may see),
   * optionally for one form; performance figures cover `days` (default 30).
   */
  async dashboard(user: AuthUser, query: { formCode?: string; days?: string; team?: string }) {
    const days = Math.min(Math.max(Math.floor(Number(query.days)) || 30, 1), 365);
    const now = new Date();
    const since = new Date(now.getTime() - days * 24 * HOUR);
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay.getTime() + 24 * HOUR);
    const base = { formCode: query.formCode || undefined, team: query.team || undefined };

    const { filter: all, waiting } = await this.recordsService.inboxFilter(user, base);
    const open = { $and: [all, openCondition(await this.definitions.latestByCode(user.orgId))] };
    const mineOpen = { $and: [open, { assigneeId: user.uuid }] };
    const overdueCond = {
      $or: [{ dueAt: { $lte: now } }, { resolutionDueAt: { $lte: now } }, { responseDueAt: { $lte: now }, respondedAt: null }],
    };
    const count = (f: object) => this.records.countDocuments(f);

    const [myOpen, myOverdue, myDueToday, myResolvedToday, openTotal, unassigned, overdue, escalated] = await Promise.all([
      count(mineOpen),
      count({ $and: [mineOpen, overdueCond] }),
      count({ $and: [mineOpen, { $or: [{ resolutionDueAt: { $gte: now, $lt: endOfDay } }, { dueAt: { $gte: now, $lt: endOfDay } }] }] }),
      count({ $and: [all, { assigneeId: user.uuid, resolvedAt: { $gte: startOfDay } }] }),
      count(open),
      count({ $and: [open, { assigneeId: '' }] }),
      count({ $and: [open, overdueCond] }),
      count({ $and: [open, { escalationStep: { $gt: 1 } }] }),
    ]);

    const group = async (key: string) =>
      (await this.records.aggregate([{ $match: open }, { $group: { _id: `$${key}`, open: { $sum: 1 } } }, { $sort: { open: -1 } }, { $limit: 20 }])) as { _id: string; open: number }[];

    // Overdue per assignee needs null-safe comparisons: nulls are "not overdue".
    const byAssignee = (await this.records.aggregate([
      { $match: open },
      {
        $group: {
          _id: '$assigneeId',
          open: { $sum: 1 },
          overdue: {
            $sum: {
              $cond: [
                {
                  $or: [
                    // Only real dates count (older items may not have these fields at all).
                    { $and: [{ $eq: [{ $type: '$dueAt' }, 'date'] }, { $lte: ['$dueAt', now] }] },
                    { $and: [{ $eq: [{ $type: '$resolutionDueAt' }, 'date'] }, { $lte: ['$resolutionDueAt', now] }] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
      { $sort: { open: -1 } },
      { $limit: 20 },
    ])) as { _id: string; open: number; overdue: number }[];
    const [byForm, byPriority] = await Promise.all([group('formCode'), group('priority')]);

    // Performance over the period: items resolved since `since`.
    const perf = (
      await this.records.aggregate([
        { $match: { $and: [all, { resolvedAt: { $gte: since } }] } },
        {
          $group: {
            _id: null,
            resolved: { $sum: 1 },
            withTarget: { $sum: { $cond: [{ $ne: ['$resolutionDueAt', null] }, 1, 0] } },
            onTime: { $sum: { $cond: [{ $and: [{ $ne: ['$resolutionDueAt', null] }, { $eq: ['$resolutionBreachedAt', null] }] }, 1, 0] } },
            reopened: { $sum: { $cond: [{ $gt: ['$reopenCount', 0] }, 1, 0] } },
            resolutionMs: { $avg: { $subtract: ['$resolvedAt', '$createdAt'] } },
            responseMs: { $avg: { $cond: [{ $ne: ['$respondedAt', null] }, { $subtract: ['$respondedAt', '$createdAt'] }, null] } },
          },
        },
      ])
    )[0] as { resolved: number; withTarget: number; onTime: number; reopened: number; resolutionMs: number | null; responseMs: number | null } | undefined;
    const created = await count({ $and: [all, { createdAt: { $gte: since } }] });

    // Raised / resolved per day (the org's time zone), every day of the period, zeros included.
    const offset = (await this.calendars.get(user.orgId)).utcOffsetMinutes;
    const timezone = `${offset < 0 ? '-' : '+'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`;
    const perDay = async (field: 'createdAt' | 'resolvedAt') =>
      new Map(
        (
          (await this.records.aggregate([
            { $match: { $and: [all, { [field]: { $gte: since } }] } },
            { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: `$${field}`, timezone } }, n: { $sum: 1 } } },
          ])) as { _id: string; n: number }[]
        ).map((r) => [r._id, r.n]),
      );
    const [raisedByDay, resolvedByDay] = await Promise.all([perDay('createdAt'), perDay('resolvedAt')]);
    const dayKey = (d: Date) => new Date(d.getTime() + offset * 60_000).toISOString().slice(0, 10);
    const trend = Array.from({ length: days }, (_, i) => dayKey(new Date(now.getTime() - (days - 1 - i) * 24 * HOUR))).map((date) => ({
      date,
      raised: raisedByDay.get(date) ?? 0,
      resolved: resolvedByDay.get(date) ?? 0,
    }));

    const people = Object.fromEntries(await this.recordsService.contacts(user.orgId, byAssignee.map((r) => r._id)));
    return apiResponse(true, 200, 'Dashboard', {
      days,
      teams: await this.people.departments(user.orgId),
      me: { open: myOpen, overdue: myOverdue, dueToday: myDueToday, waitingMyApproval: waiting.length, resolvedToday: myResolvedToday },
      team: {
        open: openTotal,
        unassigned,
        overdue,
        escalated,
        byAssignee: byAssignee.map((r) => ({ userId: r._id, name: r._id ? people[r._id]?.name ?? 'Unknown user' : 'Unassigned', open: r.open, overdue: r.overdue })),
        byForm: byForm.map((r) => ({ formCode: r._id, open: r.open })),
        byPriority: byPriority.map((r) => ({ priority: r._id || 'NONE', open: r.open })),
      },
      performance: {
        created,
        resolved: perf?.resolved ?? 0,
        slaCompliance: perf?.withTarget ? Math.round((perf.onTime / perf.withTarget) * 100) : null,
        avgResolutionHours: perf?.resolutionMs ? round1(perf.resolutionMs / HOUR) : null,
        avgFirstResponseHours: perf?.responseMs ? round1(perf.responseMs / HOUR) : null,
        reopenRate: perf?.resolved ? Math.round((perf.reopened / perf.resolved) * 100) : null,
        trend,
      },
    });
  }

  /**
   * For a period: records opened, resolved, open and overdue now, and the median time to resolve, grouped by
   * one choice question of a form, by team (the assignee's department), by assignee, by priority or by status,
   * side by side, under the same rules as the inbox for what this person may see.
   */
  async report(user: AuthUser, query: { formCode?: string; days?: string; by?: string; team?: string }) {
    const days = Math.min(Math.max(Math.floor(Number(query.days)) || 30, 1), 365);
    const now = new Date();
    const since = new Date(now.getTime() - days * 24 * HOUR);
    const latest = await this.definitions.latestByCode(user.orgId);
    const form = query.formCode ? latest.get(query.formCode) : undefined;
    if (query.formCode && !form) throw new NotFoundException('Form not found');
    // What a report can be grouped by: the fixed ones, and a form's single-choice questions.
    const questions = form
      ? formShape(form.fields)
          .top.filter((f) => (f.type === 'DROPDOWN' || f.type === 'RADIO') && REPORT_KEY.test(form.submission.mapping?.[f.name] ?? f.name))
          .map((f) => ({ value: `field:${f.name}`, label: f.label || f.name }))
      : [];
    const choices = [...questions, { value: 'team', label: 'Team' }, { value: 'assignee', label: 'Assigned to' }, { value: 'priority', label: 'Priority' }, { value: 'status', label: 'Status' }];
    const by = choices.some((c) => c.value === query.by) ? query.by! : choices[0]!.value;
    const field = by.startsWith('field:') ? form!.fields.find((f) => f.name === by.slice(6))! : undefined;
    const key = field ? `payload.${form!.submission.mapping?.[field.name] ?? field.name}` : by === 'team' || by === 'assignee' ? 'assigneeId' : by;

    const { filter: all } = await this.recordsService.inboxFilter(user, { formCode: query.formCode || undefined, team: query.team || undefined });
    const pick = `${key} createdAt resolvedAt dueAt resolutionDueAt responseDueAt respondedAt`;
    const [inPeriod, open] = await Promise.all([
      this.records.find({ $and: [all, { $or: [{ createdAt: { $gte: since } }, { resolvedAt: { $gte: since } }] }] }).select(pick).limit(REPORT_ROWS).lean(),
      this.records.find({ $and: [all, openCondition(latest)] }).select(pick).limit(REPORT_ROWS).lean(),
    ]);
    const valueOf = (r: Record<string, unknown>) => {
      const v = key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), r);
      return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
    };
    const departments = by === 'team' ? await this.people.departmentsOf(user.orgId, [...inPeriod, ...open].map((r) => r.assigneeId ?? '').filter(Boolean)) : new Map<string, string>();
    const groupOf = (r: Record<string, unknown>) => (by === 'team' ? (r.assigneeId ? departments.get(String(r.assigneeId)) || 'No team' : 'Not assigned') : valueOf(r));

    type Group = { opened: number; resolved: number; openNow: number; overdueNow: number; times: number[] };
    const groups = new Map<string, Group>();
    const at = (g: string) => {
      if (!groups.has(g)) groups.set(g, { opened: 0, resolved: 0, openNow: 0, overdueNow: 0, times: [] });
      return groups.get(g)!;
    };
    const total: Group = { opened: 0, resolved: 0, openNow: 0, overdueNow: 0, times: [] };
    for (const r of inPeriod as unknown as (Record<string, unknown> & { createdAt: Date; resolvedAt: Date | null })[]) {
      const g = at(groupOf(r));
      if (r.createdAt >= since) {
        g.opened++;
        total.opened++;
      }
      if (r.resolvedAt && r.resolvedAt >= since) {
        g.resolved++;
        total.resolved++;
        const ms = r.resolvedAt.getTime() - r.createdAt.getTime();
        g.times.push(ms);
        total.times.push(ms);
      }
    }
    const late = (d: unknown) => d instanceof Date && d <= now;
    for (const r of open as unknown as (Record<string, unknown> & { respondedAt: Date | null })[]) {
      const g = at(groupOf(r));
      g.openNow++;
      total.openNow++;
      if (late(r.dueAt) || late(r.resolutionDueAt) || (late(r.responseDueAt) && !r.respondedAt)) {
        g.overdueNow++;
        total.overdueNow++;
      }
    }

    // What each group is called, in the words the people who use the form know.
    const names = new Map<string, string>();
    if (field) for (const o of field.dataSource?.options ?? []) names.set(o.value, o.label);
    if (by === 'priority') for (const p of ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']) names.set(p, p[0] + p.slice(1).toLowerCase());
    if (by === 'status') for (const def of form ? [form] : [...latest.values()]) for (const st of def.workflow?.statuses ?? []) names.set(st.key, st.label);
    if (by === 'assignee') for (const [id, p] of await this.recordsService.contacts(user.orgId, [...groups.keys()].filter(Boolean))) names.set(id, p.name);
    const label = (g: string) => names.get(g) ?? (g ? g : by === 'assignee' ? 'Not assigned' : by.startsWith('field:') ? '(not answered)' : '—');
    const summary = (g: Group) => ({ opened: g.opened, resolved: g.resolved, openNow: g.openNow, overdueNow: g.overdueNow, medianResolveHours: median(g.times) });
    return {
      days,
      from: since,
      to: now,
      by,
      choices,
      teams: await this.people.departments(user.orgId),
      groups: [...groups.entries()].map(([g, v]) => ({ key: g, label: label(g), ...summary(v) })).sort((a, b) => b.opened + b.openNow - (a.opened + a.openNow) || a.label.localeCompare(b.label)),
      total: summary(total),
      // More records than a report reads at once: the numbers are of the first ones only.
      partial: inPeriod.length >= REPORT_ROWS || open.length >= REPORT_ROWS,
    };
  }
}
