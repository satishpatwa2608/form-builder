import { z } from 'zod';
import type { Condition, FormDefinition, FormEventAction, FormField, RuleAction } from './types';
import { conditionFields } from './evaluate-condition';
import { checkExpression, expressionFields, MAX_EXPRESSION_LENGTH } from './expression';
import { isExpressionCondition } from './form-state';
import { isTimeZone, safeLinkUrl } from './form-events';
import { formShape, MAX_ROWS, ROW_FIELD_TYPES } from './repeat';
import { isContainerField, isNumberField, isOptionField, isRepeat, isSectionGroup, isValueField } from './field-kinds';
import { columnCount } from './layout';
import { isHexColor, safeImageUrl, usedStyleIds } from './style-css';
import { fieldParents, paramReferences } from './resolve-params';
import { stepKey } from './workflow';

/**
 * Validates a FormDefinition *itself* - fixtures, builder output and (later)
 * API responses - so a malformed form fails loudly at load time instead of
 * half-rendering. Typed against the interfaces in ../types, so the two cannot
 * drift apart silently.
 */

const operatorSchema = z.enum([
  'equals',
  'notEquals',
  'contains',
  'notContains',
  'in',
  'notIn',
  'isEmpty',
  'isNotEmpty',
  'greaterThan',
  'lessThan',
  'greaterThanOrEqual',
  'lessThanOrEqual',
]);

const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(conditionSchema).min(1) }),
    z.object({ any: z.array(conditionSchema).min(1) }),
    z.object({ field: z.string().min(1), operator: operatorSchema, value: z.unknown().optional() }),
  ]),
);

const selectOptionSchema = z.object({ label: z.string().min(1), value: z.string().min(1) });

const dataSourceSchema = z.object({
  type: z.enum(['STATIC', 'API']),
  options: z.array(selectOptionSchema).optional(),
  api: z
    .object({
      url: z.string().min(1),
      method: z.enum(['GET', 'POST']),
      valueField: z.string().min(1),
      labelField: z.string().min(1),
      params: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
});

const expressionText = z.string().min(1).max(MAX_EXPRESSION_LENGTH);

const ruleActionSchema: z.ZodType<RuleAction> = z.union([
  z.object({ type: z.enum(['SHOW', 'HIDE', 'ENABLE', 'DISABLE', 'REQUIRE']), target: z.string().min(1) }),
  z.object({ type: z.literal('SET_VALUE'), target: z.string().min(1), value: expressionText }),
  z.object({ type: z.literal('ERROR'), target: z.string().min(1), message: z.string().min(1).max(300) }),
  z.object({ type: z.literal('SET_OPTIONS'), target: z.string().min(1), values: z.array(z.string().min(1)).min(1).max(500) }),
]);

export const MAX_RULES = 100;
const MAX_RULE_ACTIONS = 20;

const ruleSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(120).optional(),
  disabled: z.boolean().optional(),
  when: z.union([z.object({ expr: expressionText }), conditionSchema]).optional(),
  then: z.array(ruleActionSchema).min(1).max(MAX_RULE_ACTIONS),
  else: z.array(ruleActionSchema).max(MAX_RULE_ACTIONS).optional(),
});

const fetchSourceSchema = z.object({
  url: z.string().min(1).max(300),
  method: z.enum(['GET', 'POST']),
  params: z.record(z.string(), z.string().max(200)).optional(),
});

const eventActionSchema: z.ZodType<FormEventAction> = z.union([
  z.object({ type: z.literal('SET_VALUE'), target: z.string().min(1), value: expressionText }),
  z.object({ type: z.literal('GO_TO_STEP'), step: z.string().min(1) }),
  z.object({ type: z.literal('FETCH'), source: fetchSourceSchema, set: z.record(z.string(), z.string().min(1).max(100)) }),
  z.object({ type: z.literal('SHOW_MESSAGE'), message: z.string().min(1).max(500) }),
  z.object({ type: z.literal('REDIRECT'), url: z.string().min(1).max(500) }),
]);

export const MAX_EVENTS = 50;

const eventSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(120).optional(),
  disabled: z.boolean().optional(),
  on: z.union([
    z.object({ type: z.enum(['LOAD', 'SUBMIT_SUCCESS', 'SUBMIT_ERROR']) }),
    z.object({ type: z.literal('CLICK'), field: z.string().min(1) }),
  ]),
  when: z.union([z.object({ expr: expressionText }), conditionSchema]).optional(),
  do: z.array(eventActionSchema).min(1).max(10),
});

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const fieldSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    'TEXT',
    'TEXTAREA',
    'NUMBER',
    'EMAIL',
    'PHONE',
    'DATE',
    'DATETIME',
    'CHECKBOX',
    'RADIO',
    'DROPDOWN',
    'MULTI_SELECT',
    'FILE',
    'HIDDEN',
    'HTML',
    'BUTTON',
    'CAPTCHA',
    'SWITCH',
    'CHECKBOX_GROUP',
    'STEPPER',
    'SIGNATURE',
    'CONSENT',
    'IMAGE',
    'COLUMNS',
    'SECTION',
    'TABS',
    'ACCORDION',
    'REPEAT',
  ]),
  name: z.string().regex(FIELD_NAME, 'Field name must be letters, digits or _, not starting with a digit'),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  helpText: z.string().optional(),
  required: z.boolean().optional(),
  requiredWhen: conditionSchema.optional(),
  disabled: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
  validation: z
    .object({
      minLength: z.number().int().nonnegative().optional(),
      maxLength: z.number().int().positive().optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      pattern: z.string().optional(),
      messages: z
        .object({
          required: z.string().optional(),
          minLength: z.string().optional(),
          maxLength: z.string().optional(),
          min: z.string().optional(),
          max: z.string().optional(),
          pattern: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  visibility: z.object({ when: conditionSchema }).optional(),
  dependency: z
    .object({ dependsOn: z.array(z.string().min(1)).min(1), resetOnChange: z.boolean().optional() })
    .optional(),
  dataSource: dataSourceSchema.optional(),
  systemSource: z
    .enum([
      'ORG_ID',
      'BUSINESS_ID',
      'USER_ID',
      'USER_EMAIL',
      'USER_NAME',
      'USER_PHONE',
      'EMPLOYEE_ID',
      'FORM_ID',
      'FORM_VERSION',
      'SOURCE_CHANNEL',
      'CURRENT_DATE',
      'URL_PARAMETER',
    ])
    .optional(),
  systemParam: z.string().optional(),
  prefill: z
    .object({
      source: z.enum(['USER_NAME', 'USER_EMAIL', 'USER_PHONE', 'EMPLOYEE_ID', 'USER_ID']),
      lock: z.boolean().optional(),
    })
    .optional(),
  parentId: z.string().optional(),
  column: z.number().int().nonnegative().optional(),
  width: z.enum(['full', 'half', 'third', 'two-thirds']).optional(),
  styleId: z.string().optional(),
  props: z.record(z.string(), z.unknown()).optional(),
});

export const formStyleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  props: z.object({
    textColor: z.string().optional(),
    labelColor: z.string().optional(),
    backgroundColor: z.string().optional(),
    borderColor: z.string().optional(),
    borderWidth: z.number().optional(),
    borderRadius: z.number().optional(),
    padding: z.number().optional(),
    fontSize: z.number().optional(),
    fontWeight: z.union([z.literal(400), z.literal(500), z.literal(600), z.literal(700)]).optional(),
    textAlign: z.enum(['left', 'center', 'right']).optional(),
    shadow: z.enum(['none', 'sm', 'md', 'lg']).optional(),
    inputBackground: z.string().optional(),
    inputBorderColor: z.string().optional(),
  }),
});

// Structure only: drafts are saved while half-filled. "Required" is checked at publish (checkWorkflow).
const recipientSchema = z.union([
  z.object({ kind: z.literal('ASSIGNEE') }),
  z.object({ kind: z.literal('SUBMITTER') }),
  z.object({ kind: z.literal('USER'), userId: z.string().min(1).max(64) }),
  z.object({ kind: z.literal('MANAGER') }),
  z.object({ kind: z.literal('FIELD'), field: z.string().min(1) }),
  z.object({ kind: z.literal('EMAIL'), email: z.email() }),
]);

const recipients = z.array(recipientSchema).max(10);

/** Common to every step. Ids are what later steps use: {{$steps.<id>.<field>}}. */
const stepMeta = {
  id: z.string().regex(/^[a-z][a-z0-9_]{0,29}$/, 'Step keys are lower-case letters, digits and _').optional(),
  label: z.string().max(80).optional(),
  if: conditionSchema.optional(),
  continueOnError: z.boolean().optional(),
};

const actionSchema = z.union([
  z.object({ ...stepMeta, type: z.literal('EMAIL'), to: recipients, subject: z.string().max(200), body: z.string().max(10_000) }),
  z.object({ ...stepMeta, type: z.literal('NOTIFY'), to: recipients, message: z.string().max(500) }),
  z.object({
    ...stepMeta,
    type: z.literal('CREATE_TASK'),
    title: z.string().max(100),
    description: z.string().max(1000).optional(),
    to: recipients,
    dueInHours: z.number().positive().max(8760).optional(),
  }),
  z.object({
    ...stepMeta,
    type: z.literal('APPROVAL'),
    to: recipients,
    title: z.string().max(120),
    instructions: z.string().max(2000).optional(),
    dueInHours: z.number().positive().max(8760).optional(),
  }),
  z.object({ ...stepMeta, type: z.literal('ASSIGN'), userId: z.string().max(64) }),
  z.object({ ...stepMeta, type: z.literal('SET_STATUS'), status: z.string().max(40) }),
  z.object({ ...stepMeta, type: z.literal('WEBHOOK'), url: z.string().max(500) }),
  z.object({ ...stepMeta, type: z.literal('HANDLER'), key: z.string().max(60) }),
]);

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
        approval: z.object({ to: recipients, onReject: z.string().optional(), if: conditionSchema.optional() }).optional(),
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

