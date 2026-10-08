import type { Condition, ConditionLeaf, FormValues } from './types';
import { isEmptyValue } from './field-kinds';

const isPrimitive = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/**
 * Select values arrive as strings while a rule author may write a number or
 * boolean, so primitives compare by their string form ("5" equals 5).
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (isPrimitive(a) && isPrimitive(b)) return String(a) === String(b);
  if (isEmptyValue(a) && isEmptyValue(b)) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Numbers and numeric strings compare as numbers, ISO date strings as timestamps. */
export function toComparable(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

function compare(actual: unknown, expected: unknown, test: (a: number, b: number) => boolean) {
  const a = toComparable(actual);
  const b = toComparable(expected);
  return a !== undefined && b !== undefined && test(a, b);
}

function contains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual)) return actual.some((item) => sameValue(item, expected));
  if (typeof actual === 'string' && isPrimitive(expected)) {
    return actual.toLowerCase().includes(String(expected).toLowerCase());
  }
  return false;
}

function isIn(actual: unknown, expected: unknown): boolean {
  return Array.isArray(expected) && expected.some((item) => sameValue(actual, item));
}

function evaluateLeaf(leaf: ConditionLeaf, values: FormValues): boolean {
  const actual = values[leaf.field];
  const expected = leaf.value;
  switch (leaf.operator) {
    case 'equals':
      return sameValue(actual, expected);
    case 'notEquals':
      return !sameValue(actual, expected);
    case 'contains':
      return contains(actual, expected);
    case 'notContains':
      return !contains(actual, expected);
    case 'in':
      return isIn(actual, expected);
    case 'notIn':
      return !isIn(actual, expected);
    case 'isEmpty':
      return isEmptyValue(actual);
    case 'isNotEmpty':
      return !isEmptyValue(actual);
    case 'greaterThan':
      return compare(actual, expected, (a, b) => a > b);
    case 'lessThan':
      return compare(actual, expected, (a, b) => a < b);
    case 'greaterThanOrEqual':
      return compare(actual, expected, (a, b) => a >= b);
    case 'lessThanOrEqual':
      return compare(actual, expected, (a, b) => a <= b);
  }
}

export function evaluateCondition(condition: Condition, values: FormValues): boolean {
  if ('all' in condition) return condition.all.every((c) => evaluateCondition(c, values));
  if ('any' in condition) return condition.any.some((c) => evaluateCondition(c, values));
  return evaluateLeaf(condition, values);
}

/** Every field name a condition reads. */
export function conditionFields(condition: Condition): string[] {
  if ('all' in condition) return condition.all.flatMap(conditionFields);
  if ('any' in condition) return condition.any.flatMap(conditionFields);
  return [condition.field];
}
