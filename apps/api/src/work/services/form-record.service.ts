import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FilterQuery, Model } from 'mongoose';
import { newId as uuidv4 } from '../../common/crypto';
import apiResponse from '../response';
import type { FormDefinition, FormValues, RecordAccess } from '@fb/engine';
import {
  actionsFor,
  allowedNext,
  buildZodSchema,
  canTransition,
  findStatus,
  formatRef,
  initialPriority,
  initialStatus,
  isEmptyValue,
  isValueField,
  refPrefixOf,
  workflowOf,
} from '@fb/engine';
import { PRIORITIES, type Priority, type WorkflowAction } from '@fb/engine';
import { checkSubmissionShape } from '../../forms/payload-guard';
import { FormFieldErrors } from '../security/form-http';
import { FORM_MODULES, FORM_RECORD_FIELDS_EVENT, FORM_RECORD_STATUS_EVENT, WORK_EVENT, WORKFLOW } from '../constants';
import { MailService } from './mail.service';
import { NotificationsService } from './notifications.service';
import { PeopleService } from './people.service';
import { conditionValues, escapeHtml, evaluateCondition, renderTemplate, valuesFromPayload } from '@fb/engine';
import type { RecipientRef, WorkflowStatus } from '@fb/engine';
import { FormCalendarService } from './form-calendar.service';
import { onMove, onPriority, startTargets, statusDue, type SlaContext } from './sla';
import { FormSubmission, FormSubmissionDocument } from '../schemas/form-submission.schema';
import {
  FormCounter,
  FormCounterDocument,
  FormFlowRun,
  FormFlowRunDocument,
  FormRecordEvent,
  FormRecordEventDocument,
  type RecordEventType,
} from '../schemas/form-record.schema';
import { FormDefinitionService } from './form-definition.service';

type AuthUser = { uuid: string; orgId: string; name?: string; modules?: string[] };

export interface RecordStatusEvent {
  orgId: string;
  recordId: string;
  from: string;
  to: string;
  /** User uuid, '' when an automation moved it. */
  by: string;
  /** How many automation hops led here (0 = a person). */
  depth: number;
}

/** Work fields changed by someone (the FIELD_UPDATED trigger). */
export interface RecordFieldsEvent {
  orgId: string;
  recordId: string;
  fields: string[];
  by: string;
}

export interface InboxQuery {
  priority?: string;
  /** Only items not resolved yet. */
  open?: string;
  /** JSON [{ field, op, value }] - needs formCode. */
  ff?: string;
  sort?: 'newest' | 'oldest' | 'due' | 'priority';
  formCode?: string;
  status?: string;
  assignee?: string;
  /** 'me' = records with an approval waiting on me. */
  waiting?: string;
  overdue?: string;
  q?: string;
  page?: string;
  limit?: string;
}

export interface Person {
  uuid: string;
  name: string;
  email: string;
  department?: string;
}

/** Published to webhook subscribers for every timeline change worth knowing about. */
export interface WorkEvent {
  name: string;
  orgId: string;
  recordId: string;
  by: string;
  message: string;
  data: Record<string, unknown>;
}

export const WORK_EVENT_NAMES = [
  'record.created',
  'status.changed',
  'record.resolved',
  'record.reopened',
  'record.assigned',
  'priority.changed',
  'fields.updated',
  'comment.added',
  'sla.breached',
  'sla.approaching',
  'record.escalated',
  'approval.requested',
  'approval.decided',
  'email.sent',
] as const;

function workEventName(type: RecordEventType, data: Record<string, unknown>): string | undefined {
  switch (type) {
    case 'CREATED':
      return 'record.created';
    case 'STATUS':
      return data.resolved ? 'record.resolved' : 'status.changed';
    case 'REOPENED':
      return 'record.reopened';
    case 'ASSIGNED':
      return 'record.assigned';
    case 'PRIORITY':
      return 'priority.changed';
    case 'FIELD_UPDATE':
      return 'fields.updated';
    case 'COMMENT':
      return 'comment.added';
    case 'SLA':
      return data.kind === 'APPROACHING' ? 'sla.approaching' : 'sla.breached';
    case 'ESCALATED':
      return 'record.escalated';
    case 'APPROVAL':
      return data.phase === 'decided' ? 'approval.decided' : 'approval.requested';
    case 'EMAIL':
      return 'email.sent';
    default:
      return undefined;
  }
}

/**
 * Not resolved: no `resolvedAt` and not in one of its form's DONE statuses
 * (items closed before resolvedAt existed only have the status).
 */
export function openCondition(latest: Map<string, FormDefinition>): FilterQuery<FormSubmission> {
  const done = [...latest.entries()]
    .map(([code, def]) => ({ code, keys: workflowOf(def).statuses.filter((s) => s.category === 'DONE').map((s) => s.key) }))
    .filter((d) => d.keys.length);
  return { resolvedAt: null, ...(done.length ? { $nor: done.map((d) => ({ formCode: d.code, status: { $in: d.keys } })) } : {}) };
}

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FILTER_OPS = ['eq', 'ne', 'contains', 'in', 'gte', 'lte', 'empty', 'notEmpty'] as const;

