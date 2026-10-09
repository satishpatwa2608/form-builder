import { expect, test } from '@playwright/test';
import { MongoClient } from 'mongodb';
import { MONGO, PORTS } from '../stack';
import { addMember, call, createOrg, formUrl, label, publishForm, signIn, watchForProblems, type Org } from './helpers';

/** A form reads a customer's own database (options and a look-up) and writes the answers back to it. */

const CUSTOMER_DB = MONGO;
let org: Org;
let ref: string;
let connectorId: string;
let db: MongoClient;

test.beforeAll(async () => {
  db = await MongoClient.connect(CUSTOMER_DB);
  const crm = db.db('e2e_crm');
  await crm.dropDatabase();
  await crm.collection('plants').insertMany([
    { code: 'P1', name: 'Pune plant', region: 'WEST', budget: 900 },
    { code: 'P2', name: 'Delhi plant', region: 'NORTH', budget: 700 },
  ]);
  await crm.collection('customers').insertMany([
    { email: 'asha@customer.test', fullName: 'Asha Rao', phone: '+91 98765 43210', creditLimit: 50000, secretNote: 'do not show' },
    { email: 'ravi@customer.test', fullName: 'Ravi Kumar', phone: '+91 91234 56789', creditLimit: 10000, secretNote: 'do not show' },
  ]);

  org = await createOrg('Plants');
  const created = await call<{ id: string; ref: string }>(201, '/connectors', {
    method: 'POST',
    token: org.token,
    body: { type: 'mongodb', name: 'Plant CRM', settings: { database: 'e2e_crm' }, secrets: { uri: CUSTOMER_DB }, writable: true },
  });
  connectorId = created.id;
  ref = created.ref;
  // The credentials never come back.
  expect(JSON.stringify(created)).not.toContain('mongodb://');
  expect(await call<{ ok: boolean }>(200, `/connectors/${connectorId}/test`, { method: 'POST', token: org.token })).toMatchObject({ ok: true });
  await call(200, `/connectors/${connectorId}/discover`, { method: 'POST', token: org.token });
  await call(200, `/connectors/${connectorId}/entities`, {
    method: 'PUT',
    token: org.token,
    body: {
      entities: [
        { key: 'plants', label: 'Plants', fields: ['code', 'name', 'region'], keyField: 'code', operations: ['list', 'get'], valueField: 'code', labelField: 'name' },
        // The secret note is not exposed, so no form can read it.
        { key: 'customers', label: 'Customers', fields: ['email', 'fullName', 'phone'], keyField: 'email', operations: ['list', 'get'] },
        { key: 'issues', label: 'Issues', fields: ['plant', 'email', 'reporter', 'phone', 'what'], operations: ['insert'] },
      ],
    },
  });
  const steps = await call<{ key: string; label: string }[]>(200, '/custom-workflows', { token: org.token });
  const insert = steps.find((a) => a.label === 'Plant CRM: insert Issues')!;

  await publishForm(org, {
    name: 'Plant issue',
    code: 'PLANT_ISSUE',
    fields: [
      { id: 'f0', type: 'EMAIL', name: 'email', label: 'Your email', required: true },
      { id: 'b', type: 'BUTTON', name: 'find', label: 'Find my details' },
      { id: 'f1', type: 'TEXT', name: 'reporter', label: 'Your name', required: true },
      { id: 'f2', type: 'PHONE', name: 'phone', label: 'Phone' },
      { id: 'f3', type: 'DROPDOWN', name: 'plant', label: 'Plant', required: true, dataSource: { type: 'API', api: { url: `/connectors/${ref}/plants`, method: 'GET', valueField: 'code', labelField: 'name' } } },
      { id: 'f4', type: 'TEXTAREA', name: 'what', label: 'What happened', required: true },
    ],
    events: [
      { id: 'look', on: { type: 'CLICK', field: 'find' }, do: [{ type: 'FETCH', source: { url: `/connectors/${ref}/customers`, method: 'GET', params: { email: '{{email}}' } }, set: { reporter: 'fullName', phone: 'phone' } }] },
    ],
    workflow: {
      enabled: true,
      refPrefix: 'ISS',
      statuses: [{ key: 'NEW', label: 'New', category: 'OPEN' }, { key: 'DONE', label: 'Done', category: 'DONE' }],
      assignment: { type: 'NONE' },
      actions: [{ key: 'finish', label: 'Finish', from: ['NEW'], to: 'DONE' }],
    },
    automations: [{ id: 'a1', name: 'Save to CRM', enabled: true, when: 'SUBMITTED', actions: [{ id: 's1', type: 'HANDLER', key: insert.key, label: 'Save' }] }],
  });
});

