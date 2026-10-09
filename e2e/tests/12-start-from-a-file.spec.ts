import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { createOrg, formUrl, label, signIn, submissions, call, watchForProblems, type Org } from './helpers';

/** A new form started from a JSON Schema or a spreadsheet instead of from nothing. */

let org: Org;
test.beforeAll(async () => {
  org = await createOrg('Importer');
});

const file = (name: string, content: string) => {
  const path = join(tmpdir(), `fb-e2e-${Date.now()}-${name}`);
  writeFileSync(path, content);
  return path;
};

async function startFrom(page: Page, source: string, fileLabel: string, path: string) {
  await page.goto('/forms');
  await page.getByRole('button', { name: 'New form' }).click();
  await page.getByRole('radiogroup', { name: 'Start from' }).getByText(source, { exact: true }).click();
  // Nothing to create until a file has been read.
  await expect(page.getByRole('button', { name: 'Create draft' })).toBeDisabled();
  await page.getByLabel(fileLabel).setInputFiles(path);
}

async function publishFromList(page: Page, name: string, code: string) {
  await page.getByText(name, { exact: true }).click();
  await expect(page.getByLabel('Field palette')).toBeVisible();
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText(new RegExp(`Published ${code} v1`))).toBeVisible();
}

test('a spreadsheet becomes a form: one field per column, typed from the example rows', async ({ page, context }) => {
  const problems = watchForProblems(page);
  const csv = file(
    'staff_list.csv',
    ['Name,Email,Joined,Age,Member,Department', 'Asha Rao,asha@acme.test,2026-01-05,34,yes,Quality', 'Ravi K,ravi@acme.test,2025-11-20,41,no,Stores', 'Meera,meera@acme.test,2024-03-01,29,yes,Quality', 'Dev,dev@acme.test,2026-02-14,52,no,Stores'].join('\n'),
  );
  await signIn(page, org.email);
  await startFrom(page, 'A spreadsheet', 'Spreadsheet file (.csv)', csv);
  await expect(page.getByRole('status').filter({ hasText: 'found in' })).toContainText('6 fields found in');
  await expect(page.getByRole('status').filter({ hasText: 'found in' })).toContainText('Name, Email, Joined, Age, Member, Department');
  // The file's name suggests the form's.
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(/staff list/);
  await page.getByLabel('Name', { exact: true }).fill('Staff list');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByText(/"Staff list" was created as a draft with 6 fields from/)).toBeVisible();
  await publishFromList(page, 'Staff list', 'STAFF_LIST');

  const form = await context.newPage();
  await form.goto(formUrl(org, 'STAFF_LIST'));
  await form.getByLabel(label('Name')).fill('Kiran');
  await form.getByLabel(label('Email')).fill('kiran@acme.test');
  await form.getByLabel(label('Joined')).fill('2026-10-09');
  await form.getByLabel(label('Age')).fill('30');
  await form.getByRole('checkbox', { name: /Member/ }).click();
  await form.getByRole('combobox', { name: label('Department') }).click();
  await expect(form.getByRole('option')).toHaveText(['Quality', 'Stores']);
  await form.getByRole('option', { name: 'Stores' }).click();
  await form.getByRole('button', { name: 'Submit' }).click();
  await expect(form.getByText(/Thank you/)).toBeVisible();

  const id = (await call<{ id: string; code: string }[]>(200, '/forms', { token: org.token })).find((f) => f.code === 'STAFF_LIST')!.id;
  expect((await submissions(org, id))[0].payload).toEqual({ name: 'Kiran', email: 'kiran@acme.test', joined: '2026-10-09', age: 30, member: true, department: 'Stores' });
  expect(problems).toEqual([]);
});

test('a JSON Schema becomes a form, with a section, a repeating section, and a note about what was left out', async ({ page, context }) => {
  const schema = file(
    'order.json',
    JSON.stringify({
      type: 'object',
      required: ['customer', 'lines'],
      properties: {
        customer: { type: 'string', title: 'Customer name', minLength: 2 },
        priority: { enum: ['LOW', 'HIGH'] },
        address: { type: 'object', title: 'Delivery address', properties: { city: { type: 'string' } }, required: ['city'] },
        lines: { type: 'array', minItems: 1, items: { type: 'object', required: ['item'], properties: { item: { type: 'string' }, qty: { type: 'integer', minimum: 1 } } } },
        history: { $ref: '#/definitions/history' },
      },
    }),
  );
  await signIn(page, org.email);
  await startFrom(page, 'A JSON Schema', 'Schema file (.json)', schema);
  const found = page.getByRole('status').filter({ hasText: 'found in' });
  await expect(found).toContainText('7 fields found in');
  await expect(found).toContainText('"history" uses a reference or a choice of shapes, which cannot be turned into a field. Add it by hand.');
  await page.getByLabel('Name', { exact: true }).fill('Order');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByText(/"Order" was created as a draft with 7 fields/)).toBeVisible();
  await publishFromList(page, 'Order', 'ORDER');

  const form = await context.newPage();
  await form.goto(formUrl(org, 'ORDER'));
  // Required comes from the schema, at every level.
  await form.getByRole('button', { name: 'Submit' }).click();
  const summary = form.getByRole('alert').filter({ hasText: 'Please fix' });
  await expect(summary).toContainText('Customer name is required');
  await expect(summary).toContainText('City is required');
  await expect(summary).toContainText('Item is required');

  await form.getByLabel(label('Customer name')).fill('Acme');
  await form.getByRole('radio', { name: 'HIGH' }).click();
  await form.getByRole('region', { name: 'Delivery address' }).getByLabel(label('City')).fill('Pune');
  const row = form.getByRole('group', { name: 'Lines row 1' });
  await row.getByLabel(label('Item')).fill('Pen');
  await row.getByLabel(label('Qty')).fill('0');
  await form.getByRole('button', { name: 'Submit' }).click();
  await expect(form.getByRole('alert').filter({ hasText: 'Please fix' })).toContainText('Must be at least 1');
  await row.getByLabel(label('Qty')).fill('3');
  await form.getByRole('button', { name: 'Submit' }).click();
  await expect(form.getByText(/Thank you/)).toBeVisible();

  const id = (await call<{ id: string; code: string }[]>(200, '/forms', { token: org.token })).find((f) => f.code === 'ORDER')!.id;
  expect((await submissions(org, id))[0].payload).toEqual({ customer: 'Acme', priority: 'HIGH', city: 'Pune', lines: [{ item: 'Pen', qty: 3 }] });
});

