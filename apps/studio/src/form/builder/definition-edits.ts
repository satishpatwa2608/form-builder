import type { Condition, FormDefinition, FormEvent, FormField, FormRule, RuleAction, RuleCondition } from '../types';
import { buildLayoutIndex, childrenOf, conditionFields, descendantFields, expressionFields, isExpressionCondition, placement, renameExpressionField, ROOT } from '../engine';

/**
 * Pure edits on a FormDefinition that the builder store composes. Kept out of
 * the store so they're testable without Zustand.
 */

function renameInCondition(cond: Condition, from: string, to: string): Condition {
  if ('all' in cond) return { all: cond.all.map((c) => renameInCondition(c, from, to)) };
  if ('any' in cond) return { any: cond.any.map((c) => renameInCondition(c, from, to)) };
  return cond.field === from ? { ...cond, field: to } : cond;
}

const renameInWhen = (when: RuleCondition, from: string, to: string): RuleCondition =>
  isExpressionCondition(when) ? { expr: renameExpressionField(when.expr, from, to) } : renameInCondition(when, from, to);

const renameInParams = (params: Record<string, string>, from: string, to: string) =>
  Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v.split(`{{${from}}}`).join(`{{${to}}}`)]));

function renameInEvent(event: FormEvent, from: string, to: string): FormEvent {
  const swap = (name: string) => (name === from ? to : name);
  return {
    ...event,
    on: event.on.type === 'CLICK' || event.on.type === 'CHANGE' ? { ...event.on, field: swap(event.on.field) } : event.on,
    ...(event.when ? { when: renameInWhen(event.when, from, to) } : {}),
    do: event.do.map((a) => {
      if (a.type === 'SET_VALUE') return { ...a, target: swap(a.target), value: renameExpressionField(a.value, from, to) };
      if (a.type === 'GO_TO_STEP') return { ...a, step: swap(a.step) };
      if (a.type !== 'FETCH') return a;
      const source = a.source.params ? { ...a.source, params: renameInParams(a.source.params, from, to) } : a.source;
      return { ...a, source, set: Object.fromEntries(Object.entries(a.set).map(([name, path]) => [swap(name), path])) };
    }),
  };
}

function renameInRule(rule: FormRule, from: string, to: string): FormRule {
  const action = (a: RuleAction): RuleAction => {
    const target = a.target === from ? to : a.target;
    return a.type === 'SET_VALUE' ? { ...a, target, value: renameExpressionField(a.value, from, to) } : { ...a, target };
  };
  const when = !rule.when
    ? undefined
    : isExpressionCondition(rule.when)
      ? { expr: renameExpressionField(rule.when.expr, from, to) }
      : renameInCondition(rule.when, from, to);
  return { ...rule, ...(when ? { when } : {}), then: rule.then.map(action), ...(rule.else ? { else: rule.else.map(action) } : {}) };
}

/**
 * Renaming a field's `name` would silently break every rule, dependency and
 * mapping that points at it - so rewrite those references too.
 */
export function renameFieldReferences(def: FormDefinition, from: string, to: string): FormDefinition {
  const fields = def.fields.map((f): FormField => {
    const next = { ...f };
    if (f.visibility) next.visibility = { when: renameInCondition(f.visibility.when, from, to) };
    if (f.requiredWhen) next.requiredWhen = renameInCondition(f.requiredWhen, from, to);
    if (f.dependency) {
      next.dependency = { ...f.dependency, dependsOn: f.dependency.dependsOn.map((d) => (d === from ? to : d)) };
    }
    if (f.dataSource?.api?.params) {
      const params = Object.fromEntries(
        Object.entries(f.dataSource.api.params).map(([k, v]) => [k, v.split(`{{${from}}}`).join(`{{${to}}}`)]),
      );
      next.dataSource = { ...f.dataSource, api: { ...f.dataSource.api, params } };
    }
    return next;
  });

  const mapping = def.submission.mapping;
  const submission =
    mapping && from in mapping
      ? {
          ...def.submission,
          mapping: Object.fromEntries(Object.entries(mapping).map(([k, v]) => [k === from ? to : k, v])),
        }
      : def.submission;

  return {
    ...def,
    fields,
    submission,
    ...(def.rules ? { rules: def.rules.map((r) => renameInRule(r, from, to)) } : {}),
    ...(def.events ? { events: def.events.map((e) => renameInEvent(e, from, to)) } : {}),
  };
}

export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, moved);
  return next;
}

/** Other fields whose rules or dependencies read `name` - shown before deleting a field. */
export function fieldsReferencing(def: FormDefinition, name: string): FormField[] {
  const mentions = (cond: Condition | undefined): boolean => {
    if (!cond) return false;
    if ('all' in cond) return cond.all.some(mentions);
    if ('any' in cond) return cond.any.some(mentions);
    return cond.field === name;
  };
  return def.fields.filter(
    (f) =>
      f.name !== name &&
      (mentions(f.visibility?.when) || mentions(f.requiredWhen) || !!f.dependency?.dependsOn.includes(name)),
  );
}

/** Form rules that read or act on `name` - shown before deleting a field. */
export function rulesReferencing(def: FormDefinition, name: string): FormRule[] {
  const reads = (rule: FormRule) =>
    !rule.when ? [] : isExpressionCondition(rule.when) ? expressionFields(rule.when.expr) : conditionFields(rule.when);
  return (def.rules ?? []).filter(
    (rule) =>
      reads(rule).includes(name) ||
      [...rule.then, ...(rule.else ?? [])].some((a) => a.target === name || (a.type === 'SET_VALUE' && expressionFields(a.value).includes(name))),
  );
}

