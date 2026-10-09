import { useUi } from '../FormRuntimeContext';
import { Button } from '@ui/button';
import type { FormDefinition, FormField, FormValues } from '../../types';
import { answerFields, answerText, fieldLabel, formShape, isSignature, rowKey, rowsOf, type FormState } from '../../engine';

interface FormReviewProps {
  definition: FormDefinition;
  /** What the rules make of the current answers: what is showing and what was calculated. */
  state: FormState;
  /** The form's own values, which still hold the files chosen (the computed ones are the same otherwise). */
  values: FormValues;
  /** Go back to the form at this field (a name, or `section.row.field`). */
  onEdit: (name: string) => void;
}


/** One answer as people would read it back. Files are known by name; a signature is shown. */
function Answer({ field, value }: { field: FormField; value: unknown }) {
  const ui = useUi();
  const NOT_ANSWERED = ui('notAnswered');
  if (field.type === 'SIGNATURE') {
    // Checked to be a PNG data URL, so it is safe as an image source.
    return isSignature(value) ? <img className="fp-review__signature" src={value} alt={ui('yourSignature')} /> : <>{NOT_ANSWERED}</>;
  }
  if (field.type === 'FILE') {
    const names = (Array.isArray(value) ? value : []).map((f) => (f as { name?: unknown })?.name).filter((n): n is string => typeof n === 'string');
    return <>{names.length ? names.join(', ') : NOT_ANSWERED}</>;
  }
  return <>{answerText(field, value) || NOT_ANSWERED}</>;
}

/**
 * "Check your answers": every answer that is showing, in form order, each
 * with a way back to change it. Nothing is sent until the person confirms.
 */
export function FormReview({ definition, state, values, onEdit }: FormReviewProps) {
  const ui = useUi();
  const shape = formShape(definition.fields);
  const fields = answerFields(definition.fields).filter((f) => f.type !== 'HIDDEN' && f.type !== 'CAPTCHA' && state.states.get(f.name)?.visible);
  return (
    <section className="fp-review" aria-label={ui('checkAnswers')}>
      <h3 className="fp-review__title">{ui('checkAnswers')}</h3>
      <p className="text-sm text-muted-foreground">{ui('checkAnswersHint')}</p>
      <dl className="fp-review__list">
        {fields.map((f) => {
          const label = fieldLabel(f);
          const children = f.type === 'REPEAT' ? shape.repeats.find((r) => r.field === f)?.valueChildren ?? [] : [];
          const rows = rowsOf(state.values[f.name]);
          return (
            <div key={f.id} className="fp-review__item">
              <dt>{label}</dt>
              <dd>
                {f.type !== 'REPEAT' ? (
                  <Answer field={f} value={f.type === 'FILE' ? values[f.name] : state.values[f.name]} />
                ) : !rows.length ? (
                  ui('noneAdded')
                ) : (
                  <ol className="fp-review__rows">
                    {rows.map((row, i) => (
                      <li key={i}>
                        {children
                          .filter((c) => state.states.get(rowKey(f.name, i, c.name))?.visible)
                          .map((c) => (
                            <span key={c.id} className="fp-review__cell">
                              <span className="fp-review__cell-label">{fieldLabel(c)}: </span>
                              <Answer field={c} value={row[c.name]} />
                            </span>
                          ))}
                      </li>
                    ))}
                  </ol>
                )}
              </dd>
              <dd className="fp-review__edit">
                <Button type="button" variant="outline" size="sm" aria-label={ui('change', { label })} onClick={() => onEdit(f.name)}>
                  {ui('changeShort')}
                </Button>
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
