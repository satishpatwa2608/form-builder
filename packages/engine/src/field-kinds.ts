import type { FieldType, FormField } from './types';

/** Layout containers - hold other fields. */
const CONTAINER_TYPES: ReadonlySet<FieldType> = new Set(['COLUMNS', 'SECTION']);

/** Types that render something but never carry a value. */
const NON_VALUE_TYPES: ReadonlySet<FieldType> = new Set(['HTML', 'BUTTON', ...CONTAINER_TYPES]);

/** Types whose value comes from a data source. */
const OPTION_TYPES: ReadonlySet<FieldType> = new Set(['RADIO', 'DROPDOWN', 'MULTI_SELECT']);

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
  switch (type) {
    case 'CHECKBOX':
      return false;
    case 'MULTI_SELECT':
    case 'FILE':
      return [];
    case 'NUMBER':
      return undefined;
    default:
      return '';
  }
}

export const fieldLabel = (field: Pick<FormField, 'label' | 'name'>): string =>
  field.label?.trim() || field.name;
