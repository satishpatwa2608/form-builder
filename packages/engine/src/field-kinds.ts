import type { FieldType, FormField } from './types';

/** Layout containers - hold other fields. */
const CONTAINER_TYPES: ReadonlySet<FieldType> = new Set(['COLUMNS', 'SECTION', 'TABS', 'ACCORDION', 'REPEAT']);

/** Containers that only arrange what is inside them. A REPEAT is a container that also holds a value. */
const LAYOUT_ONLY_TYPES: ReadonlySet<FieldType> = new Set(['COLUMNS', 'SECTION', 'TABS', 'ACCORDION']);

/** Containers whose direct children must all be SECTIONs (each one a tab or a panel). */
const SECTION_GROUP_TYPES: ReadonlySet<FieldType> = new Set(['TABS', 'ACCORDION']);

/** Types that render something but never carry a value. */
const NON_VALUE_TYPES: ReadonlySet<FieldType> = new Set(['HTML', 'BUTTON', 'IMAGE', ...LAYOUT_ONLY_TYPES]);

/** Types whose value comes from a data source. */
const OPTION_TYPES: ReadonlySet<FieldType> = new Set(['RADIO', 'DROPDOWN', 'MULTI_SELECT', 'CHECKBOX_GROUP']);

const BOOLEAN_TYPES: ReadonlySet<FieldType> = new Set(['CHECKBOX', 'SWITCH', 'CONSENT']);
const LIST_TYPES: ReadonlySet<FieldType> = new Set(['MULTI_SELECT', 'CHECKBOX_GROUP']);
const NUMBER_TYPES: ReadonlySet<FieldType> = new Set(['NUMBER', 'STEPPER', 'SLIDER']);

/** How a form names a field its organisation's extension draws. */
export const CUSTOM_FIELD_KEY = /^x-[a-z0-9]{8}-[a-z0-9-]{1,40}$/;
/** The longest answer a custom field may give. */
export const MAX_CUSTOM_LENGTH = 10_000;

/** Stored as true/false. */
export const isBooleanField = (field: Pick<FormField, 'type'>): boolean => BOOLEAN_TYPES.has(field.type);
/** Stored as a list of option values. */
export const isListField = (field: Pick<FormField, 'type'>): boolean => LIST_TYPES.has(field.type);
/** Stored as a number. */
export const isNumberField = (field: Pick<FormField, 'type'>): boolean => NUMBER_TYPES.has(field.type);
export const isRepeat = (field: Pick<FormField, 'type'>): boolean => field.type === 'REPEAT';
export const isSectionGroup = (field: Pick<FormField, 'type'>): boolean => SECTION_GROUP_TYPES.has(field.type);

/** What a SIGNATURE value must look like: a PNG the browser drew, nothing else. */
export const SIGNATURE_PATTERN = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
/** About 110 KB of image; a signature pad's strokes are a small fraction of that. */
export const MAX_SIGNATURE_LENGTH = 150_000;
export const isSignature = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= MAX_SIGNATURE_LENGTH && SIGNATURE_PATTERN.test(value);

export const isValueField = (field: Pick<FormField, 'type'>): boolean =>
  !NON_VALUE_TYPES.has(field.type);

export const isContainerField = (field: Pick<FormField, 'type'>): boolean => CONTAINER_TYPES.has(field.type);

export const isOptionField = (field: Pick<FormField, 'type'>): boolean =>
  OPTION_TYPES.has(field.type);

/** A value counts as "not filled in". Whitespace-only strings are empty. */
export function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** The value a field starts with when neither a default nor a system source applies. */
export function emptyValueFor(type: FieldType): unknown {
  if (BOOLEAN_TYPES.has(type)) return false;
  if (LIST_TYPES.has(type) || type === 'FILE' || type === 'REPEAT') return [];
  if (NUMBER_TYPES.has(type)) return undefined;
  return '';
}

export const fieldLabel = (field: Pick<FormField, 'label' | 'name'>): string =>
  field.label?.trim() || field.name;
