import type { FormField, SelectOption } from './types';

/**
 * Starting points for a new form: the fields a JSON Schema describes, or the
 * columns of a spreadsheet. Both return ordinary fields for the builder to
 * open as a draft, plus notes about anything that could not be carried over.
 * Nothing here is trusted input: sizes are bounded and every name is rebuilt.
 */

export interface ImportedFields {
  fields: FormField[];
  /** What was left out or changed on the way, for the person to read. */
  notes: string[];
}

export const MAX_IMPORTED_FIELDS = 200;
const MAX_OPTIONS = 100;
const MAX_DEPTH = 4;

class Names {
  private readonly taken = new Set<string>();
  private count = 0;

  /** A unique field key from any text: `Order No.` -> `orderNo`, then `orderNo2`. */
  key(text: string): string {
    const words = text
      .normalize('NFKD')
      // Accents come apart from their letters above; drop them so "São" reads "Sao", not "Sa o".
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean);
    let base = words.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join('');
    if (!base || /^[0-9]/.test(base)) base = `field${base}`;
    base = base.slice(0, 40);
    let name = base;
    for (let n = 2; this.taken.has(name); n++) name = `${base}${n}`;
    this.taken.add(name);
    return name;
  }

  id(): string {
    return `imp_${++this.count}`;
  }
}

/** `orderNo` / `order_no` -> `Order no`. */
function labelFrom(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : 'Field';
}

const optionsFrom = (values: unknown[]): SelectOption[] =>
  [...new Set(values.filter((v) => ['string', 'number', 'boolean'].includes(typeof v)).map(String))]
    .filter((v) => v !== '')
    .slice(0, MAX_OPTIONS)
    .map((v) => ({ label: v, value: v }));

// ------------------------------------------------------------- JSON Schema ---

type Schema = Record<string, unknown>;
const isObject = (v: unknown): v is Schema => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
/** `"type": ["string", "null"]` means an optional string. */
const typeOf = (s: Schema): string | undefined => (Array.isArray(s.type) ? (s.type as unknown[]).find((t) => t !== 'null') : s.type) as string | undefined;

/**
 * Fields for the properties of a JSON Schema object. Handles the common
 * subset: strings (with formats, lengths, patterns, enums), numbers, booleans,
 * lists of choices, nested objects (a section) and lists of objects (a
 * repeating section). `$ref`, `oneOf` and the like are noted and skipped.
 */
export function fieldsFromJsonSchema(input: unknown): ImportedFields {
  const names = new Names();
  const fields: FormField[] = [];
  const notes: string[] = [];
  const full = () => fields.length >= MAX_IMPORTED_FIELDS;

  const add = (field: FormField) => {
    fields.push(field);
    return field;
  };

  function property(key: string, schema: unknown, required: boolean, parentId: string | undefined, depth: number, inRepeat: boolean) {
    if (full()) return;
    const title = labelFrom(key);
    if (!isObject(schema)) return void notes.push(`"${key}" has no description of what it holds and was skipped.`);
    if ('$ref' in schema || 'oneOf' in schema || 'anyOf' in schema || 'allOf' in schema) {
      return void notes.push(`"${key}" uses a reference or a choice of shapes, which cannot be turned into a field. Add it by hand.`);
    }
    const base = {
      id: names.id(),
      name: names.key(key),
      label: text(schema.title) ?? title,
      ...(text(schema.description) ? { helpText: text(schema.description) } : {}),
      ...(required ? { required: true } : {}),
      ...(parentId ? { parentId, column: 0 } : {}),
    };
    const type = typeOf(schema);
    const choices = Array.isArray(schema.enum) ? optionsFrom(schema.enum) : [];

    if (choices.length) {
      return void add({ ...base, type: choices.length <= 4 ? 'RADIO' : 'DROPDOWN', dataSource: { type: 'STATIC', options: choices } });
    }
    switch (type) {
      case 'string': {
        const format = schema.format;
        const maxLength = num(schema.maxLength);
        const validation = {
          ...(num(schema.minLength) !== undefined ? { minLength: num(schema.minLength) } : {}),
          ...(maxLength !== undefined && maxLength > 0 ? { maxLength } : {}),
          ...(text(schema.pattern) && format === undefined ? { pattern: text(schema.pattern) } : {}),
        };
        const kind =
          format === 'email' ? 'EMAIL' : format === 'date' ? 'DATE' : format === 'date-time' ? 'DATETIME' : maxLength !== undefined && maxLength > 200 ? 'TEXTAREA' : 'TEXT';
        const dated = kind === 'DATE' || kind === 'DATETIME';
        return void add({ ...base, type: kind, ...(!dated && Object.keys(validation).length ? { validation } : {}) });
      }
      case 'number':
      case 'integer': {
        const validation = {
          ...(num(schema.minimum) !== undefined ? { min: num(schema.minimum) } : {}),
          ...(num(schema.maximum) !== undefined ? { max: num(schema.maximum) } : {}),
        };
        return void add({ ...base, type: 'NUMBER', ...(Object.keys(validation).length ? { validation } : {}) });
      }
      case 'boolean':
        return void add({ ...base, type: 'CHECKBOX' });
      case 'array': {
        const items = isObject(schema.items) ? schema.items : undefined;
        const itemChoices = items && Array.isArray(items.enum) ? optionsFrom(items.enum) : [];
        if (itemChoices.length) {
          const validation = {
            ...(num(schema.minItems) !== undefined ? { min: num(schema.minItems) } : {}),
            ...(num(schema.maxItems) !== undefined ? { max: num(schema.maxItems) } : {}),
          };
          return void add({ ...base, type: 'MULTI_SELECT', dataSource: { type: 'STATIC', options: itemChoices }, ...(Object.keys(validation).length ? { validation } : {}) });
        }
        if (items && typeOf(items) === 'object' && isObject(items.properties)) {
          if (inRepeat) return void notes.push(`"${key}" is a list inside a list, which a form cannot repeat. Add it by hand.`);
          const { required: _req, ...rest } = base;
          const repeat = add({
            ...rest,
            type: 'REPEAT',
            validation: { min: num(schema.minItems) ?? (required ? 1 : 0), ...(num(schema.maxItems) !== undefined ? { max: Math.min(num(schema.maxItems)!, 200) } : {}) },
            props: { addLabel: 'Add another', layout: 'cards' },
          });
          return void properties(items, repeat.id, depth + 1, true);
        }
        return void notes.push(`"${key}" is a list of free values, which has no field of its own. Add a repeating section for it by hand.`);
      }
      case 'object': {
        if (!isObject(schema.properties)) return void notes.push(`"${key}" is an object with no listed properties and was skipped.`);
        if (inRepeat || depth >= MAX_DEPTH) {
          notes.push(`The fields of "${key}" were added without their own section.`);
          return void properties(schema, parentId, depth + 1, inRepeat);
        }
        const { required: _req, helpText, ...rest } = base;
        const section = add({ ...rest, type: 'SECTION', props: { description: helpText ?? '', collapsible: false } });
        return void properties(schema, section.id, depth + 1, inRepeat);
      }
      default:
        notes.push(`"${key}" has ${type ? `the type "${String(type)}"` : 'no type'}, which has no matching field. It was added as text.`);
        return void add({ ...base, type: 'TEXT' });
    }
  }

  function properties(schema: Schema, parentId: string | undefined, depth: number, inRepeat: boolean) {
    const required = new Set(Array.isArray(schema.required) ? (schema.required as unknown[]).filter((r): r is string => typeof r === 'string') : []);
    for (const [key, value] of Object.entries(isObject(schema.properties) ? schema.properties : {})) {
      if (full()) {
        notes.push(`Only the first ${MAX_IMPORTED_FIELDS} fields were added.`);
        return;
      }
      property(key, value, required.has(key), parentId, depth, inRepeat);
    }
  }

  if (!isObject(input) || !isObject(input.properties)) {
    return { fields: [], notes: ['This is not a JSON Schema of an object with properties, so there is nothing to make fields from.'] };
  }
  properties(input, undefined, 0, false);
  return { fields, notes: [...new Set(notes)] };
}

