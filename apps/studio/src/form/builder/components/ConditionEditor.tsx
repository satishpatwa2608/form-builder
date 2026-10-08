import { Checkbox } from '@ui/checkbox';
import { Input } from '@ui/input';
import { Button } from '@ui/button';
import { Plus, Trash2 } from 'lucide-react';
import type { Condition, ConditionLeaf, ConditionOperator, FormField, SelectOption } from '../../types';
import { isOptionField } from '../../engine';
import { ChoiceSelect, type Choice } from './settings';
import { VISIBLE_BORDER } from '../../runtime/styles';

const OPERATOR_LABEL: Record<ConditionOperator, string> = {
  equals: 'is',
  notEquals: 'is not',
  contains: 'contains',
  notContains: 'does not contain',
  in: 'is any of',
  notIn: 'is none of',
  isEmpty: 'is empty',
  isNotEmpty: 'is filled in',
  greaterThan: 'is greater than',
  lessThan: 'is less than',
  greaterThanOrEqual: 'is at least',
  lessThanOrEqual: 'is at most',
};

/** Operators that make sense for the field being tested. */
export function operatorsFor(field: FormField | undefined): ConditionOperator[] {
  if (!field) return ['equals'];
  if (isOptionField(field)) return ['equals', 'notEquals', 'in', 'notIn', 'isEmpty', 'isNotEmpty'];
  switch (field.type) {
    case 'CHECKBOX':
      return ['equals'];
    case 'NUMBER':
    case 'DATE':
    case 'DATETIME':
      return ['equals', 'notEquals', 'greaterThan', 'lessThan', 'greaterThanOrEqual', 'lessThanOrEqual', 'isEmpty', 'isNotEmpty'];
    default:
      return ['equals', 'notEquals', 'contains', 'notContains', 'isEmpty', 'isNotEmpty'];
  }
}

const NO_VALUE: ReadonlySet<ConditionOperator> = new Set(['isEmpty', 'isNotEmpty']);
const LIST_VALUE: ReadonlySet<ConditionOperator> = new Set(['in', 'notIn']);

const staticOptions = (field: FormField): SelectOption[] =>
  field.dataSource?.type === 'STATIC' ? field.dataSource.options ?? [] : [];

/** A condition to start from when the user switches a rule on. */
export function defaultCondition(target: FormField | undefined): ConditionLeaf {
  if (!target) return { field: '', operator: 'equals' };
  if (target.type === 'CHECKBOX') return { field: target.name, operator: 'equals', value: true };
  const first = staticOptions(target)[0];
  return { field: target.name, operator: 'equals', value: first?.value ?? '' };
}

function ValueInput({ target, leaf, onChange }: { target: FormField; leaf: ConditionLeaf; onChange: (value: unknown) => void }) {
  if (NO_VALUE.has(leaf.operator)) return null;

  if (target.type === 'CHECKBOX') {
    return (
      <ChoiceSelect<'true' | 'false'>
        ariaLabel="Value"
        value={leaf.value === false ? 'false' : 'true'}
        options={[
          { label: 'ticked', value: 'true' },
          { label: 'not ticked', value: 'false' },
        ]}
        onChange={(v) => onChange(v === 'true')}
      />
    );
  }

  const options = staticOptions(target);
  if (options.length && LIST_VALUE.has(leaf.operator)) {
    const chosen = new Set(Array.isArray(leaf.value) ? leaf.value.map(String) : []);
    return (
      <div className="fb-settings" style={{ gap: 6 }}>
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-2 text-sm">
            <Checkbox
              className={VISIBLE_BORDER}
              checked={chosen.has(o.value)}
              onCheckedChange={(checked) => {
                const next = new Set(chosen);
                if (checked) next.add(o.value);
                else next.delete(o.value);
                onChange(options.map((x) => x.value).filter((v) => next.has(v)));
              }}
            />
            {o.label}
          </label>
        ))}
      </div>
    );
  }
  if (options.length) {
    return (
      <ChoiceSelect
        ariaLabel="Value"
        value={typeof leaf.value === 'string' ? leaf.value : undefined}
        options={options.map((o) => ({ label: o.label, value: o.value }))}
        onChange={onChange}
      />
    );
  }

  const inputType = target.type === 'NUMBER' ? 'number' : target.type === 'DATE' ? 'date' : target.type === 'DATETIME' ? 'datetime-local' : 'text';
  return (
    <Input
      aria-label="Value"
      type={inputType}
      value={leaf.value === undefined || leaf.value === null ? '' : String(leaf.value)}
      onChange={(e) => onChange(inputType === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value)}
    />
  );
}

