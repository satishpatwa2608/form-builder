import { describe, expect, it } from 'vitest';
import { descendantsOf, fieldParents, paramReferences, resetChildren, resolveParams, validateFormDefinition } from '../src';
import { fixtureDefinitions } from './fixtures';
import type { FormField } from '../src/types';

const api = (params: Record<string, string>): FormField['dataSource'] => ({
  type: 'API',
  api: { url: '/x', method: 'GET', valueField: 'id', labelField: 'name', params },
});

describe('resolveParams', () => {
  it('substitutes field and system references', () => {
    const { params, unresolved } = resolveParams(
      { businessId: '{{business}}', org: '{{$system.ORG_ID}}', fixed: 'ACTIVE', mixed: 'b-{{ business }}' },
      { business: 'B1' },
      { orgId: 'O1' },
    );
    expect(params).toEqual({ businessId: 'B1', org: 'O1', fixed: 'ACTIVE', mixed: 'b-B1' });
    expect(unresolved).toEqual([]);
  });

  it('reports empty references instead of sending an empty filter', () => {
    const { unresolved } = resolveParams({ a: '{{business}}', b: '{{$system.USER_ID}}', c: '{{$system.NOPE}}' }, { business: '' }, {});
    expect(unresolved).toEqual(['business', '$system.USER_ID', '$system.NOPE']);
  });

  it('lists references', () => {
    expect(paramReferences({ a: '{{x}}', b: '{{$system.ORG_ID}} {{y}}' })).toEqual({ fields: ['x', 'y'], system: ['ORG_ID'] });
  });
});

describe('dependency chains', () => {
  const fields: FormField[] = [
    { id: '1', type: 'DROPDOWN', name: 'business', dataSource: api({}) },
    { id: '2', type: 'DROPDOWN', name: 'section', dataSource: api({ businessId: '{{business}}' }) },
    { id: '3', type: 'DROPDOWN', name: 'subSection', dataSource: api({ sectionId: '{{section}}' }) },
    { id: '4', type: 'TEXT', name: 'note', dependency: { dependsOn: ['business'] } },
    { id: '5', type: 'TEXT', name: 'keep', dependency: { dependsOn: ['business'], resetOnChange: false } },
  ];

  it('parents come from params and explicit dependsOn', () => {
    expect(fieldParents(fields[2])).toEqual(['section']);
    expect(fieldParents(fields[3])).toEqual(['business']);
  });

  it('descendants cascade nearest-first and skip resetOnChange: false', () => {
    const children = resetChildren(fields);
    expect(descendantsOf('business', children)).toEqual(['section', 'note', 'subSection']);
    expect(descendantsOf('section', children)).toEqual(['subSection']);
  });

  it('the validator rejects params that point at unknown fields or form a loop', () => {
    const base = fixtureDefinitions[0];
    const bad = {
      ...base,
      fields: [
        { id: 'a', type: 'DROPDOWN', name: 'a', label: 'A', dataSource: api({ p: '{{b}}' }) },
        { id: 'b', type: 'DROPDOWN', name: 'b', label: 'B', dataSource: api({ p: '{{a}}' }) },
        { id: 'c', type: 'DROPDOWN', name: 'c', label: 'C', dataSource: api({ p: '{{ghost}}' }) },
      ],
    };
    const result = validateFormDefinition(bad);
    const messages = result.success ? [] : result.issues.map((i) => i.message);
    expect(messages).toContain('API parameter refers to unknown field "ghost"');
    expect(messages.some((m) => m.startsWith('Dependencies loop'))).toBe(true);
  });
});