export const automationSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(100),
  enabled: z.boolean(),
  when: z.enum(['SUBMITTED', 'STATUS_CHANGED', 'SLA_BREACHED', 'SLA_APPROACHING', 'FIELD_UPDATED']),
  sla: z.enum(['STATUS', 'RESPONSE', 'RESOLUTION']).optional(),
  toStatus: z.string().optional(),
  field: z.string().optional(),
  if: conditionSchema.optional(),
  actions: z.array(actionSchema).max(10),
});

/** Publish-level checks: workflow and automations only refer to things that exist. */
function checkWorkflow(def: FormDefinition, ctx: z.RefinementCtx) {
  const add = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  const fields = new Map(def.fields.map((f) => [f.name, f]));
  const wf = def.workflow;
  const statusKeys = new Set((wf?.enabled ? wf.statuses : []).map((st) => st.key));

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

  const needsWorkflow = 'Turn on the workflow (statuses) to use this';
  const workFieldNames = new Set((wf?.enabled ? wf.workFields ?? [] : []).filter(isValueField).map((f) => f.name));
  /** Answers, plus (with a workflow) $status, $priority and $work.<field>. */
  const knownRef = (ref: string) =>
    ref === '$status' || ref === '$priority' ? !!wf?.enabled : ref.startsWith('$work.') ? workFieldNames.has(ref.slice(6)) : fields.has(ref);
  (wf?.enabled ? wf.actions ?? [] : []).forEach((act, i) => {
    for (const ref of act.approval?.if ? conditionFields(act.approval.if) : []) {
      if (!knownRef(ref)) add(['workflow', 'actions', i], `"${act.label}": the approval condition uses unknown field "${ref}"`);
    }
  });
  (def.automations ?? []).forEach((auto, i) => {
    const at = (k: string) => ['automations', i, k];
    if (!auto.name.trim()) add(at('name'), 'Give the automation a name');
    if (!auto.actions.length) add(at('actions'), `"${auto.name}" has no steps`);
    if (!wf?.enabled && auto.when !== 'SUBMITTED') add(at('when'), needsWorkflow);
    if (auto.when === 'FIELD_UPDATED' && auto.field && !workFieldNames.has(auto.field)) add(at('field'), `Unknown work field "${auto.field}"`);
    if (auto.toStatus && !statusKeys.has(auto.toStatus)) add(at('toStatus'), `Unknown status "${auto.toStatus}"`);
    if (auto.if) {
      for (const ref of conditionFields(auto.if)) {
        if (!knownRef(ref)) add(at('if'), ref.startsWith('$') && !wf?.enabled ? needsWorkflow : `Condition uses unknown field "${ref}"`);
      }
    }
    const seen = new Set<string>();
    auto.actions.forEach((action, k) => {
      const missing = (what: string) => add(at('actions'), `"${auto.name}": ${what}`);
      const key = stepKey(action, k);
      if (seen.has(key)) missing(`two steps use the key "${key}"`);
      // A step's condition may test answers, the status, and outputs of steps above it.
      for (const ref of action.if ? conditionFields(action.if) : []) {
        const earlier = /^\$steps\.([a-z0-9_]+)\./.exec(ref)?.[1];
        const ok = earlier ? seen.has(earlier) : knownRef(ref);
        if (!ok) missing(`step ${k + 1}'s condition uses "${ref}", which isn't an answer${wf?.enabled ? ', the status' : ''} or an earlier step's output`);
      }
      seen.add(key);
      if ((action.type === 'EMAIL' || action.type === 'NOTIFY' || action.type === 'CREATE_TASK' || action.type === 'APPROVAL') && !action.to.length) {
        missing(action.type === 'APPROVAL' ? 'choose who approves' : 'add who it goes to');
      }
      if (action.type === 'APPROVAL' && !action.title.trim()) missing('the approval needs a title');
      if (action.type === 'EMAIL' && (!action.subject.trim() || !action.body.trim())) missing('the email needs a subject and a message');
      if (action.type === 'NOTIFY' && !action.message.trim()) missing('the notification needs a message');
      if (action.type === 'CREATE_TASK' && !action.title.trim()) missing('the task needs a title');
      if (action.type === 'ASSIGN' && wf?.enabled && !action.userId) missing('choose who to assign');
      if (action.type === 'WEBHOOK' && !/^https:\/\/[^\s/]+\.[^\s]+$/.test(action.url)) missing('webhooks need a full https URL');
      if (action.type === 'HANDLER' && !/^[a-z0-9-]{1,60}$/.test(action.key)) missing('choose a custom API');
      const recipients = 'to' in action ? action.to : [];
      for (const r of recipients) {
        if (r.kind === 'FIELD' && fields.get(r.field)?.type !== 'EMAIL') add(at('actions'), `"${r.field}" is not an email field`);
        if ((r.kind === 'ASSIGNEE' || r.kind === 'MANAGER') && !wf?.enabled) add(at('actions'), `The assignee: ${needsWorkflow}`);
      }
      if ((action.type === 'SET_STATUS' || action.type === 'ASSIGN') && !wf?.enabled) add(at('actions'), needsWorkflow);
      else if (action.type === 'SET_STATUS' && !statusKeys.has(action.status)) add(at('actions'), `Unknown status "${action.status}"`);
      if ((action.type === 'NOTIFY' || action.type === 'CREATE_TASK' || action.type === 'APPROVAL') && action.to.some((r) => r.kind === 'FIELD' || r.kind === 'EMAIL')) {
        add(at('actions'), 'Notifications, tasks and approvals go to Prism users (assignee, submitter or a chosen user)');
      }
    });
  });
  if ((def.automations?.length ?? 0) > 30) add(['automations'], 'A form can have at most 30 automations');
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

function checkWorkFields(fields: FormField[], add: (path: (string | number)[], message: string) => void) {
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

/** Returns the names on a cycle in `edges` (name -> names it points at), or null. */
export function findCycle(edges: Map<string, string[]>): string[] | null {
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (node: string): string[] | null => {
    if (state.get(node) === 'done') return null;
    if (state.get(node) === 'visiting') return [...stack.slice(stack.indexOf(node)), node];
    state.set(node, 'visiting');
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(node, 'done');
    return null;
  };

  for (const node of edges.keys()) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return null;
}

/** Visible field types that can be pre-filled from the signed-in user. */
const PREFILL_TYPES: ReadonlySet<FormField['type']> = new Set(['TEXT', 'EMAIL', 'PHONE']);

/** Types that show no label of their own. Every other field needs one to publish. */
const UNLABELLED_TYPES: ReadonlySet<FormField['type']> = new Set(['HIDDEN', 'HTML', 'CAPTCHA', 'IMAGE', 'COLUMNS', 'SECTION', 'TABS', 'ACCORDION']);

function checkFields(fields: FormField[], ctx: z.RefinementCtx) {
  if (!fields.some((f) => isValueField(f) && f.type !== 'HIDDEN')) {
    ctx.addIssue({ code: 'custom', path: ['fields'], message: 'Add at least one field for people to fill in' });
  }

  const names = new Set<string>();
  const ids = new Set<string>();
  const issue = (index: number, key: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: ['fields', index, key], message });

  fields.forEach((f, i) => {
    if (ids.has(f.id)) issue(i, 'id', `Duplicate field id "${f.id}"`);
    if (names.has(f.name)) issue(i, 'name', `Duplicate field name "${f.name}"`);
    ids.add(f.id);
    names.add(f.name);
  });

  const shape = formShape(fields);
  const visibilityEdges = new Map<string, string[]>();
  const layoutEdges = new Map<string, string[]>();
  const byId = new Map(fields.map((f) => [f.id, f]));
  const dependencyEdges = new Map<string, string[]>();

  fields.forEach((f, i) => {
    const checkRefs = (cond: Condition, key: string) => {
      for (const ref of conditionFields(cond)) {
        if (ref === f.name) issue(i, key, `"${f.name}" cannot refer to itself`);
        else if (!names.has(ref)) issue(i, key, `Refers to unknown field "${ref}"`);
      }
    };
    if (f.visibility) {
      checkRefs(f.visibility.when, 'visibility');
      visibilityEdges.set(f.name, conditionFields(f.visibility.when));
    }
    if (f.requiredWhen) checkRefs(f.requiredWhen, 'requiredWhen');
    if (f.dependency) {
      for (const parent of f.dependency.dependsOn) {
        if (parent === f.name) issue(i, 'dependency', `"${f.name}" cannot depend on itself`);
        else if (!names.has(parent)) issue(i, 'dependency', `Depends on unknown field "${parent}"`);
      }
    }
    for (const ref of paramReferences(f.dataSource?.api?.params).fields) {
      if (ref === f.name) issue(i, 'dataSource', `"${f.name}" cannot use its own value as an API parameter`);
      else if (!names.has(ref)) issue(i, 'dataSource', `API parameter refers to unknown field "${ref}"`);
    }
    const parents = fieldParents(f);
    if (parents.length) dependencyEdges.set(f.name, parents);

    if (isOptionField(f)) {
      const ds = f.dataSource;
      if (!ds) issue(i, 'dataSource', `${f.type} field "${f.name}" needs a data source`);
      else if (ds.type === 'STATIC' && !ds.options?.length) issue(i, 'dataSource', 'Static data source has no options');
      else if (ds.type === 'API' && !ds.api) issue(i, 'dataSource', 'API data source has no api config');
      const values = (ds?.options ?? []).map((o) => o.value);
      const repeated = values.find((v, n) => values.indexOf(v) !== n);
      if (repeated !== undefined) issue(i, 'dataSource', `Option value "${repeated}" is used twice`);
    }
    if (!f.label?.trim() && !UNLABELLED_TYPES.has(f.type)) issue(i, 'label', `"${f.name}" needs a label`);
    if (f.systemSource && f.type !== 'HIDDEN') issue(i, 'systemSource', 'Only HIDDEN fields take a systemSource');
    if (f.prefill && !PREFILL_TYPES.has(f.type)) issue(i, 'prefill', 'Only text, email and phone fields can be filled from the user');
    if (f.parentId !== undefined) {
      const parent = byId.get(f.parentId);
      if (f.parentId === f.id) issue(i, 'parentId', 'A field cannot be inside itself');
      else if (!parent) issue(i, 'parentId', 'Is inside a container that no longer exists');
      else if (!isContainerField(parent)) issue(i, 'parentId', `"${parent.name}" is not a Columns or Section block`);
      else if (isSectionGroup(parent) && f.type !== 'SECTION') issue(i, 'parentId', `Only sections go directly inside "${parent.name}": put this field in one of them`);
      else if ((f.column ?? 0) >= columnCount(parent)) issue(i, 'column', `"${parent.name}" has no column ${(f.column ?? 0) + 1}`);
      if (parent && isContainerField(parent)) layoutEdges.set(f.id, [parent.id]);
    }
    // Like a button with no link, a picture with no address yet is allowed: it shows nothing.
    if (f.type === 'IMAGE' && f.props?.src) {
      if (!safeImageUrl(f.props.src)) issue(i, 'props', 'The picture needs an https:// or site-relative (/…) address');
      else if (typeof f.props?.alt !== 'string' || !f.props.alt.trim()) issue(i, 'props', 'Describe the picture for people who cannot see it');
    }
    if (f.type === 'CONSENT' && (typeof f.props?.text !== 'string' || !f.props.text.trim())) issue(i, 'props', `"${f.name}" needs the terms people are accepting`);
    if (f.type === 'STEPPER' && f.props?.step !== undefined && !(typeof f.props.step === 'number' && f.props.step > 0)) {
      issue(i, 'props', 'The step must be a number above 0');
    }
    const section = shape.repeatOf.get(f.name);
    if (section) {
      const inside = `inside the repeating section "${section.name}"`;
      if (!ROW_FIELD_TYPES.has(f.type)) issue(i, 'parentId', `A ${f.type} field cannot go ${inside}`);
      if (f.prefill || f.systemSource) issue(i, 'parentId', `"${f.name}" is filled from the system, which does not work ${inside}`);
      if (f.dataSource?.type === 'API') issue(i, 'dataSource', `Use a fixed option list ${inside}`);
      if (f.dependency) issue(i, 'dependency', `"Clear when another field changes" does not work ${inside}`);
    }
    if (isRepeat(f)) {
      const children = shape.repeats.find((r) => r.field === f)?.valueChildren ?? [];
      if (f.validation?.max !== undefined && f.validation.max > MAX_ROWS) issue(i, 'validation', `A repeating section can have at most ${MAX_ROWS} rows`);
      if (f.defaultValue !== undefined) issue(i, 'defaultValue', 'A repeating section has no default value');
      const totals = Array.isArray(f.props?.totals) ? (f.props.totals as unknown[]) : [];
      for (const name of totals) {
        const child = children.find((c) => c.name === name);
        if (!child || !isNumberField(child)) issue(i, 'props', `Only a number field inside "${f.name}" can be totalled, not "${String(name)}"`);
      }
    }
    if (f.systemSource === 'URL_PARAMETER' && !f.systemParam) {
      issue(i, 'systemParam', 'URL_PARAMETER needs systemParam (the query-string key)');
    }

    const v = f.validation;
    if (v?.pattern !== undefined) {
      try {
        new RegExp(v.pattern);
      } catch {
        issue(i, 'validation', `Invalid pattern: ${v.pattern}`);
      }
    }
    if (v?.minLength !== undefined && v.maxLength !== undefined && v.minLength > v.maxLength) {
      issue(i, 'validation', 'minLength is greater than maxLength');
    }
    if (v?.min !== undefined && v.max !== undefined && v.min > v.max) {
      issue(i, 'validation', 'min is greater than max');
    }
  });

  const visibilityCycle = findCycle(visibilityEdges);
  if (visibilityCycle) {
    ctx.addIssue({ code: 'custom', path: ['fields'], message: `Visibility rules loop: ${visibilityCycle.join(' -> ')}` });
  }
  if (findCycle(layoutEdges)) {
    ctx.addIssue({ code: 'custom', path: ['fields'], message: 'Containers are nested inside each other in a loop' });
  }
  const dependencyCycle = findCycle(dependencyEdges);
  if (dependencyCycle) {
    ctx.addIssue({ code: 'custom', path: ['fields'], message: `Dependencies loop: ${dependencyCycle.join(' -> ')}` });
  }
}

/** Types a rule can calculate a value into. Lists and files are chosen, never computed. */
const CALCULABLE_TYPES: ReadonlySet<FormField['type']> = new Set([
  'TEXT',
  'TEXTAREA',
  'NUMBER',
  'EMAIL',
  'PHONE',
  'DATE',
  'DATETIME',
  'CHECKBOX',
  'SWITCH',
  'STEPPER',
  'RADIO',
  'DROPDOWN',
  'HIDDEN',
]);

function checkRules(def: FormDefinition, ctx: z.RefinementCtx) {
  const rules = def.rules ?? [];
  const byName = new Map(def.fields.map((f) => [f.name, f]));
  const names = new Set(byName.keys());
  const ids = new Set<string>();
  const calcEdges = new Map<string, string[]>();
  const visibilityEdges = new Map<string, string[]>();
  for (const f of def.fields) if (f.visibility) visibilityEdges.set(f.name, conditionFields(f.visibility.when));
  const legacyLoop = !!findCycle(visibilityEdges);
  const link = (edges: Map<string, string[]>, from: string, to: string[]) => edges.set(from, [...(edges.get(from) ?? []), ...to]);

  rules.forEach((rule, r) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path: ['rules', r, ...path], message });
    if (ids.has(rule.id)) issue(['id'], `Duplicate rule id "${rule.id}"`);
    ids.add(rule.id);

    let reads: string[] = [];
    if (rule.when && isExpressionCondition(rule.when)) {
      const problem = checkExpression(rule.when.expr, names);
      if (problem) issue(['when'], problem);
      reads = expressionFields(rule.when.expr);
    } else if (rule.when) {
      reads = conditionFields(rule.when);
      for (const ref of reads) if (!names.has(ref)) issue(['when'], `Refers to unknown field "${ref}"`);
    }
    if (rule.else?.length && !rule.when) issue(['else'], 'A rule with no condition always holds, so "otherwise" never happens');

    const check = (action: RuleAction, branch: 'then' | 'else', a: number) => {
      const at = (message: string) => issue([branch, a], message);
      const target = byName.get(action.target);
      if (!target) return at(`Acts on unknown field "${action.target}"`);
      switch (action.type) {
        case 'SHOW':
        case 'HIDE':
          if (reads.includes(target.name)) at(`"${target.name}" cannot be shown or hidden by its own value`);
          link(visibilityEdges, target.name, reads);
          break;
        case 'ENABLE':
        case 'DISABLE':
        case 'REQUIRE':
        case 'ERROR':
          if (!isValueField(target) || target.type === 'HIDDEN' || target.type === 'CAPTCHA') {
            at(`"${target.name}" is not a field people fill in`);
          }
          break;
        case 'SET_VALUE': {
          if (!CALCULABLE_TYPES.has(target.type)) at(`A ${target.type} field cannot be calculated`);
          if (target.systemSource || target.prefill?.lock) at(`"${target.name}" already takes its value from the system`);
          const problem = checkExpression(action.value, names);
          if (problem) at(problem);
          link(calcEdges, target.name, [...expressionFields(action.value), ...reads]);
          break;
        }
        case 'SET_OPTIONS': {
          const known = target.dataSource?.type === 'STATIC' ? new Set((target.dataSource.options ?? []).map((o) => o.value)) : null;
          if (!isOptionField(target) || !known) at(`"${target.name}" has no fixed option list to narrow`);
          else for (const v of action.values) if (!known.has(v)) at(`"${v}" is not an option of "${target.name}"`);
          break;
        }
      }
    };
    rule.then.forEach((action, a) => check(action, 'then', a));
    (rule.else ?? []).forEach((action, a) => check(action, 'else', a));
  });

  const calcLoop = findCycle(calcEdges);
  if (calcLoop) ctx.addIssue({ code: 'custom', path: ['rules'], message: `Calculations loop: ${calcLoop.join(' -> ')}` });
  // checkFields already reports a loop made only of per-field visibility.
  const visibilityLoop = legacyLoop ? null : findCycle(visibilityEdges);
  if (visibilityLoop) {
    ctx.addIssue({ code: 'custom', path: ['rules'], message: `Visibility rules loop: ${visibilityLoop.join(' -> ')}` });
  }
}