interface LeafEditorProps {
  leaf: ConditionLeaf;
  candidates: FormField[];
  onChange: (leaf: ConditionLeaf) => void;
  onRemove?: () => void;
}

/** One "<field> <operator> <value>" row. */
function LeafEditor({ leaf, candidates, onChange, onRemove }: LeafEditorProps) {
  const target = candidates.find((f) => f.name === leaf.field);
  const fieldChoices: Choice<string>[] = candidates.map((f) => ({ label: f.label || f.name, value: f.name }));
  const operatorChoices = operatorsFor(target).map((op) => ({ label: OPERATOR_LABEL[op], value: op }));

  return (
    <div className="fb-settings fb-panel" style={{ gap: 8, padding: 10 }}>
      <div className="flex items-center gap-2">
        <div style={{ flex: 1, minWidth: 0 }}>
          <ChoiceSelect
            ariaLabel="When field"
            placeholder="Choose a field"
            value={target ? leaf.field : undefined}
            options={fieldChoices}
            onChange={(name) => onChange(defaultCondition(candidates.find((f) => f.name === name)))}
          />
        </div>
        {onRemove && (
          <button type="button" className="fb-icon-btn fb-icon-btn--danger" aria-label="Remove condition" onClick={onRemove}>
            <Trash2 size={14} />
          </button>
        )}
      </div>
      {!target && leaf.field && <p className="fb-muted">Field "{leaf.field}" no longer exists - choose another.</p>}
      {target && (
        <>
          <ChoiceSelect<ConditionOperator>
            ariaLabel="Operator"
            value={leaf.operator}
            options={operatorChoices}
            onChange={(operator) => {
              const keepValue = !NO_VALUE.has(operator) && LIST_VALUE.has(operator) === LIST_VALUE.has(leaf.operator);
              onChange({ field: leaf.field, operator, ...(keepValue ? { value: leaf.value } : LIST_VALUE.has(operator) ? { value: [] } : {}) });
            }}
          />
          <ValueInput target={target} leaf={leaf} onChange={(value) => onChange({ ...leaf, value })} />
        </>
      )}
    </div>
  );
}

interface ConditionEditorProps {
  condition: Condition;
  /** Fields the rule may test - never the field that owns the rule. */
  candidates: FormField[];
  onChange: (condition: Condition) => void;
}

const isLeaf = (c: Condition): c is ConditionLeaf => !('all' in c) && !('any' in c);

/**
 * A rule: one condition, or several joined by "all" / "any". Deeper nesting
 * can exist in JSON-authored definitions; it's shown read-only rather than
 * flattened and lost.
 */
export function ConditionEditor({ condition, candidates, onChange }: ConditionEditorProps) {
  if (!candidates.length) {
    return <p className="fb-muted">Add another field first - rules test the value of a different field.</p>;
  }

  const mode: 'all' | 'any' = 'any' in condition ? 'any' : 'all';
  const items: Condition[] = 'all' in condition ? condition.all : 'any' in condition ? condition.any : [condition];

  if (!items.every(isLeaf)) {
    return (
      <div className="fb-settings" style={{ gap: 8 }}>
        <p className="fb-muted">This rule nests groups of conditions and can only be edited in the form JSON.</p>
        <Button type="button" variant="outline" size="sm" onClick={() => onChange(defaultCondition(candidates[0]))}>
          Replace with a simple rule
        </Button>
      </div>
    );
  }

  const leaves = items as ConditionLeaf[];
  const emit = (nextMode: 'all' | 'any', next: ConditionLeaf[]) =>
    onChange(next.length === 1 ? next[0] : nextMode === 'all' ? { all: next } : { any: next });

  return (
    <div className="fb-settings" style={{ gap: 8 }}>
      {leaves.length > 1 && (
        <ChoiceSelect<'all' | 'any'>
          ariaLabel="Match"
          value={mode}
          options={[
            { label: 'All of these are true', value: 'all' },
            { label: 'Any of these is true', value: 'any' },
          ]}
          onChange={(m) => emit(m, leaves)}
        />
      )}
      {leaves.map((leaf, i) => (
        <LeafEditor
          key={i}
          leaf={leaf}
          candidates={candidates}
          onChange={(next) => emit(mode, leaves.map((l, j) => (j === i ? next : l)))}
          onRemove={leaves.length > 1 ? () => emit(mode, leaves.filter((_, j) => j !== i)) : undefined}
        />
      ))}
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => emit(mode, [...leaves, defaultCondition(candidates[0])])}>
          <Plus /> Add condition
        </Button>
      </div>
    </div>
  );
}
