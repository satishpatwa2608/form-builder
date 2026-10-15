import { describe, expect, it } from 'vitest';
import { validateFormDefinition } from '@fb/engine';
import { fixtureDefinitions } from '../form/fixtures';
import { FORM_TEMPLATES, prepareTemplate } from './index';

/**
 * What the definition's validation says about every template and fixture, and about broken copies of them made
 * to trip each kind of check (fields, rules, events, workflow, automations, the form's own settings), kept in a
 * file. Moving the validation's code about must not change a word of it.
 */
type Def = Record<string, unknown> & { fields: Record<string, unknown>[]; workflow?: Record<string, unknown>; automations?: Record<string, unknown>[] };

const identity = (def: Record<string, unknown>, key: string) => ({ ...def, id: `id-${key}`, orgId: 'o', version: 1, status: 'DRAFT', name: String(def.name ?? key), code: 'T', createdBy: 'u', updatedBy: 'u' });
const clone = <T>(v: T): T => structuredClone(v);

/** Each breaks the definition in one way a person could. */
const BREAKS: Record<string, (d: Def) => void> = {
  'no labels': (d) => d.fields.forEach((f) => (f.label = '')),
  'a field twice': (d) => d.fields.length && d.fields.push(clone(d.fields[0]!)),
  'bad field names': (d) => d.fields.forEach((f, i) => i % 2 === 0 && (f.name = '1 bad name')),
  'rule on an unknown answer': (d) => (d.rules = [...((d.rules as unknown[]) ?? []), { id: 'r-x', if: { field: 'nope', operator: 'equals', value: 'x' }, then: [{ type: 'SHOW', fieldId: 'nope' }] }]),
  'event that does nothing known': (d) => (d.events = [...((d.events as unknown[]) ?? []), { id: 'e-x', on: 'CHANGE', field: 'nope', do: [{ type: 'SET_VALUE', field: 'nope', value: '1' }] }]),
  'dates the wrong way round': (d) => Object.assign(d, { opensAt: '2030-01-02T00:00:00Z', closesAt: '2030-01-01T00:00:00Z', timeZone: 'Mars/Base' }),
  'settings that do not fit': (d) =>
    Object.assign(d, {
      captcha: { enabled: false, provider: 'TURNSTILE', siteKey: 'k', mode: 'V3' },
      theme: { primaryColor: 'red', logoUrl: 'javascript:alert(1)' },
      actions: { cancel: { enabled: true, label: 'Cancel', behavior: 'REDIRECT' } },
      submission: { method: 'POST', endpointId: 'x', mapping: { nope: 'x' }, success: { type: 'REDIRECT' } },
      payment: { enabled: true, amountField: 'nope', currency: 'INR' },
      openWith: { source: '/connectors/x/y', param: '', by: 'LINK', set: { nope: 'a' }, lock: ['nope'] },
    }),
  'workflow pointing at nothing': (d) => {
    const statuses = [{ key: 'NEW', label: '', category: 'OPEN' }, { key: 'NEW', label: 'Again', category: 'OPEN' }];
    d.workflow = {
      ...(d.workflow ?? {}),
      enabled: true,
      statuses,
      transitions: { NEW: ['GONE'] },
      actions: [{ key: 'go', label: '', to: 'GONE', from: ['NOWHERE'], requireFields: ['nope'], approval: { to: [{ kind: 'FIELD', field: 'nope' }], onReject: 'GONE', if: { field: 'nope', operator: 'equals', value: 'x' } } }],
      reopen: { to: 'NEW' },
      sla: { calendar: 'WORKING', pauseIn: ['GONE'] },
      escalation: { levels: [{ afterHours: 1, notify: [{ kind: 'EMAIL', email: 'a@b.test' }] }] },
      requestInfoStatus: 'GONE',
      contactEmailField: 'nope',
      emailTemplates: [{ key: 'a', name: '', subject: '', body: '' }, { key: 'a', name: 'x', subject: 'y', body: 'z' }],
      priority: { default: 'LOW', rules: [{ if: { field: 'nope', operator: 'equals', value: 'x' }, priority: 'HIGH' }] },
      workFields: [{ id: 'w', type: 'FILE', name: 'w', label: 'W', required: true }, { id: 'w', type: 'TEXT', name: 'w', label: 'W2', prefill: 'EMAIL' }],
      assignment: { type: 'BY_FIELD', field: 'nope', map: {} },
    };
    d.recordAccess = { mode: 'TEAM', userIds: [], departments: [] };
  },
  'automations pointing at nothing': (d) => {
    d.automations = [
      ...(d.automations ?? []),
      {
        id: 'x',
        name: '',
        enabled: true,
        when: 'FIELD_UPDATED',
        field: 'nope',
        toStatus: 'GONE',
        if: { field: '$work.nope', operator: 'equals', value: 'x' },
        actions: [
          { id: 'a', type: 'EMAIL', to: [], subject: '', body: '' },
          { id: 'a', type: 'NOTIFY', to: [{ kind: 'EMAIL', email: 'x@y.test' }], message: '' },
          { type: 'APPROVAL', to: [], title: '', together: [{ to: [], title: '' }] },
          { type: 'SIGN', to: [], title: '', confirm: 'KNOWN' },
          { type: 'ASSIGN', userId: '', by: 'ANSWER', field: 'nope' },
          { type: 'WEBHOOK', url: 'http://plain.test' },
          { type: 'FLOW', service: 'ZAPIER', url: 'https://example.com/x' },
          { type: 'HANDLER', key: 'Not A Key' },
          { type: 'GO_BACK', to: 'zz' },
          { type: 'SET_STATUS', status: 'GONE', if: { field: '$steps.later.x', operator: 'equals', value: 'x' } },
          { type: 'CREATE_TASK', title: '', to: [{ kind: 'FIELD', field: 'nope' }] },
        ],
      },
    ];
  },
};

describe('the definition validation says exactly what it said before', () => {
  it('for every template and fixture, as given and broken in each way', async () => {
    const sources: { key: string; def: Record<string, unknown> }[] = [];
    for (const t of FORM_TEMPLATES) sources.push({ key: `template:${t.key}`, def: (await prepareTemplate(t.definition, { existing: async () => [], add: async () => undefined })).definition });
    fixtureDefinitions.forEach((f) => sources.push({ key: `fixture:${f.code}`, def: f as unknown as Record<string, unknown> }));

    const results: Record<string, unknown> = {};
    for (const { key, def } of sources) {
      for (const level of ['shape', 'publish'] as const) {
        const r = validateFormDefinition(identity(clone(def), key), level);
        results[`${key} | as given | ${level}`] = r.success ? 'valid' : r.issues;
      }
      for (const [name, breakIt] of Object.entries(BREAKS)) {
        const broken = clone(def) as Def;
        breakIt(broken);
        const r = validateFormDefinition(identity(broken, key), 'publish');
        results[`${key} | ${name}`] = r.success ? 'valid' : r.issues;
      }
    }
    // Enough is broken for the record to mean something.
    expect(Object.values(results).filter((r) => r !== 'valid').length).toBeGreaterThan(Object.keys(BREAKS).length * sources.length * 0.9);
    await expect(JSON.stringify(results, null, 1)).toMatchFileSnapshot('./__snapshots__/validation-golden.json');
  });
});
