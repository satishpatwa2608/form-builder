import type { Automation, Condition, FormDefinition, FormField, RecipientRef, SelectOption, WorkflowConfig } from './types';
import { fieldLabel, isOptionField, isValueField } from './field-kinds';
import { answerFields } from './repeat';

/**
 * A workflow kept in the organisation's library so several forms can use it,
 * instead of each form building its own. A form names the one it uses; when
 * the form is published the workflow is copied into that version, so work in
 * progress is never moved onto a changed process.
 *
 * A workflow reads some of a form's answers (a priority rule on "severity",
 * the requester's email for replies). It lists them as the fields it needs.
 * A form with fields of the same name needs nothing more; where a name
 * differs, the form says which of its own fields plays that part.
 */
export interface SharedWorkflowField {
  /** The name the workflow uses for it in its rules and messages. */
  name: string;
  /** What to call it when asking a form designer which field it is. */
  label: string;
  type: FormField['type'];
  /** For a choice field: the values the workflow's rules test. */
  options?: SelectOption[];
}

export interface SharedWorkflow {
  id: string;
  name: string;
  description?: string;
  workflow: WorkflowConfig;
  automations: Automation[];
  /** The answers it reads from whichever form uses it. */
  fields: SharedWorkflowField[];
}

/** On a form: the shared workflow it uses. */
export interface WorkflowRef {
  id: string;
  /** Workflow field name -> this form's field name, only where the two differ. */
  map?: Record<string, string>;
  /** Record numbers for this form, e.g. CMP. Left out, the form code's initials. */
  refPrefix?: string;
}

/** `{{name}}` in a message: an answer. `{{$record.ref}}`, `{{$work.x}}` and the like are not. */
const ANSWER_TOKEN = /\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g;

const isAnswer = (name: string) => !name.startsWith('$');

/** Applies `rename` to every answer a condition tests. */
function mapCondition(cond: Condition, rename: (name: string) => string): Condition {
  if ('all' in cond) return { all: cond.all.map((c) => mapCondition(c, rename)) };
  if ('any' in cond) return { any: cond.any.map((c) => mapCondition(c, rename)) };
  return isAnswer(cond.field) ? { ...cond, field: rename(cond.field) } : cond;
}

/** A message with its `{{answers}}` renamed; one that keeps its name is left exactly as it was written. */
const mapText = (text: string, rename: (name: string) => string) =>
  text.replace(ANSWER_TOKEN, (whole, name: string) => {
    const next = rename(name);
    return next === name ? whole : `{{${next}}}`;
  });
const mapRecipients = (to: RecipientRef[], rename: (name: string) => string) => to.map((r) => (r.kind === 'FIELD' ? { ...r, field: rename(r.field) } : r));

/**
 * The same workflow and automations with every reference to a form's answers
 * passed through `rename`. Called with a recording function it also serves to
 * list those references (see workflowFormFields).
 */
function mapWorkflow(workflow: WorkflowConfig, automations: Automation[], rename: (name: string) => string): { workflow: WorkflowConfig; automations: Automation[] } {
  const wf: WorkflowConfig = {
    ...workflow,
    ...(workflow.assignment?.type === 'BY_FIELD' ? { assignment: { ...workflow.assignment, field: rename(workflow.assignment.field) } } : {}),
    ...(workflow.priority?.rules ? { priority: { ...workflow.priority, rules: workflow.priority.rules.map((r) => ({ ...r, if: mapCondition(r.if, rename) })) } } : {}),
    ...(workflow.contactEmailField ? { contactEmailField: rename(workflow.contactEmailField) } : {}),
    ...(workflow.actions
      ? {
          actions: workflow.actions.map((a) =>
            a.approval ? { ...a, approval: { ...a.approval, to: mapRecipients(a.approval.to, rename), ...(a.approval.if ? { if: mapCondition(a.approval.if, rename) } : {}) } } : a,
          ),
        }
      : {}),
    ...(workflow.escalation ? { escalation: { levels: workflow.escalation.levels.map((l) => ({ ...l, notify: mapRecipients(l.notify, rename) })) } } : {}),
    ...(workflow.emailTemplates ? { emailTemplates: workflow.emailTemplates.map((t) => ({ ...t, subject: mapText(t.subject, rename), body: mapText(t.body, rename) })) } : {}),
  };
  const autos = automations.map((a) => ({
    ...a,
    ...(a.if ? { if: mapCondition(a.if, rename) } : {}),
    actions: a.actions.map((step) => {
      const base = { ...step, ...(step.if ? { if: mapCondition(step.if, rename) } : {}) };
      switch (base.type) {
        case 'EMAIL':
          return { ...base, to: mapRecipients(base.to, rename), subject: mapText(base.subject, rename), body: mapText(base.body, rename) };
        case 'NOTIFY':
          return { ...base, to: mapRecipients(base.to, rename), message: mapText(base.message, rename) };
        case 'APPROVAL':
          return { ...base, to: mapRecipients(base.to, rename), title: mapText(base.title, rename), ...(base.instructions ? { instructions: mapText(base.instructions, rename) } : {}) };
        case 'CREATE_TASK':
          return { ...base, to: mapRecipients(base.to, rename), title: mapText(base.title, rename), ...(base.description ? { description: mapText(base.description, rename) } : {}) };
        default:
          return base;
      }
    }),
  }));
  return { workflow: wf, automations: autos };
}

