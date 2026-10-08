import { expect, test } from '@playwright/test';
import { call, createOrg, formUrl, label, publishForm, signIn, submissions, waitForMail, watchForProblems, type Org } from './helpers';

/**
 * Phase 5's "done when": an expense claim with line items, a computed total,
 * a review step and a signature runs end to end and exports correctly to CSV.
 */
const kinds = [{ label: 'Travel', value: 'TRAVEL' }, { label: 'Meals', value: 'MEALS' }];
const claim = {
  name: 'Expense claim',
  code: 'EXPENSE_CLAIM',
  layout: { mode: 'single', review: true },
  fields: [
    { id: 'who', type: 'TEXT', name: 'employee', label: 'Your name', required: true },
    { id: 'mail', type: 'EMAIL', name: 'email', label: 'Email', required: true },
    { id: 'r', type: 'REPEAT', name: 'lines', label: 'Expenses', validation: { min: 1, max: 5 }, props: { addLabel: 'Add an expense', totals: ['amount'] } },
    { id: 'd', type: 'TEXT', name: 'what', label: 'What for', required: true, parentId: 'r' },
    { id: 'k', type: 'RADIO', name: 'kind', label: 'Kind', parentId: 'r', dataSource: { type: 'STATIC', options: kinds } },
    { id: 'q', type: 'NUMBER', name: 'qty', label: 'Quantity', parentId: 'r', validation: { min: 1 } },
    { id: 'p', type: 'NUMBER', name: 'rate', label: 'Rate', parentId: 'r' },
    { id: 'a', type: 'NUMBER', name: 'amount', label: 'Amount', parentId: 'r' },
    { id: 'n', type: 'TEXT', name: 'route', label: 'Route', parentId: 'r' },
    { id: 't', type: 'NUMBER', name: 'total', label: 'Total claimed' },
    { id: 'j', type: 'TEXTAREA', name: 'justification', label: 'Justification' },
    { id: 'c', type: 'CONSENT', name: 'declare', label: 'I declare this claim is true', required: true, props: { text: 'False claims are a disciplinary matter.' } },
    { id: 's', type: 'SIGNATURE', name: 'signature', label: 'Signature', required: true },
  ],
  rules: [
    { id: 'amount', then: [{ type: 'SET_VALUE', target: 'amount', value: 'qty * rate' }] },
    { id: 'total', then: [{ type: 'SET_VALUE', target: 'total', value: 'sum(amount)' }] },
    { id: 'route', when: { expr: 'kind == "TRAVEL"' }, then: [{ type: 'SHOW', target: 'route' }, { type: 'REQUIRE', target: 'route' }] },
    { id: 'why', when: { expr: 'total > 5000' }, then: [{ type: 'SHOW', target: 'justification' }, { type: 'REQUIRE', target: 'justification' }] },
  ],
  events: [{ id: 'big', on: { type: 'SUBMIT_SUCCESS' }, when: { expr: 'total > 5000' }, do: [{ type: 'SHOW_MESSAGE', message: 'Thank you. Claims above 5,000 go to your manager first.' }] }],
  workflow: {
    enabled: true,
    refPrefix: 'EXP',
    statuses: [{ key: 'NEW', label: 'New', category: 'OPEN' }, { key: 'PAID', label: 'Paid', category: 'DONE' }],
    assignment: { type: 'NONE' },
    priority: { default: 'LOW', rules: [{ if: { field: 'total', operator: 'greaterThan', value: 5000 }, priority: 'HIGH' }] },
    actions: [{ key: 'pay', label: 'Pay', from: ['NEW'], to: 'PAID' }],
  },
  automations: [
    { id: 'ack', name: 'Acknowledge', enabled: true, when: 'SUBMITTED', actions: [{ id: 's1', type: 'EMAIL', to: [{ kind: 'FIELD', field: 'email' }], subject: 'Claim {{$record.ref}} received', body: 'Total {{total}}. Signed: {{signature}}.' }] },
  ],
};

let org: Org;
let formId: string;

test.beforeAll(async () => {
  org = await createOrg('Expenses');
  formId = await publishForm(org, claim);
});

