import { describe, expect, it } from 'vitest';
import { fieldsFromCsv, fieldsFromEntity, fieldsFromJsonSchema, fieldsFromPdfFields, MAX_IMPORTED_FIELDS, parseCsv, validateFormDefinition } from '../src';
import type { FormField } from '../src/types';
import base from './fixtures/customer-complaint-basic.json';

/** The imported fields make a form that can be published as it is. */
const publishable = (fields: FormField[]) => {
  const result = validateFormDefinition({ ...base, fields });
  return result.success ? [] : result.issues.map((i) => `${i.path}: ${i.message}`);
};
const brief = (fields: FormField[]) => fields.map((f) => `${f.type} ${f.name}${f.required ? '*' : ''}${f.parentId ? ` in ${fields.find((p) => p.id === f.parentId)!.name}` : ''}`);

describe('a form from a JSON Schema', () => {
  const schema = {
    type: 'object',
    required: ['fullName', 'email', 'lines'],
    properties: {
      fullName: { type: 'string', title: 'Full name', minLength: 2, maxLength: 80 },
      email: { type: 'string', format: 'email', description: 'We reply here.' },
      dob: { type: 'string', format: 'date' },
      bio: { type: 'string', maxLength: 2000 },
      'postal-code': { type: 'string', pattern: '^[0-9]{6}$' },
      age: { type: 'integer', minimum: 18, maximum: 120 },
      newsletter: { type: 'boolean' },
      plan: { enum: ['FREE', 'TEAM', 'BUSINESS'] },
      country: { type: 'string', enum: ['IN', 'US', 'GB', 'DE', 'FR'] },
      interests: { type: 'array', items: { enum: ['A', 'B', 'C'] }, minItems: 1, maxItems: 2 },
      nickname: { type: ['string', 'null'] },
      address: { type: 'object', title: 'Address', description: 'Where to deliver', required: ['city'], properties: { street: { type: 'string' }, city: { type: 'string' } } },
      lines: {
        type: 'array',
        minItems: 1,
        maxItems: 500,
        items: { type: 'object', required: ['item'], properties: { item: { type: 'string' }, qty: { type: 'number' }, tags: { type: 'array', items: { type: 'object', properties: { t: { type: 'string' } } } } } },
      },
    },
  };

  it('makes a field for each property, with its type, limits and whether it is required', () => {
    const { fields, notes } = fieldsFromJsonSchema(schema);
    expect(brief(fields)).toEqual([
      'TEXT fullName*',
      'EMAIL email*',
      'DATE dob',
      'TEXTAREA bio',
      'TEXT postalCode',
      'NUMBER age',
      'CHECKBOX newsletter',
      'RADIO plan',
      'DROPDOWN country',
      'MULTI_SELECT interests',
      'TEXT nickname',
      'SECTION address',
      'TEXT street in address',
      'TEXT city* in address',
      'REPEAT lines',
      'TEXT item* in lines',
      'NUMBER qty in lines',
    ]);
    const by = (name: string) => fields.find((f) => f.name === name)!;
    expect(by('fullName')).toMatchObject({ label: 'Full name', validation: { minLength: 2, maxLength: 80 } });
    expect(by('email')).toMatchObject({ label: 'Email', helpText: 'We reply here.' });
    expect(by('postalCode')).toMatchObject({ label: 'Postal code', validation: { pattern: '^[0-9]{6}$' } });
    expect(by('age').validation).toEqual({ min: 18, max: 120 });
    expect(by('plan').dataSource?.options).toEqual([{ label: 'FREE', value: 'FREE' }, { label: 'TEAM', value: 'TEAM' }, { label: 'BUSINESS', value: 'BUSINESS' }]);
    expect(by('interests').validation).toEqual({ min: 1, max: 2 });
    expect(by('address')).toMatchObject({ label: 'Address', props: { description: 'Where to deliver' } });
    // A required list needs a row; no more rows than a form allows.
    expect(by('lines').validation).toEqual({ min: 1, max: 200 });
    expect(notes).toEqual(['"tags" is a list inside a list, which a form cannot repeat. Add it by hand.']);
    expect(publishable(fields)).toEqual([]);
  });

  it('says what it could not carry over', () => {
    const { fields, notes } = fieldsFromJsonSchema({
      type: 'object',
      properties: {
        ref: { $ref: '#/definitions/x' },
        either: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        list: { type: 'array', items: { type: 'string' } },
        bag: { type: 'object' },
        odd: { type: 'geo-point' },
        missing: null,
      },
    });
    expect(brief(fields)).toEqual(['TEXT odd']);
    expect(notes).toEqual([
      '"ref" uses a reference or a choice of shapes, which cannot be turned into a field. Add it by hand.',
      '"either" uses a reference or a choice of shapes, which cannot be turned into a field. Add it by hand.',
      '"list" is a list of free values, which has no field of its own. Add a repeating section for it by hand.',
      '"bag" is an object with no listed properties and was skipped.',
      '"odd" has the type "geo-point", which has no matching field. It was added as text.',
      '"missing" has no description of what it holds and was skipped.',
    ]);
  });

  it('gives every field a usable, unique key whatever the property is called', () => {
    const { fields } = fieldsFromJsonSchema({ type: 'object', properties: { 'Order No.': { type: 'string' }, order_no: { type: 'string' }, '123': { type: 'string' }, '  ': { type: 'string' }, 'São Paulo': { type: 'string' }, constructor: { type: 'string' } } });
    expect(fields.map((f) => f.name)).toEqual(['field123', 'orderNo', 'orderNo2', 'field', 'saoPaulo', 'constructor']);
    expect(publishable(fields)).toEqual([]);
  });

  it('refuses what is not a schema of an object, and stops at a sensible size', () => {
    for (const bad of [null, 'text', [], { type: 'string' }, { properties: 'x' }]) {
      expect(fieldsFromJsonSchema(bad)).toEqual({ fields: [], notes: ['This is not a JSON Schema of an object with properties, so there is nothing to make fields from.'] });
    }
    const huge = { type: 'object', properties: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`p${i}`, { type: 'string' }])) };
    const { fields, notes } = fieldsFromJsonSchema(huge);
    expect(fields).toHaveLength(MAX_IMPORTED_FIELDS);
    expect(notes).toEqual([`Only the first ${MAX_IMPORTED_FIELDS} fields were added.`]);
  });

  it('flattens objects nested too deeply instead of failing', () => {
    let schema: Record<string, unknown> = { type: 'object', properties: { leaf: { type: 'string' } } };
    for (let i = 0; i < 8; i++) schema = { type: 'object', properties: { [`level${i}`]: schema } };
    const { fields } = fieldsFromJsonSchema(schema);
    expect(fields.some((f) => f.name === 'leaf')).toBe(true);
    expect(fields.filter((f) => f.type === 'SECTION').length).toBe(4);
    expect(publishable(fields)).toEqual([]);
  });
});

