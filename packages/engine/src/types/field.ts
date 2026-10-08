import type { Condition, DependencyConfig, VisibilityRule } from './rules';
import type { DataSourceConfig } from './data-source';
import type { FieldWidth } from './style';

export type FieldType =
  | 'TEXT'
  | 'TEXTAREA'
  | 'NUMBER'
  | 'EMAIL'
  | 'PHONE'
  | 'DATE'
  | 'DATETIME'
  | 'CHECKBOX'
  | 'RADIO'
  | 'DROPDOWN'
  | 'MULTI_SELECT'
  | 'FILE'
  | 'HIDDEN'
  | 'HTML'
  | 'BUTTON'
  | 'CAPTCHA'
  /** Layout containers: hold other fields, never carry a value. */
  | 'COLUMNS'
  | 'SECTION';

/**
 * Where a HIDDEN field takes its value from. These values are context for the
 * form only - the backend must re-derive every one of them and never trust
 * what the browser sends.
 */
export type SystemFieldSource =
  | 'ORG_ID'
  | 'BUSINESS_ID'
  | 'USER_ID'
  | 'USER_EMAIL'
  | 'USER_NAME'
  | 'USER_PHONE'
  | 'EMPLOYEE_ID'
  | 'FORM_ID'
  | 'FORM_VERSION'
  | 'SOURCE_CHANNEL'
  | 'CURRENT_DATE'
  | 'URL_PARAMETER';

/** Where a visible field can be pre-filled from when the person is signed in. */
export type UserPrefillSource = 'USER_NAME' | 'USER_EMAIL' | 'USER_PHONE' | 'EMPLOYEE_ID' | 'USER_ID';

export interface PrefillConfig {
  source: UserPrefillSource;
  /**
   * Signed in: the field is read-only and the server overwrites it with the
   * real value, so it can't be faked. Anonymous visitors type it as usual.
   */
  lock?: boolean;
}

export interface ValidationMessages {
  required?: string;
  minLength?: string;
  maxLength?: string;
  min?: string;
  max?: string;
  pattern?: string;
}

export interface ValidationConfig {
  /** TEXT / TEXTAREA / EMAIL / PHONE */
  minLength?: number;
  maxLength?: number;
  /** NUMBER: value bounds. MULTI_SELECT / FILE: item-count bounds. */
  min?: number;
  max?: number;
  /** A JavaScript regular expression source, without slashes. */
  pattern?: string;
  messages?: ValidationMessages;
}

export interface FormField {
  /** Stable identity used by the builder. Never shown, never submitted. */
  id: string;
  type: FieldType;
  /** Key in the submitted payload. Unique within a form. */
  name: string;
  label?: string;
  placeholder?: string;
  helpText?: string;

  /** Always required. */
  required?: boolean;
  /** Required only while this condition holds. Ignored when `required` is true. */
  requiredWhen?: Condition;
  disabled?: boolean;

  defaultValue?: unknown;

  validation?: ValidationConfig;
  /** Shown only while this rule holds. Hidden fields are not validated or submitted. */
  visibility?: VisibilityRule;
  dependency?: DependencyConfig;
  dataSource?: DataSourceConfig;

  /** Visible fields: filled from the signed-in user (TEXT, EMAIL, PHONE). */
  prefill?: PrefillConfig;

  /** HIDDEN fields only. */
  systemSource?: SystemFieldSource;
  /** Query-string key when systemSource is URL_PARAMETER. */
  systemParam?: string;

  /**
   * Layout. Fields stay one flat list (so validation, rules and the payload
   * never care about layout); a field inside a COLUMNS/SECTION container
   * points at it. `column` is the column index for COLUMNS (0 for SECTION).
   */
  parentId?: string;
  column?: number;
  /** Width within its row. Defaults to full. */
  width?: FieldWidth;
  /** Style master entry applied to this field (or container). */
  styleId?: string;

  /**
   * Type-specific extras, e.g. TEXTAREA rows, BUTTON href, HTML content,
   * COLUMNS `columns` (relative widths, e.g. [1, 2]), SECTION `description` /
   * `collapsible` / `collapsed`.
   */
  props?: Record<string, unknown>;
}
