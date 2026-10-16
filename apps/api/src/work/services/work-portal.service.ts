import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { newId as uuidv4 } from '../../common/crypto';
import apiResponse from '../response';
import { FormWorkSettings, FormWorkSettingsDocument, FormWorkView, FormWorkViewDocument } from '../schemas/form-record.schema';
import { FormSubmission, FormSubmissionDocument } from '../schemas/form-submission.schema';
import { FormRecordService, isRecordAdmin, openCondition, type InboxQuery } from './form-record.service';
import { FormDefinitionService } from './form-definition.service';
import { formShape, workflowOf, type FormDefinition } from '@fb/engine';
import { FormCalendarService } from './form-calendar.service';
import { PeopleService } from './people.service';
import { Folder, type FolderDocument } from '../../access/access.schemas';
import { Form, type FormDocument } from '../../forms/form.schema';

const REPORT_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;

/** In an aggregation: the record is still open (not resolved, not in a status its form calls done). */
function openExpr(latest: Map<string, FormDefinition>) {
  const done = [...latest.entries()]
    .map(([code, def]) => ({ code, keys: workflowOf(def).statuses.filter((st: { category: string }) => st.category === 'DONE').map((st: { key: string }) => st.key) }))
    .filter((d) => d.keys.length);
  return {
    $and: [{ $eq: [{ $ifNull: ['$resolvedAt', null] }, null] }, { $not: [{ $or: [false, ...done.map((d) => ({ $and: [{ $eq: ['$formCode', d.code] }, { $in: ['$status', d.keys] }] }))] }] }],
  };
}

