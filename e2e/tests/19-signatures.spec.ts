import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { call, createOrg, mails, publishForm, signIn, waitForMail, watchForProblems, type Org } from './helpers';
import { API, RUNTIME } from '../stack';

/**
 * Sending a response out to be signed: each signer gets a private link by email,
 * signs on our page, and the signed PDF (with who signed and when) is kept on the record.
 */

let org: Org;
const stamp = Date.now();
const applicant = `applicant-${stamp}@customer.test`;
const guarantor = `guarantor-${stamp}@customer.test`;

const loan = {
  name: 'Loan agreement',
  code: 'LOAN_AGREEMENT',
  fields: [
    { id: 'f1', type: 'TEXT', name: 'name', label: 'Your name', required: true },
    { id: 'f2', type: 'EMAIL', name: 'email', label: 'Your email', required: true },
    { id: 'f3', type: 'EMAIL', name: 'guarantor', label: 'Guarantor email', required: true },
    { id: 'f4', type: 'NUMBER', name: 'amount', label: 'Amount', required: true },
  ],
  workflow: {
    enabled: true,
    refPrefix: 'LN',
    statuses: [
      { key: 'NEW', label: 'New', category: 'OPEN' },
      { key: 'SIGNED', label: 'Signed', category: 'DONE' },
      { key: 'DROPPED', label: 'Dropped', category: 'DONE' },
    ],
  },
  automations: [
    {
      id: 'a1',
      name: 'Agreement',
      enabled: true,
      when: 'SUBMITTED',
      actions: [
        { id: 'sign', type: 'SIGN', to: [{ kind: 'FIELD', field: 'email' }, { kind: 'FIELD', field: 'guarantor' }], title: 'Loan agreement {{$record.ref}}', message: 'Dear {{name}}, please read and sign.', expiresInDays: 7 },
        { id: 'ok', type: 'SET_STATUS', status: 'SIGNED', if: { field: '$steps.sign.status', operator: 'equals', value: 'SIGNED' } },
        { id: 'no', type: 'SET_STATUS', status: 'DROPPED', if: { field: '$steps.sign.status', operator: 'equals', value: 'DECLINED' } },
        { id: 'tell', type: 'EMAIL', to: [{ kind: 'FIELD', field: 'email' }], subject: 'Agreement {{$record.ref}}: {{$steps.sign.status}}', body: 'Thank you.' },
      ],
    },
  ],
};

const apply = async (name: string, a = applicant, g = guarantor) =>
  (await call<{ submissionId: string }>(201, `/public/forms/LOAN_AGREEMENT/submissions?org=${org.orgId}`, { method: 'POST', body: { values: { name, email: a, guarantor: g, amount: 50000 } } })).submissionId;

/** The newest signing link sent to an address about a reference. */
async function signLink(to: string, ref: string): Promise<string> {
  const mail = await waitForMail(to, new RegExp(`asks you to sign: Loan agreement ${ref}`));
  const link = mail.text.match(/https?:\/\/\S+\/sign\/fbsig_[A-Za-z0-9_-]+/)?.[0];
  if (!link) throw new Error(`No signing link in the mail to ${to}: ${mail.text}`);
  return link;
}
const tokenOf = (link: string) => link.split('/sign/')[1]!;

async function accessibilityProblems(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.help} e.g. ${v.nodes[0]?.html.slice(0, 120)}`);
}

let firstRecord: string;

test.beforeAll(async () => {
  org = await createOrg('Lender');
  await publishForm(org, loan);
  firstRecord = await apply('Asha Rao');
});

test('the first signer reads the document and signs with a typed name; only then is the second asked', async ({ page }) => {
  const problems = watchForProblems(page);
  const link = await signLink(applicant, 'LN-000001');
  // One after another: the guarantor hears nothing yet.
  expect(mails().filter((m) => m.to === guarantor)).toEqual([]);

  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'Loan agreement LN-000001' })).toBeVisible();
  await expect(page.getByText(/asks you to sign/)).toBeVisible();
  await expect(page.getByText('Dear Asha Rao, please read and sign.')).toBeVisible();
  expect(await accessibilityProblems(page)).toEqual([]);

  // The document is the PDF of the response, readable with nothing but the link.
  const href = await page.getByRole('link', { name: /Read the document/ }).getAttribute('href');
  const original = Buffer.from(await (await fetch(href!)).arrayBuffer());
  expect(original.subarray(0, 5).toString()).toBe('%PDF-');

  // Nothing is sent until there is a name and the box is ticked.
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Type your full name');
  await page.getByLabel('Your full name').fill('Asha Rao');
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Tick the box');
  expect(await accessibilityProblems(page)).toEqual([]);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Thank you, you have signed' })).toBeVisible();
  await expect(page.getByText(/One other person still has to sign/)).toBeVisible();

  // The same link cannot sign again.
  const again = await fetch(`${API}/public/sign/${tokenOf(link)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Someone', signature: 'data:image/png;base64,AAAA', agreed: true }) });
  expect(again.status).toBeGreaterThanOrEqual(400);
  // Now the guarantor is asked, with a link of their own.
  expect(tokenOf(await signLink(guarantor, 'LN-000001'))).not.toBe(tokenOf(link));
  expect(problems).toEqual([]);
});

