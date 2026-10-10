import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export const RECORD_EVENT_TYPES = [
  'CREATED',
  'STATUS',
  'ASSIGNED',
  'COMMENT',
  'SLA',
  'AUTOMATION',
  'PRIORITY',
  'FIELD_UPDATE',
  'APPROVAL',
  'REOPENED',
  'ESCALATED',
  'EMAIL',
] as const;
export type RecordEventType = (typeof RECORD_EVENT_TYPES)[number];

/**
 * The timeline of one record (a form submission being worked on): who moved
 * it, comments, and every automation action with its outcome. Append-only.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'form_record_events' })
export class FormRecordEvent {
  @Prop({ required: true, type: String })
  uuid: string;

  @Prop({ required: true, type: String })
  orgId: string;

  /** form_submissions uuid. */
  @Prop({ required: true, type: String })
  recordId: string;

  @Prop({ required: true, type: String, enum: RECORD_EVENT_TYPES })
  type: RecordEventType;

  /** User uuid, or '' for the system / automations. */
  @Prop({ type: String, default: '' })
  by: string;

  @Prop({ type: String, default: '' })
  message: string;

  /** Type-specific details, e.g. { from, to } or { automationId, action, ok, error }. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  data: Record<string, unknown>;
}

export type FormRecordEventDocument = HydratedDocument<FormRecordEvent>;
export const FormRecordEventSchema = SchemaFactory.createForClass(FormRecordEvent);
FormRecordEventSchema.index({ uuid: 1 }, { unique: true });
FormRecordEventSchema.index({ orgId: 1, recordId: 1, createdAt: 1 });

/** Per-form counters: record numbers and the round-robin pointer. */
@Schema({ collection: 'form_counters' })
export class FormCounter {
  @Prop({ required: true, type: String })
  orgId: string;

  @Prop({ required: true, type: String })
  formCode: string;

  @Prop({ type: Number, default: 0 })
  seq: number;

  @Prop({ type: Number, default: 0 })
  roundRobin: number;
}

export type FormCounterDocument = HydratedDocument<FormCounter>;
export const FormCounterSchema = SchemaFactory.createForClass(FormCounter);
FormCounterSchema.index({ orgId: 1, formCode: 1 }, { unique: true });

export type FlowRunStatus = 'WAITING' | 'RUNNING' | 'DONE' | 'STOPPED';

export class FlowApproval {
  stepKey: string;
  title: string;
  instructions: string;
  /** User uuids who may decide. */
  approvers: string[];
  requestedAt: Date;
  dueAt: Date | null;
  /** ALL = everyone in `approvers` must approve; `approved` are the ones who have. */
  need?: 'ANY' | 'ALL';
  approved?: string[];
  whenLate?: 'REMIND' | 'MANAGER' | 'REJECT';
  /** Set once, when the time ran out and `whenLate` was done. */
  lateAt?: Date | null;
  decision: 'APPROVED' | 'REJECTED' | null;
  decidedBy: string;
  comment: string;
  decidedAt: Date | null;
}

/**
 * A flow that paused at a "wait for approval" step (AEM workflow instance).
 * Only paused flows are stored: it keeps where to resume and what earlier
 * steps produced, so the flow carries on exactly where it stopped.
 */
@Schema({ timestamps: true, collection: 'form_flow_runs', minimize: false })
export class FormFlowRun {
  /** Same id as the run's timeline events. */
  @Prop({ required: true, type: String })
  uuid: string;

  @Prop({ required: true, type: String })
  orgId: string;

  @Prop({ required: true, type: String })
  recordId: string;

  /** The form version (its automation is what resumes). */
  @Prop({ required: true, type: String })
  formId: string;

  @Prop({ required: true, type: String })
  automationId: string;

  @Prop({ required: true, type: String })
  trigger: string;

  @Prop({ type: Number, default: 0 })
  depth: number;

  @Prop({ type: String, default: '' })
  actor: string;

  @Prop({ required: true, type: String, enum: ['WAITING', 'RUNNING', 'DONE', 'STOPPED'] })
  status: FlowRunStatus;

  /** Index of the approval step it's waiting at. */
  @Prop({ type: Number, default: 0 })
  stepIndex: number;

  /** Outputs of the steps that already ran, by step key. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  steps: Record<string, unknown>;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  approval: FlowApproval | null;

  /** Set while the flow waits at a "Send for signature" step: the request it is waiting for. */
  @Prop({ type: String, default: '' })
  signatureRequestId: string;

  /** FLOW = an automation paused at an approval step; ACTION = a named action waiting for approval. */
  @Prop({ type: String, default: 'FLOW' })
  kind: 'FLOW' | 'ACTION';

  /** ACTION runs: the action and who asked. */
  @Prop({ type: String, default: '' })
  actionKey: string;

  @Prop({ type: String, default: '' })
  requestedBy: string;
}

