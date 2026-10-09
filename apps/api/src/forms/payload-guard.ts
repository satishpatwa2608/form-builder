/* Ported from Sangam form-platform security/payload-guard.ts (unchanged rules). */
import { answerFields, formShape, isRepeat, isSignature, MAX_CUSTOM_LENGTH, MAX_ROWS, type FormDefinition, type FormField } from '@fb/engine';
import { LIMITS } from './limits';

/**
 * Checks that run BEFORE the engine's validation, on anything the public can
 * send. The engine validates meaning (required, lengths, options, rules);
 * this layer makes sure the input has the right *shape* first, so nothing
 * that could be an operator, a prototype key or markup ever gets further.
 */

export interface GuardIssue {
  field: string;
  message: string;
}

/** Keys that could be MongoDB operators, dotted paths, or prototype pollution. */
const FORBIDDEN_KEY = /^\$|\.|^(__proto__|constructor|prototype)$/;

/** Tag-like markup: `<script`, `</div`, `<!--`, `<?xml`. Plain `<` in text (e.g. "a < b") is fine. */
const MARKUP = /<\s*[a-zA-Z!/?]/;

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

export const containsMarkup = (s: string) => MARKUP.test(s);

/** Field types whose values are free text a person typed. */
const TEXT_TYPES = new Set(['TEXT', 'TEXTAREA', 'EMAIL', 'PHONE']);
const STRING_TYPES = new Set(['TEXT', 'TEXTAREA', 'EMAIL', 'PHONE', 'DATE', 'DATETIME', 'TIME', 'MONTH', 'URL', 'COLOR', 'DROPDOWN', 'RADIO', 'CAPTCHA']);

function checkValue(field: FormField, value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const tooLong = (s: string) => s.length > LIMITS.textLength;

  if (STRING_TYPES.has(field.type)) {
    if (typeof value !== 'string') return 'Must be text';
    if (tooLong(value)) return 'Is too long';
    if (TEXT_TYPES.has(field.type) && field.props?.allowMarkup !== true && containsMarkup(value)) {
      return 'HTML tags are not allowed';
    }
    return null;
  }
  switch (field.type) {
    case 'NUMBER':
    case 'SLIDER':
    case 'STEPPER':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'Must be a number';
    case 'CHECKBOX':
    case 'SWITCH':
    case 'CONSENT':
      return typeof value === 'boolean' ? null : 'Must be true or false';
    case 'CUSTOM':
      return typeof value === 'string' && value.length <= MAX_CUSTOM_LENGTH ? null : 'Must be text';
    case 'SIGNATURE':
      // A PNG data URL and nothing else: it is later shown as an image.
      return isSignature(value) ? null : 'Must be a signature';
    case 'MULTI_SELECT':
    case 'CHECKBOX_GROUP':
      if (!Array.isArray(value) || value.length > LIMITS.arrayItems) return 'Must be a list of options';
      return value.every((v) => typeof v === 'string' && !tooLong(v)) ? null : 'Must be a list of options';
    case 'FILE':
      if (!Array.isArray(value) || value.length > LIMITS.arrayItems) return 'Must be a list of uploaded files';
      return value.every(
        (v) => isPlainObject(v) && Object.keys(v).length === 1 && typeof v.uploadId === 'string' && v.uploadId.length <= 64,
      )
        ? null
        : 'Must be a list of uploaded files';
    case 'HIDDEN':
      // Replaced by server-derived values anyway; only primitives are accepted.
      return ['string', 'number', 'boolean'].includes(typeof value) && !(typeof value === 'string' && tooLong(value))
        ? null
        : 'Invalid value';
    default:
      return 'Not accepted';
  }
}

/**
 * The submitted `values` object: plain, bounded, only the form's own value
 * fields as keys, and every value of the type its field expects.
 */
