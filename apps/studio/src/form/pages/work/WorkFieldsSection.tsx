import { useMemo } from 'react';
import type { FormDefinition, FormValues, SubmissionResult } from '../../types';
import { isEmptyValue, isValueField } from '../../engine';
import type { SubmissionAdapter } from '../../adapters/submission/submission-adapter';
import { fieldErrorsOf, messageOf } from '../../adapters/backend';
import { FormContainer } from '../../runtime/FormContainer/FormContainer';

interface WorkFieldsSectionProps {
  definition: FormDefinition;
  work: FormValues;
  /** Closed records show the values read-only. */
  readOnly: boolean;
  onSave: (values: FormValues) => Promise<unknown>;
}

const display = (v: unknown) =>
  v === undefined || v === null || v === '' ? '—' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : Array.isArray(v) ? v.join(', ') : String(v);

/**
 * The form's work fields (investigation, root cause, resolution...) rendered
 * with the same runtime as the form itself, saved as you go. "Required" is
 * enforced by the actions that need them, so partial saves are fine.
 */
export function WorkFieldsSection({ definition, work, readOnly, onSave }: WorkFieldsSectionProps) {
  const fields = definition.workflow?.workFields ?? [];
  const workDefinition = useMemo<FormDefinition>(
    () => ({
      ...definition,
      fields,
      captcha: undefined,
      layout: undefined,
      description: undefined,
      actions: { submit: { enabled: true, label: 'Save' }, cancel: { enabled: false, label: 'Cancel', behavior: 'RESET' } },
    }),
    [definition, fields],
  );

  const adapter = useMemo<SubmissionAdapter>(
    () => ({
      async submit({ values }): Promise<SubmissionResult> {
        // Send every field, with emptied ones as null, so clearing a value is saved too.
        const payload = Object.fromEntries(fields.filter(isValueField).map((f) => [f.name, isEmptyValue(values[f.name]) ? null : values[f.name]]));
        try {
          await onSave(payload);
          return { ok: true, payload };
        } catch (e) {
          return { ok: false, payload, error: messageOf(e), fieldErrors: fieldErrorsOf(e) };
        }
      },
    }),
    [fields, onSave],
  );

  if (!fields.length) return null;
  if (readOnly) {
    return (
      <dl className="fb-answers">
        {fields.filter(isValueField).map((f) => (
          <div key={f.id} style={{ display: 'contents' }}>
            <dt>{f.label || f.name}</dt>
            <dd>{display(work[f.name])}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return <FormContainer definition={workDefinition} initialValues={work} stayOnSubmit showHeader={false} submissionAdapter={adapter} captchaMode="mock" />;
}
