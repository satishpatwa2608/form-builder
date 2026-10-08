import type { FormDefinition, FormRule, FormValues, SystemContext } from './types';
import { computeFormState, type FieldStates } from './form-state';

export type { FieldState, FieldStates } from './form-state';

/** Visible/required state of every field for the given values. See computeFormState. */
export function computeFieldStates(
  def: Pick<FormDefinition, 'fields'> & { rules?: FormRule[] },
  values: FormValues,
  ctx?: SystemContext,
): FieldStates {
  return computeFormState(def, values, ctx).states;
}
