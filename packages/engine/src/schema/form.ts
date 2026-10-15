import { z } from 'zod';
import { conditionSchema } from './common';
import type { Condition, FormDefinition, FormEventAction, FormField, RuleAction } from '../types';
import { conditionFields } from '../evaluate-condition';
import { checkExpression, expressionFields, MAX_EXPRESSION_LENGTH } from '../expression';
import { isExpressionCondition } from '../form-state';
import { safeLinkUrl } from '../form-events';
import { formShape, MAX_ROWS, ROW_FIELD_TYPES } from '../repeat';
import { CUSTOM_FIELD_KEY, isContainerField, isNumberField, isOptionField, isRepeat, isSectionGroup, isValueField } from '../field-kinds';
import { columnCount } from '../layout';
import { safeImageUrl } from '../style-css';
import { fieldParents, paramReferences } from '../resolve-params';

/**
 * The form itself: its fields, rules, events and data sources, and the checks that they only refer to one
 * another. Refers to nothing in the other parts.
 */

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

export const ruleSchema = z.object({
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
  z.object({ type: z.literal('FOCUS'), target: z.string().min(1) }),
  z.object({ type: z.literal('SUBMIT') }),
  z.object({ type: z.literal('RESET') }),
  z.object({ type: z.literal('SAVE') }),
  z.object({
    type: z.literal('FETCH'),
    source: fetchSourceSchema,
    set: z.record(z.string(), z.string().min(1).max(100)),
    rows: z.object({ into: z.string().min(1), set: z.record(z.string(), z.string().min(1).max(100)), from: z.string().min(1).max(100).optional() }).optional(),
  }),
  z.object({ type: z.literal('SHOW_MESSAGE'), message: z.string().min(1).max(500) }),
  z.object({ type: z.literal('REDIRECT'), url: z.string().min(1).max(500) }),
]);

export const MAX_EVENTS = 50;

export const eventSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(120).optional(),
  disabled: z.boolean().optional(),
  on: z.union([
    z.object({ type: z.enum(['LOAD', 'SUBMIT_SUCCESS', 'SUBMIT_ERROR']) }),
    z.object({ type: z.literal('CLICK'), field: z.string().min(1) }),
    z.object({ type: z.literal('CHANGE'), field: z.string().min(1) }),
  ]),
  when: z.union([z.object({ expr: expressionText }), conditionSchema]).optional(),
  do: z.array(eventActionSchema).min(1).max(10),
});

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const fieldSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    'TEXT',
    'TEXTAREA',
    'NUMBER',
    'EMAIL',
    'PHONE',
    'DATE',
    'DATETIME',
    'TIME',
    'MONTH',
    'URL',
    'COLOR',
    'SLIDER',
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
    'CUSTOM',
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
  sensitive: z.boolean().optional(),
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
    hoverBackgroundColor: z.string().optional(),
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

/** Opening the form already filled from a record (see open-with on the server). */
export const openWithSchema = z.object({
  source: z.string().min(1).max(200),
  param: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/).or(z.literal('')),
  by: z.enum(['LINK', 'USER_EMAIL', 'EMPLOYEE_ID']),
  set: z.record(z.string().max(100), z.string().min(1).max(100)),
  rows: z.array(z.object({ into: z.string().min(1), set: z.record(z.string(), z.string().min(1).max(100)), from: z.string().min(1).max(100).optional() })).max(5).optional(),
  lock: z.array(z.string().max(100)).max(100).optional(),
  only: z.boolean().optional(),
});

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

