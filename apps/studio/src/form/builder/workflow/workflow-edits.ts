import type {
  Automation,
  AutomationAction,
  FieldType,
  FormDefinition,
  FormField,
  Priority,
  RecipientRef,
  WorkflowAction,
  WorkflowConfig,
  WorkflowStatus,
} from '../../types';
import { isValueField, stepKey } from '../../engine';
import type { CustomWorkflow, Person } from '../../adapters/workflow';

/** Pure edits behind the Workflow dialog, kept out of the components so they're easy to test. */

export const ACTION_LABEL: Record<AutomationAction['type'], string> = {
  EMAIL: 'Send an email',
  APPROVAL: 'Wait for approval',
  NOTIFY: 'Notify in Form Builder',
  CREATE_TASK: 'Create a task',
  ASSIGN: 'Assign to someone',
  SET_STATUS: 'Change the status',
  WEBHOOK: 'Call a webhook',
  HANDLER: 'Run a custom API',
};

/** Step types this product doesn't run (Tasks were a Sangam app): shown if present, not offered. */
export const UNAVAILABLE_ACTIONS: ReadonlySet<AutomationAction['type']> = new Set(['CREATE_TASK']);

/** Actions that only make sense when submissions are tracked as records. */
export const WORKFLOW_ONLY_ACTIONS: ReadonlySet<AutomationAction['type']> = new Set(['ASSIGN', 'SET_STATUS']);

/** A workflow to start from when it's switched on for the first time. */
export const STARTER_WORKFLOW: WorkflowConfig = {
  enabled: true,
  statuses: [
    { key: 'NEW', label: 'New', category: 'OPEN' },
    { key: 'IN_PROGRESS', label: 'In progress', category: 'IN_PROGRESS' },
    { key: 'CLOSED', label: 'Closed', category: 'DONE' },
  ],
  assignment: { type: 'NONE' },
};

/** "Waiting for customer" -> WAITING_FOR_CUSTOMER (the format status keys must have). */
export function statusKeyFrom(label: string): string {
  const key = label
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^[^A-Z]+|_+$/g, '')
    .slice(0, 40);
  return key || 'STATUS';
}

