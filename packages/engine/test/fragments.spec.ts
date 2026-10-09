import { describe, expect, it } from 'vitest';
import { descendants, extractFragment, fragmentCopy, fragmentProblems, fragmentSectionOf, fragmentUse, fragmentUseProblems, syncFragments, validateFormDefinition } from '../src';
import type { FormField, Fragment } from '../src';
import base from './fixtures/customer-complaint-basic.json';

const states = [
  { label: 'Maharashtra', value: 'MH' },
  { label: 'Kerala', value: 'KL' },
];
const address: Fragment = {
  id: 'frag-address',
  name: 'Address',
  fields: [
    { id: 'cols', type: 'COLUMNS', name: 'cols', props: { columns: 2 } },
    { id: 'line1', type: 'TEXT', name: 'line1', label: 'Address line', required: true, parentId: 'cols', column: 0 },
    { id: 'state', type: 'DROPDOWN', name: 'state', label: 'State', parentId: 'cols', column: 1, dataSource: { type: 'STATIC', options: states } },
    { id: 'city', type: 'DROPDOWN', name: 'city', label: 'City', dependency: { dependsOn: ['state'] }, dataSource: { type: 'API', api: { url: '/connectors/abcd1234/cities', method: 'GET', valueField: 'id', labelField: 'name', params: { state: '{{state}}', org: '{{$system.ORG_ID}}' } } } },
    { id: 'pin', type: 'TEXT', name: 'pin', label: 'PIN code', requiredWhen: { field: 'state', operator: 'equals', value: 'MH' }, visibility: { when: { all: [{ field: 'line1', operator: 'isNotEmpty' }] } } },
  ],
};
const section = (id: string, prefix?: string): FormField => ({ id, type: 'SECTION', name: id, label: 'Address', props: { fragment: { id: 'frag-address', ...(prefix ? { prefix } : {}) } } });
const text = (name: string): FormField => ({ id: name, type: 'TEXT', name, label: name });

describe('A fragment on a form', () => {
  it('is an ordinary section that remembers which fragment it copies', () => {
    expect(fragmentUse(section('s1'))).toEqual({ id: 'frag-address' });
    expect(fragmentUse(section('s1', 'billing'))).toEqual({ id: 'frag-address', prefix: 'billing' });
    expect(fragmentUse({ type: 'SECTION', props: {} })).toBeNull();
    expect(fragmentUse({ type: 'TEXT', props: { fragment: { id: 'x' } } })).toBeNull();
    expect(fragmentUse({ type: 'SECTION', props: { fragment: 'frag-address' } })).toBeNull();
  });

  it('gets a copy of the fragment\'s fields, laid out as in the library', () => {
    const copy = fragmentCopy(section('s1'), address);
    expect(copy.map((f) => f.name)).toEqual(['cols', 'line1', 'state', 'city', 'pin']);
    const byName = Object.fromEntries(copy.map((f) => [f.name, f]));
    expect(byName.cols.parentId).toBe('s1');
    expect(byName.line1.parentId).toBe(byName.cols.id);
    expect(byName.line1.column).toBe(0);
    expect(byName.city.parentId).toBe('s1');
    // Ids are new, short enough for a field, and the same every time for the same section.
    expect(new Set(copy.map((f) => f.id)).size).toBe(5);
    expect(copy.every((f) => /^fr_[0-9a-f]{16}$/.test(f.id))).toBe(true);
    expect(fragmentCopy(section('s1'), address).map((f) => f.id)).toEqual(copy.map((f) => f.id));
    expect(fragmentCopy(section('s2'), address).map((f) => f.id)).not.toEqual(copy.map((f) => f.id));
  });

  it('with a prefix, names its fields for that section and keeps them pointing at each other', () => {
    const byName = Object.fromEntries(fragmentCopy(section('s1', 'billing'), address).map((f) => [f.name, f]));
    expect(Object.keys(byName)).toEqual(['billing_cols', 'billing_line1', 'billing_state', 'billing_city', 'billing_pin']);
    expect(byName.billing_city.dependency).toEqual({ dependsOn: ['billing_state'] });
    // The answer of another field is renamed; a system value is not.
    expect(byName.billing_city.dataSource!.api!.params).toEqual({ state: '{{billing_state}}', org: '{{$system.ORG_ID}}' });
    expect(byName.billing_pin.requiredWhen).toEqual({ field: 'billing_state', operator: 'equals', value: 'MH' });
    expect(byName.billing_pin.visibility).toEqual({ when: { all: [{ field: 'billing_line1', operator: 'isNotEmpty' }] } });
    expect(address.fields[3].dependency).toEqual({ dependsOn: ['state'] });
  });

  it('used twice with different prefixes makes a form that can be published', () => {
    const fields = [text('customer'), section('s1', 'billing'), section('s2', 'shipping')];
    const { definition, changed, missing } = syncFragments({ ...base, fields }, [address]);
    expect(changed).toBe(true);
    expect(missing).toEqual([]);
    expect(definition.fields.map((f) => f.name)).toEqual([
      'customer',
      's1', 'billing_cols', 'billing_line1', 'billing_state', 'billing_city', 'billing_pin',
      's2', 'shipping_cols', 'shipping_line1', 'shipping_state', 'shipping_city', 'shipping_pin',
    ]);
    const result = validateFormDefinition(definition, 'publish');
    expect(result.success ? [] : result.issues).toEqual([]);
    expect(fragmentUseProblems(definition.fields)).toEqual([]);
  });
});