test.afterAll(async () => {
  await db?.close();
});

test('options come from the customer database, a button looks the person up, and the answer is written back', async ({ page }) => {
  const problems = watchForProblems(page);
  await page.goto(formUrl(org, 'PLANT_ISSUE'));

  // Nothing to look up yet.
  await page.getByRole('button', { name: 'Find my details' }).click();
  await expect(page.getByText('Fill in the fields this looks up by first.')).toBeVisible();

  // Someone the database does not know.
  await page.getByLabel(label('Your email')).fill('stranger@customer.test');
  await page.getByRole('button', { name: 'Find my details' }).click();
  await expect(page.getByText('Nothing was found.')).toBeVisible();
  await expect(page.getByLabel(label('Your name'))).toHaveValue('');

  // Someone it does.
  await page.getByLabel(label('Your email')).fill('asha@customer.test');
  await page.getByRole('button', { name: 'Find my details' }).click();
  await expect(page.getByLabel(label('Your name'))).toHaveValue('Asha Rao');
  await expect(page.getByLabel(label('Phone'))).toHaveValue('+91 98765 43210');
  await expect(page.getByText('Nothing was found.')).toHaveCount(0);
  // What was filled in can be changed.
  await page.getByLabel(label('Your name')).fill('Asha R.');

  // The dropdown lists the plants in the database, by name.
  await page.getByRole('combobox', { name: label('Plant') }).click();
  await expect(page.getByRole('option')).toHaveText(['Pune plant', 'Delhi plant']);
  await page.getByRole('option', { name: 'Delhi plant' }).click();
  await page.getByLabel(label('What happened')).fill('Boiler leak near gate 2');
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByText(/ISS-0+1/)).toBeVisible();

  // The automation wrote the answers into the customer's own collection.
  await expect
    .poll(async () => db.db('e2e_crm').collection('issues').findOne({ plant: 'P2' }), { timeout: 10_000 })
    .toMatchObject({ plant: 'P2', email: 'asha@customer.test', reporter: 'Asha R.', phone: '+91 98765 43210', what: 'Boiler leak near gate 2' });
  expect(problems).toEqual([]);
});

