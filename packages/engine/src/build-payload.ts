import type { FormDefinition, FormValues } from './types';
import { isValueField } from './field-kinds';
import { computeFieldStates } from './field-states';

/**
 * Form values -> submission payload.
 *
 * - Fields hidden by a visibility rule are dropped (their value may linger in
 *   form state so it survives the field being shown again).
 * - Unfilled values (undefined, '') are dropped; `false` and 0 are kept.
 * - `submission.mapping` renames keys.
 */
export function buildPayload(
  def: Pick<FormDefinition, 'fields' | 'submission'>,
  values: FormValues,
): FormValues {
  const states = computeFieldStates(def, values);
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
