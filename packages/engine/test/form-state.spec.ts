import { describe, expect, it } from 'vitest';
import { buildPayload, buildZodSchema, computeFieldStates, computeFormState } from '../src';
import type { FormField, FormRule, FormValues } from '../src/types';

const field = (f: Partial<FormField> & Pick<FormField, 'type' | 'name'>): FormField => ({ id: f.name, ...f });
const num = (name: string, extra: Partial<FormField> = {}) => field({ type: 'NUMBER', name, label: name, ...extra });
const submission = { method: 'POST' as const, endpointId: 'x' };

function errors(fields: FormField[], rules: FormRule[], values: FormValues): Record<string, string> {
  const result = buildZodSchema({ fields, rules }).safeParse(values);
  if (result.success) return {};
  return Object.fromEntries(result.error.issues.map((i) => [String(i.path[0]), i.message]));
}

describe('rules — calculations', () => {
  const fields = [num('quantity'), num('unitPrice'), num('subtotal'), num('tax'), num('total')];
  // Deliberately out of order: total is listed before the values it reads.
  const rules: FormRule[] = [
    { id: 'r3', then: [{ type: 'SET_VALUE', target: 'total', value: 'subtotal + tax' }] },
    { id: 'r2', then: [{ type: 'SET_VALUE', target: 'tax', value: 'round(subtotal * 0.18, 2)' }] },
    { id: 'r1', then: [{ type: 'SET_VALUE', target: 'subtotal', value: 'quantity * unitPrice' }] },
  ];

  it('chains through other calculated fields whatever the rule order', () => {
    const state = computeFormState({ fields, rules }, { quantity: 3, unitPrice: 99.99 });
    expect(state.values).toMatchObject({ subtotal: 299.97, tax: 53.99, total: 353.96 });
    expect([...state.calculated].sort()).toEqual(['subtotal', 'tax', 'total']);
  });

  it('does not change the values it was given', () => {
    const input = { quantity: 1, unitPrice: 2 };
    computeFormState({ fields, rules }, input);
    expect(input).toEqual({ quantity: 1, unitPrice: 2 });
  });

  it('the payload carries the computed value, not a tampered one', () => {
    const payload = buildPayload({ fields, rules, submission }, { quantity: 3, unitPrice: 100, subtotal: 1, tax: 0, total: 1 });
    expect(payload).toEqual({ quantity: 3, unitPrice: 100, subtotal: 300, tax: 54, total: 354 });
  });

  it('validation runs on the computed value', () => {
    const limited = [num('quantity'), num('unitPrice'), num('subtotal', { validation: { max: 1000 } })];
    const calc: FormRule[] = [{ id: 'r', then: [{ type: 'SET_VALUE', target: 'subtotal', value: 'quantity * unitPrice' }] }];
    expect(errors(limited, calc, { quantity: 50, unitPrice: 100, subtotal: 5 })).toEqual({ subtotal: 'Must be at most 1000' });
    expect(errors(limited, calc, { quantity: 5, unitPrice: 100, subtotal: 99999 })).toEqual({});
  });

  it('stores the result in the shape of the target field', () => {
    const typed = [
      num('a'),
      field({ type: 'TEXT', name: 'label' }),
      field({ type: 'CHECKBOX', name: 'big' }),
      field({ type: 'DATE', name: 'due' }),
      num('bad'),
    ];
    const state = computeFormState(
      {
        fields: typed,
        rules: [
          {
            id: 'r',
            then: [
              { type: 'SET_VALUE', target: 'label', value: 'a * 2' },
              { type: 'SET_VALUE', target: 'big', value: 'a > 100' },
              { type: 'SET_VALUE', target: 'due', value: 'dateAdd("2026-10-08", a)' },
              { type: 'SET_VALUE', target: 'bad', value: 'a / 0' },
            ],
          },
        ],
      },
      { a: 7, bad: 12 },
    );
    expect(state.values).toMatchObject({ label: '14', big: false, due: '2026-10-15', bad: undefined });
  });

  it('a conditional calculation only takes over while its rule holds', () => {
    const f = [field({ type: 'CHECKBOX', name: 'same' }), field({ type: 'TEXT', name: 'billing' }), field({ type: 'TEXT', name: 'shipping' })];
    const r: FormRule[] = [
      { id: 'r', when: { field: 'same', operator: 'equals', value: true }, then: [{ type: 'SET_VALUE', target: 'shipping', value: 'billing' }] },
    ];
    const on = computeFormState({ fields: f, rules: r }, { same: true, billing: 'Pune', shipping: 'typed' });
    expect(on.values.shipping).toBe('Pune');
    expect(on.calculated.has('shipping')).toBe(true);
    const off = computeFormState({ fields: f, rules: r }, { same: false, billing: 'Pune', shipping: 'typed' });
    expect(off.values.shipping).toBe('typed');
    expect(off.calculated.has('shipping')).toBe(false);
  });

  it('stops on a loop instead of hanging, and gives the same answer every time', () => {
    const loop: FormRule[] = [
      { id: 'a', then: [{ type: 'SET_VALUE', target: 'quantity', value: 'unitPrice + 1' }] },
      { id: 'b', then: [{ type: 'SET_VALUE', target: 'unitPrice', value: 'quantity + 1' }] },
    ];
    const once = computeFormState({ fields, rules: loop }, {}).values;
    expect(computeFormState({ fields, rules: loop }, {}).values).toEqual(once);
  });

  it('skips disabled rules', () => {
    const state = computeFormState({ fields, rules: rules.map((r) => ({ ...r, disabled: true })) }, { quantity: 3, unitPrice: 2, total: 9 });
    expect(state.values.total).toBe(9);
    expect(state.calculated.size).toBe(0);
  });
});

