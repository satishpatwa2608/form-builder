import type { EntityField } from '../types';

export type CheckDialect = 'postgres' | 'mysql' | 'mssql';
export type CheckLimits = Pick<EntityField, 'min' | 'max' | 'minLength' | 'maxLength' | 'pattern'>;

/** A column as the check reader needs to know it. */
export interface CheckColumn {
  name: string;
  /** Whole numbers only: "more than 0" then means "1 or more". */
  whole?: boolean;
}

const LENGTH_OF = /^(?:len|length|char_length|character_length)\(+(\w+)\)+$/;
const NUMBER = /^[-+]?\d+(?:\.\d+)?$/;

/**
 * Reads the limits out of one of a table's own rules (a CHECK constraint), as the database writes it back:
 * `((qty >= 1) AND (qty <= 100))`, `([code] like '[A-Z][A-Z]%')`, ``regexp_like(`code`,_utf8mb4\'^[A-Z]{3}$\')``.
 *
 * Only a rule about one column, made of plain comparisons joined by AND, is understood. Anything else (two columns
 * compared, OR, a function we do not know) gives nothing: the form then has no limit and the database still refuses
 * a wrong value when it is saved. A limit is never guessed.
 */
export function limitsFromCheck(clause: string, columns: CheckColumn[], dialect: CheckDialect): { column: string; limits: CheckLimits } | undefined {
  const { text, strings } = tidy(clause, dialect);
  if (/\bor\b|\bnot\b|\bis\b|\bin\b|\bcase\b|\bselect\b/.test(text)) return undefined;
  const mentioned = columns.filter((c) => new RegExp(`(?<![\\w.])${escape(c.name.toLowerCase())}(?![\\w.])`).test(text));
  if (mentioned.length !== 1) return undefined;
  const column = mentioned[0]!;
  const name = column.name.toLowerCase();
  const limits: CheckLimits = {};
  // "between a and b" is two comparisons; written out so the split on AND below is not confused by it.
  const parts = text.replace(/(\S+) between (\S+) and (\S+)/g, '$1 >= $2 and $1 <= $3').split(/\band\b/);
  for (const raw of parts) {
    const part = bare(raw);
    if (!part) continue;
    const said = /^(.+?)\s*(>=|<=|<>|!=|>|<|=|~|!~|like|regexp|rlike)\s*(.+)$/.exec(part);
    const asFunction = /^regexp_like\((\w+),(\S+?)(?:,\S+)?\)$/.exec(part.replace(/\s+/g, ''));
    if (asFunction) {
      if (asFunction[1] !== name) return undefined;
      const pattern = usable(strings[index(asFunction[2]!)] ?? '');
      if (!pattern) return undefined;
      limits.pattern = pattern;
      continue;
    }
    if (!said) return undefined;
    const left = bare(said[1]!).replace(/\s+/g, '');
    const op = said[2]!;
    const right = bare(said[3]!);
    const length = LENGTH_OF.exec(left);
    if (length || left === name) {
      if (length && length[1] !== name) return undefined;
      if (op === '~' || op === 'regexp' || op === 'rlike' || op === 'like') {
        if (length) return undefined;
        const written = strings[index(right)];
        if (written === undefined) return undefined;
        const pattern = usable(op === 'like' ? fromLike(written, dialect) : written);
        if (!pattern) return undefined;
        limits.pattern = pattern;
        continue;
      }
      if (!NUMBER.test(right) || !/^(>=|<=|>|<)$/.test(op)) return undefined;
      const n = Number(right);
      // "More than" and "less than" have no word in a form's limits, which include the ends. For whole numbers (and
      // for a length, which is one) the next number says the same thing; otherwise the end itself is the nearest limit.
      const whole = Boolean(length) || column.whole === true;
      const lowest = op === '>=' ? n : op === '>' ? (whole ? Math.floor(n) + 1 : n) : undefined;
      const highest = op === '<=' ? n : op === '<' ? (whole ? Math.ceil(n) - 1 : n) : undefined;
      if (length) {
        if (lowest !== undefined && lowest > 0) limits.minLength = Math.max(limits.minLength ?? 0, lowest);
        if (highest !== undefined && highest > 0) limits.maxLength = Math.min(limits.maxLength ?? Infinity, highest);
      } else {
        if (lowest !== undefined) limits.min = Math.max(limits.min ?? -Infinity, lowest);
        if (highest !== undefined) limits.max = Math.min(limits.max ?? Infinity, highest);
      }
      continue;
    }
    return undefined;
  }
  return Object.keys(limits).length ? { column: column.name, limits } : undefined;
}

