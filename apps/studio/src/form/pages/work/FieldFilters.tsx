import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@ui/button';
import { Input } from '@ui/input';
import type { FormDefinition, FormField } from '../../types';
import { isOptionField, isValueField } from '../../engine';
import type { FieldFilter, FieldFilterOp } from '../../adapters/workflow';
import { ChoiceSelect } from '../../builder/components/settings';

const OP_LABEL: Record<FieldFilterOp, string> = {
  eq: 'is',
  ne: 'is not',
  contains: 'contains',
  in: 'is any of',
  gte: 'is at least',
  lte: 'is at most',
  empty: 'is empty',
  notEmpty: 'is filled in',
};

const opsFor = (f: FormField | undefined): FieldFilterOp[] => {
  if (!f) return ['eq'];
  if (isOptionField(f)) return ['eq', 'ne', 'empty', 'notEmpty'];
  if (f.type === 'CHECKBOX') return ['eq'];
  if (f.type === 'NUMBER' || f.type === 'DATE' || f.type === 'DATETIME') return ['eq', 'gte', 'lte', 'empty', 'notEmpty'];
  return ['contains', 'eq', 'empty', 'notEmpty'];
};

const staticOptions = (f: FormField | undefined) => (f?.dataSource?.type === 'STATIC' ? f.dataSource.options ?? [] : []);

/** Filters on the selected form's answers and work fields ("Business is Denim", "Work: Root cause is filled in"). */
export function FieldFilters({ form, value, onChange }: { form: FormDefinition; value: FieldFilter[]; onChange: (ff: FieldFilter[]) => void }) {
  const fields: FormField[] = [
    ...form.fields.filter((f) => isValueField(f) && !['HIDDEN', 'CAPTCHA', 'FILE'].includes(f.type)),
    ...(form.workflow?.workFields ?? []).filter(isValueField).map((f) => ({ ...f, name: `$work.${f.name}`, label: `Work: ${f.label || f.name}` })),
  ];
  const [draft, setDraft] = useState<FieldFilter | null>(null);
  const field = fields.find((f) => f.name === draft?.field);
  const label = (ff: FieldFilter) => {
    const f = fields.find((x) => x.name === ff.field);
    const shown = staticOptions(f).find((o) => o.value === ff.value)?.label ?? (typeof ff.value === 'boolean' ? (ff.value ? 'Yes' : 'No') : ff.value);
    return `${f?.label ?? ff.field} ${OP_LABEL[ff.op]}${ff.op === 'empty' || ff.op === 'notEmpty' ? '' : ` ${String(shown ?? '')}`}`;
  };

  const valueInput = () => {
    if (!draft || draft.op === 'empty' || draft.op === 'notEmpty') return null;
    const options = staticOptions(field);
    if (field?.type === 'CHECKBOX') {
      return (
        <ChoiceSelect<'true' | 'false'>
          ariaLabel="Filter value"
          value={draft.value === false ? 'false' : 'true'}
          options={[
            { label: 'Yes', value: 'true' },
            { label: 'No', value: 'false' },
          ]}
          onChange={(v) => setDraft({ ...draft, value: v === 'true' })}
        />
      );
    }
    if (options.length) {
      return <ChoiceSelect ariaLabel="Filter value" value={typeof draft.value === 'string' ? draft.value : undefined} options={options.map((o) => ({ label: o.label, value: o.value }))} onChange={(v) => setDraft({ ...draft, value: v })} />;
    }
    const type = field?.type === 'NUMBER' ? 'number' : field?.type === 'DATE' ? 'date' : 'text';
    return (
      <Input
        aria-label="Filter value"
        type={type}
        value={draft.value === undefined ? '' : String(draft.value)}
        onChange={(e) => setDraft({ ...draft, value: type === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value })}
        style={{ maxWidth: 220 }}
      />
    );
  };

  return (
    <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }} aria-label="Field filters">
      {value.map((ff, i) => (
        <span key={i} className="fb-chip fb-chip--rule" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {label(ff)}
          <button type="button" aria-label={`Remove filter ${label(ff)}`} onClick={() => onChange(value.filter((_, j) => j !== i))} style={{ display: 'inline-flex' }}>
            <X size={12} />
          </button>
        </span>
      ))}
      {draft ? (
        <>
          <div style={{ width: 200 }}>
            <ChoiceSelect
              ariaLabel="Filter field"
              placeholder="Field…"
              value={draft.field || undefined}
              options={fields.map((f) => ({ label: f.label || f.name, value: f.name }))}
              onChange={(name) => setDraft({ field: name, op: opsFor(fields.find((f) => f.name === name))[0] })}
            />
          </div>
          {field && (
            <div style={{ width: 150 }}>
              <ChoiceSelect<FieldFilterOp> ariaLabel="Filter operator" value={draft.op} options={opsFor(field).map((op) => ({ label: OP_LABEL[op], value: op }))} onChange={(op) => setDraft({ ...draft, op })} />
            </div>
          )}
          {valueInput()}
          <Button
            type="button"
            size="sm"
            disabled={!field || (!['empty', 'notEmpty'].includes(draft.op) && (draft.value === undefined || draft.value === ''))}
            onClick={() => {
              onChange([...value, draft]);
              setDraft(null);
            }}
          >
            Add filter
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setDraft(null)}>
            Cancel
          </Button>
        </>
      ) : (
        <Button type="button" size="sm" variant="outline" onClick={() => setDraft({ field: '', op: 'eq' })} disabled={value.length >= 10}>
          <Plus /> Filter on a field
        </Button>
      )}
    </div>
  );
}
