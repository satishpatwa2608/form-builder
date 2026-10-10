import type { FormValues, SystemContext } from './types';
import { isEmptyValue } from './field-kinds';
import { sameValue, toComparable } from './evaluate-condition';

/**
 * The expression language rules use for calculations and conditions, e.g.
 * `round(quantity * unitPrice * (1 - discount / 100), 2)`.
 *
 * It is parsed and walked here - never handed to eval/Function - so a form
 * author can only reach form values and the functions listed below. The same
 * code runs in the browser and on the server, which is what lets the server
 * recompute every calculated value instead of trusting the one it was sent.
 *
 * Blank values count as 0 in arithmetic (as in a spreadsheet) so a total over
 * optional lines works before every line is filled in. Anything that cannot
 * be computed (text in arithmetic, division by zero, a bad date) makes the
 * whole expression come out empty rather than throwing.
 */

export const MAX_EXPRESSION_LENGTH = 1000;
const MAX_DEPTH = 40;
const MAX_NODES = 500;
const MAX_TEXT_LENGTH = 10_000;

type BinaryOp = '||' | '&&' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '&' | '+' | '-' | '*' | '/' | '%';

export type ExprNode =
  | { t: 'lit'; value: string | number | boolean | null }
  | { t: 'ref'; name: string }
  | { t: 'call'; name: string; args: ExprNode[]; pos: number }
  | { t: 'unary'; op: '!' | '-'; arg: ExprNode }
  | { t: 'binary'; op: BinaryOp; left: ExprNode; right: ExprNode }
  | { t: 'cond'; test: ExprNode; then: ExprNode; else: ExprNode };

export class ExpressionError extends Error {
  constructor(
    message: string,
    /** Character offset in the source, for pointing at the mistake in the editor. */
    public readonly position?: number,
  ) {
    super(message);
    this.name = 'ExpressionError';
  }
}

// ---------------------------------------------------------------- tokens ---

type Token =
  | { k: 'num'; v: number; pos: number }
  | { k: 'str'; v: string; pos: number }
  | { k: 'id'; v: string; pos: number }
  | { k: 'op'; v: string; pos: number }
  | { k: 'end'; pos: number };

const OPERATORS = ['||', '&&', '==', '!=', '<=', '>=', '<', '>', '&', '+', '-', '*', '/', '%', '!', '(', ')', ',', '?', ':'];

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const number = /^(\d+(\.\d+)?|\.\d+)/.exec(src.slice(i));
    if (number) {
      tokens.push({ k: 'num', v: Number(number[0]), pos: i });
      i += number[0].length;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let text = '';
      let j = i + 1;
      for (; j < src.length && src[j] !== ch; j++) {
        if (src[j] === '\\' && j + 1 < src.length) j++;
        text += src[j];
      }
      if (j >= src.length) throw new ExpressionError('Text is missing its closing quote', i);
      tokens.push({ k: 'str', v: text, pos: i });
      i = j + 1;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) {
      tokens.push({ k: 'id', v: id[0], pos: i });
      i += id[0].length;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExpressionError(`Unexpected "${ch}"`, i);
    tokens.push({ k: 'op', v: op, pos: i });
    i += op.length;
  }
  tokens.push({ k: 'end', pos: src.length });
  return tokens;
}

// ---------------------------------------------------------------- parser ---

/** Binary operators by precedence, loosest first. All are left-associative. */
const LEVELS: BinaryOp[][] = [['||'], ['&&'], ['==', '!='], ['<', '<=', '>', '>='], ['&'], ['+', '-'], ['*', '/', '%']];