describe('a form from a spreadsheet', () => {
  it('reads CSV with quotes, commas and line breaks inside cells', () => {
    expect(parseCsv('a,b\n1,"x, y"\n"he said ""hi""","line\nbreak"\r\n\n,\n')).toEqual([['a', 'b'], ['1', 'x, y'], ['he said "hi"', 'line\nbreak']]);
    expect(parseCsv('﻿name\nAsha')).toEqual([['name'], ['Asha']]);
    expect(parseCsv('')).toEqual([]);
  });

  it('guesses each column\'s field from the example rows', () => {
    const csv = [
      'Name,Email,Joined,Age,Member,Department,Notes,',
      'Asha Rao,asha@acme.test,2026-01-05,34,yes,Quality,Fine,x',
      'Ravi K,ravi@acme.test,2025-11-20,41,no,Stores,"A long note, with a comma",y',
      'Meera,meera@acme.test,2024-03-01,29,yes,Quality,,z',
      'Dev,dev@acme.test,2026-02-14,52,no,Stores,ok,w',
    ].join('\n');
    const { fields, notes } = fieldsFromCsv(csv);
    expect(brief(fields)).toEqual(['TEXT name', 'EMAIL email', 'DATE joined', 'NUMBER age', 'CHECKBOX member', 'DROPDOWN department', 'TEXT notes']);
    expect(fields.find((f) => f.name === 'department')!.dataSource?.options).toEqual([{ label: 'Quality', value: 'Quality' }, { label: 'Stores', value: 'Stores' }]);
    expect(fields.find((f) => f.name === 'name')!.label).toBe('Name');
    expect(notes).toEqual(['Column 8 has no name and was skipped.']);
    expect(publishable(fields)).toEqual([]);
  });

  it('with only a header row, every column is text, and it says so', () => {
    const { fields, notes } = fieldsFromCsv('Order No.,Customer,Order No.');
    expect(brief(fields)).toEqual(['TEXT orderNo', 'TEXT customer', 'TEXT orderNo2']);
    expect(notes).toEqual(['There were no example rows, so every column became a text field. Change their types in the builder.']);
  });

  it('handles an empty file and a very wide one', () => {
    expect(fieldsFromCsv('')).toEqual({ fields: [], notes: ['The file is empty.'] });
    const wide = fieldsFromCsv(Array.from({ length: 250 }, (_, i) => `c${i}`).join(','));
    expect(wide.fields).toHaveLength(MAX_IMPORTED_FIELDS);
    expect(wide.notes[0]).toBe(`Only the first ${MAX_IMPORTED_FIELDS} columns were added.`);
  });

  it('a long answer in the examples makes a paragraph field', () => {
    expect(brief(fieldsFromCsv(`Story\n"${'word '.repeat(40)}"`).fields)).toEqual(['TEXTAREA story']);
  });
});

