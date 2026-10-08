import type { FormDefinition, FormValues, SystemContext } from './types';
import { isValueField } from './field-kinds';
import { computeFormState } from './form-state';

/**
 * Form values -> submission payload.
 *
 * - Fields hidden by a visibility rule are dropped (their value may linger in
 *   form state so it survives the field being shown again).
 * - Calculated fields carry the value the rules compute, not the one passed in.
 * - Unfilled values (undefined, '') are dropped; `false` and 0 are kept.
 * - `submission.mapping` renames keys.
 */
export function buildPayload(
  def: Pick<FormDefinition, 'fields' | 'submission' | 'rules'>,
  input: FormValues,
  ctx?: SystemContext,
): FormValues {
  const { states, values } = computeFormState(def, input, ctx);
  const mapping = def.submission.mapping ?? {};
  const payload: FormValues = {};

  for (const field of def.fields) {
    if (!isValueField(field) || !states.get(field.name)?.visible) continue;
    const value = values[field.name];
    if (value === undefined || value === '') continue;
    payload[mapping[field.name] ?? field.name] = value;
  }
  return payload;
}