function parse(src: string): ExprNode {
  if (src.length > MAX_EXPRESSION_LENGTH) {
    throw new ExpressionError(`Expression is longer than ${MAX_EXPRESSION_LENGTH} characters`);
  }
  const tokens = tokenize(src);
  let at = 0;
  let nodes = 0;
  const peek = () => tokens[at];
  const isOp = (v: string) => peek().k === 'op' && (peek() as { v: string }).v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new ExpressionError(`Expected "${v}"`, peek().pos);
    at++;
  };
  const made = <T extends ExprNode>(node: T): T => {
    if (++nodes > MAX_NODES) throw new ExpressionError('Expression is too large');
    return node;
  };
  const deeper = (depth: number) => {
    if (depth > MAX_DEPTH) throw new ExpressionError('Expression is nested too deeply', peek().pos);
    return depth + 1;
  };

  function ternary(depth: number): ExprNode {
    const d = deeper(depth);
    const test = binary(0, d);
    if (!isOp('?')) return test;
    at++;
    const then = ternary(d);
    expect(':');
    return made({ t: 'cond', test, then, else: ternary(d) });
  }

  function binary(level: number, depth: number): ExprNode {
    if (level === LEVELS.length) return unary(depth);
    let left = binary(level + 1, depth);
    for (;;) {
      const tok = peek();
      if (tok.k !== 'op' || !(LEVELS[level] as string[]).includes(tok.v)) return left;
      at++;
      left = made({ t: 'binary', op: tok.v as BinaryOp, left, right: binary(level + 1, depth) });
    }
  }

  function unary(depth: number): ExprNode {
    const tok = peek();
    if (tok.k === 'op' && (tok.v === '!' || tok.v === '-')) {
      at++;
      return made({ t: 'unary', op: tok.v, arg: unary(deeper(depth)) });
    }
    return primary(depth);
  }

  function primary(depth: number): ExprNode {
    const tok = peek();
    at++;
    if (tok.k === 'num' || tok.k === 'str') return made({ t: 'lit', value: tok.v });
    if (tok.k === 'id') {
      if (tok.v === 'true' || tok.v === 'false') return made({ t: 'lit', value: tok.v === 'true' });
      if (tok.v === 'null') return made({ t: 'lit', value: null });
      if (!isOp('(')) return made({ t: 'ref', name: tok.v });
      at++;
      const args: ExprNode[] = [];
      if (!isOp(')')) {
        do args.push(ternary(depth));
        while (isOp(',') && ++at);
      }
      expect(')');
      // Own entries only, so `constructor(...)` or `toString(...)` is an unknown function, not Object's.
      const fn = Object.prototype.hasOwnProperty.call(FUNCTIONS, tok.v) ? FUNCTIONS[tok.v] : undefined;
      if (!fn) throw new ExpressionError(`Unknown function "${tok.v}"`, tok.pos);
      if (args.length < fn.min || args.length > fn.max) {
        const wants = fn.min === fn.max ? `${fn.min}` : fn.max === Infinity ? `at least ${fn.min}` : `${fn.min} to ${fn.max}`;
        throw new ExpressionError(`${tok.v}() takes ${wants} value${wants === '1' ? '' : 's'}, not ${args.length}`, tok.pos);
      }
      return made({ t: 'call', name: tok.v, args, pos: tok.pos });
    }
    if (tok.k === 'op' && tok.v === '(') {
      const inner = ternary(depth);
      expect(')');
      return inner;
    }
    if (tok.k === 'end') throw new ExpressionError('Expression is incomplete', tok.pos);
    throw new ExpressionError(`Unexpected "${tok.v}"`, tok.pos);
  }

  if (peek().k === 'end') throw new ExpressionError('Expression is empty', 0);
  const root = ternary(0);
  if (peek().k !== 'end') {
    const extra = peek();
    throw new ExpressionError(`Unexpected "${'v' in extra ? extra.v : ''}"`, extra.pos);
  }
  return root;
}

const CACHE_LIMIT = 2000;
const cache = new Map<string, ExprNode | ExpressionError>();

/** Parses (and remembers) an expression. Throws ExpressionError when it is not valid. */
export function parseExpression(src: string): ExprNode {
  let hit = cache.get(src);
  if (!hit) {
    try {
      hit = parse(src);
    } catch (e) {
      hit = e instanceof ExpressionError ? e : new ExpressionError('Expression could not be read');
    }
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(src, hit);
  }
  if (hit instanceof ExpressionError) throw hit;
  return hit;
}

