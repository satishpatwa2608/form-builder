import { describe, expect, it } from 'vitest';
import { buildZodSchema, computeFieldStates } from '../src';
import type { FormField, FormValues } from '../src/types';

const field = (f: Partial<FormField> & Pick<FormField, 'type' | 'name'>): FormField => ({ id: f.name, ...f });

/** Field name -> first error message, for fields that failed. */
function errors(fields: FormField[], values: FormValues): Record<string, string> {
  const result = buildZodSchema({ fields }).safeParse(values);
  if (result.success) return {};
  return Object.fromEntries(result.error.issues.map((i) => [String(i.path[0]), i.message]));
}

describe('buildZodSchema — required', () => {
  it('reports required fields that are empty, using the label', () => {
    const fields = [field({ type: 'TEXT', name: 'name', label: 'Name', required: true })];
    expect(errors(fields, { name: '' })).toEqual({ name: 'Name is required' });
    expect(errors(fields, { name: '   ' })).toEqual({ name: 'Name is required' });
    expect(errors(fields, { name: 'Asha' })).toEqual({});
  });

  it('leaves optional empty fields alone but still validates them when filled', () => {
    const fields = [field({ type: 'EMAIL', name: 'email' })];
    expect(errors(fields, { email: '' })).toEqual({});
    expect(errors(fields, { email: 'nope' })).toEqual({ email: 'Enter a valid email address' });
  });

  it('a required checkbox must be ticked', () => {
    const fields = [field({ type: 'CHECKBOX', name: 'consent', label: 'Consent', required: true })];
    expect(errors(fields, { consent: false })).toEqual({ consent: 'Consent is required' });
    expect(errors(fields, { consent: true })).toEqual({});
  });

  it('uses a custom required message', () => {
    const fields = [
      field({ type: 'TEXT', name: 'n', required: true, validation: { messages: { required: 'Tell us your name' } } }),
    ];
    expect(errors(fields, {})).toEqual({ n: 'Tell us your name' });
  });

  it('CAPTCHA is always required', () => {
    expect(errors([field({ type: 'CAPTCHA', name: 'captchaToken' })], { captchaToken: '' })).toEqual({
      captchaToken: 'Please complete the verification',
    });
  });
});

describe('buildZodSchema — value rules', () => {
  it('text length and pattern', () => {
    const fields = [
      field({ type: 'TEXT', name: 't', validation: { minLength: 3, maxLength: 5 } }),
      field({ type: 'TEXT', name: 'code', validation: { pattern: '^[A-Z]{3}$', messages: { pattern: 'Three capitals' } } }),
    ];
    expect(errors(fields, { t: 'ab', code: 'ABC' })).toEqual({ t: 'Must be at least 3 characters' });
    expect(errors(fields, { t: 'abcdef', code: 'abc' })).toEqual({
      t: 'Must be at most 5 characters',
      code: 'Three capitals',
    });
  });

  it('number bounds', () => {
    const fields = [field({ type: 'NUMBER', name: 'n', validation: { min: 1, max: 10 } })];
    expect(errors(fields, { n: 0 })).toEqual({ n: 'Must be at least 1' });
    expect(errors(fields, { n: 11 })).toEqual({ n: 'Must be at most 10' });
    expect(errors(fields, { n: 5 })).toEqual({});
    expect(errors(fields, { n: undefined })).toEqual({});
  });

  it('phone uses a default pattern', () => {
    const fields = [field({ type: 'PHONE', name: 'p' })];
    expect(errors(fields, { p: '+91 98765 43210' })).toEqual({});
    expect(errors(fields, { p: 'call me' })).toHaveProperty('p');
  });

  it('date must parse', () => {
    const fields = [field({ type: 'DATE', name: 'd' })];
    expect(errors(fields, { d: '2026-09-29' })).toEqual({});
    expect(errors(fields, { d: 'yesterday' })).toEqual({ d: 'Enter a valid date' });
  });

  it('static dropdown values must be one of the options', () => {
    const fields = [
      field({
        type: 'DROPDOWN',
        name: 'c',
        dataSource: { type: 'STATIC', options: [{ label: 'A', value: 'A' }] },
      }),
    ];
    expect(errors(fields, { c: 'A' })).toEqual({});
    expect(errors(fields, { c: 'Z' })).toEqual({ c: 'Select a valid option' });
  });

  it('hidden, html and button fields are never validated', () => {
    const fields = [
      field({ type: 'HIDDEN', name: 'h', required: true }),
      field({ type: 'HTML', name: 'html' }),
      field({ type: 'BUTTON', name: 'b' }),
    ];
    expect(errors(fields, {})).toEqual({});
  });
});

describe('buildZodSchema — conditional rules', () => {
  const category = field({
    type: 'DROPDOWN',
    name: 'category',
    dataSource: { type: 'STATIC', options: [{ label: 'P', value: 'PRODUCT' }, { label: 'B', value: 'BILLING' }] },
  });
  const productName = field({
    type: 'TEXT',
    name: 'productName',
    label: 'Product Name',
    required: true,
    visibility: { when: { field: 'category', operator: 'equals', value: 'PRODUCT' } },
  });

  it('skips a required field while it is hidden', () => {
    expect(errors([category, productName], { category: 'BILLING', productName: '' })).toEqual({});
    expect(errors([category, productName], { category: 'PRODUCT', productName: '' })).toEqual({
      productName: 'Product Name is required',
    });
  });

  it('does not validate the stale value of a hidden field', () => {
    const withMin = { ...productName, required: false, validation: { minLength: 10 } };
    expect(errors([category, withMin], { category: 'BILLING', productName: 'short' })).toEqual({});
  });

  it('requiredWhen switches required on and off', () => {
    const fields = [
      field({ type: 'CHECKBOX', name: 'contactMe' }),
      field({
        type: 'PHONE',
        name: 'phone',
        label: 'Phone',
        requiredWhen: { field: 'contactMe', operator: 'equals', value: true },
      }),
    ];
    expect(errors(fields, { contactMe: false, phone: '' })).toEqual({});
    expect(errors(fields, { contactMe: true, phone: '' })).toEqual({ phone: 'Phone is required' });
  });

  it('a field whose controlling field is hidden is hidden too (cascade)', () => {
    const fields = [
      field({ type: 'TEXT', name: 'a' }),
      field({ type: 'TEXT', name: 'b', visibility: { when: { field: 'a', operator: 'equals', value: 'show' } } }),
      field({
        type: 'TEXT',
        name: 'c',
        required: true,
        visibility: { when: { field: 'b', operator: 'equals', value: 'show' } },
      }),
    ];
    // b keeps its stale "show", but b is hidden, so c must be hidden as well.
    const states = computeFieldStates({ fields }, { a: 'hide', b: 'show', c: '' });
    expect(states.get('b')?.visible).toBe(false);
    expect(states.get('c')?.visible).toBe(false);
    expect(errors(fields, { a: 'hide', b: 'show', c: '' })).toEqual({});
    expect(errors(fields, { a: 'show', b: 'show', c: '' })).toHaveProperty('c');
  });
});
