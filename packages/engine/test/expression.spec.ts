import { describe, expect, it } from 'vitest';
import { checkExpression, evaluateExpression, expressionFields, EXPRESSION_FUNCTIONS, parseExpression, renameExpressionField } from '../src';
import type { FormValues } from '../src/types';

const now = new Date('2026-10-08T20:30:00.000Z');
const calc = (src: string, values: FormValues = {}) => evaluateExpression(src, values, { now }).value;
const reason = (src: string, values: FormValues = {}) => evaluateExpression(src, values, { now }).error;

describe('expressions — arithmetic', () => {
  it('follows the usual precedence and brackets', () => {
    expect(calc('1 + 2 * 3')).toBe(7);
    expect(calc('(1 + 2) * 3')).toBe(9);
    expect(calc('10 - 4 - 3')).toBe(3);
    expect(calc('-2 * -3')).toBe(6);
    expect(calc('7 % 4')).toBe(3);
  });

  it('reads fields, numeric text and blanks (as 0)', () => {
    expect(calc('quantity * unitPrice', { quantity: 3, unitPrice: 19.5 })).toBe(58.5);
    expect(calc('a + b', { a: '4', b: 1 })).toBe(5);
    expect(calc('a + b + c', { a: 2, b: '', c: undefined })).toBe(2);
  });

  it('has no float noise', () => {
    expect(calc('0.1 + 0.2')).toBe(0.3);
    expect(calc('1.15 * 100')).toBe(115);
  });

  it('comes out empty, with a reason, when it cannot be computed', () => {
    expect(calc('total / people', { total: 10, people: 0 })).toBeUndefined();
    expect(reason('total / people', { total: 10, people: 0 })).toBe('Division by zero');
    expect(calc('name * 2', { name: 'Asha' })).toBeUndefined();
    expect(calc('10 % 0')).toBeUndefined();
  });
});

describe('expressions — comparison and logic', () => {
  it('compares numbers, numeric text and dates', () => {
    expect(calc('amount > 5000', { amount: 5001 })).toBe(true);
    expect(calc('amount >= 5000', { amount: '5000' })).toBe(true);
    expect(calc('end < start', { start: '2026-10-08', end: '2026-10-01' })).toBe(true);
    expect(calc('amount > 5', { amount: '' })).toBe(false);
  });

  it('treats "5" and 5 as equal, like conditions do', () => {
    expect(calc('a == 5', { a: '5' })).toBe(true);
    expect(calc('a != "x"', { a: 'y' })).toBe(true);
    expect(calc('a == null', { a: '' })).toBe(true);
  });

  it('combines with && || ! and only counts blank, false and 0 as no', () => {
    expect(calc('a && b', { a: true, b: 'yes' })).toBe(true);
    expect(calc('a && b', { a: true, b: '' })).toBe(false);
    expect(calc('a || b', { a: 0, b: false })).toBe(false);
    expect(calc('!a', { a: [] })).toBe(true);
  });

  it('picks a branch with ?: and if(), without running the other one', () => {
    expect(calc('n > 0 ? total / n : 0', { total: 10, n: 0 })).toBe(0);
    expect(calc('if(n == 0, 0, total / n)', { total: 10, n: 4 })).toBe(2.5);
    expect(calc('a ? "x" : b ? "y" : "z"', { a: false, b: true })).toBe('y');
  });
});