test('a person fills in line items, sees totals, reviews, signs and submits', async ({ page }) => {
  const problems = watchForProblems(page);
  await page.goto(formUrl(org, 'EXPENSE_CLAIM'));
  await expect(page.getByRole('heading', { name: 'Expense claim' })).toBeVisible();

  await page.getByLabel(label('Your name')).fill('Ravi Kumar');
  await page.getByLabel(label('Email')).fill('ravi@customer.test');

  // First line: travel, which asks for a route in this row only.
  const row1 = page.getByRole('group', { name: 'Expenses row 1' });
  await row1.getByLabel(label('What for')).fill('Cab to client');
  await expect(row1.getByLabel(label('Route'))).toHaveCount(0);
  await row1.getByRole('radio', { name: 'Travel' }).click();
  await row1.getByLabel(label('Route')).fill('Pune to Mumbai');
  await row1.getByLabel(label('Quantity')).fill('2');
  await row1.getByLabel(label('Rate')).fill('1800');
  await expect(row1.getByLabel(label('Amount'))).toHaveValue('3600');
  await expect(row1.getByLabel(label('Amount'))).toBeDisabled();

  // Second line: meals. No route here.
  await page.getByRole('button', { name: 'Add an expense' }).click();
  const row2 = page.getByRole('group', { name: 'Expenses row 2' });
  await row2.getByLabel(label('What for')).fill('Team lunch');
  await row2.getByRole('radio', { name: 'Meals' }).click();
  await expect(row2.getByLabel(label('Route'))).toHaveCount(0);
  await row2.getByLabel(label('Quantity')).fill('4');
  await row2.getByLabel(label('Rate')).fill('450.5');
  await expect(row2.getByLabel(label('Amount'))).toHaveValue('1802');
  await expect(page.getByLabel(label('Total claimed'))).toHaveValue('5402');
  await expect(page.locator('.fp-repeat__totals')).toContainText('5402');

  // Over 5,000: a justification appears and is required.
  await expect(page.getByLabel(label('Justification'))).toBeVisible();

  // Trying to go on without the rest: nothing is sent, the mistakes are listed.
  await page.getByRole('button', { name: 'Submit' }).click();
  const summary = page.getByRole('alert').filter({ hasText: 'Please fix' });
  await expect(summary).toContainText('Justification is required');
  await expect(summary).toContainText('Please accept to continue');
  await expect(summary).toContainText('Please sign');
  await expect(page.getByRole('region', { name: 'Check your answers' })).toHaveCount(0);

  await page.getByLabel(label('Justification')).fill('Quarterly client visit');
  await page.getByRole('checkbox', { name: /I declare this claim is true/ }).click();

  // Sign with the mouse.
  const pad = page.locator('canvas.fp-signature__pad');
  await pad.scrollIntoViewIfNeeded();
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 30, { steps: 6 });
  await page.mouse.move(box.x + 200, box.y + 90, { steps: 6 });
  await page.mouse.move(box.x + 280, box.y + 40, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByRole('img', { name: 'Signature: signed' })).toBeVisible();

  // The review page: what will be sent, nothing sent yet.
  await page.getByRole('button', { name: 'Submit' }).click();
  const review = page.getByRole('region', { name: 'Check your answers' });
  await expect(review).toBeVisible();
  await expect(review).toContainText('Ravi Kumar');
  await expect(review).toContainText('Cab to client');
  await expect(review).toContainText('Pune to Mumbai');
  await expect(review).toContainText('Team lunch');
  await expect(review).toContainText('5402');
  await expect(review.getByRole('img', { name: 'Your signature' })).toBeVisible();
  expect(await submissions(org, formId)).toHaveLength(0);

  // Change one answer from the review, and come back.
  await review.getByRole('button', { name: 'Change Your name' }).click();
  await expect(page.getByLabel(label('Your name'))).toBeFocused();
  await page.getByLabel(label('Your name')).fill('Ravi K. Kumar');
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByRole('region', { name: 'Check your answers' })).toContainText('Ravi K. Kumar');

  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByText('Thank you. Claims above 5,000 go to your manager first.')).toBeVisible();
  await expect(page.getByText(/EXP-000001/)).toBeVisible();

  // What the server stored: its own totals, the rows, the signature, and a priority from the total.
  const [stored] = await submissions(org, formId);
  expect(stored.payload).toMatchObject({
    employee: 'Ravi K. Kumar',
    lines: [
      { what: 'Cab to client', kind: 'TRAVEL', qty: 2, rate: 1800, amount: 3600, route: 'Pune to Mumbai' },
      { what: 'Team lunch', kind: 'MEALS', qty: 4, rate: 450.5, amount: 1802 },
    ],
    total: 5402,
    justification: 'Quarterly client visit',
    declare: true,
  });
  expect(stored.payload.lines[1]).not.toHaveProperty('route');
  expect(stored.payload.signature).toMatch(/^data:image\/png;base64,/);
  expect(stored.priority).toBe('HIGH');

  // The acknowledgement went out, with the total and without the signature's image data.
  const mail = await waitForMail('ravi@customer.test', /Claim EXP-000001 received/);
  expect(mail.text).toContain('Total 5402. Signed: Signed.');
  expect(problems).toEqual([]);
});

test('the claim shows up for staff, with its rows and signature, and exports to CSV', async ({ page }) => {
  const problems = watchForProblems(page);
  await signIn(page, org.email);
  await page.goto(`/forms/${formId}/submissions`);
  await expect(page.getByText('Ravi K. Kumar')).toBeVisible();
  // Rows are listed under the labels of their fields; the signature is not dumped as data.
  await expect(page.getByText(/1\. What for: Cab to client; Kind: Travel; Quantity: 2; Rate: 1800; Amount: 3600; Route: Pune to Mumbai/)).toBeVisible();
  await expect(page.locator('body')).not.toContainText('data:image/png');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /csv|export/i }).first().click();
  const file = await (await download).path();
  const csv = (await import('node:fs')).readFileSync(file, 'utf8');
  expect(csv).toContain('Ravi K. Kumar');
  expect(csv).toContain('2. What for: Team lunch; Kind: Meals; Quantity: 4; Rate: 450.5; Amount: 1802');
  expect(csv).toContain('"5402"');
  expect(csv).toContain('"Signed"');
  expect(csv).not.toContain('base64');
  expect(problems).toEqual([]);
});

test('a tampered request cannot change the totals', async () => {
  const sent = {
    employee: 'Mallory',
    email: 'm@customer.test',
    lines: [{ what: 'Pen', kind: 'MEALS', qty: 1, rate: 10, amount: 999999 }],
    total: 1,
    declare: true,
    signature: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  };
  const res = await call<{ payload: any }>(201, `/public/forms/EXPENSE_CLAIM/submissions?org=${org.orgId}`, { method: 'POST', body: { values: sent } });
  expect(res.payload.lines[0].amount).toBe(10);
  expect(res.payload.total).toBe(10);
});
