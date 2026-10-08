import { describe, expect, it } from 'vitest';
import { clickableButtons, eventActions, eventSources, isTimeZone, safeLinkUrl, systemContextFor, validateFormDefinition } from '../src';
import type { FormDefinition, FormEvent } from '../src/types';
import base from './fixtures/customer-complaint-basic.json';

const fields = [
  ...base.fields,
  { id: 'btn', type: 'BUTTON', name: 'lookup', label: 'Look up' },
  { id: 'sec', type: 'SECTION', name: 'details', label: 'Details' },
  { id: 'in', type: 'TEXT', name: 'inner', label: 'Inner', parentId: 'sec' },
];
const def = (events: unknown[], extra: Record<string, unknown> = {}) => ({ ...base, fields, layout: { mode: 'steps' }, events, ...extra });
const messages = (events: unknown[], extra: Record<string, unknown> = {}, level: 'shape' | 'publish' = 'publish') => {
  const r = validateFormDefinition(def(events, extra), level);
  return r.success ? [] : r.issues.map((i) => `${i.path}: ${i.message}`);
};
const source = { url: 'customers', method: 'GET' as const, params: { email: '{{email}}' } };

const events: FormEvent[] = [
  { id: 'open', on: { type: 'LOAD' }, do: [{ type: 'SET_VALUE', target: 'incidentDate', value: 'today()' }] },
  {
    id: 'find',
    on: { type: 'CLICK', field: 'lookup' },
    when: { expr: '!isEmpty(email)' },
    do: [
      { type: 'FETCH', source, set: { name: 'fullName', phone: 'contact.phone' } },
      { type: 'GO_TO_STEP', step: 'details' },
    ],
  },
  { id: 'big', on: { type: 'SUBMIT_SUCCESS' }, when: { expr: 'amountDisputed > 5000' }, do: [{ type: 'SHOW_MESSAGE', message: 'A manager will call you.' }] },
  { id: 'thanks', on: { type: 'SUBMIT_SUCCESS' }, do: [{ type: 'REDIRECT', url: '/thanks' }] },
  { id: 'oops', on: { type: 'SUBMIT_ERROR' }, do: [{ type: 'SHOW_MESSAGE', message: 'Please call us instead.' }] },
  { id: 'off', disabled: true, on: { type: 'CLICK', field: 'lookup' }, do: [{ type: 'SET_VALUE', target: 'name', value: '"x"' }] },
];

