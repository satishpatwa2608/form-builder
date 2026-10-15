import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { call, createOrg, publishForm, signIn, watchForProblems, type Org } from './helpers';

/**
 * The screens added for the comparison scenario, used as people use them: a whole maintenance process from one
 * template, a button that wants a photo first, a QR code, the reports, and work that failed run again.
 */
let org: Org;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const complaint = {
  name: 'Repairs',
  code: 'REPAIRS',
  fields: [
    { id: 'p', type: 'DROPDOWN', name: 'property', label: 'Which property?', required: true, dataSource: { type: 'STATIC', options: [{ label: 'Tower A', value: 'A' }, { label: 'Tower B', value: 'B' }] } },
    { id: 'm', type: 'PHONE', name: 'mobile', label: 'Mobile' },
  ],
  workflow: {
    enabled: true,
    refPrefix: 'REP',
    statuses: [{ key: 'NEW', label: 'New', category: 'OPEN' }, { key: 'FIXED', label: 'Fixed', category: 'DONE' }],
    assignment: { type: 'NONE' },
    actions: [{ key: 'fixed', label: 'Fixed', from: ['NEW'], to: 'FIXED', requireFiles: { picturesOnly: true } }],
  },
  // The organisation has no SMS service yet: this stops, and is listed as work that failed.
  automations: [{ id: 'tell', name: 'Text the resident', enabled: true, when: 'SUBMITTED', actions: [{ id: 'sms', type: 'SMS', field: 'mobile', message: 'We have {{$record.ref}}' }] }],
};

test.beforeAll(async () => {
  org = await createOrg('Acme Homes');
  await publishForm(org, complaint);
  for (const property of ['A', 'A', 'B']) await call(201, `/public/forms/REPAIRS/submissions?org=${org.orgId}`, { method: 'POST', body: { values: { property, mobile: '+919812345678' } } });
});

test('the maintenance process comes whole from one template, with an overdue view for the team', async ({ page }) => {
  const problems = watchForProblems(page);
  await signIn(page, org.email);
  await page.goto('/forms');
  await page.getByRole('button', { name: /New form/ }).click();
  await page.getByText('Maintenance complaint (full process)').click();
  await page.getByRole('button', { name: /Create draft/ }).click();
  await expect(page.getByText(/The inbox view "Overdue maintenance" was made for your team/)).toBeVisible();
  const views = await call<{ name: string; filters: Record<string, string> }[]>(200, '/work-views', { token: org.token });
  expect(views.find((v) => v.name === 'Overdue maintenance')?.filters).toMatchObject({ overdue: 'true', open: 'true' });
  expect(problems).toEqual([]);
});

test('a QR code of a form opens from the Forms list', async ({ page }) => {
  await signIn(page, org.email);
  await page.goto('/forms');
  await page.getByRole('button', { name: 'QR code for Repairs' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('img', { name: 'QR code that opens Repairs' })).toBeVisible();
  await expect(dialog.getByText(new RegExp(`/f/${org.orgId}/REPAIRS$`))).toBeVisible();
});

test('a button that wants a photo first says so, refuses without one, and moves with one', async ({ page }) => {
  await signIn(page, org.email);
  await page.goto('/work');
  await page.getByRole('group', { name: 'Views' }).getByRole('button', { name: 'Everything' }).click();
  await page.getByRole('button', { name: 'REP-000001' }).click();
  const record = page.getByRole('dialog');
  await record.getByRole('group', { name: 'Actions' }).getByRole('button', { name: 'Fixed' }).click();
  await expect(record.getByText(/Needs a picture added to the record while it is in this status/)).toBeVisible();
  await record.getByRole('button', { name: 'Fixed' }).last().click();
  await expect(record.getByRole('alert')).toContainText('Add a picture to the record before "Fixed"');
  await record.getByRole('tab', { name: /Files/ }).click();
  const photo = join(tmpdir(), 'repair.png');
  writeFileSync(photo, PNG);
  await record.getByLabel('Add a file').setInputFiles(photo);
  await expect(record.getByRole('tab', { name: /Files \(1\)/ })).toBeVisible();
  // The box stayed open with what was missing: pressed again, it moves now.
  await record.getByRole('button', { name: 'Fixed' }).last().click();
  await expect(record.getByText('Fixed', { exact: true }).first()).toBeVisible();
  await expect.poll(async () => (await call<{ rows: { ref: string; status: string }[] }>(200, '/records?formCode=REPAIRS', { token: org.token })).rows.find((r) => r.ref === 'REP-000001')?.status).toBe('FIXED');
});

test('the reports compare properties side by side, and give a CSV of what is shown', async ({ page }) => {
  await signIn(page, org.email);
  await page.goto('/work/reports');
  await page.getByRole('combobox', { name: 'Form' }).click();
  await page.getByRole('option', { name: 'Repairs' }).click();
  const table = page.getByRole('table');
  await expect(table.getByRole('columnheader', { name: 'Which property?' })).toBeVisible();
  await expect(table.getByRole('row', { name: /Tower A/ })).toContainText('2');
  await expect(table.getByRole('row', { name: /Tower B/ })).toContainText('1');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /Download CSV/ }).click();
  expect((await download).suggestedFilename()).toBe('report-repairs-30-days.csv');
});

test('work that failed is listed on the overview, and run again from its step', async ({ page }) => {
  await signIn(page, org.email);
  await page.goto('/');
  await expect(page.getByText('Work that failed')).toBeVisible();
  await expect(page.getByText(/Text the resident\s+stopped at step 1/).first()).toBeVisible();
  await expect(page.getByText(/SMS service is not set up and tested yet/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Run again from step 1' }).first().click();
  await expect(page.getByText(/Text the resident is running again from step 1/)).toBeVisible();
});
