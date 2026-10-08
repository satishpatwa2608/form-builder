import { expect, test } from '@playwright/test';
import { call, createOrg, formUrl, label, publishForm, signIn, watchForProblems, type Org } from './helpers';

/** When a form is open to the public, whether answers can be saved for later, and publishing at a chosen time. */

let org: Org;
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const fields = [{ id: 'a', type: 'TEXT', name: 'view', label: 'Your view', required: true }];

test.beforeAll(async () => {
  org = await createOrg('Lifecycle');
});

test('a form that has not opened yet, and one that has closed, show a notice instead of their questions', async ({ page }) => {
  await publishForm(org, { name: 'Autumn survey', code: 'AUTUMN', fields, opensAt: iso(48 * HOUR) });
  await publishForm(org, { name: 'Spring survey', code: 'SPRING', fields, closesAt: iso(-HOUR), closedMessage: 'The spring survey has ended. Thank you to everyone who took part.' });
  await publishForm(org, { name: 'Open survey', code: 'OPEN_NOW', fields, opensAt: iso(-HOUR), closesAt: iso(HOUR) });

  await page.goto(formUrl(org, 'AUTUMN'));
  await expect(page.getByText('Autumn survey')).toBeVisible();
  await expect(page.getByText(/This form is not open yet\. It opens on /)).toBeVisible();
  await expect(page.getByLabel(label('Your view'))).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Submit' })).toHaveCount(0);

  await page.goto(formUrl(org, 'SPRING'));
  await expect(page.getByText('The spring survey has ended. Thank you to everyone who took part.')).toBeVisible();
  await expect(page.getByLabel(label('Your view'))).toHaveCount(0);

  await page.goto(formUrl(org, 'OPEN_NOW'));
  await page.getByLabel(label('Your view')).fill('Fine');
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByText(/Thank you/)).toBeVisible();
});

test('the designer sets closing times and turns save-for-later off in the form settings', async ({ page, context }) => {
  const problems = watchForProblems(page);
  const id = (await call<{ definition: { id: string } }>(201, '/forms', {
    method: 'POST',
    token: org.token,
    body: { folderId: org.folderId, definition: { name: 'Raffle', code: 'RAFFLE', businessId: '', access: 'PUBLIC', submission: { method: 'POST', endpointId: 'default-submit' }, fields } },
  })).definition.id;
  await signIn(page, org.email);
  await page.goto(`/forms/${id}/edit`);
  const settings = page.getByLabel('Form settings');
  await expect(settings.getByRole('switch', { name: 'Let people save and continue later' })).toBeChecked();
  await settings.getByRole('switch', { name: 'Let people save and continue later' }).click();

  // Closing before it opens is caught before publishing.
  await settings.getByLabel('Opens', { exact: true }).fill('2030-06-01T09:00');
  await settings.getByLabel('Closes', { exact: true }).fill('2030-05-01T09:00');
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('The form must close after it opens')).toBeVisible();
  await settings.getByLabel('Opens', { exact: true }).fill('');
  await settings.getByLabel('Closes', { exact: true }).fill('2030-05-01T09:00');
  await settings.getByLabel('Message once closed').fill('The raffle is over.');

  await page.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText(/Published RAFFLE v1/)).toBeVisible();

  const form = await context.newPage();
  await form.goto(formUrl(org, 'RAFFLE'));
  await expect(form.getByLabel(label('Your view'))).toBeVisible();
  await expect(form.getByRole('button', { name: 'Save and continue later' })).toHaveCount(0);
  const live = await call<{ definition: { closesAt: string; closedMessage: string; saveForLater: boolean } }>(200, `/forms/${id}`, { token: org.token });
  expect(live.definition).toMatchObject({ closedMessage: 'The raffle is over.', saveForLater: false });
  expect(new Date(live.definition.closesAt).getFullYear()).toBe(2030);
  expect(problems).toEqual([]);
});

test('a draft is scheduled from the builder, shows when it will publish, and the schedule can be cancelled', async ({ page }) => {
  const id = (await call<{ definition: { id: string } }>(201, '/forms', {
    method: 'POST',
    token: org.token,
    body: { folderId: org.folderId, definition: { name: 'Launch', code: 'LAUNCH', businessId: '', access: 'PUBLIC', submission: { method: 'POST', endpointId: 'default-submit' }, fields } },
  })).definition.id;
  await signIn(page, org.email);
  await page.goto(`/forms/${id}/edit`);
  await page.getByRole('button', { name: 'Schedule' }).click();
  const dialog = page.getByRole('dialog', { name: 'Publish later' });

  // A time in the past is refused in the dialog.
  await dialog.getByLabel('Publish on').fill('2020-01-01T09:00');
  await expect(dialog.getByText('Choose a time in the future, or publish now.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Schedule' })).toBeDisabled();

  // More than a year ahead is refused by the server, and the dialog says why.
  await dialog.getByLabel('Publish on').fill('2099-03-04T09:30');
  await dialog.getByRole('button', { name: 'Schedule' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Choose a time within 365 days');

  const soon = new Date(Date.now() + 30 * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  await dialog.getByLabel('Publish on').fill(`${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}T09:30`);
  await dialog.getByRole('button', { name: 'Schedule' }).click();
  await expect(page.getByText(/Scheduled LAUNCH v1/)).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Set to publish by itself on' })).toContainText(String(soon.getFullYear()));
  await expect(page.getByRole('button', { name: 'Scheduled' })).toBeVisible();

  // It shows in the forms list too, and is still not public.
  await page.goto('/forms');
  await expect(page.getByText(/^Publishes /)).toBeVisible();
  expect((await fetch(`http://127.0.0.1:4198/public/forms/LAUNCH?org=${org.orgId}`)).status).toBe(404);

  await page.goto(`/forms/${id}/edit`);
  await page.getByRole('button', { name: 'Scheduled' }).click();
  await page.getByRole('dialog', { name: 'Publish later' }).getByRole('button', { name: 'Cancel the schedule' }).click();
  await expect(page.getByText('Schedule cancelled')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Schedule', exact: true })).toBeVisible();
  expect((await call<{ publishAt: string | null }>(200, `/forms/${id}`, { token: org.token })).publishAt).toBeNull();
});

test('a scheduled draft really does go live by itself when its time comes', async ({ page }) => {
  const id = (await call<{ definition: { id: string } }>(201, '/forms', {
    method: 'POST',
    token: org.token,
    body: { folderId: org.folderId, definition: { name: 'Countdown', code: 'COUNTDOWN', businessId: '', access: 'PUBLIC', submission: { method: 'POST', endpointId: 'default-submit' }, fields } },
  })).definition.id;
  await call(200, `/forms/${id}/schedule`, { method: 'POST', token: org.token, body: { publishAt: iso(3000) } });
  await page.goto(formUrl(org, 'COUNTDOWN'));
  await expect(page.getByText(/isn't available|not found/i).first()).toBeVisible();

  // Nobody touches anything: the server publishes it.
  await expect.poll(async () => (await fetch(`http://127.0.0.1:4198/public/forms/COUNTDOWN?org=${org.orgId}`)).status, { timeout: 20_000, intervals: [500] }).toBe(200);
  await page.reload();
  await expect(page.getByLabel(label('Your view'))).toBeVisible();
  expect((await call<{ definition: { status: string }; publishAt: string | null }>(200, `/forms/${id}`, { token: org.token }))).toMatchObject({ definition: { status: 'PUBLISHED' }, publishAt: null });
});
