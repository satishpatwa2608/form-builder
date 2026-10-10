import { describe, expect, it } from 'vitest';
import { needsCode, publicCopy, validateFormDefinition } from '../src';
import type { FormDefinition, FormField } from '../src/types';
import base from './fixtures/customer-complaint-basic.json';

const field = (f: Partial<FormField> & Pick<FormField, 'type' | 'name'>): FormField => ({ id: f.name, label: f.name, ...f });
const form = (fields: FormField[], more: Partial<FormDefinition> = {}) => ({ ...(base as unknown as FormDefinition), captcha: undefined, rules: [], events: [], fields, ...more });
const issues = (def: FormDefinition) => {
  const result = validateFormDefinition(def);
  return result.success ? [] : result.issues.map((i) => `${i.path}: ${i.message}`);
};

describe('confirming an answer with a one-time code', () => {
  it('is for email and phone fields of the form itself', () => {
    expect(needsCode(field({ type: 'EMAIL', name: 'e', props: { verify: true } }))).toBe(true);
    expect(needsCode(field({ type: 'PHONE', name: 'p', props: { verify: true } }))).toBe(true);
    expect(needsCode(field({ type: 'EMAIL', name: 'e' }))).toBe(false);
    expect(needsCode(field({ type: 'TEXT', name: 't', props: { verify: true } }))).toBe(false);
    expect(issues(form([field({ type: 'EMAIL', name: 'e', props: { verify: true } }), field({ type: 'PHONE', name: 'p', props: { verify: true } })]))).toEqual([]);
    expect(issues(form([field({ type: 'TEXT', name: 't', props: { verify: true } })]))).toEqual(['fields.0.props: Only an email or a phone field can be confirmed with a code']);
    expect(issues(form([field({ type: 'REPEAT', name: 'people' }), field({ type: 'EMAIL', name: 'e', parentId: 'people', props: { verify: true } })]))).toEqual([
      'fields.1.props: "e" is inside a repeating section, where a code cannot be asked for',
    ]);
  });
});

describe('taking a payment with a response', () => {
  const fields = [field({ type: 'TEXT', name: 'name' }), field({ type: 'NUMBER', name: 'fee' })];

  it('names a number field of the form as the amount, and a currency', () => {
    expect(issues(form(fields, { payment: { enabled: true, amountField: 'fee', currency: 'INR', description: 'Application fee' } }))).toEqual([]);
    expect(issues(form(fields, { payment: { enabled: true, amountField: '', currency: 'INR' } }))).toEqual(['payment.amountField: Choose the field that holds the amount to pay']);
    expect(issues(form(fields, { payment: { enabled: true, amountField: 'name', currency: 'INR' } }))).toEqual(['payment.amountField: "name" is not a number field of the form itself']);
    expect(issues(form(fields, { payment: { enabled: true, amountField: 'fee', currency: 'rupees' } }))).toEqual(['payment.currency: Use a currency code such as INR, USD or CAD']);
    const inRows = [field({ type: 'REPEAT', name: 'lines' }), field({ type: 'NUMBER', name: 'amt', parentId: 'lines' }), field({ type: 'TEXT', name: 'name' })];
    expect(issues(form(inRows, { payment: { enabled: true, amountField: 'amt', currency: 'INR' } }))).toEqual(['payment.amountField: "amt" is not a number field of the form itself']);
  });

  it('switched off, it is not checked: a half-set-up payment does not stop a form being published', () => {
    expect(issues(form(fields, { payment: { enabled: false, amountField: '', currency: 'INR' } }))).toEqual([]);
  });

  it('the public copy of the form says a payment is due, so the page can say so before the person starts', () => {
    const copy = publicCopy(form(fields, { payment: { enabled: true, amountField: 'fee', currency: 'INR' } }));
    expect(copy.payment).toEqual({ enabled: true, amountField: 'fee', currency: 'INR' });
  });
});
