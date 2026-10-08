import { describe, expect, it } from 'vitest';
import {
  answerFields,
  buildDefaultValues,
  buildPayload,
  buildZodSchema,
  computeFormState,
  defaultRow,
  formShape,
  isContainerField,
  isRowField,
  isValueField,
  MAX_ROWS,
  plainAnswer,
  rowsOf,
  rowsText,
  validateFormDefinition,
  valueAt,
  valuesFromPayload,
} from '../src';
import type { FormField, FormRule, FormValues } from '../src/types';
import base from './fixtures/customer-complaint-basic.json';

const field = (f: Partial<FormField> & Pick<FormField, 'type' | 'name'>): FormField => ({ id: f.name, label: f.name, ...f });
const submission = { method: 'POST' as const, endpointId: 'x' };
const kinds = [{ label: 'Goods', value: 'GOODS' }, { label: 'Service', value: 'SERVICE' }];

/** An order: a customer, then lines of item / kind / qty / price / lineTotal, then totals. */
const fields: FormField[] = [
  field({ type: 'TEXT', name: 'customer' }),
  field({ type: 'NUMBER', name: 'discount' }),
  field({ type: 'REPEAT', name: 'lines', label: 'Lines', validation: { min: 1, max: 3 } }),
  field({ type: 'TEXT', name: 'item', parentId: 'lines', required: true }),
  field({ type: 'COLUMNS', name: 'cols', parentId: 'lines', props: { columns: [1, 1] } }),
  field({ type: 'DROPDOWN', name: 'kind', parentId: 'cols', column: 0, dataSource: { type: 'STATIC', options: kinds } }),
  field({ type: 'NUMBER', name: 'qty', parentId: 'cols', column: 1, validation: { min: 1 } }),
  field({ type: 'NUMBER', name: 'price', parentId: 'lines' }),
  field({ type: 'NUMBER', name: 'lineTotal', parentId: 'lines' }),
  field({ type: 'TEXT', name: 'serial', parentId: 'lines' }),
  field({ type: 'NUMBER', name: 'subtotal' }),
  field({ type: 'NUMBER', name: 'total' }),
];
const rules: FormRule[] = [
  { id: 'line', then: [{ type: 'SET_VALUE', target: 'lineTotal', value: 'qty * price' }] },
  { id: 'sub', then: [{ type: 'SET_VALUE', target: 'subtotal', value: 'sum(lineTotal)' }] },
  { id: 'tot', then: [{ type: 'SET_VALUE', target: 'total', value: 'round(subtotal * (1 - discount / 100), 2)' }] },
  { id: 'serial', when: { expr: 'kind == "GOODS"' }, then: [{ type: 'SHOW', target: 'serial' }, { type: 'REQUIRE', target: 'serial' }] },
  { id: 'bulk', when: { expr: 'qty > 100' }, then: [{ type: 'ERROR', target: 'qty', message: 'Ask for a quote above 100' }] },
];
const order = (lines: FormValues[], extra: FormValues = {}): FormValues => ({ customer: 'Acme', lines, ...extra });

function errors(values: FormValues, f = fields, r = rules): Record<string, string> {
  const result = buildZodSchema({ fields: f, rules: r }).safeParse(values);
  if (result.success) return {};
  return Object.fromEntries(result.error.issues.map((i) => [i.path.join('.'), i.message]));
}

describe('repeating section — shape', () => {
  it('is a container that also holds a value; its fields live in its rows', () => {
    const repeat = fields[2];
    expect(isContainerField(repeat)).toBe(true);
    expect(isValueField(repeat)).toBe(true);
    expect(answerFields(fields).map((f) => f.name)).toEqual(['customer', 'discount', 'lines', 'subtotal', 'total']);
    expect(formShape(fields).repeats[0].valueChildren.map((f) => f.name)).toEqual(['item', 'kind', 'qty', 'price', 'lineTotal', 'serial']);
    expect(isRowField(fields, { name: 'qty' })).toBe(true); // through the columns block
    expect(isRowField(fields, { name: 'total' })).toBe(false);
  });

  it('starts with as many rows as it must have', () => {
    expect(buildDefaultValues({ fields }, {})).toEqual({
      customer: '',
      discount: undefined,
      lines: [{ item: '', kind: '', qty: undefined, price: undefined, lineTotal: undefined, serial: '' }],
      subtotal: undefined,
      total: undefined,
    });
    expect(defaultRow({ fields: [...fields.slice(0, 3), field({ type: 'NUMBER', name: 'n', parentId: 'lines', defaultValue: 1 })] }, fields[2])).toEqual({ n: 1 });
    const optional = fields.map((f) => (f.name === 'lines' ? { ...f, validation: undefined } : f));
    expect(buildDefaultValues({ fields: optional }, {}).lines).toEqual([]);
    expect(buildDefaultValues({ fields: optional.map((f) => (f.name === 'lines' ? { ...f, required: true } : f)) }, {}).lines).toHaveLength(1);
  });

  it('reads whatever was sent as a list of rows', () => {
    expect(rowsOf(undefined)).toEqual([]);
    expect(rowsOf('x')).toEqual([]);
    expect(rowsOf([{ a: 1 }, 'junk', null, [1]])).toEqual([{ a: 1 }, {}, {}, {}]);
    expect(rowsOf(Array.from({ length: MAX_ROWS + 50 }, () => ({})))).toHaveLength(MAX_ROWS);
    expect(valueAt({ lines: [{ qty: 2 }, { qty: 5 }], total: 9 }, 'lines.1.qty')).toBe(5);
    expect(valueAt({ lines: [{ qty: 2 }], total: 9 }, 'total')).toBe(9);
    expect(valueAt({ lines: [{ qty: 2 }] }, 'lines.4.qty')).toBeUndefined();
    expect(valueAt({ lines: [{}] }, 'lines.0.constructor')).toBeUndefined();
  });
});

