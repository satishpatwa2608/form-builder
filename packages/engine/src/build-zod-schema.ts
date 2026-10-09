import { z } from 'zod';
import type { FormDefinition, FormField, FormValues, SystemContext } from './types';
import { fieldLabel, isBooleanField, isEmptyValue, isRepeat, isSignature, isValueField, MAX_CUSTOM_LENGTH } from './field-kinds';
import { formShape, MAX_ROWS, rowKey, rowsOf } from './repeat';
import { computeFormState } from './form-state';

/** Used when a PHONE field has no pattern of its own. */
export const DEFAULT_PHONE_PATTERN = '^\\+?[0-9][0-9\\s-]{6,14}$';

const isValidDate = (v: string) => !Number.isNaN(Date.parse(v));

function stringSchema(field: FormField, defaultPattern?: string): z.ZodType {
  const v = field.validation ?? {};
  const m = v.messages ?? {};
  let s = z.string();
  if (v.minLength !== undefined) {
    s = s.min(v.minLength, m.minLength ?? `Must be at least ${v.minLength} characters`);
  }
  if (v.maxLength !== undefined) {
    s = s.max(v.maxLength, m.maxLength ?? `Must be at most ${v.maxLength} characters`);
  }
  const pattern = v.pattern ?? defaultPattern;
  if (pattern) {
    s = s.regex(new RegExp(pattern), m.pattern ?? `${fieldLabel(field)} is not in the expected format`);
  }
  return s;
}

function optionValueSchema(field: FormField): z.ZodType {
  const options = field.dataSource?.type === 'STATIC' ? field.dataSource.options ?? [] : undefined;
  const base = z.string();
  if (!options) return base;
  const allowed = new Set(options.map((o) => o.value));
  return base.refine((v) => allowed.has(v), 'Select a valid option');
}

/**
 * Schema for a field's value once it is known to be non-empty. Emptiness and
 * required-ness are decided separately (they depend on other fields' values),
 * so nothing here needs to be optional. Returns null for fields that are
 * never validated.
 */
export function buildFieldValueSchema(field: FormField): z.ZodType | null {
  const v = field.validation ?? {};
  const m = v.messages ?? {};
  switch (field.type) {
    case 'TEXT':
    case 'TEXTAREA':
      return stringSchema(field);
    case 'PHONE':
      return stringSchema(field, DEFAULT_PHONE_PATTERN);
    case 'EMAIL': {
      let s = z.email(m.pattern ?? 'Enter a valid email address');
      if (v.maxLength !== undefined) {
        s = s.max(v.maxLength, m.maxLength ?? `Must be at most ${v.maxLength} characters`);
      }
      return s;
    }
    case 'NUMBER':
    case 'STEPPER': {
      let s = z.number('Enter a number');
      if (v.min !== undefined) s = s.min(v.min, m.min ?? `Must be at least ${v.min}`);
      if (v.max !== undefined) s = s.max(v.max, m.max ?? `Must be at most ${v.max}`);
      return s;
    }
    case 'SIGNATURE':
      return z.string().refine(isSignature, 'Sign again');
    case 'CUSTOM':
      // What it means is the organisation's own business (a check in its extension can judge it); here it is text of a sane size.
      return z.string().max(MAX_CUSTOM_LENGTH, 'This answer is too long');
    case 'DATE':
    case 'DATETIME':
      return z.string().refine(isValidDate, 'Enter a valid date');
    case 'CHECKBOX':
    case 'SWITCH':
    case 'CONSENT':
      return z.boolean();
    case 'RADIO':
    case 'DROPDOWN':
      return optionValueSchema(field);
    case 'MULTI_SELECT':
    case 'CHECKBOX_GROUP': {
      let s = z.array(optionValueSchema(field));
      if (v.min !== undefined) s = s.min(v.min, m.min ?? `Select at least ${v.min}`);
      if (v.max !== undefined) s = s.max(v.max, m.max ?? `Select at most ${v.max}`);
      return s;
    }
    case 'FILE': {
      let s = z.array(z.any());
      if (v.max !== undefined) s = s.max(v.max, m.max ?? `Attach at most ${v.max} files`);
      return s;
    }
    case 'CAPTCHA':
      return z.string();
    // A repeating section is checked row by row in buildZodSchema, not as one value.
    case 'REPEAT':
    case 'HIDDEN':
    case 'HTML':
    case 'BUTTON':
    case 'IMAGE':
    case 'COLUMNS':
    case 'SECTION':
    case 'TABS':
    case 'ACCORDION':
      return null;
  }
}

