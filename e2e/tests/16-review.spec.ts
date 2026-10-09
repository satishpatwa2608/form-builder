import { expect, test, type Page } from '@playwright/test';
import { addMember, call, createOrg, signIn, watchForProblems, type Org } from './helpers';

/** Review before publish: a designer asks, a publisher comments and asks for changes, then approves; only then does the form go live. */

let org: Org;
let designer: Awaited<ReturnType<typeof addMember>>;
let publisher: Awaited<ReturnType<typeof addMember>>;
let formId: string;

const canvas = (page: Page) => page.locator('.fb-canvas, [aria-label="Form canvas"]').first();
const openReview = async (page: Page) => {
  await page.getByRole('button', { name: /^Review/ }).click();
  return page.getByRole('dialog', { name: 'Review' });
};

test.beforeAll(async () => {
  org = await createOrg('People');
  designer = await addMember(org, 'Dev Designer', 'DESIGNER');
  publisher = await addMember(org, 'Pia Publisher', 'PUBLISHER');
  formId = (
    await call<{ definition: { id: string } }>(201, '/forms', {
      method: 'POST',
      token: designer.token,
      body: {
        folderId: org.folderId,
        definition: {
          name: 'Leave request',
          code: 'LEAVE_REQUEST',
          businessId: '',
          access: 'PUBLIC',
          submission: { method: 'POST', endpointId: 'default-submit' },
          fields: [
            { id: 'a', type: 'TEXT', name: 'name', label: 'Your name', required: true },
            { id: 'b', type: 'EMAIL', name: 'email', label: 'Email' },
          ],
        },
      },
    })
  ).definition.id;
});

test('an admin makes review a condition of publishing', async ({ page }) => {
  await signIn(page, org.email);
  await page.goto('/settings');
  const row = page.locator('.st-row').filter({ hasText: 'Review before publishing' });
  await row.getByRole('button', { name: 'Require it' }).click();
  await expect(page.getByText('Forms must now be approved by someone else before they are published.')).toBeVisible();
  await expect(row.getByRole('button', { name: 'Stop requiring' })).toBeVisible();
});

test('a designer asks for a review; until it is approved the form cannot be published', async ({ page }) => {
  const problems = watchForProblems(page);
  await signIn(page, designer.email);
  await page.goto(`/forms/${formId}/edit`);
  const dialog = await openReview(page);
  await expect(dialog.getByRole('status', { name: 'Review status' })).toHaveText('Your organisation publishes a form only once someone else has approved it.');
  await dialog.getByLabel('Note to the reviewer').fill('Please check the wording.');
  await dialog.getByRole('button', { name: 'Ask for a review' }).click();
  await expect(dialog.getByRole('status', { name: 'Review status' })).toContainText('Dev Designer asked for a review');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /^Review/ })).toContainText('Waiting');

  const refused = await call<{ errors: { message: string }[] }>(400, `/forms/${formId}/publish`, { method: 'POST', token: org.token });
  expect(refused.errors[0].message).toBe('This form is waiting for its review. It can be published once a reviewer approves it.');
  expect(problems).toEqual([]);
});

test('a publisher sees it waiting, comments on a field and asks for changes', async ({ page }) => {
  const problems = watchForProblems(page);
  await signIn(page, publisher.email);
  await page.goto('/forms');
  await expect(page.getByRole('row').filter({ hasText: 'Leave request' })).toContainText('Waiting for review');

  await page.goto(`/forms/${formId}/edit`);
  // Trying to publish says, in a sentence, what stands in the way.
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('This form is waiting for its review. It can be published once a reviewer approves it.')).toBeVisible();

  await canvas(page).locator('.fb-card__label', { hasText: 'Email' }).click();
  const dialog = await openReview(page);
  await expect(dialog.getByRole('status', { name: 'Review status' })).toContainText('“Please check the wording.”');
  await dialog.getByLabel('New comment').fill('Say "Work email".');
  await expect(dialog.getByRole('checkbox', { name: /About “Email”/ })).toBeChecked();
  await dialog.getByRole('button', { name: 'Add comment' }).click();
  await expect(dialog.getByRole('list', { name: 'Comments' })).toContainText('Say "Work email".');
  await expect(dialog.getByRole('button', { name: 'Ask for changes' })).toBeDisabled();
  await dialog.getByLabel('Note to the author').fill('One wording change, see the comment.');
  await dialog.getByRole('button', { name: 'Ask for changes' }).click();
  await expect(dialog.getByRole('status', { name: 'Review status' })).toContainText('Pia Publisher asked for changes');
  expect(problems).toEqual([]);
});

test('the designer follows the comment to its field, fixes it, resolves the comment and asks again', async ({ page }) => {
  const problems = watchForProblems(page);
  await signIn(page, designer.email);
  await page.goto('/forms');
  await expect(page.getByRole('row').filter({ hasText: 'Leave request' })).toContainText('Changes asked');
  await page.goto(`/forms/${formId}/edit`);
  let dialog = await openReview(page);
  await expect(dialog.getByRole('status', { name: 'Review status' })).toContainText('“One wording change, see the comment.”');
  await dialog.getByRole('button', { name: 'on Email' }).click();
  // The comment took us to the field it is about.
  await expect(page.getByLabel('Label', { exact: true })).toHaveValue('Email');
  await page.getByLabel('Label', { exact: true }).fill('Work email');

  dialog = await openReview(page);
  await expect(dialog.getByRole('button', { name: 'Ask for a review' })).toBeDisabled();
  await expect(dialog.getByText('Save the draft first, so the reviewer sees your changes.')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved')).toBeVisible();

  dialog = await openReview(page);
  await dialog.getByRole('button', { name: 'Resolve' }).click();
  await expect(dialog.getByText('Resolved by Dev Designer')).toBeVisible();
  await dialog.getByRole('button', { name: 'Ask for a review' }).click();
  await expect(dialog.getByRole('status', { name: 'Review status' })).toContainText('Waiting for a reviewer');
  expect(problems).toEqual([]);
});

test('the publisher approves and publishes; a change after approval would need a new review', async ({ page }) => {
  const problems = watchForProblems(page);
  await signIn(page, publisher.email);
  await page.goto(`/forms/${formId}/edit`);
  const dialog = await openReview(page);
  await dialog.getByLabel('Note to the author').fill('Good to go.');
  await dialog.getByRole('button', { name: 'Approve' }).click();
  await expect(dialog.getByRole('status', { name: 'Review status' })).toContainText('Approved by Pia Publisher');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /^Review/ })).toContainText('Approved');

  // The author changes it after the approval: it no longer counts.
  const def = (await call<{ definition: Record<string, unknown> }>(200, `/forms/${formId}`, { token: designer.token })).definition;
  await call(200, `/forms/${formId}`, { method: 'PUT', token: designer.token, body: { ...def, name: 'Leave request (new)' } });
  const stale = await call<{ errors: { message: string }[] }>(400, `/forms/${formId}/publish`, { method: 'POST', token: publisher.token });
  expect(stale.errors[0].message).toBe('This form was changed after it was approved. Ask for a review again.');
  await call(200, `/forms/${formId}`, { method: 'PUT', token: designer.token, body: def });

  // Back as it was approved, it is published from the builder.
  await page.reload();
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText(/Published LEAVE_REQUEST v1/)).toBeVisible();
  const live = await call<{ definition: { status: string; fields: { label: string }[] } }>(200, `/forms/${formId}`, { token: org.token });
  expect(live.definition.status).toBe('PUBLISHED');
  expect(live.definition.fields.map((f) => f.label)).toEqual(['Your name', 'Work email']);
  expect(problems).toEqual([]);
});