const uniqueKey = (base: string, taken: Set<string>) => {
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base.slice(0, 37)}_${i}`;
  return key;
};

export function addStatus(wf: WorkflowConfig): WorkflowConfig {
  const taken = new Set(wf.statuses.map((s) => s.key));
  const status: WorkflowStatus = { key: uniqueKey('NEW_STATUS', taken), label: 'New status', category: 'IN_PROGRESS' };
  // Keep a "done" status last: insert new ones before the first DONE.
  const at = wf.statuses.findIndex((s) => s.category === 'DONE');
  const statuses = [...wf.statuses];
  statuses.splice(at === -1 ? statuses.length : at, 0, status);
  return { ...wf, statuses };
}

/**
 * Relabel a status. Its key follows the label only while the key still
 * matches the old label - once a form is published, records store the key,
 * so an explicitly edited key is never changed behind the designer's back.
 */
export function renameStatus(wf: WorkflowConfig, index: number, label: string, published: ReadonlySet<string>): WorkflowConfig {
  const current = wf.statuses[index];
  const follows = !published.has(current.key) && (current.key === statusKeyFrom(current.label) || current.key.startsWith('NEW_STATUS'));
  const taken = new Set(wf.statuses.filter((_, i) => i !== index).map((s) => s.key));
  const key = follows ? uniqueKey(statusKeyFrom(label), taken) : current.key;
  return renameKey({ ...wf, statuses: wf.statuses.map((s, i) => (i === index ? { ...s, label, key } : s)) }, current.key, key);
}

/** Keep allowed moves pointing at a renamed key. */
function renameKey(wf: WorkflowConfig, from: string, to: string): WorkflowConfig {
  if (from === to || !wf.transitions) return wf;
  const transitions = Object.fromEntries(
    Object.entries(wf.transitions).map(([k, v]) => [k === from ? to : k, v.map((x) => (x === from ? to : x))]),
  );
  return { ...wf, transitions };
}

export function removeStatus(wf: WorkflowConfig, index: number): WorkflowConfig {
  const key = wf.statuses[index].key;
  const transitions = wf.transitions
    ? Object.fromEntries(Object.entries(wf.transitions).filter(([k]) => k !== key).map(([k, v]) => [k, v.filter((x) => x !== key)]))
    : undefined;
  return { ...wf, statuses: wf.statuses.filter((_, i) => i !== index), transitions };
}

export function moveStatus(wf: WorkflowConfig, index: number, delta: -1 | 1): WorkflowConfig {
  const to = index + delta;
  if (to < 0 || to >= wf.statuses.length) return wf;
  const statuses = [...wf.statuses];
  [statuses[index], statuses[to]] = [statuses[to], statuses[index]];
  return { ...wf, statuses };
}

/** Allowed moves on/off. Turning them on starts from "every status to every other", so nothing breaks. */
export function setRestricted(wf: WorkflowConfig, restricted: boolean): WorkflowConfig {
  if (!restricted) return { ...wf, transitions: undefined };
  const keys = wf.statuses.map((s) => s.key);
  return { ...wf, transitions: Object.fromEntries(keys.map((k) => [k, keys.filter((x) => x !== k)])) };
}

export function toggleMove(wf: WorkflowConfig, from: string, to: string, allowed: boolean): WorkflowConfig {
  const current = wf.transitions?.[from] ?? [];
  const next = allowed ? [...new Set([...current, to])] : current.filter((x) => x !== to);
  // Keep the order of the status list, so the JSON stays readable.
  const ordered = wf.statuses.map((s) => s.key).filter((k) => next.includes(k));
  return { ...wf, transitions: { ...(wf.transitions ?? {}), [from]: ordered } };
}

export function newAutomation(existing: Automation[]): Automation {
  const ids = new Set(existing.map((a) => a.id));
  let n = existing.length + 1;
  while (ids.has(`automation-${n}`)) n++;
  return { id: `automation-${n}`, name: `Automation ${n}`, enabled: true, when: 'SUBMITTED', actions: [] };
}

const STEP_ID_BASE: Record<AutomationAction['type'], string> = {
  EMAIL: 'email',
  APPROVAL: 'approval',
  NOTIFY: 'notify',
  CREATE_TASK: 'task',
  ASSIGN: 'assign',
  SET_STATUS: 'status',
  WEBHOOK: 'webhook',
  HANDLER: 'api',
};

/** A step key not used yet in this flow: email, email_2, ... */
export function nextStepId(type: AutomationAction['type'], steps: AutomationAction[]): string {
  const taken = new Set(steps.map((s, i) => stepKey(s, i)));
  const base = STEP_ID_BASE[type];
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/** A new step, keyed so later steps can use its output. */
export function newStep(type: AutomationAction['type'], form: FormDefinition, steps: AutomationAction[]): AutomationAction {
  return { ...newAction(type, form), id: nextStepId(type, steps) };
}

export function insertStep(steps: AutomationAction[], at: number, step: AutomationAction): AutomationAction[] {
  return [...steps.slice(0, at), step, ...steps.slice(at)];
}

export function moveStep(steps: AutomationAction[], index: number, delta: -1 | 1): AutomationAction[] {
  const to = index + delta;
  if (to < 0 || to >= steps.length) return steps;
  const next = [...steps];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/** Output fields a step is known to produce (built-ins, or what a custom API declares). */
export function stepOutputs(step: AutomationAction, customWorkflows: CustomWorkflow[]): string[] {
  switch (step.type) {
    case 'EMAIL':
      return ['sent'];
    case 'NOTIFY':
      return ['notified'];
    case 'CREATE_TASK':
      return ['taskId', 'title'];
    case 'WEBHOOK':
      return ['httpStatus'];
    case 'HANDLER':
      return customWorkflows.find((w) => w.key === step.key)?.outputs ?? [];
    case 'APPROVAL':
      return ['decision', 'decidedByName', 'comment'];
    default:
      return [];
  }
}

/** The data a step can use - the payload plus what the steps above it produced (like AEM's metadata). */
export function availableData(form: FormDefinition, steps: AutomationAction[], index: number, customWorkflows: CustomWorkflow[]) {
  return {
    answers: answerFields(form).map((f) => ({ token: `{{${f.name}}}`, label: f.label || f.name })),
    record: form.workflow?.enabled
      ? [
          { token: '{{$record.ref}}', label: 'Reference' },
          { token: '{{$record.status}}', label: 'Status' },
          { token: '{{$record.link}}', label: 'Link to the record' },
        ]
      : [],
    steps: steps.slice(0, index).map((s, i) => ({
      key: stepKey(s, i),
      name: stepTitle(s),
      outputs: stepOutputs(s, customWorkflows).map((o) => `{{$steps.${stepKey(s, i)}.${o}}}`),
    })),
  };
}

/** Earlier steps' outputs as pseudo-fields, so the condition editor can test them. */
export function outputPseudoFields(steps: AutomationAction[], index: number, customWorkflows: CustomWorkflow[]): FormField[] {
  return steps.slice(0, index).flatMap((s, i) =>
    stepOutputs(s, customWorkflows).map((o): FormField => {
      const name = `$steps.${stepKey(s, i)}.${o}`;
      // An approval's decision is one of two values: offer them as a choice.
      if (s.type === 'APPROVAL' && o === 'decision') {
        return {
          id: name,
          type: 'DROPDOWN',
          name,
          label: `${stepTitle(s)} → decision`,
          dataSource: { type: 'STATIC', options: [{ label: 'Approved', value: 'APPROVED' }, { label: 'Rejected', value: 'REJECTED' }] },
        };
      }
      return { id: name, type: 'TEXT', name, label: `${stepTitle(s)} → ${o}` };
    }),
  );
}

export const stepTitle = (s: AutomationAction) => s.label || ACTION_LABEL[s.type];

/** One line under a step on the diagram. */
export function stepSummary(s: AutomationAction, form: FormDefinition, people: Person[], customWorkflows: CustomWorkflow[]): string {
  const who = (to: RecipientRef[]) =>
    to
      .map((r) =>
        r.kind === 'ASSIGNEE'
          ? 'assignee'
          : r.kind === 'MANAGER'
            ? "assignee's manager"
          : r.kind === 'SUBMITTER'
            ? 'submitter'
            : r.kind === 'USER'
              ? people.find((p) => p.uuid === r.userId)?.name ?? 'a user'
              : r.kind === 'FIELD'
                ? `answer "${form.fields.find((f) => f.name === r.field)?.label ?? r.field}"`
                : r.email,
      )
      .join(', ') || 'no one yet';
  switch (s.type) {
    case 'EMAIL':
      return `To ${who(s.to)}${s.subject ? ` · "${s.subject}"` : ''}`;
    case 'NOTIFY':
      return `To ${who(s.to)}`;
    case 'CREATE_TASK':
      return `"${s.title || 'Untitled'}" for ${who(s.to)}`;
    case 'ASSIGN':
      return s.userId ? `To ${people.find((p) => p.uuid === s.userId)?.name ?? 'a user'}` : 'Choose a person';
    case 'SET_STATUS':
      return `To ${form.workflow?.statuses.find((x) => x.key === s.status)?.label ?? (s.status || '?')}`;
    case 'WEBHOOK':
      return s.url.replace(/^https:\/\//, '') || 'No URL yet';
    case 'HANDLER':
      return customWorkflows.find((w) => w.key === s.key)?.label ?? (s.key || 'Choose a custom API');
    case 'APPROVAL':
      return `By ${who(s.to)}${s.dueInHours ? ` · due in ${s.dueInHours}h` : ''}`;
  }
}

/** A new action with sensible defaults for this form. */
export function newAction(type: AutomationAction['type'], form: FormDefinition): AutomationAction {
  const emailField = form.fields.find((f) => f.type === 'EMAIL');
  const tracked = !!form.workflow?.enabled;
  switch (type) {
    case 'EMAIL':
      return {
        type,
        to: emailField ? [{ kind: 'FIELD', field: emailField.name }] : [],
        subject: tracked ? 'We received your request {{$record.ref}}' : `We received your ${form.name}`,
        body: `Thank you. We received your ${form.name}${tracked ? ' (reference {{$record.ref}})' : ''} and will get back to you.`,
      };
    case 'NOTIFY':
      return { type, to: tracked ? [{ kind: 'ASSIGNEE' }] : [], message: `New ${form.name}${tracked ? ' {{$record.ref}}' : ''}` };
    case 'CREATE_TASK':
      return { type, to: tracked ? [{ kind: 'ASSIGNEE' }] : [], title: `Follow up ${form.name}${tracked ? ' {{$record.ref}}' : ''}`, dueInHours: 48 };
    case 'APPROVAL':
      return {
        type,
        to: tracked ? [{ kind: 'ASSIGNEE' }] : [],
        title: `Approve ${form.name}${tracked ? ' {{$record.ref}}' : ''}`,
        dueInHours: 48,
      };
    case 'ASSIGN':
      return { type, userId: '' };
    case 'SET_STATUS':
      return { type, status: form.workflow?.statuses[1]?.key ?? form.workflow?.statuses[0]?.key ?? '' };
    case 'WEBHOOK':
      return { type, url: 'https://' };
    case 'HANDLER':
      return { type, key: '' };
  }
}

/** Fields whose answers automations can test and put in messages. */
export const answerFields = (form: FormDefinition): FormField[] =>
  form.fields.filter((f) => isValueField(f) && f.type !== 'CAPTCHA' && f.type !== 'FILE');

/** The record's status as a pseudo-field, so the condition editor can test it like an answer. */
export function statusPseudoField(wf: WorkflowConfig | undefined): FormField | undefined {
  if (!wf?.enabled) return undefined;
  return {
    id: '$status',
    type: 'DROPDOWN',
    name: '$status',
    label: 'Record status',
    dataSource: { type: 'STATIC', options: wf.statuses.map((s) => ({ label: s.label, value: s.key })) },
  };
}

/** Placeholders a message can use, for the hint under template boxes. */
export function placeholders(form: FormDefinition): string[] {
  return [
    ...answerFields(form).map((f) => `{{${f.name}}}`),
    ...(form.workflow?.enabled ? ['{{$record.ref}}', '{{$record.status}}', '{{$record.link}}'] : []),
    '{{$form.name}}',
  ];
}

// ------------------------------------------------------------ WM-1: priority, actions, work fields

export const PRIORITY_LABEL: Record<Priority, string> = { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High', CRITICAL: 'Critical' };

/** $priority as a pseudo-field for conditions. */
export function priorityPseudoField(wf: WorkflowConfig | undefined): FormField | undefined {
  if (!wf?.enabled) return undefined;
  return {
    id: '$priority',
    type: 'DROPDOWN',
    name: '$priority',
    label: 'Priority',
    dataSource: { type: 'STATIC', options: (Object.keys(PRIORITY_LABEL) as Priority[]).map((p) => ({ label: PRIORITY_LABEL[p], value: p })) },
  };
}

/** Work fields as $work.<name> pseudo-fields for conditions. */
export function workPseudoFields(wf: WorkflowConfig | undefined): FormField[] {
  if (!wf?.enabled) return [];
  return (wf.workFields ?? []).filter(isValueField).map((f) => ({ ...f, id: `$work.${f.name}`, name: `$work.${f.name}`, label: `Work: ${f.label || f.name}` }));
}

/** Everything an automation / step condition can test: status, priority, answers, work fields. */
export function conditionCandidates(form: FormDefinition): FormField[] {
  const status = statusPseudoField(form.workflow);
  const priority = priorityPseudoField(form.workflow);
  return [...(status ? [status] : []), ...(priority ? [priority] : []), ...answerFields(form), ...workPseudoFields(form.workflow)];
}

/** Types offered for work fields (what the team fills in the portal). */
export const WORK_FIELD_TYPES: { type: FieldType; label: string }[] = [
  { type: 'TEXT', label: 'Short text' },
  { type: 'TEXTAREA', label: 'Long text' },
  { type: 'NUMBER', label: 'Number' },
  { type: 'DATE', label: 'Date' },
  { type: 'DROPDOWN', label: 'Dropdown' },
  { type: 'RADIO', label: 'Choice' },
  { type: 'CHECKBOX', label: 'Yes / no' },
  { type: 'MULTI_SELECT', label: 'Multi-select' },
];

const uniqueName = (base: string, taken: Set<string>) => {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}${n}`)) n++;
  return `${base}${n}`;
};

