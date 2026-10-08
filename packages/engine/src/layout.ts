import type { FormField } from './types';
import { isContainerField } from './field-kinds';

/**
 * Layout is derived from the flat field list: a field with `parentId` sits in
 * that container's column `column`. Order within a column = order in the flat
 * list. A dangling parent (container deleted, JSON hand-edited) falls back to
 * top level so a field is never silently lost.
 */

export const ROOT = '__root__';

const slotKey = (parentId: string, column: number) => `${parentId}#${column}`;

export interface LayoutIndex {
  byId: Map<string, FormField>;
  /** `${parentId}#${column}` -> children in order. Root is `${ROOT}#0`. */
  slots: Map<string, FormField[]>;
}

/** Number of columns a container has (only COLUMNS has more than one). */
export function columnCount(container: FormField): number {
  if (container.type !== 'COLUMNS') return 1;
  const cols = container.props?.columns;
  return Array.isArray(cols) && cols.length ? cols.length : 2;
}

/** Relative column widths of a COLUMNS container, e.g. [1, 2]. */
export function columnWeights(container: FormField): number[] {
  const cols = container.props?.columns;
  if (Array.isArray(cols) && cols.length && cols.every((n) => typeof n === 'number' && n > 0)) return cols as number[];
  return [1, 1];
}

/** Where a field actually sits, after falling back for dangling or out-of-range parents. */
export function placement(field: FormField, byId: Map<string, FormField>): { parentId: string; column: number } {
  const parent = field.parentId ? byId.get(field.parentId) : undefined;
  if (!parent || !isContainerField(parent) || parent.id === field.id) return { parentId: ROOT, column: 0 };
  const column = Math.min(Math.max(field.column ?? 0, 0), columnCount(parent) - 1);
  return { parentId: parent.id, column };
}

export function buildLayoutIndex(fields: FormField[]): LayoutIndex {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const slots = new Map<string, FormField[]>();
  for (const f of fields) {
    const { parentId, column } = placement(f, byId);
    const key = slotKey(parentId, column);
    slots.set(key, [...(slots.get(key) ?? []), f]);
  }
  return { byId, slots };
}

export function childrenOf(index: LayoutIndex, parentId: string = ROOT, column = 0): FormField[] {
  return index.slots.get(slotKey(parentId, column)) ?? [];
}

/** Every field nested (at any depth) inside `containerId`. */
export function descendantFields(fields: FormField[], containerId: string): FormField[] {
  const byId = new Map(fields.map((f) => [f.id, f]));
  return fields.filter((f) => {
    const seen = new Set<string>();
    let parent = f.parentId;
    while (parent && !seen.has(parent)) {
      if (parent === containerId) return true;
      seen.add(parent);
      parent = byId.get(parent)?.parentId;
    }
    return false;
  });
}

/** Container ids above a field, nearest first. Stops on cycles. */
export function ancestorIds(field: FormField, byId: Map<string, FormField>): string[] {
  const out: string[] = [];
  let current = field;
  while (current.parentId && byId.has(current.parentId) && !out.includes(current.parentId)) {
    out.push(current.parentId);
    current = byId.get(current.parentId)!;
  }
  return out;
}

export interface FormStep {
  /** The SECTION that forms the step, or undefined for loose top-level fields grouped together. */
  section?: FormField;
  title: string;
  /** Top-level items rendered on this step. */
  items: FormField[];
}

/**
 * Steps mode: each top-level SECTION is a step; runs of other top-level fields
 * between sections are grouped into their own step so nothing is unreachable.
 */
export function buildSteps(fields: FormField[]): FormStep[] {
  const top = childrenOf(buildLayoutIndex(fields));
  const steps: FormStep[] = [];
  for (const f of top) {
    if (f.type === 'SECTION') steps.push({ section: f, title: f.label || 'Section', items: [f] });
    else if (steps.length && !steps[steps.length - 1].section) steps[steps.length - 1].items.push(f);
    else steps.push({ title: 'Details', items: [f] });
  }
  return steps;
}

/** Field names (value fields included) inside a set of top-level items, recursively. */
export function namesWithin(fields: FormField[], items: FormField[]): Set<string> {
  const names = new Set<string>();
  for (const item of items) {
    names.add(item.name);
    if (isContainerField(item)) for (const d of descendantFields(fields, item.id)) names.add(d.name);
  }
  return names;
}
