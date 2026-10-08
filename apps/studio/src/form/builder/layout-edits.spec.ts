import { beforeEach, describe, expect, it } from 'vitest';
import { duplicateField, moveAmongSiblings, placeField, removeField, setColumnWeights } from './definition-edits';
import { uniqueFieldName } from './field-catalog';
import { useFormBuilderStore } from './store/useFormBuilderStore';
import { createBlankForm } from './blank-form';
import { buildLayoutIndex, childrenOf, ROOT } from '../engine';
import type { FormField } from '../types';

const f = (id: string, extra: Partial<FormField> = {}): FormField => ({ id, name: id, type: 'TEXT', label: id, ...extra });
const cols = (id: string): FormField => ({ id, name: id, type: 'COLUMNS', props: { columns: [1, 1] } });
const slot = (fields: FormField[], parentId = ROOT, column = 0) => childrenOf(buildLayoutIndex(fields), parentId, column).map((x) => x.id);

describe('layout edits', () => {
  const base = [f('a'), cols('c'), f('x', { parentId: 'c', column: 0 }), f('y', { parentId: 'c', column: 1 }), f('b')];

  it('places a field at the end of a column, or before a sibling', () => {
    const next = placeField(base, f('a'), { parentId: 'c', column: 1 });
    expect(slot(next)).toEqual(['c', 'b']);
    expect(slot(next, 'c', 1)).toEqual(['y', 'a']);
    const before = placeField(base, f('b'), { parentId: 'c', column: 0, beforeId: 'x' });
    expect(slot(before, 'c', 0)).toEqual(['b', 'x']);
  });

  it('moves a field back out to the top level', () => {
    const next = placeField(base, base[2], { beforeId: 'b' });
    expect(slot(next)).toEqual(['a', 'c', 'x', 'b']);
    expect(next.find((x) => x.id === 'x')).not.toHaveProperty('parentId');
  });

  it('refuses to drop a container into itself', () => {
    expect(placeField(base, base[1], { parentId: 'c', column: 0 })).toBe(base);
  });

  it('moves among siblings only', () => {
    const withTwo = placeField(base, f('z'), { parentId: 'c', column: 0 });
    expect(slot(moveAmongSiblings(withTwo, 'z', -1), 'c', 0)).toEqual(['z', 'x']);
    expect(moveAmongSiblings(withTwo, 'x', -1)).toBe(withTwo);
    expect(slot(moveAmongSiblings(base, 'a', 1))).toEqual(['c', 'a', 'b']);
  });

  it('removes a container with its fields, or lifts them out', () => {
    expect(removeField(base, 'c').map((x) => x.id)).toEqual(['a', 'b']);
    const kept = removeField(base, 'c', true);
    expect(slot(kept)).toEqual(['a', 'x', 'y', 'b']);
  });

  it('duplicates a container with everything inside, re-linking children', () => {
    const { fields, copyId } = duplicateField(base, 'c', uniqueFieldName);
    const copy = fields.find((x) => x.id === copyId)!;
    expect(copy.type).toBe('COLUMNS');
    expect(slot(fields, copyId!, 0)).toHaveLength(1);
    expect(slot(fields, copyId!, 1)).toHaveLength(1);
    expect(new Set(fields.map((x) => x.name)).size).toBe(fields.length);
  });

  it('shrinking columns moves fields from removed columns into the last one', () => {
    const three = setColumnWeights(base, 'c', [1, 1, 1]);
    const moved = placeField(three, three[3], { parentId: 'c', column: 2 });
    const back = setColumnWeights(moved, 'c', [2, 1]);
    expect(slot(back, 'c', 1)).toEqual(['y']);
    expect(back.find((x) => x.id === 'c')!.props!.columns).toEqual([2, 1]);
  });
});

describe('store: layout actions', () => {
  const s = () => useFormBuilderStore.getState();
  beforeEach(() =>
    s().load(createBlankForm({ name: 'T', code: 'T', businessId: 'B', access: 'PUBLIC' }, { orgId: 'O', uuid: 'u' })),
  );

  it('adds into a column, moves out, and undoes', () => {
    const c = s().addField('COLUMNS');
    const t = s().addField('TEXT', { parentId: c, column: 1 });
    expect(slot(s().form!.fields, c, 1)).toEqual([t]);
    s().moveField(t, {});
    expect(slot(s().form!.fields)).toEqual([c, t]);
    s().undo();
    expect(slot(s().form!.fields, c, 1)).toEqual([t]);
  });

  it('deleting a container keeps or drops its fields', () => {
    const c = s().addField('SECTION');
    s().addField('TEXT', { parentId: c });
    s().removeField(c, true);
    expect(s().form!.fields.map((x) => x.type)).toEqual(['TEXT']);
  });
});