// ------------------------------------------------------------- spreadsheet ---

/** Rows of a CSV file. Handles quoted cells, doubled quotes, and commas or line breaks inside quotes. */
export function parseCsv(input: string, maxRows = 2000): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const text = input.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      if (rows.length >= maxRows) return rows;
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const YES_NO = new Set(['yes', 'no', 'true', 'false', 'y', 'n']);

/**
 * One field per column of a spreadsheet saved as CSV. The first row is the
 * column names; the rows under it are examples, used to guess each field's
 * type: numbers, dates, emails, yes/no, or a short list of repeated values
 * (a dropdown). With no example rows every column is a text field.
 */
export function fieldsFromCsv(csv: string): ImportedFields {
  const rows = parseCsv(csv);
  if (!rows.length) return { fields: [], notes: ['The file is empty.'] };
  const names = new Names();
  const notes: string[] = [];
  const [header, ...examples] = rows;
  const columns = header.map((h) => h.trim()).slice(0, MAX_IMPORTED_FIELDS);
  if (header.length > MAX_IMPORTED_FIELDS) notes.push(`Only the first ${MAX_IMPORTED_FIELDS} columns were added.`);

  const fields: FormField[] = [];
  columns.forEach((column, index) => {
    if (!column) return void notes.push(`Column ${index + 1} has no name and was skipped.`);
    const values = examples.map((r) => (r[index] ?? '').trim()).filter((v) => v !== '');
    const base = { id: names.id(), name: names.key(column), label: column.slice(0, 120) };
    const all = (test: (v: string) => boolean) => values.length > 0 && values.every(test);
    const distinct = [...new Set(values)];

    if (all((v) => YES_NO.has(v.toLowerCase()))) fields.push({ ...base, type: 'CHECKBOX' });
    else if (all((v) => v !== '' && Number.isFinite(Number(v)))) fields.push({ ...base, type: 'NUMBER' });
    else if (all((v) => DATE.test(v) && !Number.isNaN(Date.parse(v)))) fields.push({ ...base, type: 'DATE' });
    else if (all((v) => EMAIL.test(v))) fields.push({ ...base, type: 'EMAIL' });
    // A handful of values that keep coming back read as a choice, not as free text.
    else if (values.length >= 4 && distinct.length <= 8 && distinct.length <= values.length / 2) {
      fields.push({ ...base, type: 'DROPDOWN', dataSource: { type: 'STATIC', options: optionsFrom(distinct) } });
    } else if (values.some((v) => v.length > 120 || v.includes('\n'))) fields.push({ ...base, type: 'TEXTAREA' });
    else fields.push({ ...base, type: 'TEXT' });
  });
  if (!examples.length && fields.length) notes.push('There were no example rows, so every column became a text field. Change their types in the builder.');
  return { fields, notes };
}
