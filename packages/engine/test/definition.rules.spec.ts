import { describe, expect, it } from 'vitest';
import { validateFormDefinition } from '../src';
import type { FormRule } from '../src/types';
import base from './fixtures/customer-complaint-basic.json';

const messages = (rules: unknown[], level: 'shape' | 'publish' = 'publish') => {
  const r = validateFormDefinition({ ...base, rules }, level);
  return r.success ? [] : r.issues.map((i) => `${i.path}: ${i.message}`);
};
const rule = (r: Partial<FormRule>): FormRule => ({ id: 'r1', then: [{ type: 'SHOW', target: 'productName' }], ...r });
const category = base.fields.find((f) => f.name === 'category')!.dataSource!.options![0].value;

describe('form rules in a definition', () => {
  it('accepts every kind of action', () => {
    expect(
      messages([
        rule({ id: 'a', when: { field: 'category', operator: 'isNotEmpty' }, then: [{ type: 'SHOW', target: 'productName' }], else: [{ type: 'HIDE', target: 'serialNumber' }] }),
        rule({ id: 'b', when: { expr: 'amountDisputed > 5000' }, then: [{ type: 'REQUIRE', target: 'description' }, { type: 'DISABLE', target: 'name' }, { type: 'ENABLE', target: 'email' }] }),
        rule({ id: 'c', then: [{ type: 'SET_VALUE', target: 'serialNumber', value: 'upper(productName)' }] }),
        rule({ id: 'd', when: { expr: 'incidentDate > today()' }, then: [{ type: 'ERROR', target: 'incidentDate', message: 'Cannot be in the future' }] }),
        rule({ id: 'e', when: { expr: 'contactMe' }, then: [{ type: 'SET_OPTIONS', target: 'category', values: [category] }] }),
      ]),
    ).toEqual([]);
  });

  it('a draft may hold a half-built rule, publishing may not', () => {
    const halfBuilt = [rule({ then: [{ type: 'SHOW', target: 'notAddedYet' }] })];
    expect(messages(halfBuilt, 'shape')).toEqual([]);
    expect(messages(halfBuilt)).toEqual(['rules.0.then.0: Acts on unknown field "notAddedYet"']);
  });

  it('rejects malformed rules outright', () => {
    expect(messages([{ id: 'x', then: [] }], 'shape')).not.toEqual([]);
    expect(messages([{ id: 'x', then: [{ type: 'EXPLODE', target: 'name' }] }], 'shape')).not.toEqual([]);
    expect(messages([rule({ then: [{ type: 'SET_VALUE', target: 'name', value: 'a'.repeat(1001) }] })], 'shape')).not.toEqual([]);
    expect(messages(Array.from({ length: 101 }, (_, i) => rule({ id: `r${i}` })), 'shape')).not.toEqual([]);
  });

  it('checks ids, conditions and expressions', () => {
    expect(messages([rule({}), rule({})])).toContain('rules.1.id: Duplicate rule id "r1"');
    expect(messages([rule({ when: { field: 'ghost', operator: 'isEmpty' } })])).toContain('rules.0.when: Refers to unknown field "ghost"');
    expect(messages([rule({ when: { expr: 'ghost > 1' } })])).toContain('rules.0.when: Refers to unknown field "ghost"');
    expect(messages([rule({ when: { expr: 'amountDisputed >' } })])).toContain('rules.0.when: Expression is incomplete');
    expect(messages([rule({ then: [{ type: 'SET_VALUE', target: 'name', value: 'launch(1)' }] })])).toContain(
      'rules.0.then.0: Unknown function "launch"',
    );
    expect(messages([rule({ else: [{ type: 'HIDE', target: 'name' }] })])).toContain(
      'rules.0.else: A rule with no condition always holds, so "otherwise" never happens',
    );
  });

  it('checks each action fits its target', () => {
    const one = (action: FormRule['then'][number]) => messages([rule({ then: [action] })]);
    expect(one({ type: 'REQUIRE', target: 'businessId' })).toEqual(['rules.0.then.0: "businessId" is not a field people fill in']);
    expect(one({ type: 'SET_VALUE', target: 'businessId', value: '1' })).toEqual([
      'rules.0.then.0: "businessId" already takes its value from the system',
    ]);
    expect(one({ type: 'SET_OPTIONS', target: 'name', values: ['x'] })).toEqual(['rules.0.then.0: "name" has no fixed option list to narrow']);
    expect(one({ type: 'SET_OPTIONS', target: 'category', values: ['NOPE'] })).toEqual(['rules.0.then.0: "NOPE" is not an option of "category"']);
  });

  it('rejects loops', () => {
    expect(messages([rule({ then: [{ type: 'SET_VALUE', target: 'amountDisputed', value: 'amountDisputed + 1' }] })])).toContain(
      'rules: Calculations loop: amountDisputed -> amountDisputed',
    );
    expect(
      messages([
        rule({ id: 'a', then: [{ type: 'SET_VALUE', target: 'name', value: 'productName' }] }),
        rule({ id: 'b', when: { expr: 'name == "x"' }, then: [{ type: 'SET_VALUE', target: 'productName', value: '"y"' }] }),
      ]),
    ).toContain('rules: Calculations loop: name -> productName -> name');
    expect(messages([rule({ when: { expr: 'productName == "x"' }, then: [{ type: 'HIDE', target: 'productName' }] })])).toContain(
      'rules.0.then.0: "productName" cannot be shown or hidden by its own value',
    );
    expect(
      messages([
        rule({ id: 'a', when: { expr: 'name == "x"' }, then: [{ type: 'SHOW', target: 'productName' }] }),
        rule({ id: 'b', when: { expr: 'productName == "x"' }, then: [{ type: 'SHOW', target: 'name' }] }),
      ]),
    ).toContain('rules: Visibility rules loop: productName -> name -> productName');
  });
});