export function checkFields(fields: FormField[], ctx: z.RefinementCtx) {
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
    if (f.type === 'CUSTOM' && !(typeof f.props?.custom === 'string' && CUSTOM_FIELD_KEY.test(f.props.custom))) {
      issue(i, 'props', `Choose which of your extension's fields "${f.label || f.name}" is`);
    }
    if (f.type === 'IMAGE' && f.props?.src) {
      if (!safeImageUrl(f.props.src)) issue(i, 'props', 'The picture needs an https:// or site-relative (/…) address');
      else if (typeof f.props?.alt !== 'string' || !f.props.alt.trim()) issue(i, 'props', 'Describe the picture for people who cannot see it');
    }
    if (f.type === 'CONSENT' && (typeof f.props?.text !== 'string' || !f.props.text.trim())) issue(i, 'props', `"${f.name}" needs the terms people are accepting`);
    if (f.type === 'SLIDER') {
      const { min, max } = f.validation ?? {};
      if (typeof min !== 'number' || typeof max !== 'number' || !(max > min)) issue(i, 'validation', 'A slider needs a lowest and a highest value');
    }
    if ((f.type === 'STEPPER' || f.type === 'SLIDER') && f.props?.step !== undefined && !(typeof f.props.step === 'number' && f.props.step > 0)) {
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
  'TIME',
  'MONTH',
  'URL',
  'COLOR',
  'SLIDER',
  'CHECKBOX',
  'SWITCH',
  'STEPPER',
  'RADIO',
  'DROPDOWN',
  'HIDDEN',
]);

