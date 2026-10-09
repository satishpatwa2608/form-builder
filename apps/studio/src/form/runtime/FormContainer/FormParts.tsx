import { useUi } from '../FormRuntimeContext';
import type { FieldErrors } from 'react-hook-form';
import { Button } from '@ui/button';
import type { FormDefinition } from '../../types';
import { fieldLabel, formShape, isRepeat, safeImageUrl } from '../../engine';
import { errorText } from '../styles';

export function FormHeader({ definition }: { definition: FormDefinition }) {
  const logo = safeImageUrl(definition.theme?.logoUrl);
  return (
    <header className="space-y-2">
      {logo && <img className="fp-logo" src={logo} alt="" />}
      <h2 className="text-2xl font-semibold text-gray-900">{definition.name}</h2>
      {definition.description && <p className="text-sm text-muted-foreground">{definition.description}</p>}
    </header>
  );
}

interface FormActionsProps {
  definition: FormDefinition;
  isSubmitting: boolean;
  onCancel: () => void;
  /**
   * Steps mode: Back / Next replace Submit until the last step. Next is the
   * form's submit button (so Enter advances too); the container's submit
   * handler turns it into "validate this step and move on".
   */
  steps?: { canGoBack: boolean; isLast: boolean; onBack: () => void };
}

export function FormActions({ definition, isSubmitting, onCancel, steps }: FormActionsProps) {
  const ui = useUi();
  // A label the designer never changed from the standard one is said in the form's language too.
  const own = definition.actions?.submit;
  const submit = own ? { ...own, label: own.label && own.label !== 'Submit' ? own.label : ui('submit') } : { enabled: true, label: ui('submit') };
  const cancel = definition.actions?.cancel;
  return (
    <div className="flex items-center justify-end gap-3 pt-4 border-t">
      {steps?.canGoBack && (
        <Button type="button" variant="outline" onClick={steps.onBack} disabled={isSubmitting} style={{ marginRight: 'auto' }}>
          {ui('back')}
        </Button>
      )}
      {cancel?.enabled && (
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
          {cancel.label}
        </Button>
      )}
      {steps && !steps.isLast ? (
        <Button type="submit">{ui('next')}</Button>
      ) : (
        submit.enabled && (
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? ui('submitting') : submit.label}
          </Button>
        )
      )}
    </div>
  );
}

interface FormErrorSummaryProps {
  definition: FormDefinition;
  errors: FieldErrors;
  onSelect: (name: string) => void;
}

interface Problem {
  /** What to focus: a field name, or `section.row.field`. */
  key: string;
  label: string;
  message: string;
}

const messageOf = (error: unknown): string | undefined => {
  const message = (error as { message?: unknown } | undefined)?.message;
  return typeof message === 'string' ? message : undefined;
};

/** Every error in field order. A repeating section lists its own problem, then each row's. */
export function problemsOf(definition: FormDefinition, errors: FieldErrors): Problem[] {
  const shape = formShape(definition.fields);
  const problems: Problem[] = [];
  for (const f of shape.top) {
    const error = errors[f.name] as unknown;
    if (!error) continue;
    if (!isRepeat(f)) {
      problems.push({ key: f.name, label: fieldLabel(f), message: messageOf(error) ?? 'Invalid' });
      continue;
    }
    const own = messageOf((error as { root?: unknown }).root) ?? (Array.isArray(error) ? undefined : messageOf(error));
    if (own) problems.push({ key: f.name, label: fieldLabel(f), message: own });
    const children = shape.repeats.find((r) => r.field === f)?.valueChildren ?? [];
    const rows = Array.isArray(error) ? (error as unknown[]) : [];
    rows.forEach((row, i) => {
      for (const c of children) {
        const message = messageOf((row as Record<string, unknown> | undefined)?.[c.name]);
        if (message) problems.push({ key: `${f.name}.${i}.${c.name}`, label: `${fieldLabel(f)}, row ${i + 1}: ${fieldLabel(c)}`, message });
      }
    });
  }
  return problems;
}

/** Shown after a failed submit: every error in field order, each one jumps to its field. */
export function FormErrorSummary({ definition, errors, onSelect }: FormErrorSummaryProps) {
  const ui = useUi();
  const failed = problemsOf(definition, errors);
  if (!failed.length) return null;
  return (
    <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-sm">
      <p className="font-semibold text-red-700">
        {failed.length === 1 ? ui('fixOne') : ui('fixMany', { n: failed.length })}
      </p>
      <ul className="mt-2 space-y-2">
        {failed.map((p) => (
          <li key={p.key}>
            <button type="button" className="text-red-700 cursor-pointer" onClick={() => onSelect(p.key)}>
              <span style={{ textDecoration: 'underline' }}>{p.label}</span>
              {': '}
              <span style={errorText}>{p.message}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface FormSuccessProps {
  message: string;
  /** Reference number to quote in follow-ups (forms with a workflow). */
  reference?: string;
  onReset: () => void;
}

export function FormSuccess({ message, reference, onReset }: FormSuccessProps) {
  const ui = useUi();
  // The reference is drawn in bold inside the sentence, wherever that language puts it.
  const [before, after] = ui('reference', { ref: '\u0000' }).split('\u0000');
  return (
    <div role="status" className="rounded-lg border border-green-200 bg-green-50 p-6 space-y-4">
      <p className="text-lg font-semibold text-green-700">{message}</p>
      {reference && (
        <p className="text-sm text-gray-700">
          {before}
          <strong>{reference}</strong>
          {after}
        </p>
      )}
      <Button type="button" variant="outline" onClick={onReset}>
        {ui('submitAnother')}
      </Button>
    </div>
  );
}