export function checkSubmissionShape(def: FormDefinition, values: unknown): GuardIssue[] {
  if (!isPlainObject(values)) return [{ field: '', message: 'Values must be an object' }];
  if (JSON.stringify(values).length > LIMITS.valuesBytes) return [{ field: '', message: 'Submission is too large' }];

  // Top-level answers only: a field inside a repeating section is sent in that section's rows.
  const fields = new Map(answerFields(def.fields).map((f) => [f.name, f]));
  const issues: GuardIssue[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (FORBIDDEN_KEY.test(key)) {
      issues.push({ field: key, message: 'Invalid field name' });
      continue;
    }
    const field = fields.get(key);
    if (!field) {
      issues.push({ field: key, message: 'Unknown field' });
      continue;
    }
    if (isRepeat(field)) {
      issues.push(...checkRows(def, field, value));
      continue;
    }
    const problem = checkValue(field, value);
    if (problem) issues.push({ field: key, message: problem });
  }
  return issues;
}

/** A repeating section's value: a bounded list of plain rows, each holding only that section's own fields. */
function checkRows(def: FormDefinition, repeat: FormField, value: unknown): GuardIssue[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [{ field: repeat.name, message: 'Must be a list of rows' }];
  if (value.length > MAX_ROWS) return [{ field: repeat.name, message: `No more than ${MAX_ROWS} rows` }];
  const children = new Map((formShape(def.fields).repeats.find((r) => r.field.id === repeat.id)?.valueChildren ?? []).map((f) => [f.name, f]));
  const issues: GuardIssue[] = [];
  value.forEach((row, i) => {
    if (!isPlainObject(row)) {
      issues.push({ field: `${repeat.name}.${i}`, message: 'Must be a row of answers' });
      return;
    }
    for (const [key, cell] of Object.entries(row)) {
      const at = `${repeat.name}.${i}.${key}`;
      const child = FORBIDDEN_KEY.test(key) ? undefined : children.get(key);
      if (!child) issues.push({ field: FORBIDDEN_KEY.test(key) ? `${repeat.name}.${i}` : at, message: FORBIDDEN_KEY.test(key) ? 'Invalid field name' : 'Unknown field' });
      else {
        const problem = checkValue(child, cell);
        if (problem) issues.push({ field: at, message: problem });
      }
    }
  });
  return issues;
}

/**
 * Regex patterns come from form designers and run on the server, so reject
 * the shapes that backtrack catastrophically (ReDoS): a quantified group that
 * itself contains a quantifier - `(a+)+`, `(\w*)*`, `(a|ab)*`... - and
 * backreferences. Also cap the length and make sure it compiles.
 */
export function isSafePattern(pattern: string): boolean {
  if (pattern.length > LIMITS.patternLength) return false;
  if (/\\[1-9]/.test(pattern)) return false;
  // A group containing +, * or {n,} followed by a quantifier.
  if (/\([^)]*([+*]|\{\d+,\d*\})[^)]*\)\s*([+*]|\{\d+,?\d*\})/.test(pattern)) return false;
  // Alternation inside a quantified group, e.g. (a|aa)+
  if (/\([^)]*\|[^)]*\)\s*([+*]|\{\d+,?\d*\})/.test(pattern)) return false;
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/** Keys anywhere in a JSON value that MongoDB would treat as operators. */
function hasOperatorKey(value: unknown, depth = 0): boolean {
  if (depth > 40) return true;
  if (Array.isArray(value)) return value.some((v) => hasOperatorKey(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
      ([k, v]) => k.startsWith('$') || /^(__proto__|constructor|prototype)$/.test(k) || hasOperatorKey(v, depth + 1),
    );
  }
  return false;
}

/** Server-only checks on a definition, on top of the engine's own validation. */
export function checkDefinitionSecurity(def: FormDefinition): GuardIssue[] {
  const issues: GuardIssue[] = [];
  if (JSON.stringify(def).length > LIMITS.definitionBytes) issues.push({ field: '', message: 'Form is too large' });
  if (def.fields.length > LIMITS.maxFields) issues.push({ field: '', message: `A form can have at most ${LIMITS.maxFields} fields` });
  if (hasOperatorKey(def)) issues.push({ field: '', message: 'Form contains invalid keys' });
  for (const f of def.fields) {
    const pattern = f.validation?.pattern;
    if (pattern !== undefined && !isSafePattern(pattern)) {
      issues.push({ field: f.name, message: 'Validation pattern is too complex or unsafe - simplify it' });
    }
  }
  return issues;
}

