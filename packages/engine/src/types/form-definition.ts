import type { FormField } from './field';
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

  fields: FormField[];
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
  /** Who sees and works this form's records in the Inbox (default: everyone with a records module). */
  recordAccess?: RecordAccess;
  /** When X happens (and a condition holds), do Y. */
  automations?: Automation[];

  createdBy: string;
  updatedBy: string;
  createdAt?: string;
  updatedAt?: string;
}