/** Every answer of a form that a workflow and its automations read, in the order first met. */
export function workflowFormFields(workflow: WorkflowConfig, automations: Automation[] = []): string[] {
  const seen = new Set<string>();
  mapWorkflow(workflow, automations, (name) => {
    seen.add(name);
    return name;
  });
  return [...seen];
}

/**
 * What a form's own workflow needs from the form, described so that it can be
 * put in the library: each answer it reads, with the label and type it has on
 * this form.
 */
export function describeWorkflowFields(def: Pick<FormDefinition, 'fields' | 'workflow' | 'automations'>): SharedWorkflowField[] {
  if (!def.workflow) return [];
  const byName = new Map(def.fields.map((f) => [f.name, f]));
  return workflowFormFields(def.workflow, def.automations ?? []).map((name) => {
    const field = byName.get(name);
    const options = field?.dataSource?.type === 'STATIC' ? field.dataSource.options : undefined;
    return { name, label: field ? fieldLabel(field) : name, type: field?.type ?? 'TEXT', ...(options?.length ? { options } : {}) };
  });
}

export interface WorkflowFieldMatch {
  need: SharedWorkflowField;
  /** The form's field that plays this part, when there is one. */
  field?: FormField;
  /** How it was found: by having the same name, or because the form says so. */
  by?: 'name' | 'choice';
}

/** The fields of a form that could supply one answer a shared workflow needs. */
export function workflowFieldChoices(fields: FormField[], need: Pick<SharedWorkflowField, 'type'>): FormField[] {
  const all = answerFields(fields).filter(isValueField);
  if (need.type === 'EMAIL') return all.filter((f) => f.type === 'EMAIL');
  return isOptionField(need) ? all.filter(isOptionField) : all;
}

/**
 * For each answer a shared workflow needs: which field of this form supplies
 * it. A field with the same name does, unless the form has chosen another.
 */
export function matchWorkflowFields(shared: Pick<SharedWorkflow, 'fields'>, fields: FormField[], map: Record<string, string> = {}): WorkflowFieldMatch[] {
  const candidates = new Map(answerFields(fields).filter(isValueField).map((f) => [f.name, f]));
  return shared.fields.map((need) => {
    const chosen = Object.prototype.hasOwnProperty.call(map, need.name) ? candidates.get(map[need.name]) : undefined;
    if (chosen) return { need, field: chosen, by: 'choice' as const };
    const same = candidates.get(need.name);
    return same ? { need, field: same, by: 'name' as const } : { need };
  });
}

/**
 * The form with its shared workflow written into it, as it will be published:
 * the workflow's rules and messages now name this form's own fields. `missing`
 * lists what the workflow needs that the form has not supplied; the form
 * cannot be published until that is empty.
 */
export function resolveSharedWorkflow<T extends Pick<FormDefinition, 'fields' | 'workflow' | 'automations'> & { workflowRef?: WorkflowRef }>(
  def: T,
  shared: SharedWorkflow,
): { definition: T & { workflow: WorkflowConfig; automations: Automation[] }; missing: SharedWorkflowField[] } {
  const matches = matchWorkflowFields(shared, def.fields, def.workflowRef?.map);
  const to = new Map(matches.filter((m) => m.field).map((m) => [m.need.name, m.field!.name]));
  const { workflow, automations } = mapWorkflow(shared.workflow, shared.automations, (name) => to.get(name) ?? name);
  const refPrefix = def.workflowRef?.refPrefix?.trim();
  return {
    definition: { ...def, workflow: { ...workflow, ...(refPrefix ? { refPrefix } : {}) }, automations },
    missing: matches.filter((m) => !m.field).map((m) => m.need),
  };
}

/**
 * A stand-in form that has exactly the fields a library workflow says it
 * needs. Editing or checking the workflow against it applies every rule a
 * form's own workflow must meet, and offers only the answers it has declared.
 */
export function sharedWorkflowForm(shared: Pick<SharedWorkflow, 'name' | 'fields'> & { workflow?: unknown; automations?: unknown }): FormDefinition {
  const fields: FormField[] = shared.fields.map((f) => {
    const field: FormField = { id: `need_${f.name}`, type: f.type, name: f.name, label: f.label };
    // A choice field cannot stand without choices; a placeholder keeps the form valid until some are given.
    return isOptionField(field) ? { ...field, dataSource: { type: 'STATIC', options: f.options?.length ? f.options : [{ label: 'Option', value: 'OPTION' }] } } : field;
  });
  if (!fields.length) fields.push({ id: 'need_none', type: 'TEXT', name: 'anAnswer', label: 'An answer' });
  return {
    id: 'library',
    orgId: 'library',
    businessId: '',
    name: shared.name,
    code: 'LIBRARY',
    version: 1,
    status: 'DRAFT',
    access: 'PUBLIC',
    submission: { method: 'POST', endpointId: 'default-submit' },
    fields,
    workflow: shared.workflow as WorkflowConfig | undefined,
    automations: (Array.isArray(shared.automations) ? shared.automations : []) as Automation[],
    createdBy: 'library',
    updatedBy: 'library',
  };
}