/** Field names an expression reads, without duplicates. Empty when it does not parse. */
export function expressionFields(src: string): string[] {
  const names = new Set<string>();
  const walk = (n: ExprNode) => {
    if (n.t === 'ref') names.add(n.name);
    else if (n.t === 'call') n.args.forEach(walk);
    else if (n.t === 'unary') walk(n.arg);
    else if (n.t === 'binary') [n.left, n.right].forEach(walk);
    else if (n.t === 'cond') [n.test, n.then, n.else].forEach(walk);
  };
  try {
    walk(parseExpression(src));
  } catch {
    return [];
  }
  return [...names];
}

/**
 * The expression with every reference to field `from` renamed to `to`.
 * Function names and text in quotes are left alone. Returned unchanged when
 * it cannot be read (a half-typed formula keeps what the author wrote).
 */
export function renameExpressionField(src: string, from: string, to: string): string {
  let tokens: Token[];
  try {
    tokens = tokenize(src);
  } catch {
    return src;
  }
  let out = '';
  let at = 0;
  tokens.forEach((tok, i) => {
    const next = tokens[i + 1];
    const isCall = next?.k === 'op' && next.v === '(';
    if (tok.k !== 'id' || tok.v !== from || isCall) return;
    out += src.slice(at, tok.pos) + to;
    at = tok.pos + from.length;
  });
  return out + src.slice(at);
}

/** Why an expression cannot be used, or null. `fields` are the names it may refer to. */
export function checkExpression(src: string, fields: ReadonlySet<string>): string | null {
  try {
    parseExpression(src);
  } catch (e) {
    return (e as ExpressionError).message;
  }
  const unknown = expressionFields(src).find((name) => !fields.has(name));
  return unknown ? `Refers to unknown field "${unknown}"` : null;
}

// ------------------------------------------------------------- evaluation ---

/** Raised inside evaluation for anything that cannot be computed; never escapes this module. */
class Uncomputable extends Error {}

const fail = (message: string): never => {
  throw new Uncomputable(message);
};

/** What a value means as a yes/no: blank, false and 0 are "no". */
export function truthy(v: unknown): boolean {
  return !isEmptyValue(v) && v !== false && v !== 0;
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : fail('Not a number');
  if (isEmptyValue(v)) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fail('Not a number');
}

function toText(v: unknown): string {
  // Not isEmptyValue: a space is real text here (`first & " " & last`).
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.map(toText).join(', ');
  if (typeof v === 'object') return fail('Not text');
  return String(v);
}

const capped = (text: string) => (text.length > MAX_TEXT_LENGTH ? fail('Text is too long') : text);

/** Lists (multi-select values) are spread, blanks dropped: what sum/min/max/count work over. */
const filled = (args: unknown[]) => args.flat(Infinity).filter((v) => !isEmptyValue(v));

/** Removes float noise such as 0.1 + 0.2 = 0.30000000000000004. */
const tidy = (n: number) => (Number.isFinite(n) ? Number(n.toPrecision(12)) : fail('Not a number'));

function round(value: number, places: number): number {
  const p = Math.max(0, Math.min(10, Math.trunc(places)));
  const factor = 10 ** p;
  return (Math.sign(value) * Math.round((Math.abs(value) + Number.EPSILON) * factor)) / factor;
}

// Dates are ISO strings in form values. All date maths is done in UTC.

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const UNIT_MS: Record<string, number> = { minutes: 60_000, hours: 3_600_000, days: DAY_MS, weeks: 7 * DAY_MS };

function toTime(v: unknown): number {
  if (typeof v !== 'string' || v.trim() === '') return fail('Not a date');
  const t = Date.parse(v);
  return Number.isNaN(t) ? fail('Not a date') : t;
}

const pad = (n: number) => String(n).padStart(2, '0');
const isoDate = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** Today's date where the form is being filled in (`ctx.timeZone`, UTC when not given). */
function today(ctx: SystemContext): string {
  const now = ctx.now ?? new Date();
  if (!ctx.timeZone) return isoDate(now);
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', { timeZone: ctx.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return isoDate(now);
  }
}

