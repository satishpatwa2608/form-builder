import { z } from 'zod';
import { conditionSchema, issueAdder, recipients, referencesOf, type AddIssue } from './common';
import { fieldSchema } from './form';
import type { FormDefinition, FormField } from '../types';
import { conditionFields } from '../evaluate-condition';
import { isValueField } from '../field-kinds';

/**
 * The workflow: statuses and the moves between them, named actions and their approvals, time limits and
 * escalation, who records go to, and the fields the team fills in. It names the form's fields by name (in
 * conditions, assignment and the contact address) and nothing in the automations.
 */

export const workflowSchema = z.object({
  enabled: z.boolean(),
  statuses: z
    .array(
      z.object({
        key: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/, 'Status keys are UPPER_SNAKE_CASE'),
        label: z.string().max(60),
        category: z.enum(['OPEN', 'IN_PROGRESS', 'DONE']),
        slaHours: z.number().positive().max(8760).optional(),
      }),
    )
    .max(20),
  refPrefix: z.string().regex(/^[A-Z][A-Z0-9]{0,9}$/, 'Use 1-10 capital letters or digits').optional(),
  transitions: z.record(z.string(), z.array(z.string())).optional(),
  priority: z
    .object({
      default: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
      rules: z.array(z.object({ if: conditionSchema, priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']) })).max(20).optional(),
    })
    .optional(),
  actions: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Action keys are lower_snake_case'),
        label: z.string().max(40),
        from: z.array(z.string()).max(20).optional(),
        to: z.string(),
        requireFields: z.array(z.string()).max(30).optional(),
        requireComment: z.boolean().optional(),
        requireFiles: z.object({ count: z.number().int().min(1).max(20).optional(), picturesOnly: z.boolean().optional(), if: conditionSchema.optional() }).optional(),
        approval: z.object({ to: recipients, onReject: z.string().optional(), if: conditionSchema.optional(), need: z.enum(['ANY', 'ALL']).optional(), dueInHours: z.number().positive().max(8760).optional(), whenLate: z.enum(['REMIND', 'MANAGER', 'REJECT']).optional(), byEmail: z.boolean().optional() }).optional(),
      }),
    )
    .max(30)
    .optional(),
  reopen: z.object({ to: z.string(), withinDays: z.number().int().positive().max(3650).optional() }).optional(),
  sla: z
    .object({
      calendar: z.enum(['WORKING', '24x7']).optional(),
      responseHours: z.number().positive().max(8760).optional(),
      resolutionHours: z.number().positive().max(8760).optional(),
      // partialRecord: zod 4's record() with enum keys would demand all four priorities.
      byPriority: z
        .partialRecord(
          z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
          z.object({ responseHours: z.number().positive().max(8760).optional(), resolutionHours: z.number().positive().max(8760).optional() }),
        )
        .optional(),
      pauseIn: z.array(z.string()).max(20).optional(),
      warnAtPercent: z.number().int().min(1).max(99).optional(),
    })
    .optional(),
  escalation: z
    .object({
      levels: z
        .array(
          z.object({
            afterHours: z.number().min(0).max(8760),
            notify: recipients,
            reassignTo: z.string().max(64).optional(),
            raisePriority: z.boolean().optional(),
          }),
        )
        .max(5),
    })
    .optional(),
  requestInfoStatus: z.string().optional(),
  contactEmailField: z.string().optional(),
  emailTemplates: z
    .array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Template keys are lower_snake_case'), name: z.string().max(80), subject: z.string().max(200), body: z.string().max(10_000) }))
    .max(30)
    .optional(),
  workFields: z.array(fieldSchema).max(100).optional(),
  assignment: z
    .union([
      z.object({ type: z.literal('NONE') }),
      z.object({ type: z.literal('USER'), userId: z.string().max(64) }),
      z.object({ type: z.literal('ROUND_ROBIN'), userIds: z.array(z.string().min(1).max(64)).max(50) }),
      z.object({
        type: z.literal('BY_FIELD'),
        field: z.string(),
        map: z.record(z.string(), z.string().min(1).max(64)),
        fallbackUserId: z.string().max(64).optional(),
      }),
    ])
    .optional(),
});

