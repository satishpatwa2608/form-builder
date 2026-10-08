import { describe, expect, it } from 'vitest';
import {
  allowedNext,
  canTransition,
  dueAt,
  formatRef,
  refPrefixOf,
  renderTemplate,
  validateFormDefinition,
  valuesFromPayload,
  workflowOf,
  DEFAULT_WORKFLOW,
  conditionValues,
  stepKey,
} from '../src';
import customerComplaintBasic from './fixtures/customer-complaint-basic.json';
import type { Automation, FormDefinition, WorkflowConfig } from '../src/types';

const base = customerComplaintBasic as unknown as FormDefinition;
const wf: WorkflowConfig = {
  enabled: true,
  statuses: [
    { key: 'NEW', label: 'New', category: 'OPEN', slaHours: 24 },
    { key: 'WIP', label: 'Investigating', category: 'IN_PROGRESS' },
    { key: 'DONE', label: 'Resolved', category: 'DONE', slaHours: 5 },
  ],
  transitions: { NEW: ['WIP'], WIP: ['DONE', 'NEW'] },
};

const issues = (def: Partial<FormDefinition>, level: 'shape' | 'publish' = 'publish') => {
  const r = validateFormDefinition({ ...base, ...def }, level);
  return r.success ? [] : r.issues.map((i) => i.message);
};
const auto = (a: Partial<Automation>): Automation => ({ id: 'a', name: 'A', enabled: true, when: 'SUBMITTED', actions: [], ...a });

describe('workflow rules', () => {
  it('reference numbers: prefix from the workflow or the code initials', () => {
    expect(refPrefixOf({ code: 'CUSTOMER_COMPLAINT_BASIC' })).toBe('CCB');
    expect(refPrefixOf({ code: 'X', workflow: { ...wf, refPrefix: 'CMP' } })).toBe('CMP');
    expect(formatRef('CMP', 42)).toBe('CMP-000042');
  });

  it('moves follow the allowed transitions; unrestricted workflows allow any move', () => {
    expect(allowedNext(wf, 'NEW').map((s) => s.key)).toEqual(['WIP']);
    expect(canTransition(wf, 'NEW', 'DONE')).toBe(false);
    expect(canTransition({ ...wf, transitions: undefined }, 'NEW', 'DONE')).toBe(true);
    expect(allowedNext(wf, 'WIP').map((s) => s.key)).toEqual(['NEW', 'DONE']);
  });

  it('SLA: due from entry time, never for done statuses', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    expect(dueAt(wf.statuses[0], from)?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
    expect(dueAt(wf.statuses[2], from)).toBeNull();
    expect(dueAt(wf.statuses[1], from)).toBeNull();
  });

  it('forms without an enabled workflow use the default statuses', () => {
    expect(workflowOf({ workflow: { ...wf, enabled: false } })).toBe(DEFAULT_WORKFLOW);
  });

  it('stored payload keys map back to field names', () => {
    const def = { ...base, submission: { ...base.submission, mapping: { name: 'customer_name' } } };
    expect(valuesFromPayload(def, { customer_name: 'Asha', email: 'a@b.c', unknownKey: 1 })).toEqual({ name: 'Asha', email: 'a@b.c' });
  });

  it('templates: answers are escaped for HTML, unknown tokens are empty', () => {
    const ctx = { values: { name: '<b>Tom</b> & "Jerry"', tags: ['A', 'B'] }, record: { ref: 'CC-000001', status: 'New', link: '' }, form: { name: 'Complaint' } };
    expect(renderTemplate('Hi {{name}} ({{ $record.ref }}) {{tags}} {{nope}}', ctx, true)).toBe('Hi &lt;b&gt;Tom&lt;/b&gt; &amp; &quot;Jerry&quot; (CC-000001) A, B ');
    expect(renderTemplate('{{$form.name}}: {{name}}', ctx, false)).toBe('Complaint: <b>Tom</b> & "Jerry"');
  });
});