export function newWorkField(type: FieldType, existing: FormField[]): FormField {
  const names = new Set(existing.map((f) => f.name));
  const label = WORK_FIELD_TYPES.find((t) => t.type === type)?.label ?? 'Field';
  const name = uniqueName(`${type.toLowerCase().replace(/_/g, '')}Field`, names);
  const field: FormField = { id: `w_${Date.now().toString(36)}_${existing.length}`, type, name, label };
  if (type === 'DROPDOWN' || type === 'RADIO' || type === 'MULTI_SELECT') {
    field.dataSource = { type: 'STATIC', options: [{ label: 'Option 1', value: 'OPTION_1' }] };
  }
  return field;
}

/** The standard resolution section (doc §24): root cause, corrective, preventive, summary. */
export function resolutionPreset(existing: FormField[]): FormField[] {
  const names = new Set(existing.map((f) => f.name));
  return [
    { name: 'rootCause', label: 'Root cause' },
    { name: 'correctiveAction', label: 'Corrective action' },
    { name: 'preventiveAction', label: 'Preventive action' },
    { name: 'resolutionSummary', label: 'Resolution summary' },
  ]
    .filter((f) => !names.has(f.name))
    .map((f, i) => ({ id: `w_res_${Date.now().toString(36)}_${i}`, type: 'TEXTAREA' as const, ...f }));
}

/** A new named action moving to the last status (usually "done"). */
export function newWorkflowAction(wf: WorkflowConfig): WorkflowAction {
  const keys = new Set((wf.actions ?? []).map((a) => a.key));
  let n = (wf.actions?.length ?? 0) + 1;
  while (keys.has(`action_${n}`)) n++;
  return { key: `action_${n}`, label: 'New action', to: wf.statuses[wf.statuses.length - 1]?.key ?? '' };
}

/** "Request info" -> request_info (action keys are lower_snake). */
export const actionKeyFrom = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+|_+$/g, '')
    .slice(0, 40) || 'action';