// ── Layout edits ─────────────────────────────────────────────────────────────
// Fields stay one flat list; these keep parentId/column and the flat order
// consistent so a slot's children appear in the order the designer arranged.

/** Where to put a field: a container slot (or root), optionally before a sibling. */
export interface Placement {
  parentId?: string;
  column?: number;
  beforeId?: string;
}

const isInside = (fields: FormField[], id: string, containerId: string) =>
  id === containerId || descendantFields(fields, containerId).some((f) => f.id === id);

/**
 * Put `field` (new, or already in the list) at `place`. A container can't be
 * dropped into itself or its own contents - that's a no-op.
 */
export function placeField(fields: FormField[], field: FormField, place: Placement): FormField[] {
  if (place.parentId && isInside(fields, place.parentId, field.id)) return fields;
  const moved: FormField = { ...field, parentId: place.parentId, column: place.parentId ? place.column ?? 0 : undefined };
  if (!moved.parentId) {
    delete moved.parentId;
    delete moved.column;
  }
  const rest = fields.filter((f) => f.id !== field.id);

  let index = place.beforeId && place.beforeId !== field.id ? rest.findIndex((f) => f.id === place.beforeId) : -1;
  if (index < 0) {
    if (!place.parentId) index = rest.length;
    else {
      // End of a container slot: just after the container's last nested field (or the container itself).
      const block = new Set([place.parentId, ...descendantFields(rest, place.parentId).map((f) => f.id)]);
      const last = rest.reduce((acc, f, i) => (block.has(f.id) ? i : acc), -1);
      index = last + 1;
    }
  }
  return [...rest.slice(0, index), moved, ...rest.slice(index)];
}

/** Move a field up (-1) or down (+1) among the fields in the same slot. */
export function moveAmongSiblings(fields: FormField[], id: string, delta: -1 | 1): FormField[] {
  const index = buildLayoutIndex(fields);
  const field = index.byId.get(id);
  if (!field) return fields;
  const { parentId, column } = placement(field, index.byId);
  const siblings = childrenOf(index, parentId, column);
  const at = siblings.findIndex((f) => f.id === id);
  const target = at + delta;
  if (target < 0 || target >= siblings.length) return fields;
  const slot = { parentId: parentId === ROOT ? undefined : parentId, column };
  // Moving down = insert before the sibling after next (or at the end of the slot).
  const beforeId = delta < 0 ? siblings[target].id : siblings[target + 1]?.id;
  return placeField(fields, field, { ...slot, beforeId });
}

/** Remove a field. For a container, either delete what's inside or lift it out to the container's slot. */
export function removeField(fields: FormField[], id: string, keepChildren = false): FormField[] {
  const container = fields.find((f) => f.id === id);
  if (!container) return fields;
  if (!keepChildren) {
    const gone = new Set([id, ...descendantFields(fields, id).map((f) => f.id)]);
    return fields.filter((f) => !gone.has(f.id));
  }
  return fields
    .filter((f) => f.id !== id)
    .map((f) => {
      if (f.parentId !== id) return f;
      const lifted: FormField = { ...f, parentId: container.parentId, column: container.parentId ? container.column : undefined };
      if (!lifted.parentId) {
        delete lifted.parentId;
        delete lifted.column;
      }
      return lifted;
    });
}

/**
 * Copy a field - for a container, with everything inside it - right after the
 * original. Copies get new ids and unique names; rules inside the copy keep
 * pointing at the originals' names (the designer adjusts them).
 */
export function duplicateField(
  fields: FormField[],
  id: string,
  uniqueName: (base: string, taken: string[]) => string,
): { fields: FormField[]; copyId?: string } {
  const source = fields.find((f) => f.id === id);
  if (!source) return { fields };
  const subtree = [source, ...descendantFields(fields, id)];
  const taken = fields.map((f) => f.name);
  const newIds = new Map(subtree.map((f) => [f.id, crypto.randomUUID()]));
  const copies = subtree.map((f) => {
    const name = uniqueName(f.name.replace(/_\d+$/, ''), taken);
    taken.push(name);
    return {
      ...structuredClone(f),
      id: newIds.get(f.id)!,
      name,
      parentId: f.id === id ? f.parentId : newIds.get(f.parentId!) ?? f.parentId,
      label: f.id === id && f.label ? `${f.label} (copy)` : f.label,
    };
  });
  const lastIndex = fields.reduce((acc, f, i) => (subtree.some((s) => s.id === f.id) ? i : acc), -1);
  return { fields: [...fields.slice(0, lastIndex + 1), ...copies, ...fields.slice(lastIndex + 1)], copyId: copies[0].id };
}

/** Change a Columns block's layout; fields in columns that disappear move to the new last column. */
export function setColumnWeights(fields: FormField[], id: string, weights: number[]): FormField[] {
  const last = weights.length - 1;
  return fields.map((f) => {
    if (f.id === id) return { ...f, props: { ...f.props, columns: weights } };
    if (f.parentId === id && (f.column ?? 0) > last) return { ...f, column: last };
    return f;
  });
}