test('the second signer draws a signature; everyone gets the signed PDF and the flow carries on', async ({ page }) => {
  const problems = watchForProblems(page);
  const link = await signLink(guarantor, 'LN-000001');
  await page.goto(link);
  await page.getByLabel('Your full name').fill('Ravi Kumar');
  const pad = page.locator('canvas.rt-sign__pad');
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 70, { steps: 6 });
  await page.mouse.move(box.x + 200, box.y + 30, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Clear' })).toBeVisible();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Thank you, you have signed' })).toBeVisible();

  // Everyone has signed: the link now gives the signed document, which is the original plus who signed.
  const href = await page.getByRole('link', { name: /Open the signed document/ }).getAttribute('href');
  const signed = Buffer.from(await (await fetch(href!)).arrayBuffer());
  expect(signed.subarray(0, 5).toString()).toBe('%PDF-');

  // The flow went on from the step after, knowing how it ended.
  await waitForMail(applicant, /Agreement LN-000001: SIGNED/);
  await expect.poll(async () => (await call<{ record: { status: string } }>(200, `/records/${firstRecord}`, { token: org.token })).record.status).toBe('SIGNED');
  // Both signers are sent the signed copy to keep.
  await waitForMail(applicant, /^Signed by everyone: Loan agreement LN-000001$/);
  await waitForMail(guarantor, /^Signed by everyone: Loan agreement LN-000001$/);
  expect(problems).toEqual([]);
});

test('staff see who signed on the record and download the signed PDF', async ({ page }) => {
  const problems = watchForProblems(page);
  await signIn(page, org.email);
  await page.goto('/work');
  // Signed means done, so it is no longer among the open items.
  await page.getByRole('button', { name: 'Everything' }).click();
  await page.getByText('LN-000001').first().click();
  const section = page.getByRole('dialog').getByRole('region', { name: 'Signatures' });
  await expect(section).toContainText('Loan agreement LN-000001');
  await expect(section).toContainText('Signed by everyone');
  await expect(section.getByRole('listitem').nth(0)).toContainText(`1. ${applicant} - Signed as Asha Rao`);
  await expect(section.getByRole('listitem').nth(1)).toContainText(`2. ${guarantor} - Signed as Ravi Kumar`);
  const [download] = await Promise.all([page.waitForEvent('download'), section.getByRole('button', { name: 'Download signed PDF' }).click()]);
  expect(download.suggestedFilename()).toBe('LN-000001-signed.pdf');
  expect(readFileSync(await download.path()).subarray(0, 5).toString()).toBe('%PDF-');
  // What happened is in the record's history too.
  await expect(page.getByRole('dialog')).toContainText(/signed by all 2 signers/);
  expect(problems).toEqual([]);
});

test('a signer declines with a reason: nobody else is asked and the flow is told', async ({ page }) => {
  const problems = watchForProblems(page);
  const a = `second-${stamp}@customer.test`;
  const g = `never-${stamp}@customer.test`;
  const recordId = await apply('Meera Nair', a, g);
  await page.goto(await signLink(a, 'LN-000002'));
  await page.getByRole('button', { name: 'Decline', exact: true }).click();
  await expect(page.getByText(/nobody else will be asked to sign/)).toBeVisible();
  await page.getByLabel(/Why are you declining/).fill('The amount is wrong');
  await page.getByRole('button', { name: 'Decline to sign' }).click();
  await expect(page.getByRole('heading', { name: 'This document was declined' })).toBeVisible();

  await waitForMail(a, /Agreement LN-000002: DECLINED/);
  await expect.poll(async () => (await call<{ record: { status: string } }>(200, `/records/${recordId}`, { token: org.token })).record.status).toBe('DROPPED');
  expect(mails().filter((m) => m.to === g)).toEqual([]);
  const list = await call<{ status: string; hasSignedDocument: boolean; signers: { status: string; declineReason?: string }[] }[]>(200, `/records/${recordId}/signatures`, { token: org.token });
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ status: 'DECLINED', hasSignedDocument: false });
  expect(list[0]!.signers[0]).toMatchObject({ status: 'DECLINED', declineReason: 'The amount is wrong' });
  expect(problems).toEqual([]);
});

test('a link that was never issued says so, and gives nothing away', async ({ page }) => {
  await page.goto(`${RUNTIME}/sign/fbsig_${'x'.repeat(43)}`);
  await expect(page.getByRole('heading', { name: "This link can't be used" })).toBeVisible();
  await expect(page.getByText('Loan agreement')).toHaveCount(0);
});

test('a designer adds a signature step in plain words', async ({ page }) => {
  const problems = watchForProblems(page);
  const id = (
    await call<{ definition: { id: string } }>(201, '/forms', {
      method: 'POST',
      token: org.token,
      body: { folderId: org.folderId, definition: { name: 'Consent', code: 'CONSENT', businessId: '', access: 'PUBLIC', submission: { method: 'POST', endpointId: 'default-submit' }, fields: [{ id: 'e', type: 'EMAIL', name: 'email', label: 'Email', required: true }] } },
    })
  ).definition.id;
  await signIn(page, org.email);
  await page.goto(`/forms/${id}/edit`);
  await page.getByRole('button', { name: /Workflow/ }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: /Automations/ }).click();
  await dialog.getByRole('button', { name: /New automation/ }).click();
  await dialog.getByRole('button', { name: 'Add a step at the start' }).click();
  await dialog.getByRole('group', { name: 'Choose a step' }).getByRole('button', { name: /Send for signature/ }).click();
  // The form's email field is already the signer; nothing has to be typed.
  await expect(dialog.getByText('1. Send for signature')).toBeVisible();
  await expect(dialog.getByLabel('What is being signed')).toHaveValue('Consent');
  await expect(dialog.getByRole('combobox', { name: 'When there are several signers' })).toContainText('One after another');
  expect(problems).toEqual([]);
});