test('the public can read only what the form binds, with only the parameters it declares', async () => {
  const query = async (body: object) => (await fetch(`http://127.0.0.1:${PORTS.api}/public/data-sources/query?org=${org.orgId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const ok = await query({ formCode: 'PLANT_ISSUE', key: `/connectors/${ref}/customers`, params: { email: 'ravi@customer.test' } });
  expect(ok.status).toBe(200);
  const rows = await ok.json();
  // Only exposed fields, never the note.
  expect(rows).toEqual([{ email: 'ravi@customer.test', fullName: 'Ravi Kumar', phone: '+91 91234 56789' }]);
  expect(JSON.stringify(rows)).not.toContain('do not show');

  // No parameter the look-up does not declare; no listing of everyone; no other collection; no other form.
  expect((await query({ formCode: 'PLANT_ISSUE', key: `/connectors/${ref}/customers`, params: { fullName: 'Asha Rao' } })).status).toBe(404);
  expect((await query({ formCode: 'PLANT_ISSUE', key: `/connectors/${ref}/issues`, params: {} })).status).toBe(404);
  expect((await query({ formCode: 'NO_SUCH_FORM', key: `/connectors/${ref}/customers`, params: { email: 'ravi@customer.test' } })).status).toBe(404);
  expect((await query({ key: `/connectors/${ref}/customers`, params: { email: 'ravi@customer.test' } })).status).toBe(404);
  // An attempt to smuggle a database operator in is refused or treated as plain text, never run.
  const smuggle = await query({ formCode: 'PLANT_ISSUE', key: `/connectors/${ref}/customers`, params: { email: { $ne: '' } } });
  expect(smuggle.status === 200 ? await smuggle.json() : []).toEqual([]);
});

test('a plant that is not in the database is refused on submit', async () => {
  const res = await fetch(`http://127.0.0.1:${PORTS.api}/public/forms/PLANT_ISSUE/submissions?org=${org.orgId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values: { email: 'x@customer.test', reporter: 'X', plant: 'P9', what: 'x' } }),
  });
  expect(res.status).toBe(422);
  expect(((await res.json()) as { errors: unknown }).errors).toEqual([{ field: 'plant', message: 'Select a valid option' }]);
});

test('a new form can start from a connected table: one field per field, named the same', async ({ page }) => {
  const problems = watchForProblems(page);
  await signIn(page, org.email);
  await page.goto('/forms');
  await page.getByRole('button', { name: 'New form' }).click();
  await page.getByRole('radio', { name: /A table from a connector/ }).check({ force: true });
  await page.getByRole('combobox', { name: 'Table', exact: true }).selectOption({ label: 'Plant CRM · Issues' });
  await expect(page.getByRole('status').filter({ hasText: 'fields found' })).toContainText('5 fields found in Plant CRM · Issues: Plant, Email, Reporter, Phone, What');
  await page.getByLabel('Name', { exact: true }).fill('Issue report');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByText(/"Issue report" was created as a draft with 5 fields from Plant CRM · Issues/)).toBeVisible();
  const forms = await call<{ id: string; code: string }[]>(200, '/forms', { token: org.token });
  const def = (await call<{ definition: { fields: { name: string; type: string }[] } }>(200, `/forms/${forms.find((f) => f.code === 'ISSUE_REPORT')!.id}`, { token: org.token })).definition;
  // The table's own names, so a "save to the table" step needs no mapping; kinds guessed from the names.
  expect(def.fields.map((f) => `${f.name}:${f.type}`)).toEqual(['plant:TEXT', 'email:EMAIL', 'reporter:TEXT', 'phone:PHONE', 'what:TEXT']);
  expect(problems).toEqual([]);
});

test('the connectors page shows the connection, its calls and never its credentials; a designer may use it but not see inside', async ({ page }) => {
  await signIn(page, org.email);
  await page.goto('/connectors');
  await expect(page.getByText('Plant CRM').first()).toBeVisible();
  await expect(page.locator('body')).not.toContainText('mongodb://');

  const designer = await addMember(org, 'Dee Designer', 'DESIGNER');
  const sources = await call<{ key: string; name: string }[]>(200, '/connectors/sources', { token: designer.token });
  expect(sources.map((s) => s.name)).toEqual(expect.arrayContaining(['Plant CRM · Plants', 'Plant CRM · Customers']));
  expect(JSON.stringify(sources)).not.toContain('mongodb://');
  // Changing the connection or its credentials is not a designer's to do.
  expect((await fetch(`http://127.0.0.1:${PORTS.api}/connectors/${connectorId}/secrets`, { method: 'PUT', headers: { authorization: `Bearer ${designer.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ secrets: { uri: 'mongodb://evil.test/' } }) })).status).toBe(403);
  // Every call was logged, without the values.
  const calls = await call<unknown[]>(200, `/connectors/${connectorId}/calls`, { token: org.token });
  expect(calls.length).toBeGreaterThan(2);
  expect(JSON.stringify(calls)).not.toContain('asha@customer.test');
});
