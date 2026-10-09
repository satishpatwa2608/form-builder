import { fragmentUse } from '../../engine';
import { useFormBuilderStore } from '../store/useFormBuilderStore';
import type { MouseEvent } from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { ArrowDown, ArrowUp, Copy, GripVertical, Trash2 } from 'lucide-react';
import type { FormDefinition, FormField } from '../../types';
import { paletteItem } from '../field-catalog';
import { buildLayoutIndex, childrenOf, columnWeights, fieldParents, isContainerField, isSectionGroup, ROOT, type LayoutIndex } from '../../engine';
import type { Placement } from '../definition-edits';
import { columnsStyle } from '../../runtime/FieldRenderer/FieldRenderer';

/** Data every droppable carries: where a dropped field goes. */
export type DropData = Placement;

interface CardActions {
  onSelect: (id: string) => void;
  onMove: (id: string, delta: -1 | 1) => void;
  onDuplicate: (id: string) => void;
  onRemove: (field: FormField) => void;
}

interface Shared extends CardActions {
  layout: LayoutIndex;
  selectedFieldId?: string;
  readOnly: boolean;
}

const SYSTEM_SOURCE_LABEL: Record<string, string> = {
  ORG_ID: 'Organisation',
  BUSINESS_ID: 'Business',
  USER_ID: 'User id',
  USER_EMAIL: 'User email',
  FORM_ID: 'Form id',
  FORM_VERSION: 'Form version',
  SOURCE_CHANNEL: 'Channel',
  CURRENT_DATE: 'Current date',
  URL_PARAMETER: 'URL parameter',
};

const WIDTH_LABEL: Record<string, string> = { half: '½ width', third: '⅓ width', 'two-thirds': '⅔ width' };

const slotOf = (parentId: string, column: number): Pick<Placement, 'parentId' | 'column'> =>
  parentId === ROOT ? {} : { parentId, column };

function cardTitle(field: FormField) {
  if (field.type === 'HIDDEN') return 'Hidden value';
  if (field.type === 'COLUMNS') return `${columnWeights(field).length} columns`;
  if (field.label) return field.label;
  if (field.type === 'TABS' || field.type === 'ACCORDION') return field.type === 'TABS' ? 'Tabs' : 'Accordion';
  if (field.type === 'REPEAT') return 'Repeating section';
  if (field.type === 'IMAGE') return typeof field.props?.alt === 'string' && field.props.alt ? field.props.alt : 'Picture';
  return field.type === 'SECTION' ? 'Untitled section' : <em>No label</em>;
}

function FieldCard({
  field,
  slot,
  index,
  count,
  ...shared
}: Shared & { field: FormField; slot: Pick<Placement, 'parentId' | 'column'>; index: number; count: number }) {
  const { selectedFieldId, readOnly, onSelect, onMove, onDuplicate, onRemove } = shared;
  // A section copied from a fragment shows its fields but offers nothing to do to them, unless it is being changed here.
  const unlockedFragment = useFormBuilderStore((s) => s.unlockedFragment);
  const isFragment = !!fragmentUse(field);
  const inside = isFragment && unlockedFragment !== field.id ? { ...shared, readOnly: true } : shared;
  const drag = useDraggable({ id: `field:${field.id}`, data: { source: 'canvas', id: field.id }, disabled: readOnly });
  const drop = useDroppable({ id: `before:${field.id}`, data: { ...slot, beforeId: field.id } satisfies DropData, disabled: readOnly });
  const item = paletteItem(field.type);
  const Icon = item?.icon;
  const required = field.required || field.type === 'CAPTCHA';
  const parents = fieldParents(field);

  const className = [
    'fb-card',
    isContainerField(field) && 'fb-card--container',
    field.id === selectedFieldId && 'fb-card--selected',
    drag.isDragging && 'fb-card--dragging',
    drop.isOver && !drag.isDragging && 'fb-card--drop-target',
  ]
    .filter(Boolean)
    .join(' ');

  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    fn();
  };

  return (
    <div
      ref={drop.setNodeRef}
      className={className}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(field.id);
      }}
      data-testid={`field-card-${field.name}`}
    >
      <div className="fb-card__row">
        {!readOnly && (
          <button
            ref={drag.setNodeRef}
            type="button"
            className="fb-card__handle"
            aria-label={`Drag ${field.label || field.name}`}
            {...drag.attributes}
            {...drag.listeners}
          >
            <GripVertical size={16} />
          </button>
        )}
        <div className="fb-card__body">
          <div className="fb-card__label">
            {cardTitle(field)}
            {required && <span className="fb-card__required">*</span>}
          </div>
          <div className="fb-card__meta">
            <span className="fb-chip">
              {Icon && <Icon size={11} aria-hidden="true" />}
              {item?.label ?? field.type}
            </span>
            <span className="fb-code">{field.name}</span>
            {isFragment && <span className="fb-chip fb-chip--rule">{unlockedFragment === field.id ? 'fragment: being changed' : 'fragment'}</span>}
            {field.width && WIDTH_LABEL[field.width] && <span className="fb-chip">{WIDTH_LABEL[field.width]}</span>}
            {field.styleId && <span className="fb-chip">style: {field.styleId}</span>}
            {field.systemSource && <span className="fb-chip">from {SYSTEM_SOURCE_LABEL[field.systemSource]}</span>}
            {field.visibility && <span className="fb-chip fb-chip--rule">visible if…</span>}
            {field.requiredWhen && !field.required && <span className="fb-chip fb-chip--rule">required if…</span>}
            {parents.length > 0 && <span className="fb-chip fb-chip--rule">follows {parents.join(', ')}</span>}
            {field.dataSource?.type === 'API' && <span className="fb-chip">options from API</span>}
          </div>
        </div>
        {!readOnly && (
          <div className="fb-card__actions">
            <button type="button" className="fb-icon-btn" aria-label="Move up" disabled={index === 0} onClick={stop(() => onMove(field.id, -1))}>
              <ArrowUp size={15} />
            </button>
            <button type="button" className="fb-icon-btn" aria-label="Move down" disabled={index === count - 1} onClick={stop(() => onMove(field.id, 1))}>
              <ArrowDown size={15} />
            </button>
            {field.type !== 'CAPTCHA' && (
              <button type="button" className="fb-icon-btn" aria-label="Duplicate" onClick={stop(() => onDuplicate(field.id))}>
                <Copy size={15} />
              </button>
            )}
            <button type="button" className="fb-icon-btn fb-icon-btn--danger" aria-label="Delete" onClick={stop(() => onRemove(field))}>
              <Trash2 size={15} />
            </button>
          </div>
        )}
      </div>

      {field.type === 'COLUMNS' && (
        <div className="fb-columns" style={columnsStyle(columnWeights(field))}>
          {columnWeights(field).map((_, col) => (
            <div key={col} className="fb-column" aria-label={`Column ${col + 1}`}>
              <CanvasList parentId={field.id} column={col} {...shared} />
            </div>
          ))}
        </div>
      )}
      {(field.type === 'SECTION' || field.type === 'REPEAT' || isSectionGroup(field)) && (
        <div className="fb-section-body">
          <CanvasList parentId={field.id} column={0} sectionsOnly={isSectionGroup(field)} {...inside} />
        </div>
      )}
    </div>
  );
}

