import { describe, expect, it } from 'vitest';
import { limitsFromCheck, limitsFromType } from '../src/plugins/source-limits';

const cols = [{ name: 'qty', whole: true }, { name: 'price' }, { name: 'code' }, { name: 'name' }, { name: 'ends' }];

describe("a table's own rules, read as a form's limits", () => {
  it('reads a range as each database writes it back', () => {
    expect(limitsFromCheck('((qty >= 1) AND (qty <= 100))', cols, 'postgres')).toEqual({ column: 'qty', limits: { min: 1, max: 100 } });
    expect(limitsFromCheck('([qty]>=(1) AND [qty]<=(100))', cols, 'mssql')).toEqual({ column: 'qty', limits: { min: 1, max: 100 } });
    expect(limitsFromCheck('((`qty` >= 1) and (`qty` <= 100))', cols, 'mysql')).toEqual({ column: 'qty', limits: { min: 1, max: 100 } });
    expect(limitsFromCheck('(`qty` between 1 and 100)', cols, 'mysql')).toEqual({ column: 'qty', limits: { min: 1, max: 100 } });
    expect(limitsFromCheck('((price >= (0)::numeric) AND (price <= 999.50))', cols, 'postgres')).toEqual({ column: 'price', limits: { min: 0, max: 999.5 } });
    expect(limitsFromCheck('([price]>=(-5.5))', cols, 'mssql')).toEqual({ column: 'price', limits: { min: -5.5 } });
  });

  it('"more than" means the next whole number for a whole-number column, and the end itself otherwise', () => {
    expect(limitsFromCheck('(qty > 0)', cols, 'postgres')?.limits).toEqual({ min: 1 });
    expect(limitsFromCheck('(qty < 10)', cols, 'postgres')?.limits).toEqual({ max: 9 });
    expect(limitsFromCheck('((price > (0)::numeric))', cols, 'postgres')?.limits).toEqual({ min: 0 });
  });

  it('reads a shortest and longest length', () => {
    expect(limitsFromCheck('(char_length((name)::text) >= 2)', cols, 'postgres')).toEqual({ column: 'name', limits: { minLength: 2 } });
    expect(limitsFromCheck('(len([name])>=(2) AND len([name])<(40))', cols, 'mssql')?.limits).toEqual({ minLength: 2, maxLength: 39 });
    expect(limitsFromCheck('(char_length(`name`) > 1)', cols, 'mysql')?.limits).toEqual({ minLength: 2 });
  });

  it('reads a pattern, and turns LIKE into one', () => {
    expect(limitsFromCheck("((code)::text ~ '^[A-Z]{3}-\\d+$'::text)", cols, 'postgres')).toEqual({ column: 'code', limits: { pattern: '^[A-Z]{3}-\\d+$' } });
    expect(limitsFromCheck("regexp_like(`code`,_utf8mb4\\'^[A-Z]{3}$\\')", cols, 'mysql')?.limits).toEqual({ pattern: '^[A-Z]{3}$' });
    expect(limitsFromCheck("([code] like '[A-Z][A-Z][0-9]%')", cols, 'mssql')?.limits).toEqual({ pattern: '^[A-Z][A-Z][0-9].*$' });
    expect(limitsFromCheck("((code)::text ~~ 'AB_-%'::text)", cols, 'postgres')).toBeUndefined();
    expect(limitsFromCheck("(`code` like 'AB_.%')", cols, 'mysql')?.limits).toEqual({ pattern: '^AB.\\..*$' });
    // The pattern it gives really does accept and refuse what the rule would.
    const p = new RegExp(limitsFromCheck("([code] like '[A-Z][A-Z][0-9]%')", cols, 'mssql')!.limits.pattern!);
    expect(p.test('AB7-x')).toBe(true);
    expect(p.test('a77')).toBe(false);
  });

  it('never guesses: anything it does not fully understand gives nothing', () => {
    expect(limitsFromCheck('(ends > qty)', cols, 'postgres')).toBeUndefined();
    expect(limitsFromCheck('((qty >= 1) OR (qty = -1))', cols, 'postgres')).toBeUndefined();
    expect(limitsFromCheck("(code IN ('A','B'))", cols, 'postgres')).toBeUndefined();
    expect(limitsFromCheck('(qty IS NOT NULL)', cols, 'postgres')).toBeUndefined();
    expect(limitsFromCheck('(abs(qty) < 5)', cols, 'postgres')).toBeUndefined();
    expect(limitsFromCheck("(code ~ '([')", cols, 'postgres')).toBeUndefined();
    expect(limitsFromCheck('(other >= 1)', cols, 'postgres')).toBeUndefined();
    // A word inside quoted text is not a column, and cannot switch the reading off or on.
    expect(limitsFromCheck("(code ~ '^qty or price$')", cols, 'postgres')?.limits).toEqual({ pattern: '^qty or price$' });
  });

  it("knows the room a column's type has", () => {
    expect(limitsFromType('numeric', 5, 2, 'postgres')).toEqual({ min: -999.99, max: 999.99 });
    expect(limitsFromType('decimal', 4, 0, 'mysql')).toEqual({ min: -9999, max: 9999 });
    expect(limitsFromType('smallint', 16, 0, 'postgres')).toEqual({ min: -32768, max: 32767 });
    expect(limitsFromType('tinyint', 3, 0, 'mssql')).toEqual({ min: 0, max: 255 });
    expect(limitsFromType('tinyint', 3, 0, 'mysql')).toEqual({});
    expect(limitsFromType('integer', 32, 0, 'postgres')).toEqual({});
    expect(limitsFromType('numeric', NaN, NaN, 'postgres')).toEqual({});
  });
});