function addMonths(time: number, months: number): number {
  const d = new Date(time);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  // 31 Jan + 1 month is the last day of February, not 3 March.
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.getTime();
}

function dateAdd(date: unknown, amount: unknown, unit: unknown): string {
  const time = toTime(date);
  const n = Math.trunc(toNumber(amount));
  const u = unit === undefined ? 'days' : toText(unit);
  let result: number;
  if (u === 'months') result = addMonths(time, n);
  else if (u === 'years') result = addMonths(time, n * 12);
  else if (UNIT_MS[u]) result = time + n * UNIT_MS[u];
  else return fail(`Unknown unit "${u}"`);
  const out = new Date(result);
  if (Number.isNaN(out.getTime())) return fail('Not a date');
  return DATE_ONLY.test(String(date).trim()) ? isoDate(out) : out.toISOString();
}

/** Whole units from `from` to `to` (negative when `to` is earlier). */
function dateDiff(from: unknown, to: unknown, unit: unknown): number {
  const a = toTime(from);
  const b = toTime(to);
  const u = unit === undefined ? 'days' : toText(unit);
  if (UNIT_MS[u]) return Math.trunc((b - a) / UNIT_MS[u]);
  if (u !== 'months' && u !== 'years') return fail(`Unknown unit "${u}"`);
  const [start, end, sign] = a <= b ? [a, b, 1] : [b, a, -1];
  const s = new Date(start);
  const e = new Date(end);
  let months = (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + (e.getUTCMonth() - s.getUTCMonth());
  if (addMonths(start, months) > end) months--;
  return sign * (u === 'years' ? Math.trunc(months / 12) : months);
}

interface ExprFunction {
  min: number;
  max: number;
  /** Shown in the rule editor's function list. */
  help: string;
  group: 'Maths' | 'Text' | 'Date' | 'Logic';
  run: (args: unknown[], ctx: SystemContext) => unknown;
}

const numbers = (args: unknown[]) => filled(args).map(toNumber);

/** `if` is here for the editor's list and arity check; it is evaluated lazily in `evaluate`. */
const FUNCTIONS: Record<string, ExprFunction> = {
  sum: { min: 1, max: Infinity, group: 'Maths', help: 'sum(a, b, …) adds the values, ignoring blanks', run: (a) => numbers(a).reduce((x, y) => x + y, 0) },
  avg: {
    min: 1,
    max: Infinity,
    group: 'Maths',
    help: 'avg(a, b, …) is the average of the filled-in values',
    run: (a) => {
      const n = numbers(a);
      return n.length ? n.reduce((x, y) => x + y, 0) / n.length : undefined;
    },
  },
  min: { min: 1, max: Infinity, group: 'Maths', help: 'min(a, b, …) is the smallest value', run: (a) => (numbers(a).length ? Math.min(...numbers(a)) : undefined) },
  max: { min: 1, max: Infinity, group: 'Maths', help: 'max(a, b, …) is the largest value', run: (a) => (numbers(a).length ? Math.max(...numbers(a)) : undefined) },
  count: { min: 1, max: Infinity, group: 'Maths', help: 'count(a, b, …) is how many of the values are filled in', run: (a) => filled(a).length },
  round: { min: 1, max: 2, group: 'Maths', help: 'round(value, places) rounds to that many decimal places (0 when left out)', run: ([v, p]) => round(toNumber(v), p === undefined ? 0 : toNumber(p)) },
  floor: { min: 1, max: 1, group: 'Maths', help: 'floor(value) rounds down to a whole number', run: ([v]) => Math.floor(toNumber(v)) },
  ceil: { min: 1, max: 1, group: 'Maths', help: 'ceil(value) rounds up to a whole number', run: ([v]) => Math.ceil(toNumber(v)) },
  abs: { min: 1, max: 1, group: 'Maths', help: 'abs(value) drops the minus sign', run: ([v]) => Math.abs(toNumber(v)) },
  pow: { min: 2, max: 2, group: 'Maths', help: 'pow(value, n) is value multiplied by itself n times, as in compound interest: pow(1 + rate, months)', run: ([v, n]) => tidy(Math.pow(toNumber(v), toNumber(n))) },
  number: { min: 1, max: 1, group: 'Maths', help: 'number(value) reads text such as "12.5" as a number', run: ([v]) => (isEmptyValue(v) ? undefined : toNumber(v)) },

  concat: { min: 1, max: Infinity, group: 'Text', help: 'concat(a, b, …) joins the values into one text', run: (a) => capped(a.map(toText).join('')) },
  text: { min: 1, max: 1, group: 'Text', help: 'text(value) turns a number into text', run: ([v]) => toText(v) },
  upper: { min: 1, max: 1, group: 'Text', help: 'upper(text) in capital letters', run: ([v]) => toText(v).toUpperCase() },
  lower: { min: 1, max: 1, group: 'Text', help: 'lower(text) in small letters', run: ([v]) => toText(v).toLowerCase() },
  trim: { min: 1, max: 1, group: 'Text', help: 'trim(text) removes spaces at both ends', run: ([v]) => toText(v).trim() },
  length: { min: 1, max: 1, group: 'Text', help: 'length(value) is the number of characters, or of selected options', run: ([v]) => (Array.isArray(v) ? v.length : toText(v).length) },
  left: { min: 2, max: 2, group: 'Text', help: 'left(text, n) is the first n characters', run: ([v, n]) => toText(v).slice(0, Math.max(0, Math.trunc(toNumber(n)))) },
  right: {
    min: 2,
    max: 2,
    group: 'Text',
    help: 'right(text, n) is the last n characters',
    run: ([v, n]) => {
      const count = Math.max(0, Math.trunc(toNumber(n)));
      return count ? toText(v).slice(-count) : '';
    },
  },
  contains: {
    min: 2,
    max: 2,
    group: 'Text',
    help: 'contains(value, part) is true when the text contains part, or the selection includes it',
    run: ([v, part]) =>
      Array.isArray(v) ? v.some((item) => sameValue(item, part)) : toText(v).toLowerCase().includes(toText(part).toLowerCase()),
  },
  startsWith: { min: 2, max: 2, group: 'Text', help: 'startsWith(text, part)', run: ([v, p]) => toText(v).toLowerCase().startsWith(toText(p).toLowerCase()) },
  endsWith: { min: 2, max: 2, group: 'Text', help: 'endsWith(text, part)', run: ([v, p]) => toText(v).toLowerCase().endsWith(toText(p).toLowerCase()) },

  today: { min: 0, max: 0, group: 'Date', help: "today() is today's date", run: (_a, ctx) => today(ctx) },
  now: { min: 0, max: 0, group: 'Date', help: 'now() is the current date and time', run: (_a, ctx) => (ctx.now ?? new Date()).toISOString() },
  dateAdd: { min: 2, max: 3, group: 'Date', help: 'dateAdd(date, amount, "days") moves a date; units: minutes, hours, days, weeks, months, years', run: ([d, n, u]) => dateAdd(d, n, u) },
  dateDiff: { min: 2, max: 3, group: 'Date', help: 'dateDiff(from, to, "days") is the whole units between two dates', run: ([a, b, u]) => dateDiff(a, b, u) },
  year: { min: 1, max: 1, group: 'Date', help: 'year(date)', run: ([d]) => new Date(toTime(d)).getUTCFullYear() },
  month: { min: 1, max: 1, group: 'Date', help: 'month(date) from 1 to 12', run: ([d]) => new Date(toTime(d)).getUTCMonth() + 1 },
  day: { min: 1, max: 1, group: 'Date', help: 'day(date) is the day of the month', run: ([d]) => new Date(toTime(d)).getUTCDate() },

  if: { min: 3, max: 3, group: 'Logic', help: 'if(condition, thenValue, elseValue)', run: ([c, a, b]) => (truthy(c) ? a : b) },
  isEmpty: { min: 1, max: 1, group: 'Logic', help: 'isEmpty(value) is true when nothing is filled in', run: ([v]) => isEmptyValue(v) },
  coalesce: { min: 1, max: Infinity, group: 'Logic', help: 'coalesce(a, b, …) is the first value that is filled in', run: (a) => a.find((v) => !isEmptyValue(v)) },
  oneOf: { min: 2, max: Infinity, group: 'Logic', help: 'oneOf(value, a, b, …) is true when value equals any of the others', run: ([v, ...rest]) => rest.some((r) => sameValue(v, r)) },
};

/** The function list for the rule editor. */
export const EXPRESSION_FUNCTIONS: { name: string; group: ExprFunction['group']; help: string }[] = Object.entries(FUNCTIONS).map(
  ([name, fn]) => ({ name, group: fn.group, help: fn.help }),
);

function order(left: unknown, right: unknown, test: (a: number, b: number) => boolean): boolean {
  const a = toComparable(left);
  const b = toComparable(right);
  return a !== undefined && b !== undefined && test(a, b);
}

function evaluate(node: ExprNode, values: FormValues, ctx: SystemContext): unknown {
  switch (node.t) {
    case 'lit':
      return node.value;
    case 'ref':
      // Own properties only: `constructor` or `__proto__` must never resolve to something on Object.
      return Object.prototype.hasOwnProperty.call(values, node.name) ? values[node.name] : undefined;
    case 'cond':
      return evaluate(truthy(evaluate(node.test, values, ctx)) ? node.then : node.else, values, ctx);
    case 'unary': {
      const v = evaluate(node.arg, values, ctx);
      return node.op === '!' ? !truthy(v) : tidy(-toNumber(v));
    }
    case 'call': {
      // Only the chosen branch of if() runs, so `if(n == 0, 0, total / n)` is safe.
      if (node.name === 'if') {
        return evaluate(truthy(evaluate(node.args[0], values, ctx)) ? node.args[1] : node.args[2], values, ctx);
      }
      const result = FUNCTIONS[node.name].run(node.args.map((a) => evaluate(a, values, ctx)), ctx);
      return typeof result === 'number' ? tidy(result) : result;
    }
    case 'binary': {
      if (node.op === '&&') return truthy(evaluate(node.left, values, ctx)) && truthy(evaluate(node.right, values, ctx));
      if (node.op === '||') return truthy(evaluate(node.left, values, ctx)) || truthy(evaluate(node.right, values, ctx));
      const l = evaluate(node.left, values, ctx);
      const r = evaluate(node.right, values, ctx);
      switch (node.op) {
        case '==':
          return sameValue(l, r);
        case '!=':
          return !sameValue(l, r);
        case '<':
          return order(l, r, (a, b) => a < b);
        case '<=':
          return order(l, r, (a, b) => a <= b);
        case '>':
          return order(l, r, (a, b) => a > b);
        case '>=':
          return order(l, r, (a, b) => a >= b);
        case '&':
          return capped(toText(l) + toText(r));
        case '+':
          return tidy(toNumber(l) + toNumber(r));
        case '-':
          return tidy(toNumber(l) - toNumber(r));
        case '*':
          return tidy(toNumber(l) * toNumber(r));
        case '/': {
          const divisor = toNumber(r);
          return divisor === 0 ? fail('Division by zero') : tidy(toNumber(l) / divisor);
        }
        case '%': {
          const divisor = toNumber(r);
          return divisor === 0 ? fail('Division by zero') : tidy(toNumber(l) % divisor);
        }
      }
    }
  }
}

export interface ExpressionResult {
  /** `undefined` when the expression is invalid or could not be computed. */
  value: unknown;
  error?: string;
}

/** Never throws: an invalid or uncomputable expression comes back as an empty value with a reason. */
export function evaluateExpression(src: string, values: FormValues, ctx: SystemContext = {}): ExpressionResult {
  try {
    return { value: evaluate(parseExpression(src), values, ctx) };
  } catch (e) {
    if (e instanceof ExpressionError || e instanceof Uncomputable) return { value: undefined, error: e.message };
    throw e;
  }
}