function EndSlot({ parentId, column, empty, readOnly, sectionsOnly }: { parentId: string; column: number; empty: boolean; readOnly: boolean; sectionsOnly?: boolean }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `end:${parentId}:${column}`,
    data: slotOf(parentId, column) satisfies DropData,
    disabled: readOnly,
  });
  if (readOnly) return empty ? <div className="fb-muted">Empty</div> : null;
  const nested = parentId !== ROOT;
  return (
    <div ref={setNodeRef} className={`fb-drop-end${nested ? ' fb-drop-end--nested' : ''}${isOver ? ' fb-drop-end--over' : ''}`}>
      {sectionsOnly ? '+ Drop a Section here to add another' : empty ? (nested ? 'Drop fields here' : 'Drag a field here from the palette, or click one to add it') : '+ Drop here'}
    </div>
  );
}

/** The fields in one slot (root, or a container column), then a drop zone for the slot's end. */
function CanvasList({ parentId, column, sectionsOnly, ...shared }: Shared & { parentId: string; column: number; sectionsOnly?: boolean }) {
  const items = childrenOf(shared.layout, parentId, column);
  const slot = slotOf(parentId, column);
  return (
    <>
      {items.map((field, index) => (
        <FieldCard key={field.id} field={field} slot={slot} index={index} count={items.length} {...shared} />
      ))}
      <EndSlot parentId={parentId} column={column} empty={items.length === 0} readOnly={shared.readOnly} sectionsOnly={sectionsOnly} />
    </>
  );
}

interface BuilderCanvasProps extends CardActions {
  form: FormDefinition;
  selectedFieldId?: string;
  readOnly: boolean;
  onSelectForm: () => void;
}

/**
 * The form as nested cards. Every card is an "insert before me" drop target;
 * every root/column/section list ends with an "insert at end" target. Columns
 * and Sections render their own lists inside their card.
 */
export function BuilderCanvas({ form, selectedFieldId, readOnly, onSelectForm, ...actions }: BuilderCanvasProps) {
  const layout = buildLayoutIndex(form.fields);
  return (
    <div className="fb-canvas" aria-label="Form canvas">
      <div
        className={`fb-canvas__intro${selectedFieldId ? '' : ' fb-canvas__intro--selected'}`}
        onClick={onSelectForm}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && onSelectForm()}
      >
        <div className="fb-canvas__form-name">{form.name}</div>
        <div className="fb-canvas__form-desc">
          {form.description || 'Form settings: name, access, look and feel, layout, buttons, after-submit'}
          {form.layout?.mode === 'steps' && ' · shown as steps'}
        </div>
      </div>
      <CanvasList parentId={ROOT} column={0} layout={layout} selectedFieldId={selectedFieldId} readOnly={readOnly} {...actions} />
    </div>
  );
}