/** One field filter -> a Mongo condition on payload.<key> or work.<name>. Values are primitives only. */
function fieldCondition(form: FormDefinition, raw: { field?: unknown; op?: unknown; value?: unknown }): FilterQuery<FormSubmission> {
  const field = typeof raw.field === 'string' ? raw.field : '';
  const op = raw.op as (typeof FILTER_OPS)[number];
  const isWork = field.startsWith('$work.');
  const name = isWork ? field.slice(6) : field;
  if (!FIELD_NAME.test(name) || !FILTER_OPS.includes(op)) throw new BadRequestException('Invalid field filter');
  const known = isWork ? form.workflow?.workFields?.some((f) => f.name === name) : form.fields.some((f) => f.name === name);
  if (!known) throw new BadRequestException(`Unknown field "${field}"`);
  const path = isWork ? `work.${name}` : `payload.${form.submission.mapping?.[name] ?? name}`;
  const prim = (v: unknown) => (typeof v === 'string' ? v.slice(0, 200) : typeof v === 'number' || typeof v === 'boolean' ? v : undefined);
  const value = Array.isArray(raw.value) ? raw.value.slice(0, 50).map(prim).filter((v) => v !== undefined) : prim(raw.value);
  switch (op) {
    case 'eq':
      return { [path]: value };
    case 'ne':
      return { [path]: { $ne: value } };
    case 'contains':
      return { [path]: { $regex: String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } };
    case 'in':
      return { [path]: { $in: Array.isArray(value) ? value : [value] } };
    case 'gte':
      return { [path]: { $gte: value } };
    case 'lte':
      return { [path]: { $lte: value } };
    case 'empty':
      return { $or: [{ [path]: { $exists: false } }, { [path]: null }, { [path]: '' }] };
    case 'notEmpty':
      return { [path]: { $exists: true, $nin: [null, ''] } };
  }
}

/** Form admins (and "All") see every record; everyone else sees what their forms' teams allow. */
export const isRecordAdmin = (user: { modules?: string[] }) => !!user.modules?.some((m) => m === 'All' || m === FORM_MODULES.admin);

const CODE = /^[A-Z0-9_]{1,100}$/;
const STATUS_KEY = /^[A-Z][A-Z0-9_]{0,39}$/;
const RECORD_FIELDS = '-_id -__v -idempotencyKey -files.key';

/** The web path of a work item in the Work app (served under /app2). */
export const recordPath = (recordId: string) => `/apps/work?view=work-inbox&uuid=${recordId}`;

/**
 * Records = submissions being worked on. Status moves follow the form
 * version's workflow; every change lands on the record's timeline. This
 * service changes state; FormAutomationService reacts to it.
 */
@Injectable()
export class FormRecordService {
  constructor(
    @InjectModel(FormSubmission.name) private readonly records: Model<FormSubmissionDocument>,
    @InjectModel(FormRecordEvent.name) private readonly events: Model<FormRecordEventDocument>,
    @InjectModel(FormCounter.name) private readonly counters: Model<FormCounterDocument>,
    @InjectModel(FormFlowRun.name) private readonly runs: Model<FormFlowRunDocument>,
    private readonly definitions: FormDefinitionService,
    private readonly emitter: EventEmitter2,
    private readonly calendars: FormCalendarService,
    private readonly mail: MailService,
    private readonly directory: PeopleService,
    private readonly notifications: NotificationsService,
  ) {}

  /** The form's SLA context: its workflow and, for WORKING SLAs, the org calendar. */
  async slaContext(orgId: string, def: FormDefinition): Promise<SlaContext> {
    const wf = workflowOf(def);
    return { wf, cal: wf.sla?.calendar === 'WORKING' ? await this.calendars.get(orgId) : null };
  }

  // ---------------------------------------------------------------- creation