describe('repeating section — rules run row by row', () => {
  const lines = [
    { item: 'Pen', kind: 'GOODS', qty: 3, price: 10, serial: 'S1' },
    { item: 'Setup', kind: 'SERVICE', qty: 1, price: 250, serial: 'left over' },
  ];

  it('calculates inside each row, and totals the column outside', () => {
    const state = computeFormState({ fields, rules }, order(lines, { discount: 10 }));
    expect((state.values.lines as FormValues[]).map((r) => r.lineTotal)).toEqual([30, 250]);
    expect(state.values).toMatchObject({ subtotal: 280, total: 252 });
    expect([...state.calculated].sort()).toEqual(['lines.0.lineTotal', 'lines.1.lineTotal', 'subtotal', 'total']);
  });

  it('does not change the rows it was given', () => {
    const input = order(lines);
    const before = JSON.stringify(input);
    computeFormState({ fields, rules }, input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('shows, requires and faults a field in one row only', () => {
    const state = computeFormState({ fields, rules }, order([{ ...lines[0], serial: '' }, { ...lines[1], qty: 500 }]));
    expect(state.states.get('lines.0.serial')).toEqual({ visible: true, required: true });
    expect(state.states.get('lines.1.serial')).toEqual({ visible: false, required: false });
    expect(state.errors.get('lines.1.qty')).toBe('Ask for a quote above 100');
    expect(state.errors.has('lines.0.qty')).toBe(false);
    // Under its plain name: the field as the section's template.
    expect(state.states.get('serial')).toEqual({ visible: true, required: false });
  });

  it('a hidden answer in a row reads as empty to calculations', () => {
    const r: FormRule[] = [
      { id: 'h', when: { expr: 'kind == "SERVICE"' }, then: [{ type: 'HIDE', target: 'qty' }] },
      { id: 'c', then: [{ type: 'SET_VALUE', target: 'lineTotal', value: 'qty * price' }] },
      { id: 's', then: [{ type: 'SET_VALUE', target: 'subtotal', value: 'sum(lineTotal)' }] },
    ];
    const state = computeFormState({ fields, rules: r }, order(lines));
    expect((state.values.lines as FormValues[]).map((row) => row.lineTotal)).toEqual([30, 0]);
    expect(state.values.subtotal).toBe(30);
  });

  it('a rule outside the section can read the whole column', () => {
    const r: FormRule[] = [
      { id: 'big', when: { expr: 'sum(qty) > 3 || count(lines) > 1' }, then: [{ type: 'REQUIRE', target: 'customer' }] },
      { id: 'n', then: [{ type: 'SET_VALUE', target: 'discount', value: 'count(lines)' }] },
    ];
    const state = computeFormState({ fields, rules: r }, { lines });
    expect(state.states.get('customer')?.required).toBe(true);
    expect(state.values.discount).toBe(2);
    expect(computeFormState({ fields, rules: r }, { lines: [lines[1]] }).states.get('customer')?.required).toBe(false);
  });

  it('a row can read the fields around the section', () => {
    const r: FormRule[] = [{ id: 'c', then: [{ type: 'SET_VALUE', target: 'lineTotal', value: 'qty * price * (1 - discount / 100)' }] }];
    const state = computeFormState({ fields, rules: r }, order(lines, { discount: 50 }));
    expect((state.values.lines as FormValues[]).map((row) => row.lineTotal)).toEqual([15, 125]);
  });

  it('hiding the section hides its rows and empties its column', () => {
    const r: FormRule[] = [...rules, { id: 'h', when: { expr: 'customer == "none"' }, then: [{ type: 'HIDE', target: 'lines' }] }];
    const state = computeFormState({ fields, rules: r }, order(lines, { customer: 'none' }));
    expect(state.states.get('lines')?.visible).toBe(false);
    expect(state.states.get('item')?.visible).toBe(false);
    expect(state.values.subtotal).toBe(0);
    expect(buildPayload({ fields, rules: r, submission }, order(lines, { customer: 'none' }))).toEqual({ customer: 'none', subtotal: 0, total: 0 });
  });

  it("a field's own show-when and required-when work in a row", () => {
    const f = fields.map((x) =>
      x.name === 'serial' ? { ...x, visibility: { when: { field: 'kind', operator: 'equals' as const, value: 'GOODS' } }, requiredWhen: { field: 'qty', operator: 'greaterThan' as const, value: 1 } } : x,
    );
    const state = computeFormState({ fields: f }, order([{ ...lines[0], qty: 1 }, lines[0], lines[1]]));
    expect([0, 1, 2].map((i) => state.states.get(`lines.${i}.serial`))).toEqual([
      { visible: true, required: false },
      { visible: true, required: true },
      { visible: false, required: false },
    ]);
  });

  it('narrows options and disables per row', () => {
    const r: FormRule[] = [
      { id: 'o', when: { expr: 'qty > 5' }, then: [{ type: 'SET_OPTIONS', target: 'kind', values: ['GOODS'] }] },
      { id: 'd', when: { expr: 'isEmpty(item)' }, then: [{ type: 'DISABLE', target: 'price' }] },
    ];
    const state = computeFormState({ fields, rules: r }, order([{ item: '', qty: 9 }, { item: 'Pen', qty: 1 }]));
    expect([...(state.options.get('lines.0.kind') ?? [])]).toEqual(['GOODS']);
    expect(state.options.has('lines.1.kind')).toBe(false);
    expect(state.disabled.has('lines.0.price')).toBe(true);
    expect(state.disabled.has('lines.1.price')).toBe(false);
  });
});

describe('repeating section — validation and payload', () => {
  it('checks each row, reporting where the mistake is', () => {
    expect(errors(order([{ item: 'Pen', kind: 'GOODS', qty: 3, price: 10, serial: 'S1' }]))).toEqual({});
    expect(
      errors(
        order([
          { item: '', kind: 'GOODS', qty: 0, price: 10, serial: '' },
          { item: 'Setup', kind: 'NOPE', qty: 500, price: 1 },
        ]),
      ),
    ).toEqual({
      'lines.0.item': 'item is required',
      'lines.0.qty': 'Must be at least 1',
      'lines.0.serial': 'serial is required',
      'lines.1.kind': 'Select a valid option',
      'lines.1.qty': 'Ask for a quote above 100',
    });
  });

  it('checks the number of rows', () => {
    const row = { item: 'x', qty: 1, price: 1 };
    expect(errors(order([]))).toEqual({ lines: 'Add at least 1 rows' });
    expect(errors(order([row, row, row, row]))).toEqual({ lines: 'No more than 3 rows' });
    const required = fields.map((f) => (f.name === 'lines' ? { ...f, required: true, validation: undefined } : f));
    expect(errors(order([]), required)).toEqual({ lines: 'Add at least one row to Lines' });
    const custom = fields.map((f) => (f.name === 'lines' ? { ...f, validation: { min: 2, messages: { min: 'Two lines at least' } } } : f));
    expect(errors(order([row]), custom)).toEqual({ lines: 'Two lines at least' });
    // Whatever the form says, never more than the hard limit.
    const unlimited = fields.map((f) => (f.name === 'lines' ? { ...f, validation: undefined } : f));
    expect(errors(order(Array.from({ length: MAX_ROWS + 1 }, () => row)), unlimited, [])).toEqual({});
  });

  it('validation runs on the calculated value of a row', () => {
    const f = fields.map((x) => (x.name === 'lineTotal' ? { ...x, validation: { max: 100 } } : x));
    expect(errors(order([{ item: 'Pen', qty: 20, price: 10, lineTotal: 1 }]), f)).toEqual({ 'lines.0.lineTotal': 'Must be at most 100' });
  });

  it('the payload carries computed rows without hidden or empty answers, whatever was sent', () => {
    const payload = buildPayload(
      { fields, rules, submission: { ...submission, mapping: { lines: 'orderLines', total: 'grandTotal' } } },
      order([
        { item: 'Pen', kind: 'GOODS', qty: 3, price: 10, lineTotal: 999999, serial: 'S1', hacked: true },
        { item: 'Setup', kind: 'SERVICE', qty: 1, price: 250, lineTotal: 0, serial: 'should go' },
      ], { subtotal: 1, total: 1 }),
    );
    expect(payload).toEqual({
      customer: 'Acme',
      orderLines: [
        { item: 'Pen', kind: 'GOODS', qty: 3, price: 10, lineTotal: 30, serial: 'S1' },
        { item: 'Setup', kind: 'SERVICE', qty: 1, price: 250, lineTotal: 250 },
      ],
      subtotal: 280,
      grandTotal: 280,
    });
    expect(valuesFromPayload({ fields, submission: { ...submission, mapping: { lines: 'orderLines' } } }, payload)).toMatchObject({ lines: payload.orderLines, subtotal: 280 });
  });

  it('reads as text', () => {
    expect(plainAnswer([{ item: 'Pen', qty: 3 }, { item: 'Ink', qty: 1 }])).toBe('item: Pen; qty: 3 | item: Ink; qty: 1');
    const children = formShape(fields).repeats[0].valueChildren.map((c) => (c.name === 'kind' ? c : { ...c, label: c.name.toUpperCase() }));
    expect(rowsText(children, [{ item: 'Pen', kind: 'GOODS', qty: 3, serial: '' }, { item: 'Ink', qty: 1 }, 'junk'])).toBe(
      '1. ITEM: Pen; kind: Goods; QTY: 3\n2. ITEM: Ink; QTY: 1\n3. ',
    );
    expect(rowsText(children, undefined)).toBe('');
  });
});

describe('repeating section — in a definition', () => {
  const lines = { id: 'r', type: 'REPEAT', name: 'lines', label: 'Lines', props: { totals: ['qty'] } };
  const qty = { id: 'q', type: 'NUMBER', name: 'qty', label: 'Qty', parentId: 'r' };
  const messages = (extra: Partial<FormField>[], patch: Record<string, unknown> = {}) => {
    const r = validateFormDefinition({ ...base, fields: [...base.fields, ...extra], ...patch });
    return r.success ? [] : r.issues.map((i) => i.message);
  };

  it('accepts a section with fields, limits and totals', () => {
    expect(messages([{ ...lines, validation: { min: 1, max: 20 } } as never, qty as never])).toEqual([]);
  });

  it('needs a label; one with no fields yet is allowed, like a button with no link', () => {
    expect(messages([{ ...lines, label: undefined, props: {} } as never])).toEqual(['"lines" needs a label']);
  });

  it('refuses what cannot repeat', () => {
    const inside = (f: Record<string, unknown>) => messages([{ ...lines, props: {} } as never, qty as never, { id: 'x', name: 'x', label: 'X', parentId: 'r', ...f } as never]);
    expect(inside({ type: 'FILE' })).toEqual(['A FILE field cannot go inside the repeating section "lines"']);
    expect(inside({ type: 'SIGNATURE' })).toEqual(['A SIGNATURE field cannot go inside the repeating section "lines"']);
    expect(inside({ type: 'REPEAT' })).toEqual(['A REPEAT field cannot go inside the repeating section "lines"']);
    expect(inside({ type: 'TEXT', prefill: { source: 'USER_NAME' } })).toEqual(['"x" is filled from the system, which does not work inside the repeating section "lines"']);
    expect(inside({ type: 'DROPDOWN', dataSource: { type: 'API', api: { url: 'u', method: 'GET', valueField: 'a', labelField: 'b' } } })).toEqual([
      'Use a fixed option list inside the repeating section "lines"',
    ]);
  });

  it('checks limits, totals, mapping and events', () => {
    expect(messages([{ ...lines, validation: { max: 500 } } as never, qty as never])).toEqual([`A repeating section can have at most ${MAX_ROWS} rows`]);
    expect(messages([{ ...lines, props: { totals: ['qty', 'name'] } } as never, qty as never])).toEqual(['Only a number field inside "lines" can be totalled, not "name"']);
    expect(messages([lines as never, qty as never], { submission: { ...base.submission, mapping: { qty: 'quantity' } } })).toEqual([
      '"qty" is inside a repeating section and is saved with its rows',
    ]);
    expect(messages([lines as never, qty as never], { events: [{ id: 'e', on: { type: 'LOAD' }, do: [{ type: 'SET_VALUE', target: 'qty', value: '1' }] }] })).toEqual([
      '"qty" is inside a repeating section; an event cannot fill it',
    ]);
  });
});
