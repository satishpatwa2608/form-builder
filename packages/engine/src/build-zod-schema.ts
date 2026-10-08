import { z } from 'zod';
import type { FormDefinition, FormField, FormValues, SystemContext } from './types';
import { fieldLabel, isBooleanField, isEmptyValue, isSignature, isValueField } from './field-kinds';
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

/**
 * FormDefinition -> Zod schema for React Hook Form.
 *
 * Visibility and conditional-required depend on live values, so they can't be
 * baked into a static object shape. Instead the schema is one pass over the
 * values that works out each field's state, skips hidden fields, applies
 * required, and runs the field's own value schema on anything filled in.
 * Calculated fields are checked on the value the rules compute, and a rule's
 * own error shows when nothing more basic is wrong with the field.
 * Build it once per definition version, not per render.
 */
export function buildZodSchema(def: Pick<FormDefinition, 'fields' | 'rules'>, ctx?: SystemContext) {
  const valueSchemas = new Map<string, z.ZodType>();
  for (const field of def.fields) {
    const schema = isValueField(field) ? buildFieldValueSchema(field) : null;
    if (schema) valueSchemas.set(field.name, schema);
  }

  return z.looseObject({}).superRefine((input: FormValues, issues) => {
    const { states, values, errors, options } = computeFormState(def, input, ctx);
    for (const field of def.fields) {
      const schema = valueSchemas.get(field.name);
      const state = states.get(field.name);
      if (!schema || !state?.visible) continue;

      const value = values[field.name];
      const ruleError = errors.get(field.name);
      if (isMissing(field, value)) {
        // A rule can fault an empty field too ("give a phone number or an email").
        const message = state.required ? requiredMessage(field) : ruleError;
        if (message) issues.addIssue({ code: 'custom', path: [field.name], message });
        continue;
      }

      const result = schema.safeParse(value);
      if (!result.success) {
        // One message per field is what the UI shows; the first is the most relevant.
        const issue = result.error.issues[0];
        issues.addIssue({ code: 'custom', path: [field.name], message: issue.message });
        continue;
      }

      const allowed = options.get(field.name);
      if (allowed && ![value].flat().every((v) => allowed.has(String(v)))) {
        issues.addIssue({ code: 'custom', path: [field.name], message: 'Select a valid option' });
        continue;
      }
      if (ruleError) issues.addIssue({ code: 'custom', path: [field.name], message: ruleError });
    }
  });
}