describe('expressions — functions', () => {
  it('maths', () => {
    expect(calc('sum(a, b, c)', { a: 1, b: '', c: 2.5 })).toBe(3.5);
    expect(calc('sum(picked)', { picked: ['2', '3'] })).toBe(5);
    expect(calc('avg(a, b, c)', { a: 2, b: 4 })).toBe(3);
    expect(calc('min(a, b)', { a: 2, b: -1 })).toBe(-1);
    expect(calc('max(a, b)', {})).toBeUndefined();
    expect(calc('count(a, b, c)', { a: 0, b: '', c: 'x' })).toBe(2);
    expect(calc('round(2.345, 2)')).toBe(2.35);
    expect(calc('round(1.005, 2)')).toBe(1.01);
    expect(calc('round(-2.5)')).toBe(-3);
    expect(calc('floor(2.9) + ceil(2.1) + abs(-1)')).toBe(6);
    expect(calc('pow(2, 10)')).toBe(1024);
    expect(calc('pow(9, 0.5)')).toBe(3);
    // A loan's monthly instalment: P × r × (1 + r)^n ÷ ((1 + r)^n − 1).
    expect(calc('round(100000 * 0.01 * pow(1.01, 12) / (pow(1.01, 12) - 1))')).toBe(8885);
    expect(calc('number("12.5") * 2')).toBe(25);
  });

  it('text', () => {
    expect(calc('first & " " & last', { first: 'Asha', last: 'Rao' })).toBe('Asha Rao');
    expect(calc('concat(code, "-", n)', { code: 'CC', n: 42 })).toBe('CC-42');
    expect(calc('upper(trim(a))', { a: '  ab ' })).toBe('AB');
    expect(calc('length(a)', { a: 'hello' })).toBe(5);
    expect(calc('length(a)', { a: ['x', 'y'] })).toBe(2);
    expect(calc('left(a, 2) & right(a, 2)', { a: 'abcdef' })).toBe('abef');
    expect(calc('contains(a, "CD")', { a: 'abcdef' })).toBe(true);
    expect(calc('contains(tags, "red")', { tags: ['blue', 'red'] })).toBe(true);
    expect(calc('startsWith(a, "ab") && endsWith(a, "EF")', { a: 'abcdef' })).toBe(true);
  });

  it('dates', () => {
    expect(calc('today()')).toBe('2026-10-08');
    // The clock where the form is filled in, written as a date-and-time field writes its answer.
    expect(evaluateExpression('now()', {}, { now: new Date('2026-10-08T20:30:00Z'), timeZone: 'Asia/Kolkata' }).value).toBe('2026-10-09T02:00:00');
    expect(evaluateExpression('now()', {}, { now: new Date('2026-10-08T20:30:00Z'), timeZone: 'America/Toronto' }).value).toBe('2026-10-08T16:30:00');
    // So "10:30 this morning", typed in India at 11:00, is in the past on a server anywhere.
    const at11inIndia = { now: new Date('2026-10-09T05:30:00Z'), timeZone: 'Asia/Kolkata' };
    expect(evaluateExpression('admitted > now()', { admitted: '2026-10-09T10:30' }, at11inIndia).value).toBe(false);
    expect(evaluateExpression('admitted > now()', { admitted: '2026-10-09T11:30' }, at11inIndia).value).toBe(true);
    expect(calc('dateAdd(d, 30)', { d: '2026-10-08' })).toBe('2026-11-07');
    expect(calc('dateAdd(d, 1, "months")', { d: '2026-01-31' })).toBe('2026-02-28');
    expect(calc('dateAdd(d, -1, "years")', { d: '2024-02-29' })).toBe('2023-02-28');
    expect(calc('dateAdd(d, 2, "hours")', { d: '2026-10-08T10:00:00.000Z' })).toBe('2026-10-08T12:00:00.000Z');
    expect(calc('dateDiff(a, b)', { a: '2026-10-01', b: '2026-10-08' })).toBe(7);
    expect(calc('dateDiff(a, b, "months")', { a: '2026-01-31', b: '2026-03-30' })).toBe(1);
    expect(calc('dateDiff(dob, today(), "years")', { dob: '2000-10-09' })).toBe(25);
    expect(calc('dateDiff(a, b, "days")', { a: '2026-10-08', b: '2026-10-01' })).toBe(-7);
    expect(calc('year(d) * 10000 + month(d) * 100 + day(d)', { d: '2026-10-08' })).toBe(20261008);
    expect(calc('dateAdd(d, 1)', { d: 'not a date' })).toBeUndefined();
    expect(calc('dateAdd(d, 1, "fortnights")', { d: '2026-10-08' })).toBeUndefined();
  });

  it("today() is the date in the form's time zone", () => {
    const at = (timeZone?: string) => evaluateExpression('today()', {}, { now, timeZone }).value;
    expect(at('Asia/Kolkata')).toBe('2026-10-09');
    expect(at('America/New_York')).toBe('2026-10-08');
    expect(at('Not/AZone')).toBe('2026-10-08');
  });

  it('logic', () => {
    expect(calc('isEmpty(a)', { a: ' ' })).toBe(true);
    expect(calc('coalesce(a, b, "none")', { a: '', b: undefined })).toBe('none');
    expect(calc('oneOf(status, "OPEN", "HOLD")', { status: 'HOLD' })).toBe(true);
  });

  it('lists every function for the editor', () => {
    expect(EXPRESSION_FUNCTIONS.map((f) => f.name)).toEqual(expect.arrayContaining(['sum', 'round', 'concat', 'dateDiff', 'if']));
    expect(EXPRESSION_FUNCTIONS.every((f) => f.help.length > 0)).toBe(true);
  });
});