describe('a form from a table a connector exposes', () => {
  it('makes one field per field, keeping the table\'s names so answers can be saved back without mapping', () => {
    const { fields, notes } = fieldsFromEntity({ fields: ['_id', 'customer_name', 'contactEmail', 'phone', 'order_date', 'amount', 'is_urgent', 'delivery_notes', 'status'] });
    expect(fields.map((f) => [f.name, f.label, f.type])).toEqual([
      ['customer_name', 'Customer name', 'TEXT'],
      ['contactEmail', 'Contact email', 'EMAIL'],
      ['phone', 'Phone', 'PHONE'],
      ['order_date', 'Order date', 'DATE'],
      ['amount', 'Amount', 'NUMBER'],
      ['is_urgent', 'Is urgent', 'CHECKBOX'],
      ['delivery_notes', 'Delivery notes', 'TEXTAREA'],
      ['status', 'Status', 'TEXT'],
    ]);
    expect(notes).toEqual(['"_id" identifies a row and is set by the system, so it has no field.']);
    const result = validateFormDefinition({ ...base, fields }, 'publish');
    expect(result.success ? [] : result.issues).toEqual([]);
  });

  it('a known type wins over what the name suggests; lists and groups are skipped and said so', () => {
    const { fields, notes } = fieldsFromEntity({
      fields: [{ name: 'email_count', type: 'number' }, { name: 'active', type: 'string' }, { name: 'signed', type: 'boolean' }, { name: 'when', type: 'date' }, { name: 'tags', type: 'array' }, { name: 'meta', type: 'object' }, { name: 'misc', type: 'unknown' }],
    });
    expect(fields.map((f) => [f.name, f.type])).toEqual([['email_count', 'NUMBER'], ['active', 'CHECKBOX'], ['signed', 'CHECKBOX'], ['when', 'DATE'], ['misc', 'TEXT']]);
    expect(notes).toEqual(['"tags" holds a list and was skipped.', '"meta" holds a group of values and was skipped.']);
  });

  it('a name that cannot be a field key gets one, and says what to do about it', () => {
    const { fields, notes } = fieldsFromEntity({ fields: ['order-no', 'address.city', '2nd line', 'order_no'] });
    expect(fields.map((f) => f.name)).toEqual(['orderNo', 'addressCity', 'field2ndLine', 'order_no']);
    expect(notes[0]).toBe('"order-no" cannot be a field key as it is, so its field is called "orderNo". Rename it, or map it when saving to the table.');
    expect(fieldsFromEntity({ fields: [] }).notes).toEqual(['This table exposes no fields.']);
  });

  it('the ranges, shortest length and pattern a table holds to come along too, each on the kind of field it fits', () => {
    const { fields } = fieldsFromEntity({
      fields: [
        { name: 'qty', type: 'number', min: 1, max: 100 },
        { name: 'code', type: 'string', maxLength: 10, minLength: 3, pattern: '^[A-Z]{3}$' },
        { name: 'contact_email', type: 'string', pattern: '^.+$', minLength: 5 },
        // Limits that make no sense are left out, not passed on to trip the form up.
        { name: 'broken', type: 'string', pattern: '([', minLength: 9000 },
        { name: 'upside', type: 'number', min: 10, max: 1 },
        { name: 'title', type: 'string', min: 1, max: 5 },
      ],
    });
    const by = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(by.qty!.validation).toEqual({ min: 1, max: 100 });
    expect(by.code!.validation).toEqual({ maxLength: 10, minLength: 3, pattern: '^[A-Z]{3}$' });
    expect(by.contact_email).toMatchObject({ type: 'EMAIL', validation: { minLength: 5 } });
    expect(by.broken!.validation).toBeUndefined();
    expect(by.upside!.validation).toEqual({ min: 10 });
    expect(by.title!.validation).toBeUndefined();
  });

  it('what the table insists on comes along: must be filled, and the longest text it takes', () => {
    const { fields } = fieldsFromEntity({
      fields: [
        { name: 'customer_name', type: 'string', nullable: false, maxLength: 80 },
        { name: 'notes', type: 'string', nullable: true, maxLength: 20000 },
        // The table fills these in itself, or unticked is an answer: nobody is made to answer them.
        { name: 'status', type: 'string', nullable: false, hasDefault: true },
        { name: 'is_urgent', type: 'boolean', nullable: false },
        { name: 'amount', type: 'number', nullable: false, maxLength: 10 },
      ],
    });
    const by = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(by.customer_name).toMatchObject({ required: true, validation: { maxLength: 80 } });
    expect(by.notes!.required).toBeUndefined();
    expect(by.notes!.validation).toEqual({ maxLength: 5000 });
    expect(by.status!.required).toBeUndefined();
    expect(by.is_urgent!.required).toBeUndefined();
    // A number has no "longest text".
    expect(by.amount).toMatchObject({ required: true });
    expect(by.amount!.validation).toBeUndefined();
  });
});

