import { expect, test } from '@playwright/test';
import { MongoClient } from 'mongodb';
import { MONGO } from '../stack';
import { call, createOrg, formUrl, label, signIn, submissions, watchForProblems, type Org } from './helpers';

/**
 * A form that opens already filled from a record: a designer sets it up in plain words (the questions named like
 * the record's fields match by themselves), makes a link for one customer, and that customer opens the form
 * with their own details and orders, some of which they may not change.
 */
let org: Org;
let ref: string;
let formId: string;
let db: MongoClient;

test.beforeAll(async () => {
  db = await MongoClient.connect(MONGO);
  const crm = db.db('e2e_renewals');
  await crm.dropDatabase();
  await crm.collection('customers').insertMany([
    { no: 'C1', name: 'Asha Textiles', city: 'Pune', creditLimit: 50000 },
    { no: 'C2', name: 'Ravi Motors', city: 'Delhi', creditLimit: 100 },
  ]);
  await crm.collection('orders').insertMany([
    { customer_no: 'C1', item: 'Cotton', qty: 40 },
    { customer_no: 'C1', item: 'Silk', qty: 5 },
    { customer_no: 'C2', item: 'Tyres', qty: 8 },
  ]);
  org = await createOrg('Renewals');
  const made = await call<{ id: string; ref: string }>(201, '/connectors', { method: 'POST', token: org.token, body: { type: 'mongodb', name: 'CRM', settings: { database: 'e2e_renewals' }, secrets: { uri: MONGO } } });
  ref = made.ref;
  await call(200, `/connectors/${made.id}/entities`, {
    method: 'PUT',
    token: org.token,
    body: {
      entities: [
        // The credit limit is not exposed, so no form can show it.
        { key: 'customers', label: 'Customers', fields: ['no', 'name', 'city'], keyField: 'no', operations: ['list'], related: [{ name: 'orders', source: `/connectors/${ref}/orders`, field: 'customer_no', equals: 'no' }] },
        { key: 'orders', label: 'Orders', fields: ['customer_no', 'item', 'qty'], operations: ['list'] },
      ],
    },
  });
  formId = (
    await call<{ definition: { id: string } }>(201, '/forms', {
      method: 'POST',
      token: org.token,
      body: {
        folderId: org.folderId,
        definition: {
          name: 'Account renewal',
          code: 'RENEW',
          businessId: '',
          access: 'PUBLIC',
          submission: { method: 'POST', endpointId: 'default-submit' },
          fields: [
            { id: 'n', type: 'TEXT', name: 'name', label: 'Company name' },
            { id: 'c', type: 'TEXT', name: 'city', label: 'City' },
            { id: 'w', type: 'TEXTAREA', name: 'changes', label: 'Anything that has changed' },
            { id: 'r', type: 'REPEAT', name: 'openOrders', label: 'Your open orders' },
            { id: 'i', type: 'TEXT', name: 'item', label: 'Item', parentId: 'r' },
            { id: 'q', type: 'NUMBER', name: 'qty', label: 'Quantity', parentId: 'r' },
          ],
        },
      },
    })
  ).definition.id;
});

test.afterAll(async () => {
  await db?.close();
});