describe('form events — in a definition', () => {
  it('accepts every trigger and action', () => {
    expect(messages(events)).toEqual([]);
  });

  it('a draft may hold a half-built event; publishing may not', () => {
    const half = [{ id: 'e', on: { type: 'CLICK', field: 'gone' }, do: [{ type: 'SET_VALUE', target: 'gone', value: '1' }] }];
    expect(messages(half, {}, 'shape')).toEqual([]);
    expect(messages(half)).toEqual(['events.0.on: Unknown button "gone"', 'events.0.do.0: Acts on unknown field "gone"']);
    expect(messages([{ id: 'e', on: { type: 'HOVER' }, do: [] }], {}, 'shape')).not.toEqual([]);
  });

  it('checks the trigger, the condition and each action', () => {
    const one = (event: Partial<FormEvent>, extra = {}) => messages([{ id: 'e', on: { type: 'LOAD' }, do: [{ type: 'SET_VALUE', target: 'name', value: '"x"' }], ...event }], extra);
    expect(one({ on: { type: 'CLICK', field: 'name' } })).toEqual(['events.0.on: "name" is not a button']);
    expect(one({ when: { expr: 'ghost > 1' } })).toEqual(['events.0.when: Refers to unknown field "ghost"']);
    expect(one({ do: [{ type: 'SET_VALUE', target: 'businessId', value: '1' }] })).toEqual(['events.0.do.0: "businessId" already takes its value from the system']);
    expect(one({ do: [{ type: 'SET_VALUE', target: 'name', value: 'launch()' }] })).toEqual(['events.0.do.0: Unknown function "launch"']);
    expect(one({ do: [{ type: 'FETCH', source: { ...source, params: { q: '{{ghost}}' } }, set: {} }] })).toEqual([
      'events.0.do.0: Parameter refers to unknown field "ghost"',
      'events.0.do.0: Choose at least one field to fill in',
    ]);
    expect(one({ on: { type: 'CLICK', field: 'lookup' }, do: [{ type: 'GO_TO_STEP', step: 'inner' }] })).toEqual(['events.0.do.0: "inner" is not one of the form\'s steps']);
    expect(one({ on: { type: 'CLICK', field: 'lookup' }, do: [{ type: 'GO_TO_STEP', step: 'details' }] }, { layout: { mode: 'single' } })).toEqual([
      'events.0.do.0: The form is not laid out in steps',
    ]);
  });

  it('keeps each action to the moments it makes sense', () => {
    const fit = (on: FormEvent['on'], action: FormEvent['do'][number]) => messages([{ id: 'e', on, do: [action] }]);
    const misfit = ['events.0.do.0: This action does not fit when the event happens'];
    expect(fit({ type: 'LOAD' }, { type: 'REDIRECT', url: '/x' })).toEqual(misfit);
    expect(fit({ type: 'LOAD' }, { type: 'GO_TO_STEP', step: 'details' })).toEqual(misfit);
    expect(fit({ type: 'SUBMIT_ERROR' }, { type: 'REDIRECT', url: '/x' })).toEqual(misfit);
    expect(fit({ type: 'SUBMIT_SUCCESS' }, { type: 'SET_VALUE', target: 'name', value: '"x"' })).toEqual(misfit);
  });

  it('only redirects to https or a path on the same site', () => {
    const go = (url: string) => messages([{ id: 'e', on: { type: 'SUBMIT_SUCCESS' }, do: [{ type: 'REDIRECT', url }] }]);
    expect(go('https://example.com/done')).toEqual([]);
    expect(go('/thanks?ref=1')).toEqual([]);
    for (const url of ['http://example.com', 'javascript:alert(1)', '//evil.test', 'data:text/html,x', 'https://a b']) {
      expect(go(url)).toHaveLength(1);
      expect(safeLinkUrl(url)).toBeUndefined();
    }
  });
});

describe('form events — at run time', () => {
  const form = def(events) as unknown as FormDefinition;

  it('gives the actions for what just happened, in order, when the condition holds', () => {
    expect(eventActions(form, { type: 'LOAD' }, {}).map((a) => a.type)).toEqual(['SET_VALUE']);
    expect(eventActions(form, { type: 'CLICK', field: 'lookup' }, { email: 'a@b.co' }).map((a) => a.type)).toEqual(['FETCH', 'GO_TO_STEP']);
    expect(eventActions(form, { type: 'CLICK', field: 'lookup' }, { email: '' })).toEqual([]);
    expect(eventActions(form, { type: 'CLICK', field: 'other' }, { email: 'a@b.co' })).toEqual([]);
    expect(eventActions(form, { type: 'SUBMIT_SUCCESS' }, { amountDisputed: 9000 }).map((a) => a.type)).toEqual(['SHOW_MESSAGE', 'REDIRECT']);
    expect(eventActions(form, { type: 'SUBMIT_SUCCESS' }, { amountDisputed: 10 }).map((a) => a.type)).toEqual(['REDIRECT']);
    expect(eventActions({}, { type: 'LOAD' }, {})).toEqual([]);
  });

  it('knows which buttons do something and which sources may be read', () => {
    expect([...clickableButtons(form)]).toEqual(['lookup']);
    expect(eventSources(form)).toEqual([{ key: 'customers', params: ['email'] }]);
    expect(eventSources({ events: [{ ...events[1], disabled: true }] })).toEqual([]);
  });
});

describe('form time zone', () => {
  it('must be a real zone', () => {
    expect(isTimeZone('Asia/Kolkata')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(isTimeZone('')).toBe(false);
    expect(messages([], { timeZone: 'Asia/Kolkata' })).toEqual([]);
    expect(messages([], { timeZone: 'IST+5:30' })).toEqual(['timeZone: "IST+5:30" is not a time zone. Use a name such as Asia/Kolkata']);
  });

  it("wins over the person's own zone", () => {
    const form = def([]) as unknown as FormDefinition;
    expect(systemContextFor(form, { timeZone: 'America/New_York' }).timeZone).toBe('America/New_York');
    expect(systemContextFor({ ...form, timeZone: 'Asia/Kolkata' }, { timeZone: 'America/New_York' }).timeZone).toBe('Asia/Kolkata');
  });
});
