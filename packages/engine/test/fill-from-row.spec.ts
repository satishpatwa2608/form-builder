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
