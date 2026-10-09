import { describe, expect, it } from 'vitest';
import { describeWorkflowFields, matchWorkflowFields, resolveSharedWorkflow, validateFormDefinition, workflowFormFields } from '../src';
import type { Automation, FormField, SharedWorkflow, WorkflowConfig } from '../src';
import base from './fixtures/customer-complaint-basic.json';

const field = (f: Partial<FormField> & Pick<FormField, 'type' | 'name'>): FormField => ({ id: f.name, label: f.name, ...f });
const levels = [{ label: 'Minor', value: 'LOW' }, { label: 'Serious', value: 'HIGH' }];

const workflow: WorkflowConfig = {
  enabled: true,
  statuses: [
    { key: 'NEW', label: 'New', category: 'OPEN' },
    { key: 'CLOSED', label: 'Closed', category: 'DONE' },
  ],
  assignment: { type: 'BY_FIELD', field: 'region', map: { WEST: 'u1' }, fallbackUserId: 'u2' },
  priority: { default: 'MEDIUM', rules: [{ if: { all: [{ field: 'severity', operator: 'equals', value: 'HIGH' }, { field: 'amount', operator: 'isNotEmpty' }] }, priority: 'HIGH' }] },
  actions: [{ key: 'close', label: 'Close', to: 'CLOSED', requireFields: ['rootCause'], approval: { to: [{ kind: 'MANAGER' }], if: { field: 'amount', operator: 'greaterThan', value: 5000 } } }],
  contactEmailField: 'email',
  emailTemplates: [{ key: 'ack', name: 'Acknowledge', subject: 'About {{$record.ref}}', body: 'Dear {{ customer }},' }],
  workFields: [field({ type: 'TEXTAREA', name: 'rootCause' })],
};
const automations: Automation[] = [
  {
    id: 'a1',
    name: 'Acknowledge',
    enabled: true,
    when: 'SUBMITTED',
    if: { field: 'severity', operator: 'isNotEmpty' },
    actions: [
      { id: 's1', type: 'EMAIL', to: [{ kind: 'FIELD', field: 'email' }, { kind: 'ASSIGNEE' }], subject: 'We got {{$record.ref}}', body: 'Dear {{customer}}, cause: {{$work.rootCause}}, step: {{$steps.s0.x}}' },
      { id: 's2', type: 'NOTIFY', to: [{ kind: 'ASSIGNEE' }], message: 'New from {{customer}}', if: { field: '$work.rootCause', operator: 'isEmpty' } },
    ],
  },
];

const shared: SharedWorkflow = {
  id: 'wf1',
  name: 'Complaint handling',
  workflow,
  automations,
  fields: [
    { name: 'region', label: 'Region', type: 'DROPDOWN' },
    { name: 'severity', label: 'Severity', type: 'RADIO', options: levels },
    { name: 'amount', label: 'Amount', type: 'NUMBER' },
    { name: 'email', label: "Requester's email", type: 'EMAIL' },
    { name: 'customer', label: "Requester's name", type: 'TEXT' },
  ],
};

describe('what a workflow reads from a form', () => {
  it('lists every answer its rules, recipients and messages use, and nothing of its own', () => {
    // Not $work.rootCause, $record.ref or $steps: those belong to the record, not the form.
    expect(workflowFormFields(workflow, automations)).toEqual(['region', 'severity', 'amount', 'email', 'customer']);
    expect(workflowFormFields({ enabled: true, statuses: [] })).toEqual([]);
  });

  it('describes them with the labels and types they have on the form they came from', () => {
    const fields = [
      field({ type: 'RADIO', name: 'severity', label: 'How bad is it', dataSource: { type: 'STATIC', options: levels } }),
      field({ type: 'EMAIL', name: 'email', label: 'Your email' }),
      field({ type: 'TEXT', name: 'customer', label: 'Your name' }),
    ];
    expect(describeWorkflowFields({ fields, workflow, automations })).toEqual([
      { name: 'region', label: 'region', type: 'TEXT' },
      { name: 'severity', label: 'How bad is it', type: 'RADIO', options: levels },
      { name: 'amount', label: 'amount', type: 'TEXT' },
      { name: 'email', label: 'Your email', type: 'EMAIL' },
      { name: 'customer', label: 'Your name', type: 'TEXT' },
    ]);
    expect(describeWorkflowFields({ fields })).toEqual([]);
  });
});

