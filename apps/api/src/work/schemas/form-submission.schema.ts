import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export class SubmissionFile {
  fieldName: string;
  uploadId: string;
  key: string;
  name: string;
  size: number;
  contentType: string;
}

/**
 * One submission of any form. `payload` is whatever the form collected,
 * already validated against `formVersion` - one collection serves every form,
 * org and business without per-form schema.
 */
@Schema({ timestamps: true, collection: 'form_submissions', minimize: false })
export class FormSubmission {
  @Prop({ required: true, type: String })
  uuid: string;

  @Prop({ required: true, type: String })
  orgId: string;

  @Prop({ type: String, default: '' })
  businessId: string;

  @Prop({ required: true, type: String })
  formCode: string;

  @Prop({ required: true, type: Number })
  formVersion: number;

  /** The form_versions uuid the payload was validated against. */
  @Prop({ required: true, type: String })
  formId: string;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  payload: Record<string, unknown>;

  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  files: SubmissionFile[];

  /** User uuid when signed in, '' for anonymous. */
  @Prop({ type: String, default: '' })
  submittedBy: string;

  /**
   * Lower-case address of the person this response is from (the form's contact email
   * field, else the signed-in submitter's): what the requests portal lists by. '' when unknown.
   */
  @Prop({ type: String, default: '' })
  requesterEmail: string;

  @Prop({ type: String, default: 'WEB' })
  channel: string;

  /** The language the form was filled in ('' on responses from before forms had languages). */
  @Prop({ type: String, default: '' })
  language: string;

  /** Client-generated key so a retried/double-clicked submit is stored once. */
  @Prop({ type: String, default: null })
  idempotencyKey: string | null;

  /** Workflow status key (the form's first status on arrival). */
  @Prop({ type: String, default: 'NEW' })
  status: string;

  /** Human reference shown to the submitter and the team, e.g. CC-000042. '' on pre-workflow submissions. */
  @Prop({ type: String, default: '' })
  ref: string;

  /** LOW / MEDIUM / HIGH / CRITICAL (forms with a workflow). */
  @Prop({ type: String, default: 'MEDIUM' })
  priority: string;

  /** The stored PDF of this response, once one has been made: where it is and when. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  document: { key: string; size: number; at: Date } | null;
  /** Work fields the team fills in (root cause, resolution...). The submitted `payload` never changes. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  work: Record<string, unknown>;

  /** PUBLIC_FORM / PORTAL / MODULE / API - where the work item came from. */
  @Prop({ type: String, default: 'PUBLIC_FORM' })
  source: string;

  /** User uuid working on it, '' when unassigned. */
  @Prop({ type: String, default: '' })
  assigneeId: string;

  @Prop({ type: Date, default: null })
  statusChangedAt: Date | null;

  /** When the current status's SLA runs out; null when it has none or the record is done. */
  @Prop({ type: Date, default: null })
  dueAt: Date | null;

  /** Set once per status by the SLA sweep (so SLA_BREACHED automations fire once). */
  @Prop({ type: Date, default: null })
  slaBreachedAt: Date | null;

  // ---- SLA v2 (form's workflow.sla): response + resolution targets, pause, escalation
  @Prop({ type: Date, default: null })
  responseDueAt: Date | null;

  /** First response by a person (status move, action, email). */
  @Prop({ type: Date, default: null })
  respondedAt: Date | null;

  @Prop({ type: Date, default: null })
  responseBreachedAt: Date | null;

  /** null while paused or when there's no resolution target. */
  @Prop({ type: Date, default: null })
  resolutionDueAt: Date | null;

  /** Working time left when the clock was paused. */
  @Prop({ type: Number, default: null })
  resolutionRemainingMs: number | null;

  @Prop({ type: Date, default: null })
  slaPausedAt: Date | null;

  /** When to raise SLA_APPROACHING (warnAtPercent of the resolution time). */
  @Prop({ type: Date, default: null })
  resolutionWarnAt: Date | null;

  @Prop({ type: Date, default: null })
  resolutionBreachedAt: Date | null;

  /** 0 = nothing yet, 1 = breach handled, 2.. = escalation levels done. */
  @Prop({ type: Number, default: 0 })
  escalationStep: number;

  /** When the sweep should take the next escalation step. */
  @Prop({ type: Date, default: null })
  nextEscalationAt: Date | null;

  /** Entered a DONE status (cleared on reopen). */
  @Prop({ type: Date, default: null })
  resolvedAt: Date | null;

  @Prop({ type: Number, default: 0 })
  reopenCount: number;

  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;

  /** The payment it came with, when the form takes one: which service, its reference, how much and when. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  payment: { id: string; provider: string; reference: string; amountMinor: number; currency: string; paidAt: Date } | null;
}

export type FormSubmissionDocument = HydratedDocument<FormSubmission>;
export const FormSubmissionSchema = SchemaFactory.createForClass(FormSubmission);
FormSubmissionSchema.index({ uuid: 1 }, { unique: true });
FormSubmissionSchema.index({ orgId: 1, requesterEmail: 1, createdAt: -1 });
FormSubmissionSchema.index({ orgId: 1, formCode: 1, createdAt: -1 });
FormSubmissionSchema.index(
  { orgId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);
FormSubmissionSchema.index({ orgId: 1, assigneeId: 1, status: 1, createdAt: -1 });
FormSubmissionSchema.index({ dueAt: 1, slaBreachedAt: 1 }, { partialFilterExpression: { dueAt: { $type: 'date' } } });
FormSubmissionSchema.index({ responseDueAt: 1, respondedAt: 1, responseBreachedAt: 1 }, { partialFilterExpression: { responseDueAt: { $type: 'date' } } });
FormSubmissionSchema.index({ nextEscalationAt: 1 }, { partialFilterExpression: { nextEscalationAt: { $type: 'date' } } });
FormSubmissionSchema.index({ resolutionWarnAt: 1 }, { partialFilterExpression: { resolutionWarnAt: { $type: 'date' } } });
