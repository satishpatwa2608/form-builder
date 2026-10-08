import type { CSSProperties } from 'react';
import type { FormField } from '../../types';
import { childrenOf, isPrefillLocked, ROOT, styleClass } from '../../engine';
import { useFormRuntime } from '../FormRuntimeContext';
import { UnsupportedField } from '../fields/SimpleFields';
import { getFieldComponent } from './field-registry';

/**
 * Config -> component. Hides the field when its visibility rule (or a
 * containing block's) doesn't hold and passes down the resolved required
 * state. The wrapper carries width + style-master classes, and its data
 * attribute lets the error summary scroll to and focus any field type.
 */
export function FieldRenderer({ field }: { field: FormField }) {
  const { states, systemContext } = useFormRuntime();
  const state = states.get(field.name);
  if (state && !state.visible) return null;
  // Filled from the signed-in user and locked: read-only (the server enforces it too).
  const shown = isPrefillLocked(field, systemContext) ? { ...field, disabled: true } : field;

  const Component = getFieldComponent(field.type) ?? UnsupportedField;
  if (field.type === 'HIDDEN') return <Component field={shown} required={false} />;

  const className = ['fp-cell', field.width && field.width !== 'full' && `fp-w-${field.width}`, field.styleId && styleClass(field.styleId)]
    .filter(Boolean)
    .join(' ');

  return (
    <div data-field-name={field.name} className={className}>
      <Component field={shown} required={state?.required ?? !!field.required} />
    </div>
  );
}

/** The fields placed in one slot (root, or a container column), in order, on the width grid. */
export function FieldList({ parentId = ROOT, column = 0, items }: { parentId?: string; column?: number; items?: FormField[] }) {
  const { layout } = useFormRuntime();
  const fields = items ?? childrenOf(layout, parentId, column);
  return (
    <div className="fp-grid">
      {fields.map((f) => (
        <FieldRenderer key={f.id} field={f} />
      ))}
    </div>
  );
}

/** `[1, 2]` -> CSS custom property the stylesheet turns into grid columns (stacked on phones). */
export const columnsStyle = (weights: number[]): CSSProperties =>
  ({ '--fp-cols': weights.map((w) => `minmax(0, ${w}fr)`).join(' ') }) as CSSProperties;
