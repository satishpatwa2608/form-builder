import type { DocumentSettings } from './document';
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
  /**
   * Answers save themselves as the person goes, and are there again when they come back on the same device.
   * Off unless set: on a shared computer the next person would be offered the last one's answers, so it is
   * the form's owner who says it suits their form. Needs `saveForLater` not to be off.
   */
  saveAsYouGo?: boolean;
  /** The form opens already filled from a record, read on the server (see OpenWith). */
  openWith?: OpenWith;
  /**
   * The connected table this form was started from (`<connector id>/<table>`), so the builder can say when
   * the table has gained columns. `leftOut` are columns the designer chose not to ask for.
   */
  startedFrom?: { table: string; name: string; leftOut?: string[] };
  /** Shown on the organisation's requests portal, for anyone to start. Public forms only. */
  listOnPortal?: boolean;
  /** The PDF made of each response (see DocumentSettings). */
  document?: DocumentSettings;
  /**
   * Money taken before a response is accepted. The amount is the value of a number field of this form
   * (usually one a rule works out), in whole units of the currency; a response whose amount is zero is
   * accepted without paying. Which payment service takes the money is the organisation's setting, not the form's.
   */
  payment?: { enabled: boolean; amountField: string; currency: string; description?: string };
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

/**
 * A form that opens already filled from a record in one of the organisation's systems. The record is read on the
 * server, and only the answers named in `set` and `rows` ever reach the browser, never the rest of the record.
 */
export interface OpenWith {
  /** The data source the record is in: a key as a look-up's (`/connectors/<ref>/<table>`). */
  source: string;
  /** The source's field the record is found by. */
  param: string;
  /**
   * Where that field's value comes from. LINK: a link made for one record, signed so it can be neither guessed
   * nor changed. USER_EMAIL / EMPLOYEE_ID: the signed-in person's own.
   */
  by: 'LINK' | 'USER_EMAIL' | 'EMPLOYEE_ID';
  /** Question -> property of the record. */
  set: Record<string, string>;
  /** Repeating sections filled from lists the record brings along (its related rows). */
  rows?: import('./rules').FetchRows[];
  /** Questions that stay as the record says: shown, not changeable, and put back by the server when the form is sent. */
  lock?: string[];
  /** LINK only: the form cannot be opened or sent without a link made for a record. */
  only?: boolean;
}

/** What the browser is told about it: enough to ask for the answers and to know they may be locked, nothing about where they come from. */
export type PublicOpenWith = Pick<OpenWith, 'by' | 'only'>;