/** A required checkbox, switch or consent is only satisfied when on. */
const isMissing = (field: FormField, value: unknown) => isEmptyValue(value) || (isBooleanField(field) && value !== true);

const requiredMessage = (field: FormField) =>
  field.validation?.messages?.required ??
  (field.type === 'CAPTCHA'
    ? 'Please complete the verification'
    : field.type === 'CONSENT'
      ? 'Please accept to continue'
      : field.type === 'SIGNATURE'
        ? 'Please sign'
        : `${fieldLabel(field)} is required`);

/** How many rows a repeating section must and may have. */
function rowCountProblem(field: FormField, count: number, required: boolean): string | null {
  const { min, max, messages } = field.validation ?? {};
  const atLeast = Math.max(min ?? 0, required ? 1 : 0);
  if (count < atLeast) {
    if (count === 0 && required) return messages?.required ?? `Add at least one row to ${fieldLabel(field)}`;
    return messages?.min ?? `Add at least ${atLeast} rows`;
  }
  const atMost = Math.min(max ?? MAX_ROWS, MAX_ROWS);
  return count > atMost ? messages?.max ?? `No more than ${atMost} rows` : null;
}

/**
 * FormDefinition -> Zod schema for React Hook Form.
 *
 * Visibility and conditional-required depend on live values, so they can't be
 * baked into a static object shape. Instead the schema is one pass over the
 * values that works out each field's state, skips hidden fields, applies
 * required, and runs the field's own value schema on anything filled in.
 * Calculated fields are checked on the value the rules compute, and a rule's
 * own error shows when nothing more basic is wrong with the field.
 * A repeating section is checked for its number of rows, then row by row;
 * a mistake in a row is reported at `[section, row, field]`.
 * Build it once per definition version, not per render.
 */
export function buildZodSchema(def: Pick<FormDefinition, 'fields' | 'rules'>, ctx?: SystemContext) {
  const shape = formShape(def.fields);
  const valueSchemas = new Map<string, z.ZodType>();
  for (const field of def.fields) {
    const schema = isValueField(field) ? buildFieldValueSchema(field) : null;
    if (schema) valueSchemas.set(field.name, schema);
  }

  return z.looseObject({}).superRefine((input: FormValues, issues) => {
    const { states, values, errors, options } = computeFormState(def, input, ctx);

    /** One answer: `key` finds its state, `path` is where a problem is reported. */
    const check = (field: FormField, value: unknown, key: string, path: (string | number)[]) => {
      const schema = valueSchemas.get(field.name);
      const state = states.get(key);
      if (!schema || !state?.visible) return;
      const add = (message: string) => issues.addIssue({ code: 'custom', path, message });

      const ruleError = errors.get(key);
      if (isMissing(field, value)) {
        // A rule can fault an empty field too ("give a phone number or an email").
        const message = state.required ? requiredMessage(field) : ruleError;
        if (message) add(message);
        return;
      }
      const result = schema.safeParse(value);
      // One message per field is what the UI shows; the first is the most relevant.
      if (!result.success) return add(result.error.issues[0].message);

      const allowed = options.get(key);
      if (allowed && ![value].flat().every((v) => allowed.has(String(v)))) return add('Select a valid option');
      if (ruleError) add(ruleError);
    };

    for (const field of shape.top) {
      if (!isRepeat(field)) {
        check(field, values[field.name], field.name, [field.name]);
        continue;
      }
      const state = states.get(field.name);
      if (!state?.visible) continue;
      const rows = rowsOf(values[field.name]);
      const problem = rowCountProblem(field, rows.length, state.required) ?? errors.get(field.name);
      if (problem) issues.addIssue({ code: 'custom', path: [field.name], message: problem });
      const children = shape.repeats.find((r) => r.field === field)?.valueChildren ?? [];
      rows.forEach((row, i) => {
        for (const child of children) check(child, row[child.name], rowKey(field.name, i, child.name), [field.name, i, child.name]);
      });
    }
  });
}
