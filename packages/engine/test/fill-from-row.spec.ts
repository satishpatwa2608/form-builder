import { describe, expect, it } from 'vitest';
import { readOwnPath, rowValues, sectionRows, type FormField } from '../src';

const fields = [
  { id: 'n', type: 'TEXT', name: 'customer', label: 'Customer' },
  { id: 'c', type: 'NUMBER', name: 'credit', label: 'Credit' },
  { id: 'a', type: 'CHECKBOX', name: 'active', label: 'Active' },
  { id: 'r', type: 'REPEAT', name: 'lines', label: 'Lines', validation: { max: 2 } },
  { id: 'i', type: 'TEXT', name: 'item', label: 'Item', parentId: 'r' },
  { id: 'q', type: 'NUMBER', name: 'qty', label: 'Qty', parentId: 'r' },
] as FormField[];

describe('filling a form from rows', () => {
  it('reads only what a row itself holds', () => {
    expect(readOwnPath({ a: { b: 3 } }, 'a.b')).toBe(3);
    expect(readOwnPath({ a: 1 }, 'toString')).toBeUndefined();
    expect(readOwnPath({ a: 1 }, 'a.constructor')).toBeUndefined();
    expect(readOwnPath(null, 'a')).toBeUndefined();
  });

  it('gives each question its answer in the shape that question stores', () => {
    expect(rowValues(fields, { name: 'Asha', limit: '5000', on: 'yes', extra: 'ignored' }, { customer: 'name', credit: 'limit', active: 'on', nothing: 'extra', lines: 'name' })).toEqual({ customer: 'Asha', credit: 5000, active: true });
    // A property that is not there leaves the question empty, as the form holds empty.
    expect(rowValues(fields, {}, { customer: 'name' })).toEqual({ customer: '' });
  });

  it('a repeating section gets a row for each row that came back, within its limit', () => {
    const found = [{ product: 'Cotton', n: '40' }, { product: 'Silk', n: 5 }, { product: 'Wool', n: 1 }];
    expect(sectionRows(fields, found, { into: 'lines', set: { item: 'product', qty: 'n', customer: 'product' } })).toEqual({ name: 'lines', rows: [{ item: 'Cotton', qty: 40 }, { item: 'Silk', qty: 5 }] });
    expect(sectionRows(fields, found, undefined)).toBeUndefined();
    expect(sectionRows(fields, found, { into: 'customer', set: {} })).toBeUndefined();
    expect(sectionRows(fields, [], { into: 'lines', set: {} })).toBeUndefined();
  });

  it('or a row for each of the related rows the first row brings along', () => {
    const found = [{ name: 'Asha', orders: [{ item: 'Cotton', qty: 40 }, 'not a row', null, { item: 'Silk', qty: 5 }] }, { name: 'Someone else', orders: [{ item: 'Theirs', qty: 1 }] }];
    expect(sectionRows(fields, found, { into: 'lines', from: 'orders', set: { item: 'item', qty: 'qty' } })).toEqual({ name: 'lines', rows: [{ item: 'Cotton', qty: 40 }, { item: 'Silk', qty: 5 }] });
    // Named, but the row holds no such list: the section is emptied, not filled with the look-up's own rows.
    expect(sectionRows(fields, found, { into: 'lines', from: 'invoices', set: { item: 'item' } })).toEqual({ name: 'lines', rows: [] });
  });
});

describe('what a public page is told about a form that opens with a record', () => {
  it('only that it does, and whether a link is needed: never the source, the key or the mapping', async () => {
    const { publicCopy } = await import('../src');
    const def = { name: 'R', code: 'R', fields, openWith: { source: '/connectors/abcd1234/customers', param: 'no', by: 'LINK', set: { customer: 'name' }, lock: ['customer'], only: true } } as never;
    const shown = publicCopy(def) as { openWith?: unknown };
    expect(shown.openWith).toEqual({ by: 'LINK', only: true });
    expect(JSON.stringify(shown)).not.toContain('abcd1234');
    expect((publicCopy({ name: 'R', code: 'R', fields } as never) as { openWith?: unknown }).openWith).toBeUndefined();
  });
});