describe('a form from a fillable PDF', () => {
  it('reads kinds, choices, lengths and what is required; names made for machines become labels for people', () => {
    const { fields, notes } = fieldsFromPdfFields([
      { name: 'applicant.first_name', kind: 'text', required: true, maxLength: 40 },
      { name: 'applicant.email', kind: 'text' },
      { name: 'applicant.dob', kind: 'text' },
      { name: 'remarks', kind: 'text', multiline: true },
      { name: 'gender', kind: 'radio', options: ['Male', 'Female', 'Other'] },
      { name: 'state', kind: 'dropdown', options: ['Kerala', 'Punjab', 'Kerala', ' '] },
      { name: 'languages', kind: 'list', multiple: true, options: ['Hindi', 'Tamil'] },
      { name: 'agree', kind: 'checkbox', required: true },
      { name: 'sign_here', kind: 'signature' },
      { name: 'Submit', kind: 'button' },
    ]);
    expect(fields.map((f) => [f.name, f.label, f.type])).toEqual([
      ['firstName', 'First name', 'TEXT'],
      ['email', 'Email', 'EMAIL'],
      ['dob', 'Dob', 'DATE'],
      ['remarks', 'Remarks', 'TEXTAREA'],
      ['gender', 'Gender', 'RADIO'],
      ['state', 'State', 'DROPDOWN'],
      ['languages', 'Languages', 'MULTI_SELECT'],
      ['agree', 'Agree', 'CHECKBOX'],
      ['signHere', 'Sign here', 'SIGNATURE'],
    ]);
    expect(fields[0]).toMatchObject({ required: true, validation: { maxLength: 40 } });
    expect(fields[5].dataSource?.options?.map((o) => o.label)).toEqual(['Kerala', 'Punjab']);
    expect(notes).toEqual([]);
    publishable(fields);
  });

  it('says what it could not make sense of, instead of guessing silently', () => {
    const { fields, notes } = fieldsFromPdfFields([
      { name: 'Text12', kind: 'text' },
      { name: 'Check Box3', kind: 'checkbox' },
      { name: 'topmostSubform[0].Page1[0].city[0]', kind: 'text' },
      { name: 'plan', kind: 'dropdown', options: [] },
      { name: 'barcode', kind: 'other' },
    ]);
    expect(fields.map((f) => [f.name, f.label, f.type])).toEqual([
      ['field1', 'Field 1', 'TEXT'],
      ['field2', 'Field 2', 'CHECKBOX'],
      ['city', 'City', 'TEXT'],
      ['plan', 'Plan', 'TEXT'],
      ['barcode', 'Barcode', 'TEXT'],
    ]);
    expect(notes).toEqual([
      '"Plan" is a choice with no choices in the PDF, so it became a text field.',
      '"Barcode" is a kind of field this cannot read, so it became a text field.',
      '2 fields have no meaningful name in the PDF and are called "Field n". Give them labels in the builder.',
    ]);
    expect(fieldsFromPdfFields([]).notes).toEqual(['This PDF has no fillable fields. A scanned or flat PDF cannot be read this way.']);
  });
});