/** Publish-level checks: the workflow only refers to things that exist. */
export function checkWorkflow(def: FormDefinition, ctx: z.RefinementCtx) {
  const add = issueAdder(ctx);
  const { fields, wf, statusKeys, knownRef } = referencesOf(def);

  if (wf?.enabled) {
    if (!wf.statuses.length) add(['workflow', 'statuses'], 'A workflow needs at least one status');
    if (statusKeys.size !== wf.statuses.length) add(['workflow', 'statuses'], 'Status keys must be unique');
    if (!wf.statuses.some((st) => st.category === 'DONE')) add(['workflow', 'statuses'], 'Add at least one "done" status so records can be closed');
    for (const [from, tos] of Object.entries(wf.transitions ?? {})) {
      for (const k of [from, ...tos]) if (!statusKeys.has(k)) add(['workflow', 'transitions'], `Unknown status "${k}" in allowed moves`);
    }
    wf.statuses.forEach((st, i) => {
      if (!st.label.trim()) add(['workflow', 'statuses', i], 'Give every status a name');
    });
    checkWorkFields(wf.workFields ?? [], add);
    const workNames = new Set((wf.workFields ?? []).filter(isValueField).map((f) => f.name));
    const actionKeys = new Set<string>();
    (wf.actions ?? []).forEach((act, i) => {
      const at = ['workflow', 'actions', i];
      if (!act.label.trim()) add(at, 'Give every action a button label');
      if (actionKeys.has(act.key)) add(at, `Two actions use the key "${act.key}"`);
      actionKeys.add(act.key);
      if (!statusKeys.has(act.to)) add(at, `"${act.label}" moves to an unknown status "${act.to}"`);
      for (const f of act.from ?? []) if (!statusKeys.has(f)) add(at, `"${act.label}" is offered in an unknown status "${f}"`);
      for (const f of act.requireFields ?? []) if (!workNames.has(f)) add(at, `"${act.label}" requires an unknown work field "${f}"`);
    });
    const usersOnly = (to: { kind: string }[]) => to.every((r) => r.kind !== 'FIELD' && r.kind !== 'EMAIL');
    (wf.actions ?? []).forEach((act, i) => {
      const at = ['workflow', 'actions', i];
      if (!act.approval) return;
      if (!act.approval.to.length) add(at, `"${act.label}": choose who approves`);
      if (!usersOnly(act.approval.to)) add(at, `"${act.label}": approvers must be Prism users`);
      if (act.approval.onReject && !statusKeys.has(act.approval.onReject)) add(at, `"${act.label}": unknown status "${act.approval.onReject}" on reject`);
    });
    const category = new Map(wf.statuses.map((st) => [st.key, st.category]));
    if (wf.reopen && category.get(wf.reopen.to) !== 'OPEN' && category.get(wf.reopen.to) !== 'IN_PROGRESS') {
      add(['workflow', 'reopen'], 'Reopen into an open or in-progress status');
    }
    for (const k of wf.sla?.pauseIn ?? []) if (!statusKeys.has(k)) add(['workflow', 'sla'], `Unknown status "${k}" to pause in`);
    if (wf.sla?.calendar && !wf.sla.responseHours && !wf.sla.resolutionHours && !wf.sla.byPriority) add(['workflow', 'sla'], 'Set a response or resolution time');
    (wf.escalation?.levels ?? []).forEach((lvl, i) => {
      const at = ['workflow', 'escalation', 'levels', i];
      if (!lvl.notify.length && !lvl.reassignTo && !lvl.raisePriority) add(at, `Escalation level ${i + 1} does nothing`);
      if (!usersOnly(lvl.notify)) add(at, `Escalation level ${i + 1}: notify Prism users only`);
    });
    if (wf.escalation?.levels.length && !wf.sla?.resolutionHours && !wf.sla?.byPriority) add(['workflow', 'escalation'], 'Escalation needs a resolution time (SLA)');
    if (wf.requestInfoStatus && !statusKeys.has(wf.requestInfoStatus)) add(['workflow', 'requestInfoStatus'], `Unknown status "${wf.requestInfoStatus}"`);
    if (wf.contactEmailField && fields.get(wf.contactEmailField)?.type !== 'EMAIL') add(['workflow', 'contactEmailField'], `"${wf.contactEmailField}" is not an email field`);
    const templateKeys = new Set<string>();
    (wf.emailTemplates ?? []).forEach((t, i) => {
      const at = ['workflow', 'emailTemplates', i];
      if (templateKeys.has(t.key)) add(at, `Two email templates use the key "${t.key}"`);
      templateKeys.add(t.key);
      if (!t.name.trim() || !t.subject.trim() || !t.body.trim()) add(at, `Email template "${t.name || t.key}" needs a name, subject and message`);
    });
    (wf.priority?.rules ?? []).forEach((r, i) => {
      for (const ref of conditionFields(r.if)) if (!fields.has(ref)) add(['workflow', 'priority', 'rules', i], `Priority rule uses unknown field "${ref}"`);
    });
    const a = wf.assignment;
    if (a?.type === 'BY_FIELD' && !fields.has(a.field)) add(['workflow', 'assignment'], `Assignment uses unknown field "${a.field}"`);
    if (a?.type === 'USER' && !a.userId) add(['workflow', 'assignment'], 'Choose who new records go to');
    if (a?.type === 'ROUND_ROBIN' && !a.userIds.length) add(['workflow', 'assignment'], 'Choose at least one person for the team');
  }

  if (def.recordAccess && !def.recordAccess.userIds.length && !def.recordAccess.departments.length) {
    add(['recordAccess'], 'Add at least one person or department to the team that works these records');
  }

  (wf?.enabled ? wf.actions ?? [] : []).forEach((act, i) => {
    for (const ref of act.approval?.if ? conditionFields(act.approval.if) : []) {
      if (!knownRef(ref)) add(['workflow', 'actions', i], `"${act.label}": the approval condition uses unknown field "${ref}"`);
    }
    for (const ref of act.requireFiles?.if ? conditionFields(act.requireFiles.if) : []) {
      if (!knownRef(ref)) add(['workflow', 'actions', i], `"${act.label}": the condition for asking for a file uses unknown field "${ref}"`);
    }
  });
}

