import { describe, expect, it } from 'vitest';
import { publicCopy, tableChanges, validateFormDefinition, withTableFields, type FormDefinition } from '../src';
import base from './fixtures/customer-complaint-basic.json';

const form = (fields: FormDefinition['fields'], startedFrom?: FormDefinition['startedFrom']) => ({ ...(base as unknown as FormDefinition), fields, startedFrom });
const text = (name: string) => ({ id: name, type: 'TEXT' as const, name, label: name });

describe('a form started from a table, when the table gains columns', () => {
  it('says nothing while the form asks for every column', () => {
    expect(tableChanges(form([text('name'), text('email')]), ['name', 'email'])).toEqual({ added: [], columns: [] });
  });

  it('offers a field for each new column, of the kind its name suggests, with an id of its own', () => {
    const def = form([text('name'), { ...text('phone'), id: 'email' }]);
    const changes = tableChanges(def, ['name', 'phone', 'email', 'amount']);
    expect(changes.columns).toEqual(['email', 'amount']);
    expect(changes.added.map((f) => [f.name, f.type])).toEqual([['email', 'EMAIL'], ['amount', 'NUMBER']]);
    // "email" was already an id in the form (of another field): the new field does not take it.
    expect(new Set([...def.fields, ...changes.added].map((f) => f.id)).size).toBe(4);
    const next = withTableFields(def, changes);
    expect(next.fields.map((f) => f.name)).toEqual(['name', 'phone', 'email', 'amount']);
    expect(validateFormDefinition(next, 'shape').success).toBe(true);
    // Once added there is nothing more to offer.
    expect(tableChanges(next, ['name', 'phone', 'email', 'amount']).columns).toEqual([]);
  });

  it('does not ask again about columns the designer left out, and a column removed from the table takes nothing from the form', () => {
    const def = form([text('name'), text('legacy')], { table: 'c1/leads', name: 'CRM · Leads', leftOut: ['internal_score'] });
    expect(tableChanges(def, ['name', 'internal_score', 'city']).columns).toEqual(['city']);
    expect(withTableFields(def, tableChanges(def, ['name'])).fields.map((f) => f.name)).toEqual(['name', 'legacy']);
  });

  it('where a form came from is kept with the form and not given to the public', () => {
    const def = form([text('name')], { table: 'c1/leads', name: 'CRM · Leads' });
    expect(validateFormDefinition(def, 'shape').success).toBe(true);
    expect(publicCopy(def)).not.toHaveProperty('startedFrom');
  });
});