/** Which actions make sense for which trigger. */
const EVENT_ACTIONS: Record<string, ReadonlySet<FormEventAction['type']>> = {
  LOAD: new Set(['SET_VALUE', 'FETCH']),
  CLICK: new Set(['SET_VALUE', 'FETCH', 'GO_TO_STEP']),
  SUBMIT_SUCCESS: new Set(['SHOW_MESSAGE', 'REDIRECT']),
  SUBMIT_ERROR: new Set(['SHOW_MESSAGE']),
};

function checkEvents(def: FormDefinition, ctx: z.RefinementCtx) {
  const byName = new Map(def.fields.map((f) => [f.name, f]));
  const names = new Set(byName.keys());
  const ids = new Set<string>();
  (def.events ?? []).forEach((event, e) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path: ['events', e, ...path], message });
    if (ids.has(event.id)) issue(['id'], `Duplicate event id "${event.id}"`);
    ids.add(event.id);

    if (event.on.type === 'CLICK') {
      const button = byName.get(event.on.field);
      if (!button) issue(['on'], `Unknown button "${event.on.field}"`);
      else if (button.type !== 'BUTTON') issue(['on'], `"${button.name}" is not a button`);
    }
    if (event.when && isExpressionCondition(event.when)) {
      const problem = checkExpression(event.when.expr, names);
      if (problem) issue(['when'], problem);
    } else if (event.when) {
      for (const ref of conditionFields(event.when)) if (!names.has(ref)) issue(['when'], `Refers to unknown field "${ref}"`);
    }

    const calculable = (name: string, at: (message: string) => void) => {
      const target = byName.get(name);
      if (!target) at(`Acts on unknown field "${name}"`);
      else if (!CALCULABLE_TYPES.has(target.type)) at(`A ${target.type} field cannot be filled in this way`);
      else if (target.systemSource || target.prefill?.lock) at(`"${target.name}" already takes its value from the system`);
      else if (formShape(def.fields).repeatOf.has(name)) at(`"${name}" is inside a repeating section; an event cannot fill it`);
    };
    event.do.forEach((action, a) => {
      const at = (message: string) => issue(['do', a], message);
      if (!EVENT_ACTIONS[event.on.type].has(action.type)) return at('This action does not fit when the event happens');
      switch (action.type) {
        case 'SET_VALUE': {
          calculable(action.target, at);
          const problem = checkExpression(action.value, names);
          if (problem) at(problem);
          break;
        }
        case 'GO_TO_STEP': {
          const section = byName.get(action.step);
          if (def.layout?.mode !== 'steps') at('The form is not laid out in steps');
          else if (!section || section.type !== 'SECTION' || section.parentId !== undefined) at(`"${action.step}" is not one of the form's steps`);
          break;
        }
        case 'FETCH': {
          for (const ref of paramReferences(action.source.params).fields) if (!names.has(ref)) at(`Parameter refers to unknown field "${ref}"`);
          if (!Object.keys(action.set).length) at('Choose at least one field to fill in');
          for (const name of Object.keys(action.set)) calculable(name, at);
          break;
        }
        case 'REDIRECT':
          if (!safeLinkUrl(action.url)) at('The address must start with https:// or be a path on this site (/…)');
          break;
        case 'SHOW_MESSAGE':
          break;
      }
    });
  });
}

