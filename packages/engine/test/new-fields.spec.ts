import { describe, expect, it } from 'vitest';
import {
  buildDefaultValues,
  buildPayload,
  buildZodSchema,
  computeFormState,
  isContainerField,
  isSignature,
  isValueField,
  MAX_SIGNATURE_LENGTH,
  validateFormDefinition,
} from '../src';
import type { FormField, FormValues } from '../src/types';
import base from './fixtures/customer-complaint-basic.json';

const field = (f: Partial<FormField> & Pick<FormField, 'type' | 'name'>): FormField => ({ id: f.name, label: f.name, ...f });
const options = ['A', 'B', 'C'].map((v) => ({ label: v, value: v }));
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function errors(fields: FormField[], values: FormValues): Record<string, string> {
  const result = buildZodSchema({ fields }).safeParse(values);
  if (result.success) return {};
  return Object.fromEntries(result.error.issues.map((i) => [String(i.path[0]), i.message]));
}
const messages = (fields: Partial<FormField>[]) => {
  const r = validateFormDefinition({ ...base, fields: [...base.fields, ...fields] });
  return r.success ? [] : r.issues.map((i) => i.message);
};

describe('switch, tick-box group, stepper, consent, signature, picture', () => {
  const fields = [
    field({ type: 'SWITCH', name: 'urgent' }),
    field({ type: 'CHECKBOX_GROUP', name: 'days', dataSource: { type: 'STATIC', options }, validation: { min: 1, max: 2 } }),
    field({ type: 'STEPPER', name: 'guests', validation: { min: 1, max: 4 } }),
    field({ type: 'CONSENT', name: 'terms', required: true, props: { text: 'The terms.' } }),
    field({ type: 'SIGNATURE', name: 'sign', required: true }),
    field({ type: 'IMAGE', name: 'logo', props: { src: '/logo.png', alt: 'Logo' } }),
  ];

  it('know what they hold and how they start', () => {
    expect(fields.filter(isValueField).map((f) => f.name)).toEqual(['urgent', 'days', 'guests', 'terms', 'sign']);
    expect(buildDefaultValues({ fields }, {})).toEqual({ urgent: false, days: [], guests: undefined, terms: false, sign: '' });
  });

  it('validate like their plain counterparts', () => {
    const good = { urgent: true, days: ['A'], guests: 2, terms: true, sign: PNG };
    expect(errors(fields, good)).toEqual({});
    expect(errors(fields, { ...good, days: ['A', 'B', 'C'] })).toEqual({ days: 'Select at most 2' });
    expect(errors(fields, { ...good, days: ['Z'] })).toEqual({ days: 'Select a valid option' });
    expect(errors(fields, { ...good, guests: 9 })).toEqual({ guests: 'Must be at most 4' });
    expect(errors(fields, { ...good, terms: false })).toEqual({ terms: 'Please accept to continue' });
    expect(errors(fields, { ...good, sign: '' })).toEqual({ sign: 'Please sign' });
    expect(errors(fields, { ...good, sign: 'data:text/html;base64,PHNjcmlwdD4=' })).toEqual({ sign: 'Sign again' });
  });

  it('a required switch must be on', () => {
    const f = [field({ type: 'SWITCH', name: 'on', required: true })];
    expect(errors(f, { on: false })).toEqual({ on: 'on is required' });
    expect(errors(f, { on: true })).toEqual({});
  });

  it('only a small PNG the browser drew counts as a signature', () => {
    expect(isSignature(PNG)).toBe(true);
    for (const bad of ['', 'hello', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,<script>', `${PNG}"onload="x`, 'javascript:alert(1)', 42, null]) {
      expect(isSignature(bad)).toBe(false);
    }
    expect(isSignature(`data:image/png;base64,${'A'.repeat(MAX_SIGNATURE_LENGTH)}`)).toBe(false);
  });

  it('are submitted and can be calculated', () => {
    const submission = { method: 'POST' as const, endpointId: 'x' };
    expect(buildPayload({ fields, submission }, { urgent: false, days: ['B'], guests: 0, terms: true, sign: PNG, logo: 'x' })).toEqual({
      urgent: false,
      days: ['B'],
      guests: 0,
      terms: true,
      sign: PNG,
    });
    const state = computeFormState(
      {
        fields,
        rules: [
          { id: 'a', then: [{ type: 'SET_VALUE', target: 'urgent', value: 'guests > 3' }] },
          { id: 'b', then: [{ type: 'SET_VALUE', target: 'guests', value: 'length(days) * 2' }] },
        ],
      },
      { days: ['A', 'B'] },
    );
    expect(state.values).toMatchObject({ guests: 4, urgent: true });
  });

  it('are checked when a form is published', () => {
    expect(messages(fields)).toEqual([]);
    expect(messages([{ id: 'i', type: 'IMAGE', name: 'pic', props: { src: 'javascript:alert(1)', alt: 'x' } }])).toEqual(['The picture needs an https:// or site-relative (/…) address']);
    expect(messages([{ id: 'i', type: 'IMAGE', name: 'pic', props: { src: 'https://cdn.example.com/a.png' } }])).toEqual(['Describe the picture for people who cannot see it']);
    expect(messages([{ id: 'i', type: 'IMAGE', name: 'pic', props: { src: '', alt: '' } }])).toEqual([]);
    expect(messages([{ id: 'c', type: 'CONSENT', name: 'ok', label: 'Terms' }])).toEqual(['"ok" needs the terms people are accepting']);
    expect(messages([{ id: 's', type: 'STEPPER', name: 'n', label: 'N', props: { step: 0 } }])).toEqual(['The step must be a number above 0']);
    expect(messages([{ id: 'g', type: 'CHECKBOX_GROUP', name: 'g', label: 'G' }])).toEqual(['CHECKBOX_GROUP field "g" needs a data source']);
    expect(messages([{ id: 's', type: 'SIGNATURE', name: 's' }])).toEqual(['"s" needs a label']);
  });
});

describe('tabs and accordion', () => {
  const tree: Partial<FormField>[] = [
    { id: 't', type: 'TABS', name: 'tabs' },
    { id: 's1', type: 'SECTION', name: 'one', label: 'One', parentId: 't' },
    { id: 'a', type: 'TEXT', name: 'a', label: 'A', parentId: 's1' },
    { id: 's2', type: 'SECTION', name: 'two', label: 'Two', parentId: 't' },
    { id: 'b', type: 'TEXT', name: 'b', label: 'B', parentId: 's2', required: true },
  ];

  it('are containers that hold sections only', () => {
    expect(isContainerField({ type: 'TABS' })).toBe(true);
    expect(isContainerField({ type: 'ACCORDION' })).toBe(true);
    expect(messages(tree)).toEqual([]);
    expect(messages([...tree, { id: 'x', type: 'TEXT', name: 'loose', label: 'Loose', parentId: 't' }])).toEqual([
      'Only sections go directly inside "tabs": put this field in one of them',
    ]);
    expect(messages(tree.map((f) => (f.id === 't' ? { ...f, type: 'ACCORDION' as const } : f)))).toEqual([]);
  });

  it('fields on a tab that is not showing are still required, and hiding the tabs hides them all', () => {
    const fields = tree as FormField[];
    expect(errors(fields, { a: 'x' })).toEqual({ b: 'B is required' });
    const hidden = computeFormState({ fields, rules: [{ id: 'h', then: [{ type: 'HIDE', target: 'tabs' }] }] }, {});
    expect(['one', 'a', 'two', 'b'].map((n) => hidden.states.get(n)?.visible)).toEqual([false, false, false, false]);
  });
});

describe('answers as text', () => {
  it('reads like the form, and never dumps a signature', async () => {
    const { answerText, plainAnswer, csvCell, renderTemplate } = await import('../src');
    expect(plainAnswer(undefined)).toBe('');
    expect(plainAnswer(false)).toBe('No');
    expect(plainAnswer(0)).toBe('0');
    expect(plainAnswer(['A', 'B'])).toBe('A, B');
    expect(plainAnswer([{ uploadId: 'u1', name: 'receipt.pdf' }, { uploadId: 'u2', name: 'photo.png' }])).toBe('receipt.pdf, photo.png');
    expect(plainAnswer(PNG)).toBe('Signed');
    expect(plainAnswer([{ item: 'Pen', qty: 2, gift: true }, { item: 'Ink', qty: 1, note: '' }])).toBe('item: Pen; qty: 2; gift: Yes | item: Ink; qty: 1');
    expect(answerText({ dataSource: { type: 'STATIC', options } }, ['A', 'C'])).toBe('A, C');
    expect(answerText({ dataSource: { type: 'STATIC', options: [{ label: 'High', value: 'H' }] } }, 'H')).toBe('High');
    expect(csvCell(PNG)).toBe('"Signed"');
    expect(renderTemplate('Signed? {{sign}}', { values: { sign: PNG }, record: {}, form: {} } as never, false)).toBe('Signed? Signed');
  });
});

describe("a field drawn by the organisation's own code", () => {
  const rating = field({ type: 'CUSTOM', name: 'rating', label: 'Rate us', props: { custom: 'x-abcd1234-stars' } });
  it('holds text of a sane size, and can be required', () => {
    expect(isValueField(rating)).toBe(true);
    expect(errors([rating], { rating: '4' })).toEqual({});
    expect(errors([rating], { rating: 'x'.repeat(10_001) })).toEqual({ rating: 'This answer is too long' });
    expect(errors([{ ...rating, required: true }], { rating: '' })).toEqual({ rating: 'Rate us is required' });
  });
  it('must say which of the extension\'s fields it is before the form is published', () => {
    const problems = (props: Record<string, unknown>) => {
      const result = validateFormDefinition({ ...base, fields: [{ ...rating, props }] }, 'publish');
      return result.success ? [] : result.issues.map((i) => i.message);
    };
    expect(problems({ custom: 'x-abcd1234-stars' })).toEqual([]);
    expect(problems({})).toEqual(['Choose which of your extension\'s fields "Rate us" is']);
    expect(problems({ custom: 'https://evil.test/field.html' })).toEqual(['Choose which of your extension\'s fields "Rate us" is']);
  });
});