/** In an aggregation: past one of its deadlines (a response not yet given counts against the response deadline). */
function overdueExpr(now: Date) {
  const isDate = (f: string) => ({ $eq: [{ $type: f }, 'date'] });
  return {
    $or: [
      { $and: [isDate('$dueAt'), { $lte: ['$dueAt', now] }] },
      { $and: [isDate('$resolutionDueAt'), { $lte: ['$resolutionDueAt', now] }] },
      { $and: [isDate('$responseDueAt'), { $lte: ['$responseDueAt', now] }, { $eq: [{ $ifNull: ['$respondedAt', null] }, null] }] },
    ],
  };
}

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
const VIEW_KEYS = ['formCode', 'status', 'priority', 'assignee', 'waiting', 'overdue', 'open', 'q', 'ff', 'sort', 'team'] as const;

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
    @InjectModel(Form.name) private readonly forms: Model<FormDocument>,
    @InjectModel(Folder.name) private readonly folders: Model<FolderDocument>,
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
    const latest = await this.definitions.latestByCode(user.orgId);
    const offset = (await this.calendars.get(user.orgId)).utcOffsetMinutes;
    const timezone = `${offset < 0 ? '-' : '+'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`;

    // Everything below is one pass over the records that matter (open, or made or resolved in the period), each
    // number a sum of those that fit: it was a dozen queries, each walking the records again (infra/load).
    const isDate = (f: string) => ({ $eq: [{ $type: f }, 'date'] });
    const isOpen = openExpr(latest);
    const isOverdue = overdueExpr(now);
    const isDueToday = {
      $or: ['$resolutionDueAt', '$dueAt'].map((f) => ({ $and: [isDate(f), { $gte: [f, now] }, { $lt: [f, endOfDay] }] })),
    };
    const mine = { $eq: ['$assigneeId', user.uuid] };
    const count = (...when: object[]) => ({ $sum: { $cond: [{ $and: when }, 1, 0] } });
    const top = (key: string) => [{ $match: { $expr: isOpen } }, { $group: { _id: `$${key}`, open: { $sum: 1 } } }, { $sort: { open: -1, _id: 1 } }, { $limit: 20 }];
    const perDay = (field: 'createdAt' | 'resolvedAt') => [
      { $match: { [field]: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: `$${field}`, timezone } }, n: { $sum: 1 } } },
    ];
    const [facets] = (await this.records.aggregate([
      { $match: { $and: [all, { $or: [{ resolvedAt: null }, { resolvedAt: { $gte: since } }, { createdAt: { $gte: since } }] }] } },
      {
        $facet: {
          counts: [
            {
              $group: {
                _id: null,
                myOpen: count(isOpen, mine),
                myOverdue: count(isOpen, mine, isOverdue),
                myDueToday: count(isOpen, mine, isDueToday),
                myResolvedToday: count(mine, isDate('$resolvedAt'), { $gte: ['$resolvedAt', startOfDay] }),
                openTotal: count(isOpen),
                unassigned: count(isOpen, { $eq: ['$assigneeId', ''] }),
                overdue: count(isOpen, isOverdue),
                escalated: count(isOpen, { $gt: ['$escalationStep', 1] }),
                created: count(isDate('$createdAt'), { $gte: ['$createdAt', since] }),
              },
            },
          ],
          byForm: top('formCode'),
          byPriority: top('priority'),
          // Overdue per assignee needs null-safe comparisons: nulls are "not overdue".
          byAssignee: [
            { $match: { $expr: isOpen } },
            {
              $group: {
                _id: '$assigneeId',
                open: { $sum: 1 },
                overdue: count({ $or: [{ $and: [isDate('$dueAt'), { $lte: ['$dueAt', now] }] }, { $and: [isDate('$resolutionDueAt'), { $lte: ['$resolutionDueAt', now] }] }] }),
              },
            },
            { $sort: { open: -1, _id: 1 } },
            { $limit: 20 },
          ],
          // Performance over the period: items resolved since `since`.
          perf: [
            { $match: { resolvedAt: { $gte: since } } },
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
          ],
          raisedByDay: perDay('createdAt'),
          resolvedByDay: perDay('resolvedAt'),
        },
      },
    ] as never)) as {
      counts: Record<'myOpen' | 'myOverdue' | 'myDueToday' | 'myResolvedToday' | 'openTotal' | 'unassigned' | 'overdue' | 'escalated' | 'created', number>[];
      byForm: { _id: string; open: number }[];
      byPriority: { _id: string; open: number }[];
      byAssignee: { _id: string; open: number; overdue: number }[];
      perf: { resolved: number; withTarget: number; onTime: number; reopened: number; resolutionMs: number | null; responseMs: number | null }[];
      raisedByDay: { _id: string; n: number }[];
      resolvedByDay: { _id: string; n: number }[];
    }[];
    const c = facets!.counts[0] ?? { myOpen: 0, myOverdue: 0, myDueToday: 0, myResolvedToday: 0, openTotal: 0, unassigned: 0, overdue: 0, escalated: 0, created: 0 };
    const { myOpen, myOverdue, myDueToday, myResolvedToday, openTotal, unassigned, overdue, escalated, created } = c;
    const { byForm, byPriority, byAssignee } = facets!;
    const perf = facets!.perf[0];
    const raisedByDay = new Map(facets!.raisedByDay.map((r) => [r._id, r.n]));
    const resolvedByDay = new Map(facets!.resolvedByDay.map((r) => [r._id, r.n]));
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

  /** Each form's business: the name of the top-level folder it is kept in. */
  private async businessOfForms(orgId: string): Promise<Map<string, string>> {
    const [forms, folders] = await Promise.all([
      this.forms.find({ orgId, isDeleted: false }).select('code folderId').lean(),
      this.folders.find({ orgId }).select('id name path').lean(),
    ]);
    const byId = new Map(folders.map((f) => [f.id, f]));
    return new Map(forms.map((f) => [f.code, byId.get(byId.get(f.folderId)?.path[0] ?? '')?.name ?? 'No business']));
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
    // A business is a top-level folder: comparing them only makes sense across forms.
    const choices = [...questions, ...(form ? [] : [{ value: 'business', label: 'Business' }]), { value: 'team', label: 'Team' }, { value: 'assignee', label: 'Assigned to' }, { value: 'priority', label: 'Priority' }, { value: 'status', label: 'Status' }];
    const by = choices.some((c) => c.value === query.by) ? query.by! : choices[0]!.value;
    const field = by.startsWith('field:') ? form!.fields.find((f) => f.name === by.slice(6))! : undefined;
    const key = field ? `payload.${form!.submission.mapping?.[field.name] ?? field.name}` : by === 'team' || by === 'assignee' ? 'assigneeId' : by === 'business' ? 'formCode' : by;

    const { filter: all } = await this.recordsService.inboxFilter(user, { formCode: query.formCode || undefined, team: query.team || undefined });
    // One pass in the database: each group's counts, and how long each record resolved in the period took (for
    // the median). It read the records into the API before, up to 50,000 of them.
    const isDate = (f: string) => ({ $eq: [{ $type: f }, 'date'] });
    const resolvedIn = { $and: [isDate('$resolvedAt'), { $gte: ['$resolvedAt', since] }] };
    const rows = (await this.records.aggregate([
      { $match: { $and: [all, { $or: [{ createdAt: { $gte: since } }, { resolvedAt: { $gte: since } }, openCondition(latest)] }] } },
      {
        $group: {
          _id: `$${key}`,
          opened: { $sum: { $cond: [{ $and: [isDate('$createdAt'), { $gte: ['$createdAt', since] }] }, 1, 0] } },
          resolved: { $sum: { $cond: [resolvedIn, 1, 0] } },
          openNow: { $sum: { $cond: [openExpr(latest), 1, 0] } },
          overdueNow: { $sum: { $cond: [{ $and: [openExpr(latest), overdueExpr(now)] }, 1, 0] } },
          times: { $push: { $cond: [resolvedIn, { $subtract: ['$resolvedAt', '$createdAt'] }, '$$REMOVE'] } },
        },
      },
    ] as never)) as { _id: unknown; opened: number; resolved: number; openNow: number; overdueNow: number; times: number[] }[];
    const businesses = by === 'business' ? await this.businessOfForms(user.orgId) : new Map<string, string>();
    const departments = by === 'team' ? await this.people.departmentsOf(user.orgId, rows.map((r) => (typeof r._id === 'string' ? r._id : '')).filter(Boolean)) : new Map<string, string>();
    const groupOf = (id: unknown) => {
      if (by === 'team') return id ? departments.get(String(id)) || 'No team' : 'Not assigned';
      if (by === 'business') return businesses.get(String(id)) ?? 'No business';
      return typeof id === 'string' || typeof id === 'number' ? String(id) : '';
    };

    type Group = { opened: number; resolved: number; openNow: number; overdueNow: number; times: number[] };
    const groups = new Map<string, Group>();
    const total: Group = { opened: 0, resolved: 0, openNow: 0, overdueNow: 0, times: [] };
    for (const r of rows) {
      const name = groupOf(r._id);
      const g = groups.get(name) ?? { opened: 0, resolved: 0, openNow: 0, overdueNow: 0, times: [] };
      groups.set(name, g);
      for (const into of [g, total]) {
        into.opened += r.opened;
        into.resolved += r.resolved;
        into.openNow += r.openNow;
        into.overdueNow += r.overdueNow;
        into.times.push(...r.times);
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
      // Kept for the page: a report is never of part of the records now.
      partial: false,
    };
  }
}
