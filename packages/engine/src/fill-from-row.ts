import { coerceToField } from './form-state';
import { formShape, MAX_ROWS } from './repeat';
import type { FetchRows, FormField, FormValues } from './types';

/** `a.b.c` in a fetched row, reading only what the row itself holds. */
export function readOwnPath(row: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((at, key) => (at && typeof at === 'object' && Object.prototype.hasOwnProperty.call(at, key) ? (at as Record<string, unknown>)[key] : undefined), row);
}

/**
 * The rows a look-up gives a repeating section: one for each row that came back, or for each of the related rows
 * the first row brings along (`rows.from`), within the section's own limit. Undefined when there is no such
 * section to fill.
 */
export function sectionRows(fields: FormField[], found: Record<string, unknown>[], rows: FetchRows | undefined): { name: string; rows: FormValues[] } | undefined {
  const section = rows && fields.find((f) => f.name === rows.into && f.type === 'REPEAT');
  if (!rows || !section || !found.length) return undefined;
  const children = formShape(fields).repeats.find((r) => r.field.id === section.id)?.valueChildren ?? [];
  const most = Math.min(section.validation?.max ?? MAX_ROWS, MAX_ROWS);
  const held = rows.from ? readOwnPath(found[0], rows.from) : found;
  const list = Array.isArray(held) ? held.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r)) : [];
  return {
    name: section.name,
    rows: list.slice(0, most).map((r) =>
      Object.fromEntries(
        Object.entries(rows.set).flatMap(([name, path]) => {
          const child = children.find((c) => c.name === name);
          return child ? [[name, coerceToField(readOwnPath(r, path), child)]] : [];
        }),
      ),
    ),
  };
}

/** The answers one row gives the form's own (top-level) questions: `{ question: 'row.property' }`, each in the shape its question stores. */
export function rowValues(fields: FormField[], row: Record<string, unknown>, set: Record<string, string>): FormValues {
  const out: FormValues = {};
  for (const [name, path] of Object.entries(set)) {
    const target = fields.find((f) => f.name === name && !f.parentId) ?? fields.find((f) => f.name === name);
    if (!target || target.type === 'REPEAT') continue;
    const value = coerceToField(readOwnPath(row, path), target);
    if (value !== undefined) out[name] = value as FormValues[string];
  }
  return out;
}
