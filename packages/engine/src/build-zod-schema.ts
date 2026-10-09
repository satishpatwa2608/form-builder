import { z } from 'zod';
import type { FormDefinition, FormField, FormValues, SystemContext } from './types';
import { fieldLabel, isBooleanField, isEmptyValue, isRepeat, isSignature, isValueField, MAX_CUSTOM_LENGTH } from './field-kinds';
import { formShape, MAX_ROWS, rowKey, rowsOf } from './repeat';
import { computeFormState } from './form-state';
import { uiText, type Say } from './i18n';

/** Used when a PHONE field has no pattern of its own. */
export const DEFAULT_PHONE_PATTERN = '^\\+?[0-9][0-9\\s-]{6,14}$';

const isValidDate = (v: string) => !Number.isNaN(Date.parse(v));
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
/** A web address a person could open: http or https, a host with a dot, nothing that is not printable. */
export const isWebAddress = (v: string) => /^https?:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}(:\d{1,5})?([/?#][^\s<>"'`\\]*)?$/i.test(v);

function stringSchema(field: FormField, say: Say, defaultPattern?: string): z.ZodType {
  const v = field.validation ?? {};
  const m = v.messages ?? {};
  let s = z.string();
  if (v.minLength !== undefined) {
    s = s.min(v.minLength, m.minLength ?? say('minLength', { n: v.minLength }));
  }
  if (v.maxLength !== undefined) {
    s = s.max(v.maxLength, m.maxLength ?? say('maxLength', { n: v.maxLength }));
  }
  const pattern = v.pattern ?? defaultPattern;
  if (pattern) {
    s = s.regex(new RegExp(pattern), m.pattern ?? say('format', { label: fieldLabel(field) }));
  }
  return s;
}

function optionValueSchema(field: FormField, say: Say): z.ZodType {
  const options = field.dataSource?.type === 'STATIC' ? field.dataSource.options ?? [] : undefined;
  const base = z.string();
  if (!options) return base;
  const allowed = new Set(options.map((o) => o.value));
  return base.refine((v) => allowed.has(v), say('option'));
}

/**
 * Schema for a field's value once it is known to be non-empty. Emptiness and
 * required-ness are decided separately (they depend on other fields' values),
 * so nothing here needs to be optional. Returns null for fields that are
 * never validated.
 */
export function buildFieldValueSchema(field: FormField, say: Say = uiText('en')): z.ZodType | null {
  const v = field.validation ?? {};
  const m = v.messages ?? {};
  switch (field.type) {
    case 'TEXT':
    case 'TEXTAREA':
      return stringSchema(field, say);
    case 'PHONE':
      return stringSchema(field, say, DEFAULT_PHONE_PATTERN);
    case 'EMAIL': {
      let s = z.email(m.pattern ?? say('email'));
      if (v.maxLength !== undefined) {
        s = s.max(v.maxLength, m.maxLength ?? say('maxLength', { n: v.maxLength }));
      }
      return s;
    }
    case 'NUMBER':
    case 'SLIDER':
    case 'STEPPER': {
      let s = z.number(say('number'));
      if (v.min !== undefined) s = s.min(v.min, m.min ?? say('min', { n: v.min }));
      if (v.max !== undefined) s = s.max(v.max, m.max ?? say('max', { n: v.max }));
      return s;
    }
    case 'SIGNATURE':
      return z.string().refine(isSignature, say('signAgain'));
    case 'CUSTOM':
      // What it means is the organisation's own business (a check in its extension can judge it); here it is text of a sane size.
      return z.string().max(MAX_CUSTOM_LENGTH, say('tooLong'));
    case 'DATE':
    case 'DATETIME':
      return z.string().refine(isValidDate, say('date'));
    case 'TIME':
      return z.string().regex(TIME, m.pattern ?? say('time'));
    case 'MONTH':
      return z.string().regex(MONTH, m.pattern ?? say('month'));
    case 'COLOR':
      return z.string().regex(COLOR, m.pattern ?? say('colour'));
    case 'URL':
      // http and https only: an address is shown as a link, and a link may not run anything.
      return z.string().max(v.maxLength ?? 2000, say('tooLong')).refine(isWebAddress, m.pattern ?? say('url'));
    case 'CHECKBOX':
    case 'SWITCH':
    case 'CONSENT':
      return z.boolean();
    case 'RADIO':
    case 'DROPDOWN':
      return optionValueSchema(field, say);
    case 'MULTI_SELECT':
    case 'CHECKBOX_GROUP': {
      let s = z.array(optionValueSchema(field, say));
      if (v.min !== undefined) s = s.min(v.min, m.min ?? say('selectMin', { n: v.min }));
      if (v.max !== undefined) s = s.max(v.max, m.max ?? say('selectMax', { n: v.max }));
      return s;
    }
    case 'FILE': {
      let s = z.array(z.any());
      if (v.max !== undefined) s = s.max(v.max, m.max ?? say('filesMax', { n: v.max }));
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

const requiredMessage = (field: FormField, say: Say) =>
  field.validation?.messages?.required ??
  (field.type === 'CAPTCHA'
    ? say('captcha')
    : field.type === 'CONSENT'
      ? say('consent')
      : field.type === 'SIGNATURE'
        ? say('sign')
        : say('required', { label: fieldLabel(field) }));

/** How many rows a repeating section must and may have. */
function rowCountProblem(field: FormField, count: number, required: boolean, say: Say): string | null {
  const { min, max, messages } = field.validation ?? {};
  const atLeast = Math.max(min ?? 0, required ? 1 : 0);
  if (count < atLeast) {
    if (count === 0 && required) return messages?.required ?? say('rowsRequired', { label: fieldLabel(field) });
    return messages?.min ?? say('rowsMin', { n: atLeast });
  }
  const atMost = Math.min(max ?? MAX_ROWS, MAX_ROWS);
  return count > atMost ? messages?.max ?? say('rowsMax', { n: atMost }) : null;
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
export function buildZodSchema(def: Pick<FormDefinition, 'fields' | 'rules'> & Partial<Pick<FormDefinition, 'translations'>>, ctx?: SystemContext) {
  // Messages are worded in the language the form is being filled in. Give the form already localised, so labels match.
  const say = uiText(ctx?.language, def);
  const shape = formShape(def.fields);
  const valueSchemas = new Map<string, z.ZodType>();
  for (const field of def.fields) {
    const schema = isValueField(field) ? buildFieldValueSchema(field, say) : null;
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
        const message = state.required ? requiredMessage(field, say) : ruleError;
        if (message) add(message);
        return;
      }
      const result = schema.safeParse(value);
      // One message per field is what the UI shows; the first is the most relevant.
      if (!result.success) return add(result.error.issues[0].message);

      const allowed = options.get(key);
      if (allowed && ![value].flat().every((v) => allowed.has(String(v)))) return add(say('option'));
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
      const problem = rowCountProblem(field, rows.length, state.required, say) ?? errors.get(field.name);
      if (problem) issues.addIssue({ code: 'custom', path: [field.name], message: problem });
      const children = shape.repeats.find((r) => r.field === field)?.valueChildren ?? [];
      rows.forEach((row, i) => {
        for (const child of children) check(child, row[child.name], rowKey(field.name, i, child.name), [field.name, i, child.name]);
      });
    }
  });
}
