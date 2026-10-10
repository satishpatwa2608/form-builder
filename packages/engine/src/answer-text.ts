import type { FormField } from './types';
import { isSignature } from './field-kinds';

const isRow = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * An answer as plain text, for tables, emails, exports and the timeline.
 * Empty answers come out as ''. A signature is never dumped as image data.
 */
export function plainAnswer(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (isSignature(value)) return 'Signed';
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (!isRow(item)) return plainAnswer(item);
        // An uploaded file is known by its name; a repeated row by its answers.
        if (typeof item.name === 'string' && ('uploadId' in item || 'size' in item)) return item.name;
        return Object.entries(item)
          .map(([key, v]) => [key, plainAnswer(v)] as const)
          .filter(([, text]) => text !== '')
          .map(([key, text]) => `${key}: ${text}`)
          .join('; ');
      })
      .filter((text) => text !== '')
      .join(value.some(isRow) && !value.every((v) => isRow(v) && typeof v.name === 'string') ? ' | ' : ', ');
  }
  if (isRow(value)) return JSON.stringify(value).slice(0, 500);
  return String(value);
}

/** The same, with option values shown as the labels people chose from. */
export function answerText(field: Pick<FormField, 'dataSource'> | undefined, value: unknown): string {
  const options = field?.dataSource?.type === 'STATIC' ? field.dataSource.options ?? [] : [];
  if (!options.length) return plainAnswer(value);
  const label = (v: unknown) => options.find((o) => o.value === v)?.label ?? v;
  return plainAnswer(Array.isArray(value) ? value.map(label) : label(value));
}

/**
 * A repeating section's rows as numbered lines under the labels people saw:
 * `1. Item: Pen; Qty: 3`. Empty answers are left out; '' when there are no rows.
 */
export function rowsText(children: Pick<FormField, 'name' | 'label' | 'dataSource'>[], value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((row, i) => {
      const cells = children
        .map((c) => [c.label || c.name, answerText(c, isRow(row) ? row[c.name] : undefined)] as const)
        .filter(([, text]) => text !== '')
        .map(([label, text]) => `${label}: ${text}`);
      return `${i + 1}. ${cells.join('; ')}`;
    })
    .join('\n');
}

/** How a text answer's letters are kept, whatever way they were typed. */
export type Letters = 'upper' | 'lower' | 'title';

/**
 * A text answer with its letters as the question asks for them: CAPITALS (a PAN, a vehicle number), small
 * letters, or The First Letter Of Each Word (a name). Anything that is not text, and a question that asks for
 * nothing, is left exactly as it is.
 */
export function withLetters(field: { type: string; props?: Record<string, unknown> }, value: unknown): unknown {
  const how = field.props?.letters;
  if (field.type !== 'TEXT' || typeof value !== 'string' || !value) return value;
  const cased =
    how === 'upper'
      ? value.toLocaleUpperCase()
      : how === 'lower'
        ? value.toLocaleLowerCase()
        : how === 'title'
          ? value.toLocaleLowerCase().replace(/(^|[\s\-'’.])(\p{L})/gu, (_, gap: string, letter: string) => gap + letter.toLocaleUpperCase())
          : value;
  return withSpacing(field.props?.spacing, cased);
}

/** The spacings offered by name; any other is a shape of the designer's own. */
export const SPACINGS: Record<string, string> = {
  fours: '#### #### #### #### ####',
  threes: '### ### ### ### ### ###',
  phone: '##### #####',
};

/**
 * A text answer set out in a shape, however it was typed: `#` stands for each letter or digit the person gave, and
 * anything else in the shape (a space, a dash, a stroke) is put between them. "1234 5678 9012" for an ID typed
 * without spaces, "AB-1234" for a code. What does not fit the shape is kept, after it. A shape with no `#`, or an
 * answer with nothing in it to place, changes nothing.
 */
export function withSpacing(spacing: unknown, value: string): string {
  const shape = typeof spacing === 'string' ? (SPACINGS[spacing] ?? spacing) : '';
  if (!shape.includes('#') || shape.length > 60) return value;
  const given = [...value].filter((ch) => /[\p{L}\p{N}]/u.test(ch));
  if (!given.length) return value;
  let out = '';
  let used = 0;
  for (const slot of shape) {
    if (used >= given.length) break;
    out += slot === '#' ? given[used++] : slot;
  }
  // The shape ran out first: the rest follows as it is.
  return (out + given.slice(used).join('')).trim();
}
