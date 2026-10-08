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
import { emptyValueFor, isBooleanField, isEmptyValue, isNumberField } from './field-kinds';
import { ancestorIds } from './layout';
import { formShape, rowKey, rowsOf, type FormShape, type Row } from './repeat';

export interface FieldState {
  visible: boolean;
  required: boolean;
}

export type FieldStates = Map<string, FieldState>;

/** Everything the rules decide for one set of values. */
export interface FormState {
  /** The given values with every calculated field recomputed. */
  values: FormValues;
  /**
   * By field name. A field inside a repeating section also has one entry per
   * row, under its row key (`lines.0.qty`); the same goes for the sets below.
   */
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

/** A calculated or fetched value in the shape the target field's type stores. */
export function coerceToField(value: unknown, field: FormField): unknown {
  if (isBooleanField(field)) return truthy(value);
  if (isEmptyValue(value)) return emptyValueFor(field.type);
  if (isNumberField(field)) {
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    return Number.isFinite(n) ? n : undefined;
  }
  return typeof value === 'object' ? '' : String(value);
}

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** One pass's view of the values: what rules read, with hidden answers blanked. */
interface Scopes {
  /** Top-level values. A field inside a repeating section reads here as the list of its values down the rows. */
  top: FormValues;
  /** Section name -> one scope per row: the top-level values with that row's own answers over them. */
  rows: Map<string, FormValues[]>;
}

function scopesFor(shape: FormShape, values: FormValues, hidden: Set<string>): Scopes {
  const top: FormValues = { ...values };
  for (const f of shape.top) if (hidden.has(f.name)) top[f.name] = undefined;
  const visibleRows = new Map<string, Row[]>();
  for (const { field, valueChildren } of shape.repeats) {
    const rows = hidden.has(field.name)
      ? []
      : rowsOf(values[field.name]).map((row, i) => {
          const copy: Row = { ...row };
          for (const c of valueChildren) if (hidden.has(rowKey(field.name, i, c.name))) copy[c.name] = undefined;
          return copy;
        });
    visibleRows.set(field.name, rows);
    top[field.name] = rows;
    // `sum(lineTotal)` outside the section adds up the column.
    for (const c of valueChildren) top[c.name] = rows.map((row) => row[c.name]);
  }
  const rows = new Map<string, FormValues[]>();
  for (const [name, list] of visibleRows) rows.set(name, list.map((row) => ({ ...top, ...row })));
  return { top, rows };
}

/**
 * Where an action lands: on a top-level field once, or on a field inside a
 * repeating section once per row, each time with whether it applies there
 * and the values that row sees.
 */
function* landings(
  shape: FormShape,
  rules: FormRule[],
  scopes: Scopes,
  ctx: SystemContext,
): Generator<{ action: RuleAction; target: FormField; key: string; on: boolean; scope: FormValues; row?: { repeat: string; index: number } }> {
  for (const rule of rules) {
    const activeTop = conditionHolds(rule.when, scopes.top, ctx);
    const activeRow = new Map<string, boolean[]>();
    for (const [branch, actions] of [[true, rule.then], [false, rule.else ?? []]] as const) {
      for (const action of actions) {
        const target = shape.byName.get(action.target);
        if (!target) continue;
        const repeat = shape.repeatOf.get(target.name);
        if (!repeat) {
          yield { action, target, key: target.name, on: activeTop === branch, scope: scopes.top };
          continue;
        }
        const rowScopes = scopes.rows.get(repeat.name) ?? [];
        if (!activeRow.has(repeat.name)) activeRow.set(repeat.name, rowScopes.map((scope) => conditionHolds(rule.when, scope, ctx)));
        for (const [index, scope] of rowScopes.entries()) {
          yield { action, target, key: rowKey(repeat.name, index, target.name), on: activeRow.get(repeat.name)![index] === branch, scope, row: { repeat: repeat.name, index } };
        }
      }
    }
  }
}

/** Names and row keys that are hidden: by their own rule, by a form rule, or by sitting inside something hidden. */
function hiddenKeys(shape: FormShape, rules: FormRule[], scopes: Scopes, ctx: SystemContext): Set<string> {
  const byRule = new Set<string>();
  for (const { action, key, on } of landings(shape, rules, scopes, ctx)) {
    if ((action.type === 'SHOW' && !on) || (action.type === 'HIDE' && on)) byRule.add(key);
  }
  const hidden = new Set<string>();

  // Top level, and anything hidden for every row because a block around the whole section is.
  const topHidden = new Set(
    shape.top.filter((f) => byRule.has(f.name) || (f.visibility && !evaluateCondition(f.visibility.when, scopes.top))).map((f) => f.id),
  );
  const underHidden = (f: FormField, ids: Set<string>) => ids.has(f.id) || ancestorIds(f, shape.byId).some((id) => ids.has(id));
  for (const f of shape.top) if (underHidden(f, topHidden)) hidden.add(f.name);

  for (const { field, children } of shape.repeats) {
    if (hidden.has(field.name)) {
      for (const c of children) hidden.add(c.name);
      continue;
    }
    (scopes.rows.get(field.name) ?? []).forEach((scope, i) => {
      const rowHidden = new Set(
        children
          .filter((c) => byRule.has(rowKey(field.name, i, c.name)) || (c.visibility && !evaluateCondition(c.visibility.when, scope)))
          .map((c) => c.id),
      );
      for (const c of children) if (underHidden(c, rowHidden)) hidden.add(rowKey(field.name, i, c.name));
    });
  }
  return hidden;
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
 *
 * Inside a repeating section every rule is applied row by row: a rule that
 * acts on a field in the section sees that row's answers under their plain
 * names, and the rest of the form around them.
 */
export function computeFormState(def: RuleSource, input: FormValues, ctx: SystemContext = {}): FormState {
  const rules = (def.rules ?? []).filter((r) => !r.disabled);
  const shape = formShape(def.fields);

  let values: FormValues = { ...input };
  for (const { field } of shape.repeats) values[field.name] = rowsOf(input[field.name]);
  let hidden = new Set<string>();
  let scopes = scopesFor(shape, values, hidden);
  let calculated = new Set<string>();

  for (let i = 0; i <= def.fields.length + rules.length; i++) {
    scopes = scopesFor(shape, values, hidden);

    const next: FormValues = { ...values };
    for (const { field } of shape.repeats) next[field.name] = rowsOf(values[field.name]).map((row) => ({ ...row }));
    calculated = new Set();
    let moved = false;
    for (const { action, target, key, on, scope, row } of landings(shape, rules, scopes, ctx)) {
      if (action.type !== 'SET_VALUE' || !on) continue;
      const result = coerceToField(evaluateExpression(action.value, scope, ctx).value, target);
      const holder = row ? (next[row.repeat] as Row[])[row.index] : next;
      const before = row ? rowsOf(values[row.repeat])[row.index]?.[target.name] : values[target.name];
      holder[target.name] = result;
      calculated.add(key);
      if (!same(result, before)) moved = true;
    }

    const nextHidden = hiddenKeys(shape, rules, scopes, ctx);
    const settled = !moved && sameSet(nextHidden, hidden);
    values = next;
    hidden = nextHidden;
    if (settled) break;
  }

  const required = new Set<string>();
  const disabled = new Set<string>();
  const errors = new Map<string, string>();
  const options = new Map<string, Set<string>>();
  for (const { action, key, on } of landings(shape, rules, scopes, ctx)) {
    switch (action.type) {
      case 'REQUIRE':
        if (on) required.add(key);
        break;
      case 'ENABLE':
        if (!on) disabled.add(key);
        break;
      case 'DISABLE':
        if (on) disabled.add(key);
        break;
      case 'ERROR':
        if (on && !hidden.has(key) && !errors.has(key)) errors.set(key, action.message);
        break;
      case 'SET_OPTIONS': {
        if (!on) break;
        const allowed = new Set(action.values);
        const already = options.get(key);
        // Two rules narrowing the same list leave what both allow.
        options.set(key, already ? new Set([...already].filter((v) => allowed.has(v))) : allowed);
        break;
      }
    }
  }

  const states: FieldStates = new Map();
  const stateOf = (f: FormField, key: string, scope: FormValues, visible: boolean): FieldState => ({
    visible,
    required:
      visible && (f.type === 'CAPTCHA' || !!f.required || required.has(key) || (!!f.requiredWhen && evaluateCondition(f.requiredWhen, scope))),
  });
  for (const f of shape.top) {
    states.set(f.name, stateOf(f, f.name, scopes.top, !hidden.has(f.name)));
    if (f.disabled) disabled.add(f.name);
  }
  for (const { field, children } of shape.repeats) {
    const rowScopes = scopes.rows.get(field.name) ?? [];
    for (const c of children) {
      // Under its plain name: the field as the section's template (shown unless the whole section is hidden).
      states.set(c.name, { visible: !hidden.has(c.name), required: !hidden.has(c.name) && !!c.required });
      if (c.disabled) disabled.add(c.name);
      rowScopes.forEach((scope, i) => {
        const key = rowKey(field.name, i, c.name);
        states.set(key, stateOf(c, key, scope, !hidden.has(key)));
        if (c.disabled) disabled.add(key);
      });
    }
  }
  return { values, states, disabled, calculated, errors, options };
}
