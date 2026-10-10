import { withLetters } from './answer-text';
import type { FormDefinition, FormValues, SystemContext } from './types';
import { isRepeat, isValueField } from './field-kinds';
import { formShape, rowKey, rowsOf } from './repeat';
import { computeFormState } from './form-state';

/**
 * Form values -> submission payload.
 *
 * - Fields hidden by a visibility rule are dropped (their value may linger in
 *   form state so it survives the field being shown again).
 * - Calculated fields carry the value the rules compute, not the one passed in.
 * - Unfilled values (undefined, '') are dropped; `false` and 0 are kept.
 * - A repeating section is a list of row objects, each trimmed the same way.
 * - `submission.mapping` renames top-level keys.
 */
export function buildPayload(
  def: Pick<FormDefinition, 'fields' | 'submission' | 'rules'>,
  input: FormValues,
  ctx?: SystemContext,
): FormValues {
  const { states, values } = computeFormState(def, input, ctx);
  const shape = formShape(def.fields);
  const mapping = def.submission.mapping ?? {};
  const payload: FormValues = {};
  const filled = (value: unknown) => value !== undefined && value !== '';

  for (const field of shape.top) {
    if (!isValueField(field) || !states.get(field.name)?.visible) continue;
    let value = values[field.name];
    if (isRepeat(field)) {
      // Each row keeps only its own visible, filled-in answers.
      const children = shape.repeats.find((r) => r.field === field)?.valueChildren ?? [];
      value = rowsOf(value).map((row, i) =>
        Object.fromEntries(
          children.filter((c) => states.get(rowKey(field.name, i, c.name))?.visible && filled(row[c.name])).map((c) => [c.name, withLetters(c, row[c.name])]),
        ),
      );
    }
    if (!filled(value)) continue;
    // Stored with its letters as the question asks, however it was typed or sent.
    payload[mapping[field.name] ?? field.name] = withLetters(field, value);
  }
  return payload;
}
