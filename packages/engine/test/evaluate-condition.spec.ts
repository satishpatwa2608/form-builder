import { describe, expect, it } from 'vitest';
import { conditionFields, evaluateCondition } from '../src';
import type { ConditionLeaf } from '../src/types';

const leaf = (operator: ConditionLeaf['operator'], value?: unknown): ConditionLeaf => ({
  field: 'x',
  operator,
  value,
});
const run = (cond: ConditionLeaf, x: unknown) => evaluateCondition(cond, { x });

describe('evaluateCondition', () => {
  it('equals / notEquals compare primitives by string form', () => {
    expect(run(leaf('equals', 'PRODUCT'), 'PRODUCT')).toBe(true);
    expect(run(leaf('equals', 5), '5')).toBe(true);
    expect(run(leaf('equals', true), true)).toBe(true);
    expect(run(leaf('equals', 'PRODUCT'), 'BILLING')).toBe(false);
    expect(run(leaf('notEquals', 'PRODUCT'), 'BILLING')).toBe(true);
    expect(run(leaf('notEquals', 'PRODUCT'), undefined)).toBe(true);
  });

  it('contains works on strings (case-insensitive) and arrays', () => {
    expect(run(leaf('contains', 'broken'), 'Screen is BROKEN')).toBe(true);
    expect(run(leaf('contains', 'A'), ['A', 'B'])).toBe(true);
    expect(run(leaf('notContains', 'C'), ['A', 'B'])).toBe(true);
    expect(run(leaf('contains', 'x'), undefined)).toBe(false);
  });

  it('in / notIn need an array of expected values', () => {
    expect(run(leaf('in', ['A', 'B']), 'B')).toBe(true);
    expect(run(leaf('in', ['A', 'B']), 'C')).toBe(false);
    expect(run(leaf('notIn', ['A', 'B']), 'C')).toBe(true);
    expect(run(leaf('in', 'A'), 'A')).toBe(false);
  });

  it('isEmpty treats undefined, null, blank strings and empty arrays as empty', () => {
    for (const empty of [undefined, null, '', '   ', []]) {
      expect(run(leaf('isEmpty'), empty)).toBe(true);
      expect(run(leaf('isNotEmpty'), empty)).toBe(false);
    }
    expect(run(leaf('isEmpty'), 0)).toBe(false);
    expect(run(leaf('isEmpty'), false)).toBe(false);
  });

  it('comparisons use numbers, numeric strings and dates; unparseable is false', () => {
    expect(run(leaf('greaterThan', 10), 11)).toBe(true);
    expect(run(leaf('greaterThan', 10), '11')).toBe(true);
    expect(run(leaf('lessThan', 10), 10)).toBe(false);
    expect(run(leaf('lessThanOrEqual', 10), 10)).toBe(true);
    expect(run(leaf('greaterThanOrEqual', '2026-01-01'), '2026-06-30')).toBe(true);
    expect(run(leaf('greaterThan', 10), 'abc')).toBe(false);
    expect(run(leaf('greaterThan', 10), undefined)).toBe(false);
  });

  it('all / any nest', () => {
    const cond = {
      all: [
        { field: 'a', operator: 'equals' as const, value: 1 },
        { any: [{ field: 'b', operator: 'equals' as const, value: 'x' }, { field: 'c', operator: 'isNotEmpty' as const }] },
      ],
    };
    expect(evaluateCondition(cond, { a: 1, b: 'x' })).toBe(true);
    expect(evaluateCondition(cond, { a: 1, c: 'y' })).toBe(true);
    expect(evaluateCondition(cond, { a: 1 })).toBe(false);
    expect(evaluateCondition(cond, { a: 2, b: 'x' })).toBe(false);
    expect(conditionFields(cond)).toEqual(['a', 'b', 'c']);
  });
});
