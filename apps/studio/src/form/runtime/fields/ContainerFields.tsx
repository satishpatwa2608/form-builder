import { useMemo, useState } from 'react';
import { useFormState } from 'react-hook-form';
import { columnWeights, descendantFields } from '../../engine';
import { useFormRuntime } from '../FormRuntimeContext';
import { FieldList, columnsStyle } from '../FieldRenderer/FieldRenderer';
import type { FieldComponentProps } from './types';

/** Side-by-side columns; each column is its own field list. Stacks on phones. */
export function ColumnsField({ field }: FieldComponentProps) {
  const weights = columnWeights(field);
  return (
    <div className="fp-columns" style={columnsStyle(weights)}>
      {weights.map((_, i) => (
        <div key={i} className="fp-column">
          <FieldList parentId={field.id} column={i} />
        </div>
      ))}
    </div>
  );
}

/**
 * A titled group. Optionally collapsible. In steps mode a top-level section
 * *is* the step, so it drops its own frame and title (the step header shows it).
 */
export function SectionField({ field }: FieldComponentProps) {
  const { stepSectionId, definition } = useFormRuntime();
  const asStep = stepSectionId === field.id;
  const collapsible = !asStep && field.props?.collapsible === true;
  const [collapsedByUser, setCollapsed] = useState(collapsible && field.props?.collapsed === true);

  // Never hide an error: a collapsed section opens when something inside it is invalid.
  const inside = useMemo(() => descendantFields(definition.fields, field.id).map((f) => f.name), [definition, field.id]);
  const { errors } = useFormState({ name: inside });
  const hasError = inside.some((name) => errors[name]);
  const collapsed = collapsedByUser && !hasError;
  const description = typeof field.props?.description === 'string' ? field.props.description : '';

  return (
    <section
      className={`fp-section${asStep ? ' fp-section--bare' : ''}${collapsed ? ' fp-section--collapsed' : ''}`}
      aria-label={field.label || undefined}
    >
      {!asStep && (field.label || description || collapsible) && (
        <div className="fp-section__head">
          <div>
            {field.label && <div className="fp-section__title">{field.label}</div>}
            {description && <div className="fp-section__desc">{description}</div>}
          </div>
          {collapsible && (
            <button type="button" className="fp-section__toggle" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
              {collapsed ? 'Show' : 'Hide'}
            </button>
          )}
        </div>
      )}
      {/* Collapsed content stays mounted (hidden) so its values and validation are untouched. */}
      <div hidden={collapsed}>
        <FieldList parentId={field.id} column={0} />
      </div>
    </section>
  );
}