test('a designer sets it up from lists, makes a link for one customer, and the customer opens the form with their own record', async ({ page, context }) => {
  const problems = watchForProblems(page);
  await signIn(page, org.email);
  await page.goto(`/forms/${formId}/edit`);
  const settings = page.getByLabel('Form settings');
  const opens = settings.getByRole('group', { name: 'Opens with a record' });
  await opens.getByRole('combobox', { name: 'This form opens' }).click();
  await page.getByRole('option', { name: 'Filled from a record' }).click();

  // The table is chosen, what finds the record is guessed, and the questions named like its fields are matched already.
  await expect(opens.getByRole('combobox', { name: 'The record is in' })).toContainText('CRM · Customers');
  await expect(opens.getByRole('combobox', { name: 'It is found by its' })).toContainText('no');
  await expect(opens.getByRole('combobox', { name: 'Company name comes from' })).toContainText('name');
  await expect(opens.getByRole('combobox', { name: 'City comes from' })).toContainText('city');
  await expect(opens.getByRole('combobox', { name: 'Anything that has changed comes from' })).toContainText('Not filled');

  // The company name stays as the record has it; the orders come along as rows, matched by name too.
  await opens.getByRole('checkbox', { name: 'Keep Company name as the record says' }).click();
  await opens.getByRole('combobox', { name: 'Rows of Your open orders come from' }).click();
  await page.getByRole('option', { name: 'One for each of the record\'s "orders"' }).click();
  await expect(opens.getByRole('combobox', { name: 'Item of Your open orders comes from' })).toContainText('item');
  await expect(opens.getByRole('combobox', { name: 'Quantity of Your open orders comes from' })).toContainText('qty');
  await opens.getByRole('checkbox', { name: 'Keep the rows of Your open orders as the record says' }).click();

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved')).toBeVisible();
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText(/published/i).first()).toBeVisible();

  if (process.env.SHOT_DIR) await page.getByLabel('Form settings').screenshot({ path: `${process.env.SHOT_DIR}/opens-with-setting.png` });
  // A link for one customer, made from the list of forms.
  await page.goto('/forms');
  await page.getByRole('button', { name: 'Link for a record, for Account renewal' }).click();
  const maker = page.getByRole('group', { name: 'Make a link for a record' });
  await maker.getByRole('textbox', { name: "The record's no" }).fill('C1');
  await maker.getByRole('button', { name: 'Make the link' }).click();
  const link = await maker.getByRole('textbox', { name: 'Link for this record' }).inputValue();
  expect(link).toContain(`${formUrl(org, 'RENEW')}?fill=`);

  // The customer follows the link, in a browser that is signed in to nothing.
  const theirs = await (await context.browser()!.newContext()).newPage();
  const theirProblems = watchForProblems(theirs);
  await theirs.goto(link);
  await expect(theirs.getByText('Some answers have been filled in from our records.')).toBeVisible();
  await expect(theirs.getByLabel(label('Company name'))).toHaveValue('Asha Textiles');
  await expect(theirs.getByLabel(label('Company name'))).toBeDisabled();
  await expect(theirs.getByLabel(label('City'))).toHaveValue('Pune');
  await expect(theirs.getByLabel(label('City'))).toBeEnabled();
  await expect(theirs.getByLabel(label('Item'))).toHaveCount(2);
  await expect(theirs.getByLabel(label('Item')).first()).toHaveValue('Cotton');
  await expect(theirs.getByLabel(label('Item')).nth(1)).toHaveValue('Silk');
  await expect(theirs.getByLabel(label('Item')).first()).toBeDisabled();
  // The link is out of the address bar once it has been used, and nothing else of the record is on the page.
  expect(theirs.url()).not.toContain('fill=');
  expect(await theirs.content()).not.toContain('50000');
  if (process.env.SHOT_DIR) await theirs.screenshot({ path: `${process.env.SHOT_DIR}/opens-with-form.png`, fullPage: true });

  await theirs.getByLabel(label('City')).fill('Mumbai');
  await theirs.getByLabel(label('Anything that has changed')).fill('We moved office.');
  await theirs.getByRole('button', { name: 'Submit' }).click();
  await expect(theirs.getByText(/thank you|submitted|received/i).first()).toBeVisible();

  await expect.poll(async () => (await submissions(org, formId))[0]?.payload).toMatchObject({ name: 'Asha Textiles', city: 'Mumbai', changes: 'We moved office.', openOrders: [{ item: 'Cotton', qty: 40 }, { item: 'Silk', qty: 5 }] });
  // Without a link, the same form opens empty for anyone.
  await theirs.goto(formUrl(org, 'RENEW'));
  await expect(theirs.getByLabel(label('Company name'))).toHaveValue('');
  await expect(theirs.getByLabel(label('Company name'))).toBeEnabled();
  expect(problems).toEqual([]);
  expect(theirProblems).toEqual([]);
});
