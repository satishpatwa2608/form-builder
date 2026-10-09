import type { FormField, FormValues } from './types';
import { isRepeat, isValueField } from './field-kinds';

/** The most rows a repeating section may hold, whatever the form says. */
export const MAX_ROWS = 200;

/** What may sit inside a repeating section. Uploads, signatures and other containers may not. */
export const ROW_FIELD_TYPES: ReadonlySet<FormField['type']> = new Set([
  'TEXT',
  'TEXTAREA',
  'NUMBER',
  'STEPPER',
  'EMAIL',
  'PHONE',
  'DATE',
  'DATETIME',
  'TIME',
  'MONTH',
  'URL',
  'COLOR',
  'SLIDER',
  'CHECKBOX',
  'SWITCH',
  'RADIO',
  'DROPDOWN',
  'MULTI_SELECT',
  'CHECKBOX_GROUP',
  'HTML',
  'IMAGE',
  'COLUMNS',
]);

export type Row = Record<string, unknown>;

export interface RepeatShape {
  field: FormField;
  /** Everything inside it, layout blocks included, in form order. */
  children: FormField[];
  /** The fields inside it that hold an answer. */
  valueChildren: FormField[];
}

export interface FormShape {
  byName: Map<string, FormField>;
  byId: Map<string, FormField>;
  /** Fields that are not inside a repeating section (the sections themselves included). */
  top: FormField[];
  repeats: RepeatShape[];
  /** Name of a field inside a repeating section -> that section. */
  repeatOf: Map<string, FormField>;
}

const shapes = new WeakMap<FormField[], FormShape>();

/** How a form's fields divide into top-level fields and the rows of repeating sections. */
export function formShape(fields: FormField[]): FormShape {
  const known = shapes.get(fields);
  if (known) return known;
  const byId = new Map(fields.map((f) => [f.id, f]));
  const byName = new Map(fields.map((f) => [f.name, f]));
  const repeatOf = new Map<string, FormField>();
  for (const f of fields) {
    const seen = new Set<string>([f.id]);
    for (let parent = f.parentId ? byId.get(f.parentId) : undefined; parent && !seen.has(parent.id); parent = parent.parentId ? byId.get(parent.parentId) : undefined) {
      if (isRepeat(parent)) {
        repeatOf.set(f.name, parent);
        break;
      }
      seen.add(parent.id);
    }
  }
  const repeats = fields.filter(isRepeat).map((field) => {
    const children = fields.filter((f) => repeatOf.get(f.name) === field);
    return { field, children, valueChildren: children.filter(isValueField) };
  });
  const shape = { byName, byId, top: fields.filter((f) => !repeatOf.has(f.name)), repeats, repeatOf };
  shapes.set(fields, shape);
  return shape;
}

/** The fields whose answers sit at the top of a submission: every value field outside a repeating section. */
export const answerFields = (fields: FormField[]): FormField[] => formShape(fields).top.filter(isValueField);

/** Whether a field sits inside a repeating section. */
export const isRowField = (fields: FormField[], field: Pick<FormField, 'name'>): boolean => formShape(fields).repeatOf.has(field.name);

/** How one row's answer is addressed in form state and in errors: `lines.0.qty`. */
export const rowKey = (repeat: string, index: number, child: string) => `${repeat}.${index}.${child}`;

const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A repeating section's value as a list of row objects, whatever was stored or sent. */
export function rowsOf(value: unknown): Row[] {
  return Array.isArray(value) ? value.slice(0, MAX_ROWS).map((row) => (isRow(row) ? row : {})) : [];
}

/** Reads `lines.0.qty` (or a plain name) out of form values. */
export function valueAt(values: FormValues, key: string): unknown {
  if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
  const [repeat, index, child, ...rest] = key.split('.');
  if (child === undefined || rest.length) return undefined;
  const row = rowsOf(values[repeat])[Number(index)];
  return row && Object.prototype.hasOwnProperty.call(row, child) ? row[child] : undefined;
}