test('a file that is not what it claims is refused with a plain message', async ({ page }) => {
  await signIn(page, org.email);
  await startFrom(page, 'A JSON Schema', 'Schema file (.json)', file('broken.json', '{ not json'));
  await expect(page.getByText('This file could not be read as JSON.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create draft' })).toBeDisabled();

  await page.getByLabel('Schema file (.json)').setInputFiles(file('list.json', '[1, 2, 3]'));
  await expect(page.getByText('This is not a JSON Schema of an object with properties, so there is nothing to make fields from.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create draft' })).toBeDisabled();
});

test('a fillable PDF becomes a form: its fields, choices and what it requires, read in the browser', async ({ page, context }) => {
  const problems = watchForProblems(page);
  // The kind of PDF an organisation already has: an application form with boxes to fill in.
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([400, 400]);
  const fields = doc.getForm();
  const applicant = fields.createTextField('applicant.full_name');
  applicant.enableRequired();
  applicant.addToPage(sheet, { x: 20, y: 340, width: 200, height: 20 });
  const membership = fields.createRadioGroup('membership');
  membership.addOptionToPage('Annual', sheet, { x: 20, y: 300, width: 14, height: 14 });
  membership.addOptionToPage('Lifetime', sheet, { x: 60, y: 300, width: 14, height: 14 });
  fields.createCheckBox('agree_to_terms').addToPage(sheet, { x: 20, y: 260, width: 14, height: 14 });
  fields.createButton('print').addToPage('Print', sheet, { x: 20, y: 220, width: 60, height: 20 });
  const path = join(tmpdir(), `fb-e2e-${Date.now()}-membership_form.pdf`);
  writeFileSync(path, await doc.save());

  // The PDF is read on this computer: it must never be sent to our servers.
  const uploads: string[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET' && (r.postDataBuffer()?.subarray(0, 5).toString() === '%PDF-' || /pdf/i.test(r.headers()['content-type'] ?? ''))) uploads.push(r.url());
  });

  await signIn(page, org.email);
  await startFrom(page, 'A fillable PDF', 'PDF form (.pdf)', path);
  await expect(page.getByRole('status').filter({ hasText: 'found in' })).toContainText('3 fields found in');
  await expect(page.getByRole('status').filter({ hasText: 'found in' })).toContainText('Full name, Membership, Agree to terms');
  await page.getByLabel('Name', { exact: true }).fill('Membership');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByText(/"Membership" was created as a draft with 3 fields from/)).toBeVisible();
  expect(uploads).toEqual([]);
  await publishFromList(page, 'Membership', 'MEMBERSHIP');

  const form = await context.newPage();
  await form.goto(formUrl(org, 'MEMBERSHIP'));
  await form.getByRole('button', { name: 'Submit' }).click();
  await expect(form.getByText('Full name is required').first()).toBeVisible();
  await form.getByLabel(label('Full name')).fill('Kiran Rao');
  await form.getByRole('radio', { name: 'Lifetime' }).click();
  await form.getByRole('checkbox', { name: /Agree to terms/ }).click();
  await form.getByRole('button', { name: 'Submit' }).click();
  const forms = await call<{ id: string; code: string }[]>(200, '/forms', { token: org.token });
  await expect.poll(async () => (await submissions(org, forms.find((f) => f.code === 'MEMBERSHIP')!.id))[0]?.payload).toMatchObject({ fullName: 'Kiran Rao', membership: 'Lifetime', agreeToTerms: true });

  // A file that only claims to be a PDF is refused with words, not an error.
  const fake = file('not-really.pdf', 'hello');
  await page.goto('/forms');
  await startFrom(page, 'A fillable PDF', 'PDF form (.pdf)', fake);
  await expect(page.getByText(/could not be read as a PDF form/)).toBeVisible();
  expect(problems).toEqual([]);
});

