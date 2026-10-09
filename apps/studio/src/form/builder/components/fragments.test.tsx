import { beforeEach, describe, expect, it } from 'vitest';
import type { FormDefinition, FormField } from '../../types';
import { fragmentUse, syncFragments, type Fragment } from '../../engine';
import { publishIssues } from '../publish-issues';
import { useFormBuilderStore } from '../store/useFormBuilderStore';
import { addFragmentSection, nextPrefix } from './FragmentSettings';

const address: Fragment = {
  id: 'frag-address',
  name: 'Postal address',
  fields: [
    { id: 'line1', type: 'TEXT', name: 'line1', label: 'Address line', required: true },
    { id: 'city', type: 'TEXT', name: 'city', label: 'City' },
  ],
};
const section = (id: string): FormField => ({ id, type: 'SECTION', name: id, label: 'Section' });
const form = (fields: FormField[]): FormDefinition => ({
  id: 'f1',
  orgId: 'o1',
  businessId: '',
  name: 'Order',
  code: 'ORDER',
  version: 1,
  status: 'DRAFT',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields,
  createdBy: 'u',
  updatedBy: 'u',
});
const names = (fields: FormField[]) => fields.map((f) => f.name);

describe('Adding a fragment to a form', () => {
  it('adds a section named after it, holding a copy of its fields', () => {
    const fields = addFragmentSection(form([{ id: 'who', type: 'TEXT', name: 'customer', label: 'Customer' }]), address, section('s1'));
    expect(names(fields)).toEqual(['customer', 's1', 'line1', 'city']);
    expect(fields[1]).toMatchObject({ label: 'Postal address', props: { fragment: { id: 'frag-address' } } });
    expect(fields[2].parentId).toBe('s1');
  });

  it('a second copy is given a prefix straight away, so the two never share a field key', () => {
    const once = form(addFragmentSection(form([]), address, section('s1')));
    const twice = addFragmentSection(once, address, section('s2'));
    expect(names(twice)).toEqual(['s1', 'line1', 'city', 's2', 'postalAddress2_line1', 'postalAddress2_city']);
    const thrice = addFragmentSection(form(twice), address, section('s3'));
    expect(fragmentUse(thrice.find((f) => f.id === 's3')!)?.prefix).toBe('postalAddress3');
    expect(publishIssues(form(thrice), undefined, [address])).toEqual([]);
  });

  it('makes a usable prefix out of any name', () => {
    expect(nextPrefix('Bank details', new Set(['']))).toBe('bankDetails2');
    expect(nextPrefix('Bank details', new Set(['', 'bankDetails2']))).toBe('bankDetails3');
    expect(nextPrefix('2nd address!', new Set())).toBe('ndAddress2');
    expect(nextPrefix('***', new Set())).toBe('copy2');
    expect(nextPrefix('A very long fragment name indeed', new Set()).length).toBeLessThanOrEqual(20);
  });
});

describe('Fields inside a fragment section', () => {
  const store = () => useFormBuilderStore.getState();
  const child = (name: string) => store().form!.fields.find((f) => f.name === name)!;
  beforeEach(() => {
    const fields = addFragmentSection(form([{ id: 'who', type: 'TEXT', name: 'customer', label: 'Customer' }]), address, section('s1'));
    store().load(form(fields));
  });

  it('are the library\'s: on the form they cannot be changed, moved, copied, removed or added to', () => {
    const before = store().form!.fields;
    store().updateField(child('line1').id, { label: 'Changed' });
    store().replaceField({ ...child('line1'), label: 'Changed' });
    store().removeField(child('city').id);
    store().duplicateField(child('city').id);
    store().moveSibling(child('city').id, -1);
    store().moveField(child('city').id, { parentId: undefined, index: 0 } as never);
    store().addField('TEXT', { parentId: 's1', index: 0 } as never);
    store().moveField('who', { parentId: 's1', index: 0 } as never);
    expect(store().form!.fields).toEqual(before);
    expect(store().isDirty).toBe(false);
  });

  it('the section itself is the form\'s: it can be renamed, moved and removed with what it holds', () => {
    store().updateField('s1', { label: 'Delivery address' });
    expect(child('s1').label).toBe('Delivery address');
    store().removeField('s1');
    expect(names(store().form!.fields)).toEqual(['customer']);
  });

  it('while an admin is changing the fragment here, its fields can be edited; loading another form locks again', () => {
    store().unlockFragment('s1');
    store().updateField(child('city').id, { label: 'Town or city' });
    expect(child('city').label).toBe('Town or city');
    store().addField('TEXT', { parentId: 's1', index: 2 } as never);
    expect(store().form!.fields.filter((f) => f.parentId === 's1')).toHaveLength(3);
    store().load(store().form!);
    expect(store().unlockedFragment).toBeUndefined();
    store().updateField(child('city').id, { label: 'Locked again' });
    expect(child('city').label).toBe('Town or city');
  });
});

describe('Publish checks with fragments', () => {
  const twice = (): FormField[] => [
    { ...section('s1'), label: 'Bill to', props: { fragment: { id: 'frag-address' } } },
    { ...section('s2'), label: 'Ship to', props: { fragment: { id: 'frag-address' } } },
  ];
  it('the same fragment twice must be told apart, said once per section in words', () => {
    expect(publishIssues(form(twice()), undefined, [address]).map((i) => i.message)).toEqual([
      '"Bill to" is used more than once on this form. Give each one a different prefix so their answers are kept apart.',
      '"Ship to" is used more than once on this form. Give each one a different prefix so their answers are kept apart.',
    ]);
  });
  it('a section whose fragment has left the library points at the section and says what to do', () => {
    const fields = syncFragments({ fields: [{ ...section('s1'), label: 'Delivery', props: { fragment: { id: 'frag-address' } } }] }, [address]).definition.fields;
    expect(publishIssues(form(fields), undefined, [])).toEqual([
      { message: 'The fragment "Delivery" is no longer in the library. Detach the section to keep its fields, or remove it.', fieldId: 's1', fieldLabel: 'Delivery' },
    ]);
    // Before the library has loaded nothing is claimed, and with it present the form is fine.
    expect(publishIssues(form(fields))).toEqual([]);
    expect(publishIssues(form(fields), undefined, [address])).toEqual([]);
  });
});