/**
 * The range a column's type alone allows: a `decimal(5,2)` holds nothing past 999.99, a `smallint` nothing past 32,767.
 * Types whose range is wider than anybody would type (int, bigint, float) say nothing.
 */
export function limitsFromType(dataType: string, precision: number, scale: number, dialect: CheckDialect): Pick<EntityField, 'min' | 'max'> {
  const type = dataType.toLowerCase();
  if ((type === 'numeric' || type === 'decimal') && Number.isInteger(precision) && precision > 0 && precision <= 15) {
    const places = Number.isInteger(scale) && scale > 0 ? scale : 0;
    const max = Number((10 ** (precision - places) - 10 ** -places).toFixed(places));
    return { min: -max, max };
  }
  if (type === 'smallint') return { min: -32768, max: 32767 };
  if (type === 'tinyint' && dialect === 'mssql') return { min: 0, max: 255 };
  return {};
}

/** Lower case, with the quoting, type casts and character-set marks each database adds taken off, and every piece of quoted text set aside. */
function tidy(clause: string, dialect: CheckDialect): { text: string; strings: string[] } {
  const strings: string[] = [];
  let text = clause
    // MySQL writes quotes inside the stored rule with a backslash before them.
    .replace(/\\'/g, "'")
    .replace(/(?:\b_\w+|\bN)?'((?:[^']|'')*)'/g, (_m, s: string) => `\u0001${strings.push(s.replace(/''/g, "'")) - 1}\u0001`);
  text = text.toLowerCase();
  if (dialect === 'postgres') text = text.replace(/::[a-z_]+(?: [a-z_]+)*(?:\(\d+(?:,\d+)?\))?(?:\[\])?/g, '');
  text = text.replace(/[`"[\]]/g, '').replace(/\s+/g, ' ').trim();
  return { text, strings };
}

const index = (marker: string) => Number(/^\u0001(\d+)\u0001$/.exec(marker.trim())?.[1] ?? -1);

/** Takes off brackets that wrap the whole of it, as many times as they do. */
function bare(part: string): string {
  let s = part.trim();
  for (;;) {
    if (!s.startsWith('(') || !s.endsWith(')')) {
      // Brackets left unbalanced by the split on AND: drop the strays.
      const opens = (s.match(/\(/g) ?? []).length;
      const closes = (s.match(/\)/g) ?? []).length;
      if (opens > closes && s.startsWith('(')) s = s.slice(1).trim();
      else if (closes > opens && s.endsWith(')')) s = s.slice(0, -1).trim();
      else return s;
      continue;
    }
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < s.length - 1; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') depth--;
      if (depth === 0) {
        wraps = false;
        break;
      }
    }
    if (!wraps) return s;
    s = s.slice(1, -1).trim();
  }
}

/** A LIKE pattern as the same thing a form understands. SQL Server alone has `[A-Z]` in LIKE. */
function fromLike(like: string, dialect: CheckDialect): string {
  let out = '';
  for (let i = 0; i < like.length; i++) {
    const ch = like[i]!;
    if (ch === '%') out += '.*';
    else if (ch === '_') out += '.';
    else if (ch === '[' && dialect === 'mssql') {
      const end = like.indexOf(']', i + 1);
      if (end < 0) return '';
      out += `[${like.slice(i + 1, end).replace(/\\/g, '\\\\')}]`;
      i = end;
    } else out += escape(ch);
  }
  return `^${out}$`;
}

/** Only a pattern a browser can run, and short enough to keep. */
function usable(pattern: string): string | undefined {
  if (!pattern || pattern.length > 200) return undefined;
  try {
    new RegExp(pattern);
    return pattern;
  } catch {
    return undefined;
  }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
