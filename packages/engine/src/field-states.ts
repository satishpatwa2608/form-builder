import type { FormDefinition, FormField, FormValues } from './types';
import { evaluateCondition } from './evaluate-condition';
import { ancestorIds } from './layout';

export interface FieldState {
  visible: boolean;
  required: boolean;
}

export type FieldStates = Map<string, FieldState>;

/** Fields hidden by their own rule, plus everything inside a hidden container. */
function hiddenNames(fields: FormField[], values: FormValues): Set<string> {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const ruleHidden = new Set(
    fields.filter((f) => f.visibility && !evaluateCondition(f.visibility.when, values)).map((f) => f.id),
  );
  return new Set(
    fields
      .filter((f) => ruleHidden.has(f.id) || ancestorIds(f, byId).some((id) => ruleHidden.has(id)))
      .map((f) => f.name),
  );
}

const sameSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x));

/**
 * Visible/required state of every field for the given values.
 *
 * A hidden field's value is treated as empty when other rules read it, so
 * "B shows when A = x" stops holding once A itself is hidden, even though A
 * keeps its value in form state (in case A is shown again). That can cascade,
 * so this iterates to a fixed point. Hiding a COLUMNS/SECTION container hides
 * everything inside it; the definition validator rejects
 * visibility cycles, and the loop bound guards against them anyway.
 */
export function computeFieldStates(def: Pick<FormDefinition, 'fields'>, values: FormValues): FieldStates {
  let hidden = new Set<string>();
  let effective: FormValues = values;

  for (let i = 0; i <= def.fields.length; i++) {
    const next = hiddenNames(def.fields, effective);
    const settled = sameSet(next, hidden);
    hidden = next;
    effective = { ...values };
    for (const name of hidden) effective[name] = undefined;
    if (settled) break;
  }

  const states: FieldStates = new Map();
  for (const f of def.fields) {
    const visible = !hidden.has(f.name);
    const required =
      visible &&
      (f.type === 'CAPTCHA' ||
        !!f.required ||
        (!!f.requiredWhen && evaluateCondition(f.requiredWhen, effective)));
    states.set(f.name, { visible, required });
  }
  return states;
}