describe('flow data ($steps)', () => {
  it('templates read earlier steps\' outputs; conditions see them flattened', () => {
    const ctx = { values: { name: 'Asha' }, record: { ref: 'R-1', status: 'New', link: '' }, form: { name: 'F' }, steps: { crm: { leadId: 'L-9', owner: { name: 'Ravi' } } } };
    expect(renderTemplate('{{$steps.crm.leadId}} / {{$steps.crm.owner.name}} / {{$steps.nope.x}} / {{name.x}}', ctx, true)).toBe('L-9 / Ravi /  / ');
    expect(conditionValues({ name: 'Asha' }, 'NEW', { crm: { duplicate: true } })).toEqual({ name: 'Asha', $status: 'NEW', '$steps.crm.duplicate': true });
    expect(stepKey({}, 2)).toBe('s3');
    expect(stepKey({ id: 'crm' }, 0)).toBe('crm');
  });
});

describe('workflow validation', () => {
  it('drafts save half-filled automations; publishing asks for what is missing', () => {
    const def = { workflow: wf, automations: [auto({ actions: [{ type: 'EMAIL', to: [], subject: '', body: '' }, { type: 'HANDLER', key: '' }] })] };
    expect(issues(def, 'shape')).toEqual([]);
    expect(issues(def)).toEqual(
      expect.arrayContaining(['"A": add who it goes to', '"A": the email needs a subject and a message', '"A": choose a custom API']),
    );
  });

  it('status features need the workflow switched on', () => {
    const off = issues({
      automations: [
        auto({ when: 'SLA_BREACHED', actions: [{ type: 'HANDLER', key: 'x' }] }),
        auto({ id: 'b', if: { field: '$status', operator: 'equals', value: 'NEW' }, actions: [{ type: 'NOTIFY', to: [{ kind: 'ASSIGNEE' }], message: 'm' }] }),
      ],
    });
    expect(off).toEqual(expect.arrayContaining(['Turn on the workflow (statuses) to use this', 'The assignee: Turn on the workflow (statuses) to use this']));
  });

  it('checks statuses, moves, assignment and recipients against the form', () => {
    const m = issues({
      workflow: {
        ...wf,
        statuses: [...wf.statuses.slice(0, 2)],
        transitions: { NEW: ['GONE'] },
        assignment: { type: 'BY_FIELD', field: 'nope', map: {} },
      },
      automations: [
        auto({
          actions: [
            { type: 'EMAIL', to: [{ kind: 'FIELD', field: 'name' }], subject: 's', body: 'b' },
            { type: 'NOTIFY', to: [{ kind: 'EMAIL', email: 'x@y.z' }], message: 'm' },
            { type: 'SET_STATUS', status: 'GONE' },
            { type: 'WEBHOOK', url: 'http://insecure.test' },
          ],
        }),
      ],
    });
    expect(m).toEqual(
      expect.arrayContaining([
        'Add at least one "done" status so records can be closed',
        'Unknown status "GONE" in allowed moves',
        'Assignment uses unknown field "nope"',
        '"name" is not an email field',
        'Notifications, tasks and approvals go to Prism users (assignee, submitter or a chosen user)',
        'Unknown status "GONE"',
        '"A": webhooks need a full https URL',
      ]),
    );
  });

  it('a complete workflow publishes', () => {
    expect(
      issues({
        workflow: { ...wf, assignment: { type: 'BY_FIELD', field: 'category', map: {} } },
        automations: [
          auto({
            if: { field: '$status', operator: 'equals', value: 'NEW' },
            actions: [
              { type: 'EMAIL', to: [{ kind: 'FIELD', field: 'email' }, { kind: 'ASSIGNEE' }], subject: 'Got it {{$record.ref}}', body: 'Thanks {{name}}' },
              { type: 'CREATE_TASK', to: [{ kind: 'ASSIGNEE' }], title: 'Look at {{$record.ref}}' },
              { type: 'HANDLER', key: 'crm-push' },
            ],
          }),
          auto({ id: 'b', when: 'STATUS_CHANGED', toStatus: 'DONE', actions: [{ type: 'NOTIFY', to: [{ kind: 'SUBMITTER' }], message: 'Resolved' }] }),
        ],
      }),
    ).toEqual([]);
  });
});
