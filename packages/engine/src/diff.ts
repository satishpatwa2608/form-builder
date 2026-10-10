import type { FormDefinition, FormField } from './types';
import { fieldLabel } from './field-kinds';

/**
 * What changed between two versions of a form, in words a designer can read:
 * "Field 'Phone' changed: now required; label was 'Mobile'". Used to compare a
 * draft with what is live, and an old version with the current one.
 */
export interface FormChange {
  area: 'Form' | 'Field' | 'Rule' | 'Event' | 'Workflow' | 'Automation';
  kind: 'added' | 'removed' | 'changed';
  /** The thing that changed: a field's label, a rule's name, a setting. */
  what: string;
  /** For `changed`: each difference. Empty for added and removed. */
  details: string[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const isPlain = (v: unknown) => v === undefined || v === null || ['string', 'number', 'boolean'].includes(typeof v);
const shown = (v: unknown) => (v === undefined || v === null || v === '' ? 'nothing' : typeof v === 'boolean' ? (v ? 'on' : 'off') : `"${String(v)}"`);

/** "label: was "Mobile", now "Phone"" for a plain value; just the name for anything structured. */
function describe(name: string, before: unknown, after: unknown): string {
  return isPlain(before) && isPlain(after) ? `${name}: was ${shown(before)}, now ${shown(after)}` : `${name} changed`;
}

const FIELD_PROPS: [key: keyof FormField, name: string][] = [
  ['label', 'label'],
  ['name', 'key'],
  ['type', 'type'],
  ['required', 'required'],
  ['requiredWhen', 'required-when rule'],
  ['visibility', 'show-when rule'],
  ['disabled', 'read-only'],
  ['placeholder', 'placeholder'],
  ['helpText', 'help text'],
  ['defaultValue', 'default value'],
  ['validation', 'validation'],
  ['dataSource', 'options'],
  ['dependency', 'clear-when-changed setting'],
  ['prefill', 'fill from signed-in user'],
  ['systemSource', 'system value'],
  ['systemParam', 'URL parameter'],
  ['width', 'width'],
  ['styleId', 'style'],
  ['props', 'other settings'],
];

const SETTINGS: [key: keyof FormDefinition, name: string][] = [
  ['name', 'name'],
  ['description', 'description'],
  ['access', 'who can open it'],
  ['layout', 'layout'],
  ['theme', 'look and feel'],
  ['actions', 'buttons'],
  ['submission', 'after-submit settings'],
  ['captcha', 'CAPTCHA settings'],
  ['timeZone', 'time zone'],
  ['saveForLater', 'save and continue later'],
  ['saveAsYouGo', 'answers saved as people go'],
  ['listOnPortal', 'listed on the requests portal'],
  ['opensAt', 'opening time'],
  ['closesAt', 'closing time'],
  ['closedMessage', 'message once closed'],
  ['recordAccess', 'who works its records'],
];

const WORKFLOW_PARTS: [key: string, name: string][] = [
  ['enabled', 'on or off'],
  ['refPrefix', 'reference prefix'],
  ['statuses', 'statuses'],
  ['transitions', 'allowed moves'],
  ['actions', 'actions'],
  ['assignment', 'assignment'],
  ['priority', 'priority rules'],
  ['sla', 'SLA'],
  ['workFields', 'work fields'],
  ['emailTemplates', 'email templates'],
  ['contactEmailField', 'contact email field'],
];

/** Added, removed and changed items of two lists matched by `id`. */
function byId<T extends { id: string }>(
  before: T[],
  after: T[],
  area: FormChange['area'],
  nameOf: (item: T, index: number) => string,
  detailsOf: (a: T, b: T) => string[],
): FormChange[] {
  const old = new Map(before.map((x) => [x.id, x]));
  const now = new Map(after.map((x) => [x.id, x]));
  const changes: FormChange[] = [];
  before.forEach((item, i) => {
    if (!now.has(item.id)) changes.push({ area, kind: 'removed', what: nameOf(item, i), details: [] });
  });
  after.forEach((item, i) => {
    const was = old.get(item.id);
    if (!was) changes.push({ area, kind: 'added', what: nameOf(item, i), details: [] });
    else if (!same(was, item)) changes.push({ area, kind: 'changed', what: nameOf(item, i), details: detailsOf(was, item) });
  });
  return changes;
}

const named = (prefix: string) => (item: { name?: string }, index: number) => item.name?.trim() || `${prefix} ${index + 1}`;

export function diffForms(before: FormDefinition, after: FormDefinition): FormChange[] {
  const changes: FormChange[] = [];

  const settings = SETTINGS.filter(([key]) => !same(before[key], after[key])).map(([key, name]) => describe(name, before[key], after[key]));
  if (settings.length) changes.push({ area: 'Form', kind: 'changed', what: 'Form settings', details: settings });

  const beforeIds = new Map(before.fields.map((f) => [f.id, f]));
  changes.push(
    ...byId(
      before.fields,
      after.fields,
      'Field',
      (f) => fieldLabel(f),
      (a, b) => {
        const details = FIELD_PROPS.filter(([key]) => !same(a[key], b[key])).map(([key, name]) => describe(name, a[key], b[key]));
        if (!same([a.parentId, a.column], [b.parentId, b.column])) {
          const into = b.parentId ? after.fields.find((f) => f.id === b.parentId) : undefined;
          details.push(into ? `moved into "${fieldLabel(into)}"` : 'moved to the top level');
        }
        return details;
      },
    ),
  );
  // The same fields in a different order, apart from anything already reported as moved between blocks.
  const kept = after.fields.filter((f) => beforeIds.has(f.id)).map((f) => f.id);
  const wasOrder = before.fields.filter((f) => kept.includes(f.id)).map((f) => f.id);
  if (!same(kept, wasOrder)) changes.push({ area: 'Form', kind: 'changed', what: 'Order of fields', details: [] });

  changes.push(...byId(before.rules ?? [], after.rules ?? [], 'Rule', named('Rule'), (a, b) => [
    ...(!same(a.name, b.name) ? [describe('name', a.name, b.name)] : []),
    ...(!same(a.disabled, b.disabled) ? [b.disabled ? 'switched off' : 'switched on'] : []),
    ...(!same(a.when, b.when) ? ['condition changed'] : []),
    ...(!same(a.then, b.then) ? ['"then" actions changed'] : []),
    ...(!same(a.else, b.else) ? ['"otherwise" actions changed'] : []),
  ]));
  changes.push(...byId(before.events ?? [], after.events ?? [], 'Event', named('Event'), (a, b) => [
    ...(!same(a.name, b.name) ? [describe('name', a.name, b.name)] : []),
    ...(!same(a.disabled, b.disabled) ? [b.disabled ? 'switched off' : 'switched on'] : []),
    ...(!same(a.on, b.on) ? ['when it happens changed'] : []),
    ...(!same(a.when, b.when) ? ['condition changed'] : []),
    ...(!same(a.do, b.do) ? ['actions changed'] : []),
  ]));

  const wfBefore = (before.workflow ?? {}) as unknown as Record<string, unknown>;
  const wfAfter = (after.workflow ?? {}) as unknown as Record<string, unknown>;
  if (!before.workflow && after.workflow) changes.push({ area: 'Workflow', kind: 'added', what: 'Workflow', details: [] });
  else if (before.workflow && !after.workflow) changes.push({ area: 'Workflow', kind: 'removed', what: 'Workflow', details: [] });
  else if (!same(wfBefore, wfAfter)) {
    const parts = WORKFLOW_PARTS.filter(([key]) => !same(wfBefore[key], wfAfter[key])).map(([key, name]) => describe(name, wfBefore[key], wfAfter[key]));
    changes.push({ area: 'Workflow', kind: 'changed', what: 'Workflow', details: parts.length ? parts : ['settings changed'] });
  }
  changes.push(...byId(before.automations ?? [], after.automations ?? [], 'Automation', named('Automation'), (a, b) => [
    ...(!same(a.name, b.name) ? [describe('name', a.name, b.name)] : []),
    ...(!same(a.enabled, b.enabled) ? [b.enabled ? 'switched on' : 'switched off'] : []),
    ...(!same(a.when, b.when) ? ['trigger changed'] : []),
    ...(!same(a.if, b.if) ? ['condition changed'] : []),
    ...(!same(a.actions, b.actions) ? ['steps changed'] : []),
  ]));
  return changes;
}
