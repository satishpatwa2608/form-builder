/**
 * CSV / Excel formula injection: a cell starting with = + - @ (or tab / CR)
 * is executed by spreadsheet apps. Prefix it so it stays text. Used by every
 * export of submitted data (browser CSV and any server export).
 */
export function neutralizeSpreadsheetCell(value: unknown): unknown {
  return typeof value === 'string' && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** One CSV cell: neutralised, then quoted. */
export function csvCell(value: unknown): string {
  const v = neutralizeSpreadsheetCell(value);
  const text = v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return `"${text.replace(/"/g, '""')}"`;
}