describe('rules — show, hide, require, enable', () => {
  const fields = [
    field({ type: 'DROPDOWN', name: 'kind' }),
    field({ type: 'TEXT', name: 'other', label: 'Other' }),
    field({ type: 'SECTION', name: 'details' }),
    field({ type: 'TEXT', name: 'inside', parentId: 'details' }),
    num('amount'),
    field({ type: 'TEXT', name: 'reason', label: 'Reason' }),
  ];

  it('show also hides while the rule does not hold, and hide is the reverse', () => {
    const rules: FormRule[] = [
      { id: 's', when: { field: 'kind', operator: 'equals', value: 'OTHER' }, then: [{ type: 'SHOW', target: 'other' }] },
      { id: 'h', when: { expr: 'amount > 100' }, then: [{ type: 'HIDE', target: 'reason' }] },
    ];
    const a = computeFieldStates({ fields, rules }, { kind: 'OTHER', amount: 5 });
    expect(a.get('other')?.visible).toBe(true);
    expect(a.get('reason')?.visible).toBe(true);
    const b = computeFieldStates({ fields, rules }, { kind: 'X', amount: 500 });
    expect(b.get('other')?.visible).toBe(false);
    expect(b.get('reason')?.visible).toBe(false);
  });

  it('"otherwise" actions apply while the rule does not hold', () => {
    const rules: FormRule[] = [
      { id: 's', when: { expr: 'amount > 100' }, then: [{ type: 'SHOW', target: 'reason' }], else: [{ type: 'SHOW', target: 'other' }] },
    ];
    const low = computeFieldStates({ fields, rules }, { amount: 1 });
    expect([low.get('reason')?.visible, low.get('other')?.visible]).toEqual([false, true]);
    const high = computeFieldStates({ fields, rules }, { amount: 101 });
    expect([high.get('reason')?.visible, high.get('other')?.visible]).toEqual([true, false]);
  });

  it('hiding a section hides what is inside it', () => {
    const rules: FormRule[] = [{ id: 'h', when: { expr: 'kind == "NONE"' }, then: [{ type: 'HIDE', target: 'details' }] }];
    const states = computeFieldStates({ fields, rules }, { kind: 'NONE' });
    expect(states.get('details')?.visible).toBe(false);
    expect(states.get('inside')?.visible).toBe(false);
  });

  it('a field is visible only when its own rule and every form rule agree', () => {
    const own = fields.map((f) => (f.name === 'other' ? { ...f, visibility: { when: { field: 'amount', operator: 'greaterThan' as const, value: 10 } } } : f));
    const rules: FormRule[] = [{ id: 's', when: { expr: 'kind == "OTHER"' }, then: [{ type: 'SHOW', target: 'other' }] }];
    const visible = (v: FormValues) => computeFieldStates({ fields: own, rules }, v).get('other')?.visible;
    expect(visible({ kind: 'OTHER', amount: 50 })).toBe(true);
    expect(visible({ kind: 'OTHER', amount: 5 })).toBe(false);
    expect(visible({ kind: 'X', amount: 50 })).toBe(false);
  });

  it('a hidden field reads as empty to calculations and other rules', () => {
    const rules: FormRule[] = [
      { id: 'h', when: { expr: 'kind == "FREE"' }, then: [{ type: 'HIDE', target: 'amount' }] },
      { id: 'c', then: [{ type: 'SET_VALUE', target: 'reason', value: 'amount * 2' }] },
    ];
    expect(computeFormState({ fields, rules }, { kind: 'PAID', amount: 10 }).values.reason).toBe('20');
    expect(computeFormState({ fields, rules }, { kind: 'FREE', amount: 10 }).values.reason).toBe('0');
  });

  it('requires a field while the rule holds, and never while it is hidden', () => {
    const rules: FormRule[] = [
      { id: 'q', when: { expr: 'amount > 5000' }, then: [{ type: 'REQUIRE', target: 'reason' }] },
      { id: 'h', when: { expr: 'kind == "SKIP"' }, then: [{ type: 'HIDE', target: 'reason' }] },
    ];
    expect(errors(fields, rules, { amount: 6000 })).toEqual({ reason: 'Reason is required' });
    expect(errors(fields, rules, { amount: 10 })).toEqual({});
    expect(errors(fields, rules, { amount: 6000, kind: 'SKIP' })).toEqual({});
  });

  it('enable and disable, on top of a field that is always disabled', () => {
    const f = [...fields, field({ type: 'TEXT', name: 'fixed', disabled: true })];
    const rules: FormRule[] = [
      { id: 'e', when: { expr: 'amount > 0' }, then: [{ type: 'ENABLE', target: 'reason' }] },
      { id: 'd', when: { expr: 'kind == "LOCK"' }, then: [{ type: 'DISABLE', target: 'other' }] },
    ];
    expect([...computeFormState({ fields: f, rules }, { amount: 0, kind: 'LOCK' }).disabled].sort()).toEqual(['fixed', 'other', 'reason']);
    expect([...computeFormState({ fields: f, rules }, { amount: 1, kind: 'X' }).disabled]).toEqual(['fixed']);
  });
});

