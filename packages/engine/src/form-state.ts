import type {
  FormDefinition,
  FormField,
  FormRule,
  FormValues,
  RuleAction,
  RuleCondition,
  RuleStateAction,
  SystemContext,
} from './types';
import { evaluateCondition } from './evaluate-condition';
import { evaluateExpression, truthy } from './expression';
import { emptyValueFor, isEmptyValue } from './field-kinds';
import { ancestorIds } from './layout';

export interface FieldState {
  visible: boolean;
  required: boolean;
}

export type FieldStates = Map<string, FieldState>;

/** Everything the rules decide for one set of values. */
export interface FormState {
  /** The given values with every calculated field recomputed. */
  values: FormValues;
  states: FieldStates;
  /** Names switched off by a rule or by the field's own `disabled`. */
  disabled: Set<string>;
  /** Names whose value a rule is setting right now. Read-only for the person filling in. */
  calculated: Set<string>;
  /** First rule error per field name. Hidden fields have none. */
  errors: Map<string, string>;
  /** Option values a rule currently allows, for fields a rule narrows. */
  options: Map<string, Set<string>>;
}

type RuleSource = Pick<FormDefinition, 'fields'> & { rules?: FormRule[] };

const STATE_ACTIONS: ReadonlySet<string> = new Set<RuleStateAction>(['SHOW', 'HIDE', 'ENABLE', 'DISABLE', 'REQUIRE']);

export const isStateAction = (action: RuleAction): action is { type: RuleStateAction; target: string } =>
  STATE_ACTIONS.has(action.type);

export const isExpressionCondition = (when: RuleCondition): when is { expr: string } => 'expr' in when;

/** Whether a rule's or an event's condition holds. No condition always does. */
export function conditionHolds(when: RuleCondition | undefined, values: FormValues, ctx: SystemContext = {}): boolean {
  if (!when) return true;
  return isExpressionCondition(when) ? truthy(evaluateExpression(when.expr, values, ctx).value) : evaluateCondition(when, values);
}

const holds = (rule: FormRule, values: FormValues, ctx: SystemContext) => conditionHolds(rule.when, values, ctx);

/**
 * Every action of every rule with whether it applies: `then` actions while
 * the rule holds, `else` actions while it does not.
 */
function* applied(rules: FormRule[], active: boolean[]): Generator<{ action: RuleAction; on: boolean }> {
  for (const [i, rule] of rules.entries()) {
    for (const action of rule.then) yield { action, on: active[i] };
    for (const action of rule.else ?? []) yield { action, on: !active[i] };
  }
}

/** A calculated or fetched value in the shape the target field's type stores. */
export function coerceToField(value: unknown, field: FormField): unknown {
  if (isEmptyValue(value) && field.type !== 'CHECKBOX') return emptyValueFor(field.type);
  switch (field.type) {
    case 'NUMBER': {
      const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
      return Number.isFinite(n) ? n : undefined;
    }
    case 'CHECKBOX':
      return truthy(value);
    default:
      return typeof value === 'object' ? '' : String(value);
  }
}

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

/** Fields hidden by their own rule or a form rule, plus everything inside a hidden container. */
function hiddenNames(fields: FormField[], values: FormValues, rules: FormRule[], active: boolean[]): Set<string> {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const byRule = new Set<string>();
  for (const { action, on } of applied(rules, active)) {
    if ((action.type === 'SHOW' && !on) || (action.type === 'HIDE' && on)) byRule.add(action.target);
  }
  const ruleHidden = new Set(
    fields
      .filter((f) => byRule.has(f.name) || (f.visibility && !evaluateCondition(f.visibility.when, values)))
      .map((f) => f.id),
  );
  return new Set(
    fields
      .filter((f) => ruleHidden.has(f.id) || ancestorIds(f, byId).some((id) => ruleHidden.has(id)))
      .map((f) => f.name),
  );
}

/**
 * Works out visibility, required-ness, calculated values, rule errors and
 * narrowed options for the given values. The browser calls it on every change
 * and the server calls it on submit, so both always agree.
 *
 * A hidden field's value is treated as empty when other rules read it, so
 * "B shows when A = x" stops holding once A itself is hidden, even though A
 * keeps its value in form state (in case A is shown again). That can cascade,
 * and a calculation can feed another, so this iterates to a fixed point. The
 * definition validator rejects loops; the bound guards against them anyway.
 */
export function computeFormState(def: RuleSource, input: FormValues, ctx: SystemContext = {}): FormState {
  const rules = (def.rules ?? []).filter((r) => !r.disabled);
  const byName = new Map(def.fields.map((f) => [f.name, f]));

  let values: FormValues = input;
  let hidden = new Set<string>();
  let effective: FormValues = input;
  let active: boolean[] = [];
  let calculated = new Set<string>();

  for (let i = 0; i <= def.fields.length + rules.length; i++) {
    effective = { ...values };
    for (const name of hidden) effective[name] = undefined;
    active = rules.map((rule) => holds(rule, effective, ctx));

    const next: FormValues = { ...values };
    calculated = new Set();
    for (const { action, on } of applied(rules, active)) {
      const target = action.type === 'SET_VALUE' && on ? byName.get(action.target) : undefined;
      if (!target || action.type !== 'SET_VALUE') continue;
      next[target.name] = coerceToField(evaluateExpression(action.value, effective, ctx).value, target);
      calculated.add(target.name);
    }

    const nextHidden = hiddenNames(def.fields, effective, rules, active);
    const settled =
      sameSet(nextHidden, hidden) && [...calculated].every((name) => JSON.stringify(next[name]) === JSON.stringify(values[name]));
    values = next;
    hidden = nextHidden;
    if (settled) break;
  }

  const required = new Set<string>();
  const disabled = new Set(def.fields.filter((f) => f.disabled).map((f) => f.name));
  const errors = new Map<string, string>();
  const options = new Map<string, Set<string>>();
  for (const { action, on } of applied(rules, active)) {
    const name = action.target;
    switch (action.type) {
      case 'REQUIRE':
        if (on) required.add(name);
        break;
      case 'ENABLE':
        if (!on) disabled.add(name);
        break;
      case 'DISABLE':
        if (on) disabled.add(name);
        break;
      case 'ERROR':
        if (on && !hidden.has(name) && !errors.has(name)) errors.set(name, action.message);
        break;
      case 'SET_OPTIONS': {
        if (!on) break;
        const allowed = new Set(action.values);
        const already = options.get(name);
        // Two rules narrowing the same list leave what both allow.
        options.set(name, already ? new Set([...already].filter((v) => allowed.has(v))) : allowed);
        break;
      }
    }
  }

  const states: FieldStates = new Map();
  for (const f of def.fields) {
    const visible = !hidden.has(f.name);
    states.set(f.name, {
      visible,
      required:
        visible &&
        (f.type === 'CAPTCHA' ||
          !!f.required ||
          required.has(f.name) ||
          (!!f.requiredWhen && evaluateCondition(f.requiredWhen, effective))),
    });
  }
  return { values, states, disabled, calculated, errors, options };
}