export type FormFlowRunDocument = HydratedDocument<FormFlowRun>;
export const FormFlowRunSchema = SchemaFactory.createForClass(FormFlowRun);
FormFlowRunSchema.index({ uuid: 1 }, { unique: true });
FormFlowRunSchema.index({ orgId: 1, recordId: 1 });
FormFlowRunSchema.index({ orgId: 1, status: 1, 'approval.approvers': 1 });

/** The org's working time for SLAs (one per org; absent = Mon-Fri 09:00-18:00 IST). */
@Schema({ timestamps: true, collection: 'form_calendars' })
export class FormCalendar {
  @Prop({ required: true, type: String })
  orgId: string;

  @Prop({ type: [Number], default: [1, 2, 3, 4, 5] })
  workingDays: number[];

  @Prop({ type: String, default: '09:00' })
  start: string;

  @Prop({ type: String, default: '18:00' })
  end: string;

  @Prop({ type: [String], default: [] })
  holidays: string[];

  @Prop({ type: Number, default: 330 })
  utcOffsetMinutes: number;

  @Prop({ type: String, default: '' })
  updatedBy: string;
}

export type FormCalendarDocument = HydratedDocument<FormCalendar>;
export const FormCalendarSchema = SchemaFactory.createForClass(FormCalendar);
FormCalendarSchema.index({ orgId: 1 }, { unique: true });

/** WM-3: an org's webhook subscription to work item events. */
@Schema({ timestamps: true, collection: 'form_webhooks' })
export class FormWebhook {
  @Prop({ required: true, type: String })
  uuid: string;

  @Prop({ required: true, type: String })
  orgId: string;

  @Prop({ required: true, type: String })
  name: string;

  /** https, host on FORM_WEBHOOK_ALLOWLIST. */
  @Prop({ required: true, type: String })
  url: string;

  /** Event names (e.g. "status.changed"); empty = all. */
  @Prop({ type: [String], default: [] })
  events: string[];

  /** Limit to these forms; empty = all. */
  @Prop({ type: [String], default: [] })
  formCodes: string[];

  /** HMAC secret for the x-fb-signature header ('' = unsigned). Never returned by the API. */
  @Prop({ type: String, default: '' })
  secret: string;

  @Prop({ type: Boolean, default: true })
  active: boolean;

  /** Also send the item's answers (by field name) and work fields. */
  @Prop({ type: Boolean, default: false })
  includeData: boolean;

  @Prop({ type: Date, default: null })
  lastDeliveryAt: Date | null;

  @Prop({ type: String, default: '' })
  lastResult: string;

  @Prop({ type: Number, default: 0 })
  failures: number;

  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;
}

export type FormWebhookDocument = HydratedDocument<FormWebhook>;
export const FormWebhookSchema = SchemaFactory.createForClass(FormWebhook);
FormWebhookSchema.index({ uuid: 1 }, { unique: true });
FormWebhookSchema.index({ orgId: 1, active: 1, isDeleted: 1 });

/** WM-4: a saved Inbox view (filters + sort), personal or shared with the org. */
@Schema({ timestamps: true, collection: 'form_work_views' })
export class FormWorkView {
  @Prop({ required: true, type: String })
  uuid: string;

  @Prop({ required: true, type: String })
  orgId: string;

  @Prop({ required: true, type: String })
  ownerId: string;

  @Prop({ required: true, type: String })
  name: string;

  /** Visible to everyone who can open the Inbox (each still sees only what they may). */
  @Prop({ type: Boolean, default: false })
  shared: boolean;

  /** The Inbox filters: formCode, status, priority, assignee, waiting, overdue, open, q, ff, sort. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  filters: Record<string, unknown>;

  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;
}

export type FormWorkViewDocument = HydratedDocument<FormWorkView>;
export const FormWorkViewSchema = SchemaFactory.createForClass(FormWorkView);
FormWorkViewSchema.index({ uuid: 1 }, { unique: true });
FormWorkViewSchema.index({ orgId: 1, isDeleted: 1, shared: 1, ownerId: 1 });

/** Org-wide Work settings chosen by a Form admin (one document per org). */
@Schema({ timestamps: true, collection: 'form_work_settings' })
export class FormWorkSettings {
  @Prop({ required: true, type: String })
  orgId: string;

  /** Inbox colour theme everyone sees (classic, ocean, sunset, forest, lavender, midnight). */
  @Prop({ type: String, default: 'classic' })
  inboxTheme: string;

  @Prop({ type: String, default: '' })
  updatedBy: string;
}

export type FormWorkSettingsDocument = HydratedDocument<FormWorkSettings>;
export const FormWorkSettingsSchema = SchemaFactory.createForClass(FormWorkSettings);
FormWorkSettingsSchema.index({ orgId: 1 }, { unique: true });