describe('a text answer set out in a shape', () => {
  it('is spaced the way the question asks, however it was typed', async () => {
    const { withLetters, withSpacing } = await import('../src');
    expect(withSpacing('fours', '123456789012')).toBe('1234 5678 9012');
    expect(withSpacing('fours', ' 1234-5678  9012 ')).toBe('1234 5678 9012');
    expect(withSpacing('phone', '9876543210')).toBe('98765 43210');
    expect(withSpacing('threes', '1234567')).toBe('123 456 7');
    // A shape of the designer's own: what is between the #s is put between the characters.
    expect(withSpacing('##-####', 'ab1234')).toBe('ab-1234');
    expect(withSpacing('##/##/####', '01022026')).toBe('01/02/2026');
    // What does not fit is kept, after it; an unfinished answer is not padded out with separators.
    expect(withSpacing('##-##', 'abcdefg')).toBe('ab-cdefg');
    expect(withSpacing('##-##', 'ab')).toBe('ab');
    expect(withSpacing('##-##', 'abc')).toBe('ab-c');
    // Nothing to place, or no shape: as it was.
    expect(withSpacing('fours', '   ')).toBe('   ');
    expect(withSpacing(undefined, 'as typed')).toBe('as typed');
    expect(withSpacing('no slots here', 'as typed')).toBe('as typed');
    // Other scripts' letters and digits are placed like any others.
    expect(withSpacing('## ##', 'कखगघ')).toBe('कख गघ');
    // With letters too: capitals first, then the shape; and only for text questions.
    expect(withLetters({ type: 'TEXT', props: { letters: 'upper', spacing: '##-## ####' } }, 'mh12ab1234')).toBe('MH-12 AB12' + '34');
    expect(withLetters({ type: 'NUMBER', props: { spacing: 'fours' } }, '123456')).toBe('123456');
  });
});

describe('rows that follow an answer', () => {
  it('must be as many as the answer says, within the section\'s own limits, when the form is checked', async () => {
    const { buildZodSchema } = await import('../src');
    const def = {
      name: 'Trip', code: 'TRIP', fields: [
        { id: 'h', type: 'NUMBER', name: 'howMany', label: 'How many travellers' },
        { id: 'r', type: 'REPEAT', name: 'travellers', label: 'Travellers', validation: { max: 3 }, props: { rowsFrom: 'howMany' } },
        { id: 'n', type: 'TEXT', name: 'name', label: 'Name', parentId: 'r' },
      ],
    } as never;
    const check = (values: object) => buildZodSchema(def).safeParse(values);
    expect(check({ howMany: 2, travellers: [{ name: 'A' }, { name: 'B' }] }).success).toBe(true);
    const short = check({ howMany: 3, travellers: [{ name: 'A' }] });
    expect(short.success).toBe(false);
    expect(short.error!.issues[0]).toMatchObject({ path: ['travellers'], message: 'This needs 3 rows, to match the answer it follows' });
    expect(check({ howMany: 1, travellers: [{ name: 'A' }, { name: 'B' }] }).success).toBe(false);
    // More than the section allows is held to what it allows.
    expect(check({ howMany: 9, travellers: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] }).success).toBe(true);
    // No answer to follow yet: nothing to insist on.
    expect(check({ travellers: [{ name: 'A' }] }).success).toBe(true);
  });
});

describe('example answers and the time of day', () => {
  it('"today" in an example answer is the day the form\'s rules call today, whatever the hour and the computer\'s own zone', async () => {
    const { exampleAnswers } = await import('../src');
    const def = { name: 'Claim', code: 'CLAIM', fields: [{ id: 't', type: 'DATE', name: 'tripTo', label: 'Trip ended', required: true }] } as never;
    // The engine has no Node types (it also runs in the browser), so the environment is reached this way.
    const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
    const zone = env.TZ;
    // A computer in India: half past midnight there is still the day before in UTC, which is what today() counts.
    env.TZ = 'Asia/Kolkata';
    try {
      for (const [now, day] of [['2026-10-15T19:00:00Z', '2026-10-15'], ['2026-10-16T06:00:00Z', '2026-10-16'], ['2026-10-16T23:30:00Z', '2026-10-16']] as const) {
        expect((await exampleAnswers(def, { now: new Date(now) })).values.tripTo).toBe(day);
      }
    } finally {
      if (zone === undefined) delete env.TZ;
      else env.TZ = zone;
    }
  });
});
