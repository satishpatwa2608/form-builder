/** Values the form engine can read for HIDDEN system fields and `{{$system.X}}` params. */
export interface SystemContext {
  orgId?: string;
  businessId?: string;
  userId?: string;
  userEmail?: string;
  userName?: string;
  userPhone?: string;
  employeeId?: string;
  formId?: string;
  formVersion?: number;
  sourceChannel?: string;
  /** Injected so tests and server-side validation get a deterministic date. */
  now?: Date;
  urlParams?: Record<string, string>;
  /** The language the form is being filled in: decides the wording of messages. The form's own when not given. */
  language?: string;
  /** IANA zone (e.g. Asia/Kolkata) that `today()` in a rule is taken in. UTC when not given. */
  timeZone?: string;
}

export type FormValues = Record<string, unknown>;

export interface SubmissionResult {
  ok: boolean;
  submissionId?: string;
  /** Reference number for forms with a workflow, e.g. CC-000042 (shown to the submitter). */
  ref?: string;
  /** Echo of what was sent, as the backend received it. */
  payload: FormValues;
  error?: string;
  /** Server-side validation failures by field, shown next to each field. */
  fieldErrors?: { field: string; message: string }[];
}
