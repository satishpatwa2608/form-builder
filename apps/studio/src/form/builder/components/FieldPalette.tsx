import { Library } from 'lucide-react';
import type { Fragment } from '../../engine';
import { useCustomFields } from '../../adapters/extensions';
import { useDraggable } from '@dnd-kit/core';
import type { FieldType, FormField } from '../../types';
import { paletteFor, type PaletteItem } from '../field-catalog';

export const paletteDragId = (type: FieldType) => `palette:${type}`;

interface PaletteButtonProps {
  item: PaletteItem;
  onAdd: (type: FieldType) => void;
}

function PaletteButton({ item, onAdd }: PaletteButtonProps) {
  const unavailable = !!item.unavailable;
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: paletteDragId(item.type),
    data: { source: 'palette', type: item.type },
    disabled: unavailable,
  });
  const Icon = item.icon;
  return (
    <button
      ref={setNodeRef}
      type="button"
      className="fb-palette-item"
      {...attributes}
      {...listeners}
      aria-disabled={unavailable}
      title={item.unavailable ?? `Drag onto the form, or click to add at the end`}
      onClick={() => !unavailable && onAdd(item.type)}
    >
      <Icon size={15} aria-hidden="true" />
      {item.label}
    </button>
  );
}

/** Drag a field type onto the canvas, or click it to append. */
interface FieldPaletteProps {
  fields: FormField[];
  onAdd: (type: FieldType) => void;
  /** Sections kept in the organisation's library; clicking one adds a copy at the end of the form. */
  fragments?: Fragment[];
  onAddFragment?: (fragment: Fragment) => void;
}

export function FieldPalette({ fields, onAdd, fragments = [], onAddFragment }: FieldPaletteProps) {
  // Fields the organisation's own code draws appear only when its extension offers some.
  const { data: custom = [] } = useCustomFields();
  return (
    <div className="fb-panel" aria-label="Field palette">
      {paletteFor(fields, custom.length > 0).map((group) => (
        <div key={group.title}>
          <div className="fb-panel__title">{group.title}</div>
          {group.items.map((item) => (
            <PaletteButton key={item.type} item={item} onAdd={onAdd} />
          ))}
        </div>
      ))}
      {!!fragments.length && onAddFragment && (
        <div>
          <div className="fb-panel__title">Fragments</div>
          {fragments.map((fragment) => (
            <button key={fragment.id} type="button" className="fb-palette-item" title={fragment.description || 'Adds this section at the end of the form'} onClick={() => onAddFragment(fragment)}>
              <Library size={15} aria-hidden="true" />
              {fragment.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