describe('Keeping forms in step with the library', () => {
  const form = () => syncFragments({ fields: [text('customer'), section('s1'), text('notes')] }, [address]).definition;

  it('a change to the fragment replaces the section\'s fields and nothing else', () => {
    const changed: Fragment = { ...address, fields: [...address.fields.filter((f) => f.name !== 'pin'), { id: 'country', type: 'TEXT', name: 'country', label: 'Country' }] };
    const next = syncFragments(form(), [changed]);
    expect(next.changed).toBe(true);
    expect(next.definition.fields.map((f) => f.name)).toEqual(['customer', 's1', 'cols', 'line1', 'state', 'city', 'country', 'notes']);
    // Fields that stayed keep their ids, so nothing that points at them moves.
    const idOf = (fields: FormField[], name: string) => fields.find((f) => f.name === name)!.id;
    expect(idOf(next.definition.fields, 'city')).toBe(idOf(form().fields, 'city'));
  });

  it('says nothing changed when nothing did, and returns the very same form', () => {
    const current = form();
    const again = syncFragments(current, [address]);
    expect(again.changed).toBe(false);
    expect(again.definition).toBe(current);
  });

  it('a section whose fragment has left the library keeps what it has and is reported', () => {
    const current = form();
    const result = syncFragments(current, []);
    expect(result.missing.map((s) => s.id)).toEqual(['s1']);
    expect(result.definition.fields).toEqual(current.fields);
  });

  it('finds the fields inside a section, and the fragment a field belongs to', () => {
    const fields = form().fields;
    expect(descendants(fields, 's1').map((f) => f.name)).toEqual(['cols', 'line1', 'state', 'city', 'pin']);
    expect(fragmentSectionOf(fields, fields.find((f) => f.name === 'line1')!.id)?.id).toBe('s1');
    expect(fragmentSectionOf(fields, 'customer')).toBeNull();
    expect(fragmentSectionOf(fields, 's1')).toBeNull();
  });
});

describe('Putting a section into the library', () => {
  it('takes what the section holds, without its prefix, ready to be copied elsewhere', () => {
    const { definition } = syncFragments({ fields: [section('s1', 'billing')] }, [address]);
    const extracted = extractFragment(definition.fields, 's1');
    expect(extracted.map((f) => f.name)).toEqual(['cols', 'line1', 'state', 'city', 'pin']);
    expect(extracted.find((f) => f.name === 'cols')!.parentId).toBeUndefined();
    expect(extracted.find((f) => f.name === 'line1')!.parentId).toBe(extracted.find((f) => f.name === 'cols')!.id);
    expect(extracted.find((f) => f.name === 'city')!.dependency).toEqual({ dependsOn: ['state'] });
    expect(fragmentProblems(extracted)).toEqual([]);
    // Round trip: what was extracted makes the same section again.
    expect(fragmentCopy(section('s9', 'billing'), { ...address, fields: extracted }).map((f) => f.name)).toEqual(definition.fields.slice(1).map((f) => f.name));
  });

  it('refuses what cannot stand on its own', () => {
    expect(fragmentProblems([])).toEqual(['A fragment needs at least one field']);
    expect(fragmentProblems([{ id: 'h', type: 'HTML', name: 'h' }])).toEqual(['A fragment needs at least one field']);
    expect(fragmentProblems([text('a'), { id: 'c', type: 'CAPTCHA', name: 'captchaToken' }])).toEqual(['A CAPTCHA belongs to the form, not to a fragment']);
    expect(fragmentProblems([text('a'), section('inner')])).toEqual(['"Address" is itself a fragment; a fragment cannot hold another']);
    expect(fragmentProblems([{ ...text('pin'), requiredWhen: { field: 'country', operator: 'equals', value: 'IN' } }])).toEqual(['"pin" depends on "country", which is not part of the fragment']);
    expect(fragmentProblems([{ ...text('pin'), visibility: { when: { field: '$user.role', operator: 'equals', value: 'x' } } }])).toEqual([]);
  });
});

describe('What stops a form with fragments from being published', () => {
  it('the same fragment twice without telling them apart', () => {
    expect(fragmentUseProblems([section('s1'), section('s2')])).toEqual(['"Address" is used more than once on this form. Give each one a different prefix so their answers are kept apart.']);
    expect(fragmentUseProblems([section('s1', 'a'), section('s2', 'a')])).toHaveLength(1);
    expect(fragmentUseProblems([section('s1'), section('s2', 'shipping')])).toEqual([]);
  });
  it('a prefix that cannot be part of a field name', () => {
    const bad = { ...section('s1'), props: { fragment: { id: 'frag-address', prefix: 'bill to' } } };
    expect(fragmentUseProblems([bad])).toEqual(['The prefix of "Address" must be letters and digits, starting with a letter']);
  });
});
