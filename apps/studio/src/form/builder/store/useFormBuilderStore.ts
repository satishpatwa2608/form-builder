import { fragmentSectionOf, fragmentUse } from '../../engine';
import { create } from 'zustand';
import type { FieldType, FormDefinition, FormField } from '../../types';
import { createField, DEFAULT_CAPTCHA_CONFIG, uniqueFieldName } from '../field-catalog';
import {
  duplicateField as duplicateInList,
  moveAmongSiblings,
  moveItem,
  placeField,
  removeField as removeFromList,
  renameFieldReferences,
  setColumnWeights,
  type Placement,
} from '../definition-edits';
import { descendantFields, isRepeat, isSectionGroup, ROW_FIELD_TYPES } from '../../engine';

const HISTORY_LIMIT = 50;
/** Keystrokes into the same setting within this window are one undo step. */
const COALESCE_MS = 800;

/**
 * Local editing state for the one form open in the builder. Loading and
 * saving go through the registry hooks; this store never persists anything.
 */
export interface FormBuilderState {
  form: FormDefinition | null;
  selectedFieldId?: string;
  isDirty: boolean;
  past: FormDefinition[];
  future: FormDefinition[];
  /** Identifies the last edit so rapid edits to the same setting coalesce. */
  lastEdit?: { key: string; at: number };
  /**
   * The fragment section whose fields are being changed here, to be saved back to the library.
   * Every other fragment section's fields are a copy and cannot be edited on the form.
   */
  unlockedFragment?: string;
  unlockFragment: (sectionId?: string) => void;

  load: (form: FormDefinition) => void;
  /** Close the open form (leaving the builder). */
  reset: () => void;
  /** After a successful save: adopt the saved copy, keep history, clear dirty. */
  markSaved: (form: FormDefinition) => void;

  updateForm: (changes: Partial<FormDefinition>) => void;
  /** Returns the new field's id. `place` is a flat index (legacy) or a layout placement; default is the end. */
  addField: (type: FieldType, place?: number | Placement) => string;
  /** Move an existing field (and, for a container, everything inside it) to a new place. */
  moveField: (fieldId: string, place: Placement) => void;
  /** Up / down within the field's own column or section. */
  moveSibling: (fieldId: string, delta: -1 | 1) => void;
  /** Change a Columns block's column layout. */
  setColumns: (fieldId: string, weights: number[]) => void;
  updateField: (fieldId: string, changes: Partial<FormField>) => void;
  /** Replace the whole field - for clearing optional keys, which a partial update can't do. */
  replaceField: (field: FormField) => void;
  /** For a container, `keepChildren` lifts its fields out instead of deleting them. */
  removeField: (fieldId: string, keepChildren?: boolean) => void;
  duplicateField: (fieldId: string) => void;
  reorderFields: (sourceIndex: number, targetIndex: number) => void;
  selectField: (fieldId?: string) => void;

  undo: () => void;
  redo: () => void;
}

/**
 * Whether fields of these types (the first is the one being placed, the rest
 * what it carries inside) may go into `parentId`: tabs and accordions hold
 * sections only, and a repeating section only what can repeat.
 */
function fitsIn(fields: FormField[], types: FieldType[], parentId: string | undefined): boolean {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const parent = parentId ? byId.get(parentId) : undefined;
  if (!parent) return true;
  if (isSectionGroup(parent) && types[0] !== 'SECTION') return false;
  const seen = new Set<string>();
  for (let at: FormField | undefined = parent; at && !seen.has(at.id); at = at.parentId ? byId.get(at.parentId) : undefined) {
    if (isRepeat(at)) return types.every((t) => ROW_FIELD_TYPES.has(t));
    seen.add(at.id);
  }
  return true;
}

const USABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const useFormBuilderStore = create<FormBuilderState>()((set, get) => {
  /** Apply an edit to the open form, recording history. */
  const commit = (next: FormDefinition, editKey?: string, extra: Partial<FormBuilderState> = {}) => {
    const { form, past, lastEdit } = get();
    if (!form) return;
    const at = Date.now();
    const coalesce = !!editKey && lastEdit?.key === editKey && at - lastEdit.at < COALESCE_MS;
    set({
      form: next,
      past: coalesce ? past : [...past, form].slice(-HISTORY_LIMIT),
      future: [],
      isDirty: true,
      lastEdit: editKey ? { key: editKey, at } : undefined,
      ...extra,
    });
  };

  const withFields = (fields: FormField[]) => ({ ...get().form!, fields });

  /** Field id -> the name rules still use for it, while its key is being retyped (see updateField). */
  const heldNames = new Map<string, string>();

  /** A field inside a fragment section is the library's, not this form's, unless that section is being edited. */
  const locked = (fieldId: string | undefined): boolean => {
    const { form, unlockedFragment } = get();
    if (!form || !fieldId) return false;
    const section = fragmentSectionOf(form.fields, fieldId);
    return !!section && section.id !== unlockedFragment;
  };
  /** Nothing may be put into a fragment section, or into anything inside one, either. */
  const lockedPlace = (parentId: string | undefined): boolean => {
    const { form, unlockedFragment } = get();
    const parent = form?.fields.find((f) => f.id === parentId);
    if (!form || !parent) return false;
    return (!!fragmentUse(parent) && parent.id !== unlockedFragment) || locked(parent.id);
  };

  return {
    form: null,
    selectedFieldId: undefined,
    unlockedFragment: undefined,
    unlockFragment: (sectionId) => set({ unlockedFragment: sectionId }),
    isDirty: false,
    past: [],
    future: [],

    load: (form) => {
      heldNames.clear();
      set({ form, selectedFieldId: undefined, isDirty: false, past: [], future: [], lastEdit: undefined, unlockedFragment: undefined });
    },

    reset: () => {
      heldNames.clear();
      set({ form: null, selectedFieldId: undefined, isDirty: false, past: [], future: [], lastEdit: undefined });
    },

    markSaved: (form) => set({ form, isDirty: false, lastEdit: undefined }),

    updateForm: (changes) => {
      const { form } = get();
      if (!form) return;
      commit({ ...form, ...changes }, `form:${Object.keys(changes).join(',')}`);
    },

    addField: (type, place) => {
      const { form } = get();
      if (!form) return '';
      if (type === 'CAPTCHA' && form.fields.some((f) => f.type === 'CAPTCHA')) return '';
      if (typeof place === 'object' && (lockedPlace(place.parentId) || !fitsIn(form.fields, [type], place.parentId))) return '';
      const field = createField(type, form.fields.map((f) => f.name));
      let fields: FormField[];
      if (typeof place === 'number' || place === undefined) {
        fields = [...form.fields];
        fields.splice(place ?? fields.length, 0, field);
      } else {
        fields = placeField([...form.fields, field], field, place);
      }
      // A repeating section starts with one field to repeat.
      if (isRepeat(field)) {
        const first = createField('TEXT', fields.map((f) => f.name));
        fields.push({ ...first, label: 'Item', parentId: field.id, column: 0 });
      }
      // Tabs and an accordion are nothing without sections: start with two.
      if (isSectionGroup(field)) {
        for (const n of [1, 2]) {
          const section = createField('SECTION', fields.map((f) => f.name));
          fields.push({ ...section, label: `${type === 'TABS' ? 'Tab' : 'Panel'} ${n}`, parentId: field.id, column: 0 });
        }
      }
      const next = withFields(fields);
      // A CAPTCHA field needs the form-level provider settings to publish.
      if (type === 'CAPTCHA' && !next.captcha) next.captcha = { ...DEFAULT_CAPTCHA_CONFIG };
      commit(next, undefined, { selectedFieldId: field.id });
      return field.id;
    },

    updateField: (fieldId, changes) => {
      const { form } = get();
      const current = form?.fields.find((f) => f.id === fieldId);
      if (!form || !current || locked(fieldId)) return;
      let next = withFields(form.fields.map((f) => (f.id === fieldId ? { ...f, ...changes } : f)));
      if (changes.name !== undefined && changes.name !== current.name) {
        // The key is typed a character at a time. While it is empty, half-typed or the same as
        // another field's, rules keep the name they had; they follow once the key is usable again.
        // Renaming through a clash would merge the two fields' references for good.
        const others = new Set(form.fields.filter((f) => f.id !== fieldId).map((f) => f.name));
        const known = heldNames.get(fieldId) ?? current.name;
        if (!USABLE_NAME.test(changes.name) || others.has(changes.name) || others.has(known)) heldNames.set(fieldId, known);
        else {
          next = renameFieldReferences(next, known, changes.name);
          heldNames.delete(fieldId);
        }
      }
      commit(next, `field:${fieldId}:${Object.keys(changes).join(',')}`);
    },

    replaceField: (field) => {
      const { form } = get();
      if (!form || locked(field.id)) return;
      commit(withFields(form.fields.map((f) => (f.id === field.id ? field : f))), `field:${field.id}:replace`);
    },

    removeField: (fieldId, keepChildren = false) => {
      const { form, selectedFieldId } = get();
      if (!form || locked(fieldId)) return;
      const next = withFields(removeFromList(form.fields, fieldId, keepChildren));
      if (!next.fields.some((f) => f.type === 'CAPTCHA')) delete next.captcha;
      const stillThere = next.fields.some((f) => f.id === selectedFieldId);
      commit(next, undefined, { selectedFieldId: stillThere ? selectedFieldId : undefined });
    },

    moveField: (fieldId, place) => {
      const { form } = get();
      const field = form?.fields.find((f) => f.id === fieldId);
      if (form && field && !fitsIn(form.fields, [field.type, ...descendantFields(form.fields, field.id).map((f) => f.type)], place.parentId)) return;
      if (!form || !field || locked(fieldId) || lockedPlace(place.parentId)) return;
      const fields = placeField(form.fields, field, place);
      if (fields !== form.fields) commit(withFields(fields));
    },

    moveSibling: (fieldId, delta) => {
      const { form } = get();
      if (!form || locked(fieldId)) return;
      const fields = moveAmongSiblings(form.fields, fieldId, delta);
      if (fields !== form.fields) commit(withFields(fields));
    },

    setColumns: (fieldId, weights) => {
      const { form } = get();
      if (!form || locked(fieldId)) return;
      commit(withFields(setColumnWeights(form.fields, fieldId, weights)), `field:${fieldId}:columns`);
    },

    duplicateField: (fieldId) => {
      const { form } = get();
      if (!form || locked(fieldId)) return;
      // One CAPTCHA per form: never copy it, alone or inside a container.
      const subtree = [form.fields.find((f) => f.id === fieldId), ...descendantFields(form.fields, fieldId)];
      if (!subtree[0] || subtree.some((f) => f?.type === 'CAPTCHA')) return;
      const { fields, copyId } = duplicateInList(form.fields, fieldId, uniqueFieldName);
      commit(withFields(fields), undefined, { selectedFieldId: copyId });
    },

    reorderFields: (sourceIndex, targetIndex) => {
      const { form } = get();
      if (!form || sourceIndex === targetIndex) return;
      commit(withFields(moveItem(form.fields, sourceIndex, targetIndex)));
    },

    selectField: (fieldId) => set({ selectedFieldId: fieldId }),

    undo: () => {
      const { form, past, future } = get();
      if (!form || !past.length) return;
      set({ form: past[past.length - 1], past: past.slice(0, -1), future: [form, ...future], isDirty: true, lastEdit: undefined });
    },

    redo: () => {
      const { form, past, future } = get();
      if (!form || !future.length) return;
      set({ form: future[0], past: [...past, form], future: future.slice(1), isDirty: true, lastEdit: undefined });
    },
  };
});