/**
 * Structure only: right types, right enums. Enough to store a DRAFT - a
 * half-built form may still have a rule pointing at a field not yet added.
 */
const formDefinitionShapeObject = z.object({
  id: z.string().min(1),
  orgId: z.string(),
  businessId: z.string(),
  name: z.string().min(1),
  code: z.string().regex(/^[A-Z0-9_]+$/, 'Form code must be UPPER_SNAKE_CASE'),
  description: z.string().optional(),
  version: z.number().int().positive(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']),
  access: z.enum(['PUBLIC', 'AUTHENTICATED']),
  fields: z.array(fieldSchema),
  rules: z.array(ruleSchema).max(MAX_RULES).optional(),
  events: z.array(eventSchema).max(MAX_EVENTS).optional(),
  timeZone: z.string().max(64).optional(),
  actions: z
    .object({
      submit: z.object({ enabled: z.boolean(), label: z.string() }).optional(),
      cancel: z
        .object({
          enabled: z.boolean(),
          label: z.string(),
          behavior: z.enum(['RESET', 'REDIRECT']),
          redirectUrl: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  submission: z.object({
    method: z.enum(['POST', 'PUT']),
    endpointId: z.string().min(1),
    mapping: z.record(z.string(), z.string()).optional(),
    success: z
      .object({
        type: z.enum(['MESSAGE', 'REDIRECT']),
        message: z.string().optional(),
        redirectUrl: z.string().optional(),
      })
      .optional(),
  }),
  captcha: z
    .object({
      enabled: z.boolean(),
      provider: z.enum(['RECAPTCHA', 'TURNSTILE']),
      siteKey: z.string(),
      mode: z.enum(['CHECKBOX', 'INVISIBLE', 'V3']),
    })
    .optional(),
  theme: z
    .object({
      primaryColor: z.string().optional(),
      backgroundColor: z.string().optional(),
      fontFamily: z.enum(['default', 'serif', 'rounded', 'mono']).optional(),
      logoUrl: z.string().optional(),
      styleId: z.string().optional(),
    })
    .optional(),
  layout: z.object({ mode: z.enum(['single', 'steps']) }).optional(),
  styles: z.array(formStyleSchema).optional(),
  workflow: workflowSchema.optional(),
  recordAccess: z
    .object({
      mode: z.literal('TEAM'),
      userIds: z.array(z.string().min(1).max(64)).max(200),
      departments: z.array(z.string().min(1).max(100)).max(50),
    })
    .optional(),
  automations: z.array(automationSchema).max(30).optional(),
  createdBy: z.string(),
  updatedBy: z.string(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const formDefinitionShape: z.ZodType<FormDefinition> = formDefinitionShapeObject;

/** Structure plus internal consistency. Required to publish and to render publicly. */
export const formDefinitionSchema: z.ZodType<FormDefinition> = formDefinitionShapeObject.superRefine((def, ctx) => {
  checkFields(def.fields, ctx);
  checkRules(def, ctx);
  checkEvents(def, ctx);
  if (def.timeZone !== undefined && !isTimeZone(def.timeZone)) {
    ctx.addIssue({ code: 'custom', path: ['timeZone'], message: `"${def.timeZone}" is not a time zone. Use a name such as Asia/Kolkata` });
  }
  checkWorkflow(def, ctx);

  const names = new Set(def.fields.map((f) => f.name));
  for (const key of Object.keys(def.submission.mapping ?? {})) {
    if (!names.has(key)) {
      ctx.addIssue({ code: 'custom', path: ['submission', 'mapping', key], message: `Maps unknown field "${key}"` });
    }
    else if (formShape(def.fields).repeatOf.has(key)) {
      ctx.addIssue({ code: 'custom', path: ['submission', 'mapping', key], message: `"${key}" is inside a repeating section and is saved with its rows` });
    }
  }

  const captchaFields = def.fields.filter((f) => f.type === 'CAPTCHA');
  if (captchaFields.length > 1) {
    ctx.addIssue({ code: 'custom', path: ['fields'], message: 'A form can have only one CAPTCHA field' });
  }
  if (captchaFields.length && !def.captcha?.enabled) {
    ctx.addIssue({ code: 'custom', path: ['captcha'], message: 'CAPTCHA field present but captcha is not configured' });
  }

  const { cancel } = def.actions ?? {};
  if (cancel?.enabled && cancel.behavior === 'REDIRECT' && !cancel.redirectUrl) {
    ctx.addIssue({ code: 'custom', path: ['actions', 'cancel', 'redirectUrl'], message: 'Redirect cancel needs a redirectUrl' });
  }
  const { theme } = def;
  for (const key of ['primaryColor', 'backgroundColor'] as const) {
    if (theme?.[key] && !isHexColor(theme[key])) {
      ctx.addIssue({ code: 'custom', path: ['theme', key], message: `${key} must be a hex colour like #1458e2` });
    }
  }
  if (theme?.logoUrl && !safeImageUrl(theme.logoUrl)) {
    ctx.addIssue({ code: 'custom', path: ['theme', 'logoUrl'], message: 'Logo must be an https:// or site-relative (/…) URL' });
  }
  if (def.styles) {
    const embedded = new Set(def.styles.map((st) => st.id));
    for (const id of usedStyleIds(def)) {
      if (!embedded.has(id)) ctx.addIssue({ code: 'custom', path: ['styles'], message: `Style "${id}" is used but not included` });
    }
  }
  const { success } = def.submission;
  if (success?.type === 'REDIRECT' && !success.redirectUrl) {
    ctx.addIssue({ code: 'custom', path: ['submission', 'success', 'redirectUrl'], message: 'Redirect on success needs a redirectUrl' });
  }
});

export interface DefinitionIssue {
  path: string;
  message: string;
}

/** 'publish' (default) = fully consistent; 'shape' = structurally valid, as drafts need. */
export type ValidationLevel = 'shape' | 'publish';

export function validateFormDefinition(
  input: unknown,
  level: ValidationLevel = 'publish',
): { success: true; data: FormDefinition } | { success: false; issues: DefinitionIssue[] } {
  const schema = level === 'shape' ? formDefinitionShape : formDefinitionSchema;
  const result = schema.safeParse(input);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  };
}

export class FormDefinitionError extends Error {
  constructor(public readonly issues: DefinitionIssue[]) {
    super(`Invalid form definition:\n${issues.map((i) => `  ${i.path || '(root)'}: ${i.message}`).join('\n')}`);
    this.name = 'FormDefinitionError';
  }
}

/** Parses or throws FormDefinitionError listing every problem. */
export function parseFormDefinition(input: unknown): FormDefinition {
  const result = validateFormDefinition(input);
  // `in` narrows under both the web's strict and the API's non-strict tsconfig.
  if ('issues' in result) throw new FormDefinitionError(result.issues);
  return result.data;
}
