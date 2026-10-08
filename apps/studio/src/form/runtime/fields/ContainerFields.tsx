import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useFormState } from 'react-hook-form';
import { columnWeights, descendantFields } from '../../engine';
import { useFormRuntime } from '../FormRuntimeContext';
import { FieldList, columnsStyle } from '../FieldRenderer/FieldRenderer';
import { childrenOf } from '../../engine';
import type { FormField } from '../../types';
import type { FieldComponentProps } from './types';

/** Asks every block around a field to show it (open its tab or panel) before it is focused. */
export const REVEAL_EVENT = 'fp:reveal';

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

  // About to focus a field inside: open up.
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const open = () => setCollapsed(false);
    el.addEventListener(REVEAL_EVENT, open);
    return () => el.removeEventListener(REVEAL_EVENT, open);
  }, []);

  return (
    <section
      ref={root}
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

/**
 * Shared by Tabs and Accordion: the SECTIONs directly inside, which of them is
 * open, which hold an error, and opening the right one when a field inside is
 * about to be focused. Hidden sections (by a rule) are left out.
 */
function useSectionGroup(field: FormField) {
  const { layout, states, definition } = useFormRuntime();
  const sections = childrenOf(layout, field.id, 0).filter((s) => states.get(s.name)?.visible !== false);
  const namesIn = useMemo(
    () => new Map(childrenOf(layout, field.id, 0).map((s) => [s.id, descendantFields(definition.fields, s.id).map((f) => f.name)])),
    [layout, definition, field.id],
  );
  const { errors } = useFormState({ name: [...namesIn.values()].flat() });
  const hasError = (id: string) => (namesIn.get(id) ?? []).some((name) => errors[name]);
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const open = sections.find((s) => s.id === chosen) ?? sections[0];

  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const reveal = (e: Event) => {
      const panel = (e.target as HTMLElement).closest<HTMLElement>('[data-group-panel]');
      if (panel && el.contains(panel) && panel.dataset.groupOwner === field.id) setChosen(panel.dataset.groupPanel);
    };
    el.addEventListener(REVEAL_EVENT, reveal);
    return () => el.removeEventListener(REVEAL_EVENT, reveal);
  }, [field.id]);

  return { sections, open, setChosen, hasError, root };
}

/** Each SECTION inside is a tab. Panels that are not showing stay mounted, so their values and validation are untouched. */
export function TabsField({ field }: FieldComponentProps) {
  const { sections, open, setChosen, hasError, root } = useSectionGroup(field);
  const id = useId();
  const vertical = field.props?.orientation === 'vertical';
  if (!sections.length) return null;
  const move = (from: number, by: number) => {
    const next = sections[(from + by + sections.length) % sections.length];
    setChosen(next.id);
    root.current?.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus();
  };
  return (
    <div ref={root} className={`fp-tabs${vertical ? ' fp-tabs--vertical' : ''}`}>
      <div role="tablist" aria-label={field.label || undefined} aria-orientation={vertical ? 'vertical' : 'horizontal'} className="fp-tabs__list">
        {sections.map((s, i) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            id={`${id}-tab-${s.id}`}
            data-tab={s.id}
            aria-selected={s.id === open.id}
            aria-controls={`${id}-panel-${s.id}`}
            tabIndex={s.id === open.id ? 0 : -1}
            className="fp-tabs__tab"
            onClick={() => setChosen(s.id)}
            onKeyDown={(e) => {
              if (e.key === (vertical ? 'ArrowDown' : 'ArrowRight')) move(i, 1);
              else if (e.key === (vertical ? 'ArrowUp' : 'ArrowLeft')) move(i, -1);
            }}
          >
            {s.label || `Tab ${i + 1}`}
            {hasError(s.id) && <span className="fp-tabs__error"> (needs attention)</span>}
          </button>
        ))}
      </div>
      {sections.map((s) => (
        <div key={s.id} role="tabpanel" id={`${id}-panel-${s.id}`} aria-labelledby={`${id}-tab-${s.id}`} hidden={s.id !== open.id} data-group-panel={s.id} data-group-owner={field.id} className="fp-tabs__panel">
          <FieldList parentId={s.id} column={0} />
        </div>
      ))}
    </div>
  );
}

/** Each SECTION inside is a panel; opening one closes the others. */
export function AccordionField({ field }: FieldComponentProps) {
  const { sections, open, setChosen, hasError, root } = useSectionGroup(field);
  const id = useId();
  const [closed, setClosed] = useState(false);
  if (!sections.length) return null;
  return (
    <div ref={root} className="fp-accordion">
      {sections.map((s, i) => {
        const isOpen = !closed && s.id === open.id;
        return (
          <div key={s.id} className="fp-accordion__item">
            <button
              type="button"
              id={`${id}-head-${s.id}`}
              className="fp-accordion__head"
              aria-expanded={isOpen}
              aria-controls={`${id}-panel-${s.id}`}
              onClick={() => {
                setClosed(isOpen);
                setChosen(s.id);
              }}
            >
              <span>
                {s.label || `Panel ${i + 1}`}
                {hasError(s.id) && <span className="fp-tabs__error"> (needs attention)</span>}
              </span>
              <span aria-hidden="true">{isOpen ? '−' : '+'}</span>
            </button>
            <div role="region" id={`${id}-panel-${s.id}`} aria-labelledby={`${id}-head-${s.id}`} hidden={!isOpen} data-group-panel={s.id} data-group-owner={field.id} className="fp-accordion__panel">
              <FieldList parentId={s.id} column={0} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