describe('a form using a shared workflow', () => {
  const sameNames = [
    field({ type: 'DROPDOWN', name: 'region', dataSource: { type: 'STATIC', options: [{ label: 'West', value: 'WEST' }] } }),
    field({ type: 'RADIO', name: 'severity', dataSource: { type: 'STATIC', options: levels } }),
    field({ type: 'NUMBER', name: 'amount' }),
    field({ type: 'EMAIL', name: 'email' }),
    field({ type: 'TEXT', name: 'customer' }),
  ];

  it('needs nothing more when its fields have the same names', () => {
    const matches = matchWorkflowFields(shared, sameNames);
    expect(matches.map((m) => [m.need.name, m.field?.name, m.by])).toEqual([
      ['region', 'region', 'name'],
      ['severity', 'severity', 'name'],
      ['amount', 'amount', 'name'],
      ['email', 'email', 'name'],
      ['customer', 'customer', 'name'],
    ]);
    const { definition, missing } = resolveSharedWorkflow({ fields: sameNames, workflowRef: { id: 'wf1' } }, shared);
    expect(missing).toEqual([]);
    expect(definition.workflow).toEqual(workflow);
    expect(definition.automations).toEqual(automations);
  });

  it('says which of its own fields plays each part where the names differ', () => {
    const fields = [
      field({ type: 'DROPDOWN', name: 'zone', dataSource: { type: 'STATIC', options: [{ label: 'West', value: 'WEST' }] } }),
      field({ type: 'RADIO', name: 'urgency', dataSource: { type: 'STATIC', options: levels } }),
      field({ type: 'NUMBER', name: 'claim' }),
      field({ type: 'EMAIL', name: 'contactEmail' }),
      field({ type: 'TEXT', name: 'fullName' }),
    ];
    const map = { region: 'zone', severity: 'urgency', amount: 'claim', email: 'contactEmail', customer: 'fullName' };
    const { definition, missing } = resolveSharedWorkflow({ fields, workflowRef: { id: 'wf1', map, refPrefix: ' CMP ' } }, shared);
    expect(missing).toEqual([]);
    const wf = definition.workflow!;
    expect(wf.refPrefix).toBe('CMP');
    expect(wf.assignment).toMatchObject({ type: 'BY_FIELD', field: 'zone' });
    expect(wf.priority!.rules![0].if).toEqual({ all: [{ field: 'urgency', operator: 'equals', value: 'HIGH' }, { field: 'claim', operator: 'isNotEmpty' }] });
    expect(wf.actions![0].approval!.if).toEqual({ field: 'claim', operator: 'greaterThan', value: 5000 });
    expect(wf.contactEmailField).toBe('contactEmail');
    expect(wf.emailTemplates![0]).toMatchObject({ subject: 'About {{$record.ref}}', body: 'Dear {{fullName}},' });
    const [email, notify] = definition.automations![0].actions as { to: unknown; subject?: string; body?: string; message?: string; if?: unknown }[];
    expect(definition.automations![0].if).toEqual({ field: 'urgency', operator: 'isNotEmpty' });
    expect(email).toMatchObject({ to: [{ kind: 'FIELD', field: 'contactEmail' }, { kind: 'ASSIGNEE' }], subject: 'We got {{$record.ref}}', body: 'Dear {{fullName}}, cause: {{$work.rootCause}}, step: {{$steps.s0.x}}' });
    expect(notify).toMatchObject({ message: 'New from {{fullName}}', if: { field: '$work.rootCause', operator: 'isEmpty' } });
    // The library's copy is untouched.
    expect(shared.workflow.contactEmailField).toBe('email');

    // And the result is a form that can be published.
    const published = validateFormDefinition({ ...base, fields, workflow: definition.workflow, automations: definition.automations });
    expect(published.success ? [] : published.issues).toEqual([]);
  });

  it('lists what it has not supplied', () => {
    const fields = [field({ type: 'RADIO', name: 'severity', dataSource: { type: 'STATIC', options: levels } }), field({ type: 'EMAIL', name: 'contactEmail' })];
    const { missing } = resolveSharedWorkflow({ fields, workflowRef: { id: 'wf1', map: { email: 'contactEmail', customer: 'noSuchField' } } }, shared);
    expect(missing.map((m) => m.label)).toEqual(['Region', 'Amount', "Requester's name"]);
  });

  it('only a top-level answer can play a part: not a block, and not a field inside a repeating section', () => {
    const fields = [
      field({ type: 'SECTION', name: 'customer' }),
      field({ type: 'REPEAT', name: 'lines' }),
      field({ type: 'NUMBER', name: 'amount', parentId: 'lines' }),
    ];
    expect(matchWorkflowFields(shared, fields).filter((m) => m.field).map((m) => m.need.name)).toEqual([]);
  });
});
