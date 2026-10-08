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
export function FieldPalette({ fields, onAdd }: { fields: FormField[]; onAdd: (type: FieldType) => void }) {
  return (
    <div className="fb-panel" aria-label="Field palette">
      {paletteFor(fields).map((group) => (
        <div key={group.title}>
          <div className="fb-panel__title">{group.title}</div>
          {group.items.map((item) => (
            <PaletteButton key={item.type} item={item} onAdd={onAdd} />
          ))}
        </div>
      ))}
    </div>
  );
}
