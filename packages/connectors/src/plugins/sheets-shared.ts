import { ConnectorError } from '../registry';
import type { EntityRef } from '../types';
import type { Primitive } from './shared';

/**
 * A column heading as a field name. Headings are written for people
 * ("First name", "E-mail"); field names are plain. The same rule is used
 * when the columns are found and when a row is written, so they always agree.
 */
export function columnName(heading: unknown): string {
  const name = String(heading ?? '')
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 62);
  return /^[0-9]/.test(name) ? `c_${name}`.slice(0, 62) : name;
}

/** The field names for a header row, in column order; a blank or repeated heading has no name and is never written to. */
export function columnNames(headings: unknown[]): string[] {
  const seen = new Set<string>();
  return headings.map((h) => {
    const name = columnName(h);
    if (!name || seen.has(name)) return '';
    seen.add(name);
    return name;
  });
}

/**
 * A cell that a spreadsheet cannot mistake for a formula. Text that starts
 * with = + - or @ is run as one when the file is opened, which lets a form
 * answer read other cells or call out; an apostrophe in front makes it text.
 */
export function safeCell(v: unknown): string | number | boolean {
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (v === null || v === undefined) return '';
  const text = Array.isArray(v) ? v.join(', ') : String(v);
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/** One row, in the sheet's own column order: each exposed column with its value, every other column empty. */
export function rowFor(columns: string[], entity: EntityRef, values: Record<string, unknown>): (string | number | boolean)[] {
  const row = columns.map((c) => (c && entity.fields.includes(c) && values[c] !== undefined ? safeCell(values[c]) : ''));
  if (!row.some((v) => v !== '')) throw new ConnectorError('UNSUPPORTED', 'Nothing to write: no values for the exposed columns');
  return row;
}

/** Rows of cells as records by column name, keeping only rows that match every filter exactly. */
export function rowsFrom(columns: string[], rows: unknown[][], filters: [string, Primitive][], max: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const cells of rows) {
    const record: Record<string, unknown> = {};
    columns.forEach((c, i) => {
      if (c) record[c] = cells[i] ?? '';
    });
    if (filters.every(([k, v]) => String(record[k] ?? '') === String(v ?? ''))) out.push(record);
    if (out.length >= max) break;
  }
  return out;
}
