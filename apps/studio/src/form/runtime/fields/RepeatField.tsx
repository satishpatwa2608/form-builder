import { useUi } from '../FormRuntimeContext';
import { useMemo } from 'react';
import { useFieldArray, useFormContext, useFormState } from 'react-hook-form';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@ui/button';
import { defaultRow, fieldLabel, formShape, MAX_ROWS, rowsOf } from '../../engine';
import { RowProvider, useFormRuntime } from '../FormRuntimeContext';
import { FieldList } from '../FieldRenderer/FieldRenderer';
import { RequiredMark } from './FieldShell';
import { errorText } from '../styles';
import type { FieldComponentProps } from './types';

/** The message of an error on the section itself (too few rows), wherever the form library keeps it. */
function ownError(error: unknown): string | undefined {
  const e = error as { message?: unknown; root?: { message?: unknown } } | undefined;
  const message = e?.root?.message ?? (Array.isArray(e) ? undefined : e?.message);
  return typeof message === 'string' ? message : undefined;
}

/**
 * A section people add copies of. Each row is the same fields again, kept as
 * one object in a list. `props.layout: 'table'` lays the rows out as a table
 * (still stacked on phones); `props.totals` names number fields to total.
 */
export function RepeatField({ field, required }: FieldComponentProps) {
  const ui = useUi();
  const { control } = useFormContext();
  const { definition, values } = useFormRuntime();
  const { fields: rows, append, remove } = useFieldArray({ control, name: field.name });
  const { errors } = useFormState({ control, name: field.name });
  const children = useMemo(() => formShape(definition.fields).repeats.find((r) => r.field.id === field.id)?.valueChildren ?? [], [definition, field.id]);

  const title = fieldLabel(field);
  const { min, max } = field.validation ?? {};
  const atLeast = Math.max(min ?? 0, required ? 1 : 0);
  const atMost = Math.min(max ?? MAX_ROWS, MAX_ROWS);
  const asTable = field.props?.layout === 'table';
  const addLabel = typeof field.props?.addLabel === 'string' && field.props.addLabel.trim() ? field.props.addLabel : ui('addAnother');
  const problem = ownError(errors[field.name]);

  const totals = (Array.isArray(field.props?.totals) ? (field.props.totals as unknown[]) : [])
    .map((name) => children.find((c) => c.name === name))
    .filter((c) => !!c)
    .map((c) => ({
      label: fieldLabel(c!),
      // Float noise such as 0.1 + 0.2 never reaches the page.
      sum: Number(rowsOf(values[field.name]).reduce((n, row) => n + (typeof row[c!.name] === 'number' ? (row[c!.name] as number) : 0), 0).toPrecision(12)),
    }));

  return (
    <section className={`fp-repeat${asTable ? ' fp-repeat--table' : ''}`} aria-label={title} data-rows={rows.length}>
      <div className="fp-repeat__head">
        <div className="fp-section__title">
          {title}
          <RequiredMark required={required} />
        </div>
        {field.helpText && <div className="fp-section__desc">{field.helpText}</div>}
      </div>

      {asTable && rows.length > 0 && (
        <div className="fp-repeat__cols" aria-hidden="true">
          {children.map((c) => (
            <span key={c.id}>{fieldLabel(c)}</span>
          ))}
          <span />
        </div>
      )}

      {rows.map((row, i) => (
        <div key={row.id} role="group" aria-label={ui('row', { label: title, n: i + 1 })} className="fp-repeat__row">
          <div className="fp-repeat__fields">
            <RowProvider value={`${field.name}.${i}`}>
              <FieldList parentId={field.id} column={0} />
            </RowProvider>
          </div>
          <button
            type="button"
            className="fp-repeat__remove"
            aria-label={ui('removeRow', { label: title, n: i + 1 })}
            title={ui('removeThisRow')}
            disabled={field.disabled || rows.length <= atLeast}
            onClick={() => remove(i)}
          >
            <Trash2 size={16} />
          </button>
        </div>
      ))}
      {!rows.length && <p className="text-sm text-muted-foreground">{ui('nothingAdded')}</p>}

      {totals.length > 0 && rows.length > 0 && (
        <dl className="fp-repeat__totals">
          {totals.map((t) => (
            <div key={t.label}>
              <dt>Total {t.label.toLowerCase()}</dt>
              <dd>{t.sum}</dd>
            </div>
          ))}
        </dl>
      )}

      <div>
        <Button type="button" variant="outline" size="sm" disabled={field.disabled || rows.length >= atMost} onClick={() => append(defaultRow(definition, field))}>
          <Plus /> {addLabel}
        </Button>
        {rows.length >= atMost && <span className="text-sm text-muted-foreground"> No more than {atMost}.</span>}
      </div>
      {problem && (
        <p role="alert" className="text-sm" style={errorText}>
          {problem}
        </p>
      )}
    </section>
  );
}