describe('expressions — what is rejected', () => {
  const problem = (src: string) => {
    try {
      parseExpression(src);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };

  it('explains syntax mistakes', () => {
    expect(problem('')).toBe('Expression is empty');
    expect(problem('1 +')).toBe('Expression is incomplete');
    expect(problem('(1 + 2')).toBe('Expected ")"');
    expect(problem('"abc')).toBe('Text is missing its closing quote');
    expect(problem('1 2')).toBe('Unexpected "2"');
    expect(problem('a = 1')).toBe('Unexpected "="');
    expect(problem('a ? b')).toBe('Expected ":"');
  });

  it('knows its functions and how many values they take', () => {
    expect(problem('launch(1)')).toBe('Unknown function "launch"');
    expect(problem('round()')).toBe('round() takes 1 to 2 values, not 0');
    expect(problem('today(1)')).toBe('today() takes 0 values, not 1');
    expect(problem('floor(1, 2)')).toBe('floor() takes 1 value, not 2');
  });

  it('gives no way out of the form values', () => {
    // Property access, indexing, assignment and statements are simply not in the language.
    for (const src of ['a.b', 'a[0]', 'a = 1', 'a; b', '`x`', 'x => x', '{}', 'new Date()']) expect(problem(src)).not.toBeNull();
    expect(problem('constructor("return 1")()')).toBe('Unknown function "constructor"');
    // A field-like name that exists on every object resolves to nothing, not to Object internals.
    expect(calc('constructor')).toBeUndefined();
    expect(calc('__proto__')).toBeUndefined();
    expect(calc('toString & "x"')).toBe('x');
  });

  it('limits size and nesting', () => {
    expect(problem('1 + '.repeat(400) + '1')).toBe('Expression is longer than 1000 characters');
    expect(problem('('.repeat(60) + '1' + ')'.repeat(60))).toBe('Expression is nested too deeply');
    expect(problem('-'.repeat(60) + '1')).toBe('Expression is nested too deeply');
    expect(calc('concat(a, a, a, a)', { a: 'x'.repeat(3000) })).toBeUndefined();
  });

  it('never throws from evaluate', () => {
    for (const src of ['', '1 +', 'nope(1)', 'a / 0', 'dateDiff(1, 2)']) {
      expect(() => evaluateExpression(src, {})).not.toThrow();
      expect(evaluateExpression(src, {}).error).toBeTruthy();
    }
  });
});

describe('expressions — references', () => {
  it('lists the fields an expression reads, once each', () => {
    expect(expressionFields('round(qty * price, 2) + if(qty > 10, bonus, 0)').sort()).toEqual(['bonus', 'price', 'qty']);
    expect(expressionFields('1 +')).toEqual([]);
  });

  it('renames a field wherever it is read, and nothing else', () => {
    expect(renameExpressionField('qty * price + qty', 'qty', 'quantity')).toBe('quantity * price + quantity');
    // Not part of a longer name, not a function of the same name, not text in quotes.
    expect(renameExpressionField('sum(sum, summary, "sum")', 'sum', 'total')).toBe('sum(total, summary, "sum")');
    expect(renameExpressionField('a>1?a:-a', 'a', 'amount')).toBe('amount>1?amount:-amount');
    expect(renameExpressionField('qty * "unclosed', 'qty', 'quantity')).toBe('qty * "unclosed');
    expect(renameExpressionField('qty *', 'qty', 'quantity')).toBe('quantity *');
  });

  it('checks references against the form', () => {
    const fields = new Set(['qty', 'price']);
    expect(checkExpression('qty * price', fields)).toBeNull();
    expect(checkExpression('qty * cost', fields)).toBe('Refers to unknown field "cost"');
    expect(checkExpression('qty *', fields)).toBe('Expression is incomplete');
  });
});