export function checkRules(def: FormDefinition, ctx: z.RefinementCtx) {
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

/** Email and phone fields can be confirmed with a one-time code (`props.verify`); nothing else can. */
export const VERIFIABLE_TYPES: ReadonlySet<FormField['type']> = new Set(['EMAIL', 'PHONE']);
/** Whether the person must confirm this field's value with a code sent to it. */
export const needsCode = (field: Pick<FormField, 'type' | 'props'>): boolean => VERIFIABLE_TYPES.has(field.type) && field.props?.verify === true;

export function checkPaymentAndCodes(def: FormDefinition, ctx: z.RefinementCtx) {
  const repeated = formShape(def.fields).repeatOf;
  def.fields.forEach((f, i) => {
    if (f.props?.verify !== true) return;
    if (!VERIFIABLE_TYPES.has(f.type)) ctx.addIssue({ code: 'custom', path: ['fields', i, 'props'], message: 'Only an email or a phone field can be confirmed with a code' });
    else if (repeated.has(f.name)) ctx.addIssue({ code: 'custom', path: ['fields', i, 'props'], message: `"${f.name}" is inside a repeating section, where a code cannot be asked for` });
  });
  if (!def.payment?.enabled) return;
  const amount = def.fields.find((f) => f.name === def.payment!.amountField);
  if (!amount) ctx.addIssue({ code: 'custom', path: ['payment', 'amountField'], message: 'Choose the field that holds the amount to pay' });
  else if (!isNumberField(amount) || repeated.has(amount.name)) ctx.addIssue({ code: 'custom', path: ['payment', 'amountField'], message: `"${amount.label || amount.name}" is not a number field of the form itself` });
}

/** Which actions make sense for which trigger. */
const EVENT_ACTIONS: Record<string, ReadonlySet<FormEventAction['type']>> = {
  LOAD: new Set(['SET_VALUE', 'FETCH', 'FOCUS']),
  CLICK: new Set(['SET_VALUE', 'FETCH', 'GO_TO_STEP', 'FOCUS', 'SUBMIT', 'RESET', 'SAVE']),
  CHANGE: new Set(['SET_VALUE', 'FETCH', 'FOCUS']),
  SUBMIT_SUCCESS: new Set(['SHOW_MESSAGE', 'REDIRECT']),
  SUBMIT_ERROR: new Set(['SHOW_MESSAGE']),
};

/** A form that opens filled from a record: the record must be findable, and what it fills must be questions of this form. */
export function checkOpenWith(def: FormDefinition, ctx: z.RefinementCtx) {
  const open = def.openWith;
  if (!open) return;
  const issue = (message: string) => ctx.addIssue({ code: 'custom', path: ['openWith'], message: `Opens with a record: ${message}` });
  const byName = new Map(def.fields.map((f) => [f.name, f]));
  if (!open.source.trim()) issue('choose where the record is');
  if (!open.param) issue('choose the field the record is found by');
  if (open.by !== 'LINK' && def.access !== 'AUTHENTICATED') issue('finding the record by the person who is signed in needs a form that asks people to sign in');
  if (open.only && open.by !== 'LINK') issue('"only from a link" goes with a link made for each record');
  if (!Object.keys(open.set).length && !open.rows?.length) issue('choose at least one question to fill in');
  for (const name of Object.keys(open.set)) {
    const target = byName.get(name);
    if (!target) issue(`"${name}" is not a question of this form`);
    else if (!isValueField(target) || target.type === 'FILE' || target.type === 'SIGNATURE' || target.type === 'CAPTCHA' || isRepeat(target)) issue(`"${target.label || name}" cannot be filled from a record`);
  }
  for (const rows of open.rows ?? []) {
    const section = byName.get(rows.into);
    const repeat = section && isRepeat(section) ? formShape(def.fields).repeats.find((r) => r.field.id === section.id) : undefined;
    if (!repeat) issue(`"${rows.into}" is not a repeating section`);
    else {
      if (!rows.from) issue(`say which of the record's lists fills "${section!.label || section!.name}"`);
      if (!Object.keys(rows.set).length) issue(`choose at least one question of "${section!.label || section!.name}" to fill in`);
      for (const name of Object.keys(rows.set)) if (!repeat.valueChildren.some((c) => c.name === name)) issue(`"${name}" is not a question of "${section!.label || section!.name}"`);
    }
  }
  const filled = new Set([...Object.keys(open.set), ...(open.rows ?? []).map((r) => r.into)]);
  for (const name of open.lock ?? []) if (!filled.has(name)) issue(`"${name}" is kept as the record says, but the record does not fill it`);
}

export function checkEvents(def: FormDefinition, ctx: z.RefinementCtx) {
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
    if (event.on.type === 'CHANGE') {
      const watched = byName.get(event.on.field);
      if (!watched) issue(['on'], `Unknown field "${event.on.field}"`);
      else if (!isValueField(watched) || watched.type === 'HIDDEN' || watched.type === 'CAPTCHA' || watched.type === 'FILE' || watched.type === 'SIGNATURE') issue(['on'], `"${watched.name}" is not a question whose answer can be watched`);
      else if (formShape(def.fields).repeatOf.has(watched.name)) issue(['on'], `"${watched.name}" is inside a repeating section; an event cannot watch it`);
      // Filling the watched answer from its own change would go round for ever.
      for (const [a, action] of event.do.entries()) {
        const fills = action.type === 'SET_VALUE' ? [action.target] : action.type === 'FETCH' ? Object.keys(action.set) : [];
        if (fills.includes(event.on.field)) issue(['do', a], `This would change "${event.on.field}", the very answer it waits on`);
      }
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
          if (!Object.keys(action.set).length && !action.rows) at('Choose at least one field to fill in');
          for (const name of Object.keys(action.set)) calculable(name, at);
          if (action.rows) {
            const section = byName.get(action.rows.into);
            const repeat = section && isRepeat(section) ? formShape(def.fields).repeats.find((r) => r.field.id === section.id) : undefined;
            if (!repeat) at(`"${action.rows.into}" is not a repeating section`);
            else if (!Object.keys(action.rows.set).length) at(`Choose at least one question of "${section!.label || section!.name}" to fill in`);
            else for (const name of Object.keys(action.rows.set)) if (!repeat.valueChildren.some((c) => c.name === name)) at(`"${name}" is not a question of "${section!.label || section!.name}"`);
          }
          break;
        }
        case 'FOCUS': {
          const target = byName.get(action.target);
          if (!target) at(`Acts on unknown field "${action.target}"`);
          else if (!isValueField(target) || target.type === 'HIDDEN' || target.type === 'CAPTCHA') at(`"${target.name}" is not a question the cursor can be put in`);
          else if (formShape(def.fields).repeatOf.has(target.name)) at(`"${target.name}" is inside a repeating section; an event cannot point at one of its rows`);
          break;
        }
        case 'SUBMIT':
        case 'RESET':
          break;
        case 'SAVE':
          if (def.saveForLater === false) at('This form does not let people save and continue later (form settings)');
          break;
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