describe('rules — errors and options', () => {
  const fields = [
    field({ type: 'DATE', name: 'start', label: 'Start' }),
    field({ type: 'DATE', name: 'end', label: 'End' }),
    field({ type: 'PHONE', name: 'phone', label: 'Phone' }),
    field({ type: 'EMAIL', name: 'email', label: 'Email' }),
  ];
  const rules: FormRule[] = [
    { id: 'd', when: { expr: 'end < start' }, then: [{ type: 'ERROR', target: 'end', message: 'End must be on or after start' }] },
    { id: 'c', when: { expr: 'isEmpty(phone) && isEmpty(email)' }, then: [{ type: 'ERROR', target: 'phone', message: 'Give a phone number or an email' }] },
  ];

  it('faults the target while the rule holds, including an empty one', () => {
    expect(errors(fields, rules, { start: '2026-10-08', end: '2026-10-01', email: 'a@b.co' })).toEqual({ end: 'End must be on or after start' });
    expect(errors(fields, rules, { start: '2026-10-08', end: '2026-10-09' })).toEqual({ phone: 'Give a phone number or an email' });
    expect(errors(fields, rules, { start: '2026-10-08', end: '2026-10-09', phone: '+91 98765 43210' })).toEqual({});
  });

  it("a field's own validation message comes first", () => {
    expect(errors(fields, rules, { start: '2026-10-08', end: 'nonsense', email: 'a@b.co' })).toEqual({ end: 'Enter a valid date' });
  });

  it('an error on a hidden field is not reported', () => {
    const hide: FormRule[] = [...rules, { id: 'h', when: { expr: 'start == "2026-01-01"' }, then: [{ type: 'HIDE', target: 'end' }] }];
    expect(errors(fields, hide, { start: '2026-01-01', end: '2025-01-01', email: 'a@b.co' })).toEqual({});
  });

  it('narrows a static option list and rejects a choice outside it', () => {
    const options = ['S', 'M', 'L', 'XL'].map((v) => ({ label: v, value: v }));
    const f = [
      field({ type: 'DROPDOWN', name: 'range', dataSource: { type: 'STATIC', options: [{ label: 'Kids', value: 'KIDS' }, { label: 'Adult', value: 'ADULT' }] } }),
      field({ type: 'DROPDOWN', name: 'size', dataSource: { type: 'STATIC', options } }),
      field({ type: 'MULTI_SELECT', name: 'sizes', dataSource: { type: 'STATIC', options } }),
    ];
    const r: FormRule[] = [
      {
        id: 'o',
        when: { expr: 'range == "KIDS"' },
        then: [
          { type: 'SET_OPTIONS', target: 'size', values: ['S', 'M'] },
          { type: 'SET_OPTIONS', target: 'sizes', values: ['S', 'M'] },
        ],
      },
      { id: 'o2', when: { expr: 'range == "KIDS"' }, then: [{ type: 'SET_OPTIONS', target: 'size', values: ['M', 'L'] }] },
    ];
    expect([...(computeFormState({ fields: f, rules: r }, { range: 'KIDS' }).options.get('size') ?? [])]).toEqual(['M']);
    expect(computeFormState({ fields: f, rules: r }, { range: 'ADULT' }).options.has('size')).toBe(false);
    expect(errors(f, r, { range: 'KIDS', size: 'S' })).toEqual({ size: 'Select a valid option' });
    expect(errors(f, r, { range: 'KIDS', size: 'M', sizes: ['S', 'XL'] })).toEqual({ sizes: 'Select a valid option' });
    expect(errors(f, r, { range: 'ADULT', size: 'XL', sizes: ['XL'] })).toEqual({});
  });
});

describe('forms without rules behave exactly as before', () => {
  it('computeFieldStates and buildPayload ignore a missing rules list', () => {
    const fields = [field({ type: 'TEXT', name: 'a' }), field({ type: 'TEXT', name: 'b', visibility: { when: { field: 'a', operator: 'equals', value: 'x' } } })];
    expect(computeFieldStates({ fields }, { a: 'y', b: 'kept' }).get('b')).toEqual({ visible: false, required: false });
    expect(buildPayload({ fields, submission }, { a: 'y', b: 'kept' })).toEqual({ a: 'y' });
  });
});
