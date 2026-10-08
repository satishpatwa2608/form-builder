import { describe, expect, it } from 'vitest';
import { findCycle, FormDefinitionError, parseFormDefinition, validateFormDefinition } from '../src';
import customerComplaint from './fixtures/customer-complaint.json';
import customerComplaintBasic from './fixtures/customer-complaint-basic.json';
import type { FormField } from '../src/types';

const base = customerComplaintBasic;
const withFields = (fields: Partial<FormField>[]) => ({ ...base, fields });
const messages = (input: unknown) => {
  const r = validateFormDefinition(input);
  return r.success ? [] : r.issues.map((i) => i.message);
};

describe('formDefinitionSchema', () => {
  it('accepts both fixtures', () => {
    expect(() => parseFormDefinition(customerComplaint)).not.toThrow();
    expect(() => parseFormDefinition(customerComplaintBasic)).not.toThrow();
  });

  it('rejects unknown field types and bad names', () => {
    expect(messages(withFields([{ id: 'a', type: 'SLIDER' as never, name: 'a' }]))).not.toEqual([]);
    expect(messages(withFields([{ id: 'a', type: 'TEXT', name: '1st name' }]))).toContain(
      'Field name must be letters, digits or _, not starting with a digit',
    );
  });

  it('rejects duplicate names and ids', () => {
    const m = messages(
      withFields([
        { id: 'a', type: 'TEXT', name: 'x' },
        { id: 'a', type: 'TEXT', name: 'x' },
      ]),
    );
    expect(m).toContain('Duplicate field id "a"');
    expect(m).toContain('Duplicate field name "x"');
  });

  it('rejects rules that point at unknown fields or at themselves', () => {
    const m = messages(
      withFields([
        { id: 'a', type: 'TEXT', name: 'a', visibility: { when: { field: 'ghost', operator: 'isEmpty' } } },
        { id: 'b', type: 'TEXT', name: 'b', requiredWhen: { field: 'b', operator: 'isEmpty' } },
        { id: 'c', type: 'TEXT', name: 'c', dependency: { dependsOn: ['nope'] } },
      ]),
    );
    expect(m).toContain('Refers to unknown field "ghost"');
    expect(m).toContain('"b" cannot refer to itself');
    expect(m).toContain('Depends on unknown field "nope"');
  });

  it('rejects visibility and dependency loops', () => {
    const m = messages(
      withFields([
        { id: 'a', type: 'TEXT', name: 'a', visibility: { when: { field: 'b', operator: 'isEmpty' } }, dependency: { dependsOn: ['b'] } },
        { id: 'b', type: 'TEXT', name: 'b', visibility: { when: { field: 'a', operator: 'isEmpty' } }, dependency: { dependsOn: ['a'] } },
      ]),
    );
    expect(m.some((x) => x.startsWith('Visibility rules loop'))).toBe(true);
    expect(m.some((x) => x.startsWith('Dependencies loop'))).toBe(true);
  });

  it('requires a data source for option fields', () => {
    expect(messages(withFields([{ id: 'a', type: 'DROPDOWN', name: 'a' }]))).toContain(
      'DROPDOWN field "a" needs a data source',
    );
    expect(
      messages(withFields([{ id: 'a', type: 'RADIO', name: 'a', dataSource: { type: 'STATIC', options: [] } }])),
    ).toContain('Static data source has no options');
  });

  it('checks system fields, patterns and ranges', () => {
    const m = messages(
      withFields([
        { id: 'a', type: 'HIDDEN', name: 'a', systemSource: 'URL_PARAMETER' },
        { id: 'b', type: 'TEXT', name: 'b', systemSource: 'ORG_ID' },
        { id: 'c', type: 'TEXT', name: 'c', validation: { pattern: '([' } },
        { id: 'd', type: 'TEXT', name: 'd', validation: { minLength: 10, maxLength: 5 } },
      ]),
    );
    expect(m).toContain('URL_PARAMETER needs systemParam (the query-string key)');
    expect(m).toContain('Only HIDDEN fields take a systemSource');
    expect(m).toContain('Invalid pattern: ([');
    expect(m).toContain('minLength is greater than maxLength');
  });

  it('a CAPTCHA field needs captcha config', () => {
    const { captcha: _omit, ...noCaptcha } = customerComplaint;
    expect(messages(noCaptcha)).toContain('CAPTCHA field present but captcha is not configured');
  });

  it('parseFormDefinition throws a readable error listing every issue', () => {
    try {
      parseFormDefinition({ ...base, code: 'lower case' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FormDefinitionError);
      expect((e as Error).message).toContain('code: Form code must be UPPER_SNAKE_CASE');
    }
  });
});

describe('findCycle', () => {
  it('finds a cycle and returns null for a DAG', () => {
    expect(findCycle(new Map([['a', ['b']], ['b', ['c']], ['c', []]]))).toBeNull();
    expect(findCycle(new Map([['a', ['b']], ['b', ['c']], ['c', ['a']]]))).toEqual(['a', 'b', 'c', 'a']);
  });
});
