import type { FormField } from './field';
import type { FormEvent, FormRule } from './rules';
import type { FormActionConfig, SubmissionConfig } from './submission';
import type { CaptchaConfig } from './captcha';
import type { FormLayout, FormStyle, FormTheme } from './style';
import type { Automation, RecordAccess, WorkflowConfig } from './workflow';

export type FormStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

/** PUBLIC forms open on the unauthenticated /f/:code route; AUTHENTICATED forms never do. */
export type FormAccess = 'PUBLIC' | 'AUTHENTICATED';

export interface FormDefinition {
  id: string;
  orgId: string;
  businessId: string;

  name: string;
  /** Stable across versions - pages and URLs point at the code, not a version. */
  code: string;
  description?: string;

  version: number;
  status: FormStatus;
  access: FormAccess;
  /**
   * Whether people may save their answers and come back to them by a private
   * link. On unless set to false.
   */
  saveForLater?: boolean;
  /** Shown on the organisation's requests portal, for anyone to start. Public forms only. */
  listOnPortal?: boolean;
  /**
   * The PDF made of each response. `keep` stores one with every submission as it
   * arrives; without it a PDF is still made when someone asks for it.
   */
  document?: { keep?: boolean; title?: string; footer?: string; showEmpty?: boolean };
  /**
   * Checks the organisation's extension runs before a submission is accepted
   * (x-<ref>-<check>), after the form's own rules have passed.
   */
  submitChecks?: string[];
  /**
   * When the form starts and stops taking answers (ISO date-times). Outside
   * that window the public sees a notice instead of the form, and the server
   * refuses submissions. Staff can still raise items from inside.
   */
  opensAt?: string;
  closesAt?: string;
  /** What the public reads once the form has closed. */
  closedMessage?: string;

  /**
   * The languages the form is offered in: the one it is written in, and others
   * it has translations for (see i18n.ts). Left out, the form is in English only.
   */
  languages?: { default: string; others: string[] };
  /** Per language, the translation of each piece of wording, by key (`field.email.label`). */
  translations?: Record<string, Record<string, string>>;

  fields: FormField[];
  /** Calculations, conditional states and cross-field validation. */
  rules?: FormRule[];
  /** What happens when the form opens, a button is clicked or a submit finishes. Browser only. */
  events?: FormEvent[];
  /**
   * IANA zone (e.g. Asia/Kolkata) that dates in rules are taken in. Left out,
   * each person's own zone is used.
   */
  timeZone?: string;
  actions?: FormActionConfig;
  submission: SubmissionConfig;
  captcha?: CaptchaConfig;
  theme?: FormTheme;
  layout?: FormLayout;
  /**
   * Snapshot of the master styles this form uses, embedded at publish so a
   * published version keeps its look even if the master changes later.
   */
  styles?: FormStyle[];
  /** What happens to submissions: statuses, assignment, SLAs. */
  workflow?: WorkflowConfig;
  /**
   * The shared workflow this form uses instead of one of its own (see
   * shared-workflow.ts). On a published version `workflow` and `automations`
   * hold the copy that was taken when it was published.
   */
  workflowRef?: { id: string; map?: Record<string, string>; refPrefix?: string };
  /** Who sees and works this form's records in the Inbox (default: everyone with a records module). */
  recordAccess?: RecordAccess;
  /** When X happens (and a condition holds), do Y. */
  automations?: Automation[];

  createdBy: string;
  updatedBy: string;
  createdAt?: string;
  updatedAt?: string;
}