/** Types the team can fill in the portal (no uploads, CAPTCHA or system values). */
const WORK_FIELD_TYPES: ReadonlySet<FormField['type']> = new Set([
  'TEXT',
  'TEXTAREA',
  'EMAIL',
  'PHONE',
  'NUMBER',
  'DATE',
  'DATETIME',
  'DROPDOWN',
  'MULTI_SELECT',
  'RADIO',
  'CHECKBOX',
  'SECTION',
  'COLUMNS',
  'HTML',
]);

function checkWorkFields(fields: FormField[], add: AddIssue) {
  const names = new Set<string>();
  const ids = new Set<string>();
  fields.forEach((f, i) => {
    const at = ['workflow', 'workFields', i];
    if (!WORK_FIELD_TYPES.has(f.type)) add(at, `"${f.label || f.name}": ${f.type} can't be a work field`);
    if (names.has(f.name)) add(at, `Two work fields use the key "${f.name}"`);
    if (ids.has(f.id)) add(at, `Duplicate work field id "${f.id}"`);
    if (f.dataSource && f.dataSource.type !== 'STATIC') add(at, `"${f.label || f.name}": work fields use fixed options`);
    if (f.prefill || f.systemSource) add(at, `"${f.label || f.name}": work fields can't be pre-filled`);
    if (f.required || f.requiredWhen) add(at, `"${f.label || f.name}": make it required on an action instead`);
    names.add(f.name);
    ids.add(f.id);
  });
}

