import type { Condition } from './rules';
import type { FormField } from './field';

/**
 * What happens after a form is submitted: every submission becomes a record
 * that moves through the form's statuses, gets assigned, and can trigger
 * automations. Configured per form (versioned with it) - no code per form.
 */

/** OPEN / IN_PROGRESS count toward SLAs; DONE stops the clock. */
export type StatusCategory = 'OPEN' | 'IN_PROGRESS' | 'DONE';

export interface WorkflowStatus {
  /** Stored on records, e.g. "NEW", "RESOLVED". */
  key: string;
  label: string;
  category: StatusCategory;
  /** Time allowed in this status before it's overdue. */
  slaHours?: number;
}

export type AssignmentRule =
  | { type: 'NONE' }
  | { type: 'USER'; userId: string }
  | { type: 'ROUND_ROBIN'; userIds: string[] }
  /** Pick by an answer, e.g. Business = Denim -> the Denim quality head. */
  | { type: 'BY_FIELD'; field: string; map: Record<string, string>; fallbackUserId?: string };

/** Fixed scale so SLAs, filters and reports compare across forms. */
export type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export const PRIORITIES: Priority[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/** First matching rule sets a new work item's priority. */
export interface PriorityRule {
  if: Condition;
  priority: Priority;
}

/**
 * A named move shown as a button ("Resolve", "Request info"). When a form
 * defines actions, records move only through them - so their required work
 * fields and comments can't be bypassed.
 */
export interface WorkflowAction {
  /** lower_snake, unique in the workflow. */
  key: string;
  label: string;
  /** Statuses the button shows in (empty / absent = every status except `to`). */
  from?: string[];
  to: string;
  /** Work fields that must be filled before this move. */
  requireFields?: string[];
  /** Ask for a reason / comment (logged on the timeline). */
  requireComment?: boolean;
  /**
   * Someone must approve the move first (e.g. the manager approves "Resolve").
   * Approved -> the item moves to `to`; rejected -> to `onReject` (or stays).
   */
  approval?: {
    to: RecipientRef[];
    onReject?: string;
    /** Only needs approval when this holds (e.g. $work.compensationAmount >= 50000); otherwise it just moves. */
    if?: Condition;
  };
}

/** Response / resolution targets in hours (working hours when the calendar is WORKING). */
export interface SlaTargets {
  responseHours?: number;
  resolutionHours?: number;
}

export interface SlaConfig extends SlaTargets {
  /** WORKING = the org's working-time calendar; 24x7 = wall clock. Default 24x7. */
  calendar?: 'WORKING' | '24x7';
  /** Per-priority targets override the defaults above. */
  byPriority?: Partial<Record<Priority, SlaTargets>>;
  /** The resolution clock stops in these statuses (e.g. waiting for the customer). */
  pauseIn?: string[];
  /** Warn (SLA_APPROACHING) when this share of the resolution time has passed, e.g. 80. */
  warnAtPercent?: number;
}

/** One escalation step after the resolution target is missed. */
export interface EscalationLevel {
  /** Hours after the breach (0 = at the breach). */
  afterHours: number;
  notify: RecipientRef[];
  /** Hand the item to this user. */
  reassignTo?: string;
  /** Bump priority one step (up to CRITICAL). */
  raisePriority?: boolean;
}

/** A reusable email the team sends from an item (templates use the same {{tokens}}). */
export interface EmailTemplate {
  key: string;
  name: string;
  subject: string;
  body: string;
}

/** The org's working time, for SLAs counted in working hours. */
export interface WorkingCalendar {
  /** 0 = Sunday ... 6 = Saturday. Default Mon-Fri. */
  workingDays: number[];
  /** "09:00" */
  start: string;
  /** "18:00" */
  end: string;
  /** "2026-10-02" */
  holidays: string[];
  /** Offset from UTC in minutes (India +330). */
  utcOffsetMinutes: number;
}

/** Where a work item came from. Every item still has a form behind it (its fields + process). */
export type WorkItemSource = 'PUBLIC_FORM' | 'PORTAL' | 'MODULE' | 'API';

export interface WorkflowConfig {
  enabled: boolean;
  /** The first status is where new records start. */
  statuses: WorkflowStatus[];
  /** Record numbers look like CMP-000042. Defaults to the form code's initials. */
  refPrefix?: string;
  /** from status -> statuses it may move to. A status missing here may move anywhere. */
  transitions?: Record<string, string[]>;
  assignment?: AssignmentRule;
  /** Default MEDIUM; rules can raise or lower it from the answers. */
  priority?: { default: Priority; rules?: PriorityRule[] };
  /** Named moves; when present they replace free status changes. */
  actions?: WorkflowAction[];
  /** Closed items can be reopened into this status (within N days). */
  reopen?: { to: string; withinDays?: number };
  sla?: SlaConfig;
  escalation?: { levels: EscalationLevel[] };
  /** "Request information" emails move the item here (and it can pause the SLA). */
  requestInfoStatus?: string;
  /** The EMAIL field holding the requester's address (default: the first EMAIL field). */
  contactEmailField?: string;
  emailTemplates?: EmailTemplate[];
  /**
   * Internal fields the team fills while working the item (investigation,
   * root cause, resolution...). Same field model as the form; stored apart
   * from the submitted answers, which never change.
   */
  workFields?: FormField[];
}

/** Who an email / notification / task goes to. */
export type RecipientRef =
  | { kind: 'ASSIGNEE' }
  | { kind: 'SUBMITTER' }
  | { kind: 'USER'; userId: string }
  /** The assignee's manager (their user record's `reportingTo`). */
  | { kind: 'MANAGER' }
  /** An EMAIL field's answer (e.g. the complainant's email). */
  | { kind: 'FIELD'; field: string }
  | { kind: 'EMAIL'; email: string };

/**
 * What every step has, whatever it does. Steps run top to bottom; each sees
 * the payload (answers + record) and the outputs of the steps before it.
 */
export interface StepMeta {
  /** Key for this step's output: {{$steps.<id>.<field>}}. Unique within the automation. */
  id?: string;
  /** Shown on the flow diagram instead of the default name. */
  label?: string;
  /** Skip this step unless the condition holds (answers, $status, $steps.<id>.<field>). */
  if?: Condition;
  /** Default: a failed step stops the rest of the flow. */
  continueOnError?: boolean;
}

/**
 * Templates may use {{fieldName}}, {{$record.ref}}, {{$record.status}},
 * {{$record.link}}, {{$form.name}} and earlier steps' outputs
 * {{$steps.<id>.<field>}}. Values are HTML-escaped when rendered.
 */
export type AutomationAction = StepMeta &
  (
  /** `attachDocument` sends the PDF of the response with it (made by the server; see the form's `document`). */
  | { type: 'EMAIL'; to: RecipientRef[]; subject: string; body: string; attachDocument?: boolean }
  | { type: 'NOTIFY'; to: RecipientRef[]; message: string }
  /**
   * Pause the flow until one of `to` approves or rejects (AEM participant
   * step). Output: { decision: 'APPROVED' | 'REJECTED', decidedBy, comment }.
   */
  | { type: 'APPROVAL'; to: RecipientRef[]; title: string; instructions?: string; dueInHours?: number }
  /** A task in the Tasks module: the first recipient is accountable, the rest responsible. */
  | { type: 'CREATE_TASK'; title: string; description?: string; to: RecipientRef[]; dueInHours?: number }
  | { type: 'ASSIGN'; userId: string }
  | { type: 'SET_STATUS'; status: string }
  /** POST the record as JSON to an allow-listed https URL (FORM_WEBHOOK_ALLOWLIST). */
  | { type: 'WEBHOOK'; url: string }
  /** Code registered on the server under this key, for logic that can't be configured. */
  | { type: 'HANDLER'; key: string }
  );

/**
 * Who works a form's records. Absent = everyone with a Form records module.
 * A team sees only its forms' records (plus what's assigned to or waiting on
 * them); Form admins always see everything.
 */
export interface RecordAccess {
  mode: 'TEAM';
  userIds: string[];
  /** Users whose `department` is one of these. */
  departments: string[];
}

export type AutomationTrigger = 'SUBMITTED' | 'STATUS_CHANGED' | 'SLA_BREACHED' | 'SLA_APPROACHING' | 'FIELD_UPDATED';

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  when: AutomationTrigger;
  /** STATUS_CHANGED only: fire when moving into this status (any if unset). */
  toStatus?: string;
  /** SLA_BREACHED only: which target (any if unset). STATUS = a status's own slaHours. */
  sla?: 'STATUS' | 'RESPONSE' | 'RESOLUTION';
  /** FIELD_UPDATED only: the work field (any if unset). Test the new value with `if` on `$work.<field>`. */
  field?: string;
  /** Tested against the answers plus `$status`. */
  if?: Condition;
  /** The steps, run in order. */
  actions: AutomationAction[];
}