  /**
   * Workflow fields of a new submission: reference number, first status,
   * owner, SLA. Forms without a workflow stay plain submissions.
   */
  async initialState(def: FormDefinition, orgId: string, values: FormValues): Promise<Partial<FormSubmission>> {
    if (!def.workflow?.enabled) return {};
    const now = new Date();
    const status = initialStatus(workflowOf(def));
    const ctx = await this.slaContext(orgId, def);
    const priority = initialPriority(workflowOf(def), values);
    const counter = await this.counters.findOneAndUpdate(
      { orgId, formCode: def.code },
      { $inc: { seq: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return {
      ref: formatRef(refPrefixOf(def), counter.seq),
      status: status.key,
      priority,
      statusChangedAt: now,
      dueAt: statusDue(ctx, status, now),
      ...startTargets(ctx, priority, status.key, now),
      assigneeId: await this.pickAssignee(def, orgId, values),
    };
  }

  /** Who a new record goes to. An unknown / inactive user means unassigned, never an error for the submitter. */
  private async pickAssignee(def: FormDefinition, orgId: string, values: FormValues): Promise<string> {
    const rule = workflowOf(def).assignment;
    let userId = '';
    if (rule?.type === 'USER') userId = rule.userId;
    if (rule?.type === 'BY_FIELD') userId = rule.map[String(values[rule.field] ?? '')] ?? rule.fallbackUserId ?? '';
    if (rule?.type === 'ROUND_ROBIN' && rule.userIds.length) {
      const c = await this.counters.findOneAndUpdate({ orgId, formCode: def.code }, { $inc: { roundRobin: 1 } }, { upsert: true, new: true });
      userId = rule.userIds[(c.roundRobin - 1) % rule.userIds.length];
    }
    return userId && (await this.findPeople(orgId, [userId])).length ? userId : '';
  }

  // ---------------------------------------------------------------- people

  /** Members who can work records - the only people records can be assigned to (a team narrows it). */
  private findPeople(orgId: string, uuids?: string[], search?: string, team?: RecordAccess): Promise<Person[]> {
    return this.directory.workers(orgId, uuids, search, team);
  }

  /** People records can go to - for a form with a team, only its members. */
  async people(user: AuthUser, search?: string, formCode?: string) {
    const q = typeof search === 'string' ? search.trim().slice(0, 50) : '';
    const team = formCode && CODE.test(formCode) ? (await this.definitions.recordAccessByCode(user.orgId)).get(formCode) : undefined;
    return apiResponse(true, 200, 'People fetched', await this.findPeople(user.orgId, undefined, q || undefined, team));
  }

  // ---------------------------------------------------------------- visibility

  /** Records with an approval waiting on this user. */
  async waitingOn(user: AuthUser): Promise<string[]> {
    const rows = await this.runs.find({ orgId: user.orgId, status: 'WAITING', 'approval.approvers': user.uuid }).select('recordId').limit(500).lean();
    return [...new Set(rows.map((r) => r.recordId))];
  }

  /**
   * What this user may see, as a filter: Form admins see everything (null);
   * everyone else sees the records assigned to them and the ones waiting on
   * their approval.
   */
  private async scope(user: AuthUser, waiting: string[]): Promise<FilterQuery<FormSubmission> | null> {
    if (isRecordAdmin(user)) return null;
    return { $or: [{ assigneeId: user.uuid }, { uuid: { $in: waiting } }] };
  }

  /** 404 (not 403) for records outside the user's scope - don't reveal they exist. */
  private async mustSee(user: AuthUser, id: string) {
    const found = await this.mustGet(user.orgId, id);
    if (isRecordAdmin(user) || found.record.assigneeId === user.uuid) return found;
    if ((await this.waitingOn(user)).includes(id)) return found;
    throw new NotFoundException('Record not found');
  }

  /**
   * The record after a change by this user - or, when the change took it out
   * of their scope (reassigned to someone else, approval decided),
   * `{ gone: true }` (apiResponse drops null data, so the marker is explicit).
   */
  async getAfterChange(user: AuthUser, id: string) {
    try {
      return await this.get(user, id);
    } catch (e) {
      if (e instanceof NotFoundException) return apiResponse(true, 200, 'Done - this item is no longer with you', { gone: true as const });
      throw e;
    }
  }

  /** Name/email for user uuids (any member - submitters needn't be record workers). */
  contacts(orgId: string, uuids: string[]): Promise<Map<string, Person>> {
    return this.directory.contacts(orgId, uuids);
  }

  // ---------------------------------------------------------------- reads

  /**
   * The Inbox filter shared by the list and the dashboard: visibility
   * (teams, assignee, pending approvals) plus the user's filters. Answer
   * filters and text search work on any form's fields - `payload.<key>` for
   * answers (after the form's mapping) and `work.<name>` for work fields.
   */
  async inboxFilter(user: AuthUser, query: InboxQuery): Promise<{ filter: FilterQuery<FormSubmission>; waiting: string[] }> {
    const waiting = await this.waitingOn(user);
    const scope = await this.scope(user, waiting);
    const and: FilterQuery<FormSubmission>[] = [
      ...(scope ? [scope] : []),
      // `$gt: ''` (not `$ne: ''`): submissions saved before references existed have no `ref` at all.
      query.waiting === 'me' ? { uuid: { $in: waiting } } : { $or: [{ ref: { $gt: '' } }, { uuid: { $in: waiting } }] },
    ];
    const filter: FilterQuery<FormSubmission> = { orgId: user.orgId, isDeleted: false, $and: and };
    const latest = await this.definitions.latestByCode(user.orgId);
    let form: FormDefinition | undefined;
    if (query.formCode) {
      if (!CODE.test(query.formCode)) throw new BadRequestException('Invalid form code');
      filter.formCode = query.formCode;
      form = latest.get(query.formCode);
    }
    if (query.status) {
      if (!STATUS_KEY.test(query.status)) throw new BadRequestException('Invalid status');
      filter.status = query.status;
    }
    if (query.priority) {
      if (!PRIORITIES.includes(query.priority as Priority)) throw new BadRequestException('Invalid priority');
      filter.priority = query.priority;
    }
    if (query.assignee === 'me') filter.assigneeId = user.uuid;
    if (query.assignee === 'unassigned') filter.assigneeId = '';
    if (query.overdue === 'true') {
      const now = new Date();
      and.push(openCondition(latest), { $or: [{ dueAt: { $lte: now } }, { resolutionDueAt: { $lte: now } }, { responseDueAt: { $lte: now }, respondedAt: null }] });
    }
    if (query.open === 'true') and.push(openCondition(latest));

    // Text search: a reference, or text in the answers (text-like fields of the form(s) in view).
    const q = typeof query.q === 'string' ? query.q.trim().slice(0, 60) : '';
    if (q) {
      const rx = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      const defs = form ? [form] : [...latest.values()].filter((d) => d.workflow?.enabled);
      const keys = new Set<string>();
      for (const d of defs) {
        for (const f of d.fields) {
          if (['TEXT', 'TEXTAREA', 'EMAIL', 'PHONE'].includes(f.type)) keys.add(d.submission.mapping?.[f.name] ?? f.name);
        }
      }
      and.push({ $or: [{ ref: { $regex: `^${q.toUpperCase().replace(/[^A-Z0-9-]/g, '')}` } }, ...[...keys].slice(0, 40).map((k) => ({ [`payload.${k}`]: rx }))] });
    }

    // Field filters (one form selected): [{ field, op, value }] on answers or $work.<field>.
    if (query.ff) {
      if (!form) throw new BadRequestException('Pick a form to filter on its fields');
      let list: unknown;
      try {
        list = JSON.parse(query.ff);
      } catch {
        throw new BadRequestException('Invalid field filter');
      }
      if (!Array.isArray(list) || list.length > 10) throw new BadRequestException('Invalid field filter');
      for (const raw of list as { field?: unknown; op?: unknown; value?: unknown }[]) {
        and.push(fieldCondition(form, raw));
      }
    }
    return { filter, waiting };
  }

  async inbox(user: AuthUser, query: InboxQuery) {
    const limit = Math.min(Math.max(1, Math.floor(Number(query.limit)) || 20), 50);
    const page = Math.max(1, Math.floor(Number(query.page)) || 1);
    const { filter, waiting } = await this.inboxFilter(user, query);

    // Priority / due sorts need computed keys, so the list is an aggregation.
    const far = new Date('9999-12-31T00:00:00Z');
    const sorts: Record<string, Record<string, 1 | -1>> = {
      newest: { createdAt: -1 },
      oldest: { createdAt: 1 },
      due: { _due: 1, createdAt: 1 },
      priority: { _prio: -1, createdAt: -1 },
    };
    const sort = sorts[query.sort ?? 'newest'] ?? sorts.newest;
    const [rows, total] = await Promise.all([
      this.records.aggregate([
        { $match: filter },
        {
          $addFields: {
            _prio: { $indexOfArray: [PRIORITIES, '$priority'] },
            _due: { $ifNull: ['$resolutionDueAt', { $ifNull: ['$dueAt', far] }] },
          },
        },
        { $sort: sort },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        { $project: { _id: 0, __v: 0, idempotencyKey: 0, 'files.key': 0, _prio: 0, _due: 0 } },
      ]),
      this.records.countDocuments(filter),
    ]);

    // Labels for the statuses on this page, and names for its assignees - one round trip each.
    const forms: Record<string, { name: string; code: string; statuses: ReturnType<typeof workflowOf>['statuses'] }> = {};
    for (const formId of new Set(rows.map((r) => r.formId as string))) {
      const def = await this.definitions.findVersion(user.orgId, formId);
      if (def) forms[formId] = { name: def.name, code: def.code, statuses: workflowOf(def).statuses };
    }
    const people = Object.fromEntries(await this.contacts(user.orgId, rows.map((r) => r.assigneeId as string)));
    return apiResponse(true, 200, 'Records fetched', { rows, total, page, limit, forms, people, waitingOnMe: waiting });
  }


  private async mustGet(orgId: string, id: string) {
    const record = await this.records.findOne({ uuid: id, orgId, isDeleted: false }).select(RECORD_FIELDS).lean();
    if (!record) throw new NotFoundException('Record not found');
    const definition = await this.definitions.findVersion(orgId, record.formId);
    if (!definition) throw new NotFoundException('Form not found');
    return { record, definition };
  }

  async get(user: AuthUser, id: string) {
    const { record, definition } = await this.mustSee(user, id);
    const events = await this.events.find({ orgId: user.orgId, recordId: id }).sort({ createdAt: 1 }).select('-_id -__v').lean();
    const runs = await this.runs.find({ orgId: user.orgId, recordId: id, approval: { $ne: null } }).sort({ createdAt: 1 }).lean();
    const approvals = runs.map((r) => ({
      runId: r.uuid,
      kind: r.kind ?? 'FLOW',
      status: r.status,
      ...r.approval!,
      canDecide: r.status === 'WAITING' && (r.approval!.approvers.includes(user.uuid) || isRecordAdmin(user)),
    }));
    const people = await this.contacts(user.orgId, [
      record.assigneeId,
      record.submittedBy,
      ...events.map((e) => e.by),
      ...runs.flatMap((r) => [...r.approval!.approvers, r.approval!.decidedBy]),
    ]);
    return apiResponse(true, 200, 'Record fetched', {
      record,
      definition,
      events,
      approvals,
      people: Object.fromEntries(people),
      // Forms with named actions move only through them; others offer the allowed statuses.
      actions: definition.workflow?.enabled ? actionsFor(workflowOf(definition), record.status) : [],
      canReopen: this.canReopen(record, definition),
      contactEmail: await this.contactEmail(user.orgId, record, definition),
      next: definition.workflow?.enabled && !definition.workflow.actions?.length ? allowedNext(workflowOf(definition), record.status) : [],
    });
  }

  /** For automations: the live record and its form version. */
  async load(orgId: string, id: string) {
    return this.mustGet(orgId, id);
  }

  // ---------------------------------------------------------------- changes

  async log(orgId: string, recordId: string, type: RecordEventType, by: string, message: string, data: Record<string, unknown> = {}) {
    await this.events.create({ uuid: uuidv4(), orgId, recordId, type, by, message: message.slice(0, 1000), data });
    const name = workEventName(type, data);
    if (name) {
      const event: WorkEvent = { name, orgId, recordId, by, message: message.slice(0, 1000), data };
      this.emitter.emit(WORK_EVENT, event);
    }
  }

  /**
   * Move a record to `to`. `from` guards against two people moving it at
   * once: the write only happens if it's still in the status we checked.
   */
  async transition(orgId: string, id: string, to: string, by: string, depth: number, note = '', action?: WorkflowAction) {
    const { record, definition } = await this.mustGet(orgId, id);
    const wf = workflowOf(definition);
    const target = findStatus(wf, to);
    if (!target) throw new BadRequestException(`Unknown status "${to}"`);
    if (!canTransition(wf, record.status, to)) {
      throw new BadRequestException(`A record can't move from ${findStatus(wf, record.status)?.label ?? record.status} to ${target.label}`);
    }
    if (!definition.workflow?.enabled) throw new BadRequestException('This form has no workflow');
    await this.moveTo(orgId, record, definition, target, by, depth, note, { action });
  }

  /**
   * The one place a record changes status: SLA bookkeeping (status due,
   * first response, resolution pause/resume, resolved), the optimistic
   * status check, the timeline and the status event for automations.
   */
  private async moveTo(
    orgId: string,
    record: FormSubmission & { createdAt?: Date },
    definition: FormDefinition,
    target: WorkflowStatus,
    by: string,
    depth: number,
    note: string,
    extra: { action?: WorkflowAction; reopen?: boolean } = {},
  ) {
    const wf = workflowOf(definition);
    const ctx = await this.slaContext(orgId, definition);
    const now = new Date();
    let set: Record<string, unknown> = { status: target.key, statusChangedAt: now, ...onMove(ctx, record, target, now, !!by) };
    if (extra.reopen) {
      // A reopened item gets a fresh resolution target and escalation from now.
      set = { ...set, ...startTargets(ctx, record.priority as Priority, target.key, now, false), reopenCount: (record.reopenCount ?? 0) + 1 };
    }
    const moved = await this.records.updateOne({ uuid: record.uuid, orgId, status: record.status, isDeleted: false }, { $set: set });
    if (!moved.modifiedCount) throw new ConflictException('Someone else just changed this record - refresh and try again');

    const from = findStatus(wf, record.status)?.label ?? record.status;
    await this.log(orgId, record.uuid, extra.reopen ? 'REOPENED' : 'STATUS', by, note, {
      from: record.status,
      to: target.key,
      fromLabel: from,
      toLabel: target.label,
      ...(target.category === 'DONE' ? { resolved: true } : {}),
      ...(extra.reopen ? { count: (record.reopenCount ?? 0) + 1 } : {}),
      ...(extra.action ? { action: extra.action.key, actionLabel: extra.action.label } : {}),
    });
    const event: RecordStatusEvent = { orgId, recordId: record.uuid, from: record.status, to: target.key, by, depth };
    this.emitter.emit(FORM_RECORD_STATUS_EVENT, event);
  }

  /** Reopen a closed item within the form's window. */
  async reopen(user: AuthUser, id: string, body: { comment?: unknown }) {
    const { record, definition } = await this.mustSee(user, id);
    const wf = workflowOf(definition);
    const config = definition.workflow?.enabled ? definition.workflow.reopen : undefined;
    if (!config) throw new BadRequestException("This form's items can't be reopened");
    if (findStatus(wf, record.status)?.category !== 'DONE') throw new BadRequestException('Only closed items can be reopened');
    const closedAt = record.resolvedAt ?? record.statusChangedAt;
    if (config.withinDays && closedAt && Date.now() - new Date(closedAt).getTime() > config.withinDays * 86_400_000) {
      throw new BadRequestException(`Items can only be reopened within ${config.withinDays} days of closing`);
    }
    const comment = typeof body?.comment === 'string' ? body.comment.trim().slice(0, WORKFLOW.commentLength) : '';
    if (!comment) throw new FormFieldErrors(400, 'Say why it is reopened', [{ field: 'comment', message: 'Add a comment' }]);
    const target = findStatus(wf, config.to);
    if (!target) throw new BadRequestException(`Unknown status "${config.to}"`);
    await this.moveTo(user.orgId, record, definition, target, user.uuid, 0, comment, { reopen: true });
    return this.getAfterChange(user, id);
  }

  canReopen(record: FormSubmission & { createdAt?: Date }, definition: FormDefinition): boolean {
    const config = definition.workflow?.enabled ? definition.workflow.reopen : undefined;
    if (!config || findStatus(workflowOf(definition), record.status)?.category !== 'DONE') return false;
    const closedAt = record.resolvedAt ?? record.statusChangedAt;
    return !config.withinDays || !closedAt || Date.now() - new Date(closedAt).getTime() <= config.withinDays * 86_400_000;
  }

  // ---------------------------------------------------------------- recipients

  /** The manager of `userId` (set on their membership). */
  managerOf(orgId: string, userId: string): Promise<string> {
    return this.directory.managerOf(orgId, userId);
  }

  /** Members behind recipient refs (assignee, submitter, a user, the assignee's manager). */
  async resolveUsers(orgId: string, to: RecipientRef[], record: Pick<FormSubmission, 'assigneeId' | 'submittedBy'>): Promise<string[]> {
    const ids: string[] = [];
    for (const r of to) {
      if (r.kind === 'ASSIGNEE') ids.push(record.assigneeId);
      if (r.kind === 'SUBMITTER') ids.push(record.submittedBy);
      if (r.kind === 'USER') ids.push(r.userId);
      if (r.kind === 'MANAGER') ids.push(await this.managerOf(orgId, record.assigneeId));
    }
    return [...new Set(ids.filter(Boolean))];
  }

  /**
   * Where to email the requester: the form's contact EMAIL field (or its
   * first EMAIL field), else the signed-in submitter's account email.
   */
  async contactEmail(orgId: string, record: Pick<FormSubmission, 'payload' | 'submittedBy'>, definition: FormDefinition): Promise<string> {
    const values = valuesFromPayload(definition, record.payload as FormValues);
    const field = definition.workflow?.contactEmailField ?? definition.fields.find((f) => f.type === 'EMAIL')?.name;
    const answer = field ? values[field] : undefined;
    if (typeof answer === 'string' && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(answer.trim())) return answer.trim();
    if (record.submittedBy) return (await this.contacts(orgId, [record.submittedBy])).get(record.submittedBy)?.email ?? '';
    return '';
  }

  /**
   * Email the requester from the item. Outbound only: replies go to the
   * sender's own mailbox (their address is in the mail), not back into Form Builder.
   * `requestInfo` also moves the item to the form's "waiting" status.
   */
  async sendEmail(user: AuthUser, id: string, body: { subject?: unknown; body?: unknown; templateKey?: unknown; requestInfo?: unknown }) {
    const { record, definition } = await this.mustSee(user, id);
    const wf = definition.workflow;
    if (!wf?.enabled) throw new BadRequestException('This form has no workflow');
    const to = await this.contactEmail(user.orgId, record, definition);
    if (!to) throw new BadRequestException('There is no email address for the requester');
    const subjectIn = typeof body?.subject === 'string' ? body.subject : '';
    const textIn = typeof body?.body === 'string' ? body.body : '';
    if (!subjectIn.trim() || !textIn.trim()) throw new FormFieldErrors(400, 'Write a subject and a message', [{ field: 'subject', message: 'Required' }, { field: 'body', message: 'Required' }].filter((e) => (e.field === 'subject' ? !subjectIn.trim() : !textIn.trim())));

    const me = (await this.contacts(user.orgId, [user.uuid])).get(user.uuid);
    const status = findStatus(workflowOf(definition), record.status);
    const ctx = {
      values: valuesFromPayload(definition, record.payload as FormValues),
      work: record.work ?? {},
      record: { ref: record.ref, status: status?.label ?? record.status, link: '' },
      form: { name: definition.name },
    };
    // Header injection: the subject is one line. The message is plain text made safe for HTML.
    const subject = renderTemplate(subjectIn, ctx, false).replace(/[\r\n]+/g, ' ').slice(0, 200);
    const text = renderTemplate(textIn, ctx, false).slice(0, 10_000);
    const signature = me ? `\n\n--\n${me.name}${me.email ? `\nTo reply, write to ${me.email}` : ''}` : '';
    const html = `<div style="font-family: Arial, sans-serif; font-size: 14px; color: #333;">${escapeHtml(text + signature).replace(/\r?\n/g, '<br>')}</div>`;

    const sent = await this.mail.sendMail({
      to,
      subject,
      template: html,
      orgId: user.orgId,
      fromName: me?.name || 'Form Builder',
      sourceModule: 'FORMS',
      entityType: 'form-record',
      entityId: record.uuid,
    });
    if (!sent?.success) throw new BadRequestException(`The email could not be sent: ${sent?.message ?? 'unknown error'}`);

    const requestInfo = body?.requestInfo === true && !!wf.requestInfoStatus;
    await this.log(user.orgId, id, 'EMAIL', user.uuid, '', {
      to,
      subject,
      body: text.slice(0, 2000),
      templateKey: typeof body?.templateKey === 'string' ? body.templateKey.slice(0, 40) : '',
      requestInfo,
    });
    if (!record.respondedAt) await this.records.updateOne({ uuid: id, orgId: user.orgId, respondedAt: null }, { $set: { respondedAt: new Date() } });
    if (requestInfo && record.status !== wf.requestInfoStatus) {
      const target = findStatus(workflowOf(definition), wf.requestInfoStatus!);
      const fresh = (await this.mustGet(user.orgId, id)).record;
      if (target) await this.moveTo(user.orgId, fresh, definition, target, user.uuid, 0, 'Information requested from the requester');
    }
    return this.getAfterChange(user, id);
  }

  /** One priority step up (escalation). */
  async bumpPriority(orgId: string, id: string, by: string) {
    const { record, definition } = await this.mustGet(orgId, id);
    const next = PRIORITIES[Math.min(PRIORITIES.indexOf(record.priority as Priority) + 1, PRIORITIES.length - 1)];
    if (next === record.priority) return;
    const ctx = await this.slaContext(orgId, definition);
    await this.records.updateOne({ uuid: id, orgId }, { $set: { priority: next, ...onPriority(ctx, record, next) } });
    await this.log(orgId, id, 'PRIORITY', by, 'Raised by escalation', { from: record.priority, to: next });
  }

  /** Assign (or unassign with ''). The new assignee gets an in-app notification. */
  async assign(orgId: string, id: string, userId: string, by: string) {
    const { record, definition } = await this.mustGet(orgId, id);
    if (typeof userId !== 'string') throw new BadRequestException('userId is required');
    if (!definition.workflow?.enabled) throw new BadRequestException('This form has no workflow');
    const team = (await this.definitions.recordAccessByCode(orgId)).get(record.formCode);
    const person = userId ? (await this.findPeople(orgId, [userId], undefined, team))[0] : undefined;
    if (userId && !person) {
      throw new BadRequestException(team ? 'That user isn\'t in the team that works this form\'s records' : 'That user can\'t work on records (they need a Form records module)');
    }
    if (record.assigneeId === userId) return;

    await this.records.updateOne({ uuid: id, orgId }, { $set: { assigneeId: userId } });
    await this.log(orgId, id, 'ASSIGNED', by, '', { from: record.assigneeId, to: userId });
    if (userId && userId !== by) this.notify(orgId, [userId], `${record.ref || 'A record'} (${definition.name}) was assigned to you`, record.uuid, record.ref, definition.name);
  }

  /** In-app notification + email (NotificationsService). */
  notify(orgId: string, userIds: string[], message: string, recordId: string, ref: string, formName: string) {
    this.notifications.notify(orgId, userIds, message, recordId, ref, formName);
  }


  // ---------------------------------------------------------------- endpoints

  async changeStatus(user: AuthUser, id: string, body: { to?: unknown; note?: unknown }) {
    if (typeof body?.to !== 'string' || !STATUS_KEY.test(body.to)) throw new BadRequestException('Choose a status');
    const { definition } = await this.mustSee(user, id);
    if (definition.workflow?.actions?.length) throw new BadRequestException('This form moves records through its actions');
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, WORKFLOW.commentLength) : '';
    await this.transition(user.orgId, id, body.to, user.uuid, 0, note);
    return this.getAfterChange(user, id);
  }

  /** A named move: checks its required work fields and comment, then moves the record. */
  async act(user: AuthUser, id: string, key: string, body: { comment?: unknown }) {
    const { record, definition } = await this.mustSee(user, id);
    const action = actionsFor(workflowOf(definition), record.status).find((a) => a.key === key);
    if (!definition.workflow?.enabled || !action) throw new BadRequestException("This action isn't available for the record now");
    const comment = typeof body?.comment === 'string' ? body.comment.trim().slice(0, WORKFLOW.commentLength) : '';
    const missing: { field: string; message: string }[] = [];
    if (action.requireComment && !comment) missing.push({ field: 'comment', message: 'Add a comment' });
    const work = record.work ?? {};
    for (const name of action.requireFields ?? []) {
      if (isEmptyValue(work[name])) {
        const label = definition.workflow.workFields?.find((f) => f.name === name)?.label ?? name;
        missing.push({ field: name, message: `${label} is required to ${action.label}` });
      }
    }
    if (missing.length) throw new FormFieldErrors(400, `Complete these to ${action.label}`, missing);
    if (await this.runs.exists({ orgId: user.orgId, recordId: id, kind: 'ACTION', status: 'WAITING' })) {
      throw new ConflictException('This item is waiting for an approval');
    }
    const needsApproval =
      !!action.approval &&
      (!action.approval.if ||
        evaluateCondition(
          action.approval.if,
          conditionValues(valuesFromPayload(definition, record.payload as FormValues), record.status, {}, { priority: record.priority, work: record.work ?? {} }),
        ));
    if (needsApproval) {
      await this.requestActionApproval(user, record, definition, action, comment);
      return this.getAfterChange(user, id);
    }
    await this.transition(user.orgId, id, action.to, user.uuid, 0, comment, action);
    return this.getAfterChange(user, id);
  }

  /**
   * The action needs approval: park it as an approval (same Inbox card and
   * decide endpoint as flow approvals); the decision makes (or refuses) the move.
   */
  private async requestActionApproval(user: AuthUser, record: FormSubmission, definition: FormDefinition, action: WorkflowAction, comment: string) {
    const approvers = (await this.resolveUsers(user.orgId, action.approval!.to, record)).filter((u) => u !== user.uuid || action.approval!.to.length === 1);
    if (!approvers.length) throw new BadRequestException(`No one to approve "${action.label}" (is the assignee's manager set?)`);
    const now = new Date();
    const runId = uuidv4();
    const title = `${action.label}: ${record.ref || definition.name}`;
    await this.runs.create({
      uuid: runId,
      orgId: user.orgId,
      recordId: record.uuid,
      formId: definition.id,
      automationId: `action:${action.key}`,
      trigger: 'ACTION',
      kind: 'ACTION',
      actionKey: action.key,
      requestedBy: user.uuid,
      status: 'WAITING',
      stepIndex: 0,
      steps: {},
      approval: {
        stepKey: action.key,
        title,
        instructions: comment,
        approvers,
        requestedAt: now,
        dueAt: null,
        decision: null,
        decidedBy: '',
        comment: '',
        decidedAt: null,
      },
    });
    await this.log(user.orgId, record.uuid, 'APPROVAL', user.uuid, comment, { phase: 'requested', runId, action: action.key, actionLabel: action.label, approvers });
    this.notify(user.orgId, approvers, `Approval needed: ${title}`, record.uuid, record.ref, definition.name);
  }

  /** An approver decided on a pending action: make the move (or the reject move). */
  async completeActionApproval(orgId: string, recordId: string, actionKey: string, decision: 'APPROVED' | 'REJECTED', by: string, comment: string, runId: string) {
    const { record, definition } = await this.mustGet(orgId, recordId);
    const action = definition.workflow?.actions?.find((a) => a.key === actionKey);
    await this.log(orgId, recordId, 'APPROVAL', by, comment, { phase: 'decided', runId, action: actionKey, actionLabel: action?.label ?? actionKey, decision });
    const to = decision === 'APPROVED' ? action?.to : action?.approval?.onReject;
    if (!action || !to || to === record.status) return;
    const target = findStatus(workflowOf(definition), to);
    if (!target) return;
    // The approval was the check; the move itself follows the workflow's allowed moves.
    await this.moveTo(orgId, record, definition, target, by, 0, comment, { action: decision === 'APPROVED' ? action : undefined });
  }

  async setPriority(user: AuthUser, id: string, body: { priority?: unknown }) {
    const priority = body?.priority as Priority;
    if (!PRIORITIES.includes(priority)) throw new BadRequestException('Choose a priority');
    const { record, definition } = await this.mustSee(user, id);
    if (!definition.workflow?.enabled) throw new BadRequestException('This form has no workflow');
    if (record.priority !== priority) {
      const ctx = await this.slaContext(user.orgId, definition);
      await this.records.updateOne({ uuid: id, orgId: user.orgId }, { $set: { priority, ...onPriority(ctx, record, priority) } });
      await this.log(user.orgId, id, 'PRIORITY', user.uuid, '', { from: record.priority, to: priority });
    }
    return this.getAfterChange(user, id);
  }

  /**
   * Save work fields (partial). Same safety checks as a submission (types,
   * markup, known fields); "required" is enforced by actions, not here, so
   * people can save as they go. Every change is audited with before/after.
   */
  async updateWork(user: AuthUser, id: string, body: { values?: unknown }) {
    const { record, definition } = await this.mustSee(user, id);
    const wf = definition.workflow;
    const workFields = wf?.enabled ? wf.workFields ?? [] : [];
    if (!workFields.length) throw new BadRequestException('This form has no work fields');
    if (findStatus(workflowOf(definition), record.status)?.category === 'DONE') throw new ConflictException('This record is closed');

    const optional = workFields.map((f) => ({ ...f, required: false, requiredWhen: undefined }));
    const issues = checkSubmissionShape({ ...definition, fields: optional }, body?.values);
    if (issues.length) throw new FormFieldErrors(422, 'Please check the fields', issues);
    const values = body.values as Record<string, unknown>;
    const merged = { ...(record.work ?? {}), ...values };
    const result = buildZodSchema({ fields: optional }).safeParse(merged);
    if (!result.success) {
      throw new FormFieldErrors(422, 'Please check the fields', result.error.issues.map((i) => ({ field: String(i.path[0] ?? ''), message: i.message })));
    }

    const byName = new Map(workFields.filter(isValueField).map((f) => [f.name, f]));
    const changes = Object.keys(values)
      .filter((k) => JSON.stringify(record.work?.[k] ?? null) !== JSON.stringify(values[k] ?? null))
      .map((k) => ({ field: k, label: byName.get(k)?.label ?? k, from: record.work?.[k] ?? null, to: values[k] ?? null }));
    if (!changes.length) return this.getAfterChange(user, id);

    await this.records.updateOne(
      { uuid: id, orgId: user.orgId },
      { $set: Object.fromEntries(changes.map((c) => [`work.${c.field}`, c.to])) },
    );
    await this.log(user.orgId, id, 'FIELD_UPDATE', user.uuid, '', { changes });
    const event: RecordFieldsEvent = { orgId: user.orgId, recordId: id, fields: changes.map((c) => c.field), by: user.uuid };
    this.emitter.emit(FORM_RECORD_FIELDS_EVENT, event);
    return this.getAfterChange(user, id);
  }

  async changeAssignee(user: AuthUser, id: string, body: { userId?: unknown }) {
    await this.mustSee(user, id);
    await this.assign(user.orgId, id, body?.userId as string, user.uuid);
    return this.getAfterChange(user, id);
  }

  async comment(user: AuthUser, id: string, body: { message?: unknown }) {
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!message) throw new BadRequestException('Write a comment');
    if (message.length > WORKFLOW.commentLength) throw new BadRequestException(`Comments are limited to ${WORKFLOW.commentLength} characters`);
    await this.mustSee(user, id);
    await this.log(user.orgId, id, 'COMMENT', user.uuid, message);
    return this.getAfterChange(user, id);
  }
}
