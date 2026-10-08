import { expect, test } from '@playwright/test';
import { call, createOrg, formUrl, signIn, watchForProblems, type Org } from './helpers';

/** A last sweep: every screen of the builder app opens cleanly, and each built-in template makes a working form. */

let org: Org;

test.beforeAll(async () => {
  org = await createOrg('Sweep');
});

const screens: [path: string, shows: RegExp][] = [
  ['/', /overview|welcome|forms/i],
  ['/forms', /Forms/],
  ['/work', /Inbox/],
  ['/work/dashboard', /My work/],
  ['/work/new', /New work item/],
  ['/connectors', /Connectors/],
  ['/members', /Members/],
  ['/access', /Folders/],
  ['/audit', /Audit/],
  ['/settings', /Branding/],
  ['/settings/working-time', /Working/i],
  ['/settings/webhooks', /Webhooks/],
  ['/account', /Account & security/],
];

test('every screen opens for the owner without an error on the page or from the server', async ({ page }) => {
  const problems = watchForProblems(page);
  await signIn(page, org.email);
  for (const [path, shows] of screens) {
    await page.goto(path);
    await expect(page.locator('main, body').first(), path).toContainText(shows);
    // Give late requests a moment to fail loudly if they are going to.
    await page.waitForLoadState('networkidle');
  }
  expect(problems).toEqual([]);
});

test('the organisation page shows the plan and what has been used of it', async ({ page }) => {
  await signIn(page, org.email);
  await page.goto('/settings');
  const usage = await call<{ plan: string }>(200, '/org/usage', { token: org.token });
  await expect(page.locator('main')).toContainText(new RegExp(usage.plan, 'i'));
  await expect(page.locator('main')).toContainText(/forms/i);
  await expect(page.locator('main')).toContainText(/responses/i);
});

test('a webhook is set up from its page, and only for an address that is allowed', async ({ page }) => {
  await signIn(page, org.email);
  await page.goto('/settings/webhooks');
  await page.getByRole('button', { name: /add|new/i }).first().click();
  await page.getByLabel('Name', { exact: true }).fill('CRM');
  // A plain http address inside a private network is refused by the server.
  await page.getByLabel('URL', { exact: true }).fill('http://10.0.0.5/hook');
  await page.getByRole('button', { name: /^save/i }).click();
  await expect(page.getByText(/https|not allowed|allow/i).first()).toBeVisible();
  expect((await call<{ webhooks: unknown[] }>(200, '/webhooks', { token: org.token })).webhooks).toHaveLength(0);
});

for (const template of ['Customer complaint', 'Plant issue report', 'Supplier registration']) {
  test(`the "${template}" template makes a form that publishes and opens for the public`, async ({ page, context }) => {
    const problems = watchForProblems(page);
    await signIn(page, org.email);
    await page.goto('/forms');
    await page.getByRole('button', { name: 'New form' }).click();
    await page.getByRole('radiogroup', { name: 'Start from' }).getByText(template, { exact: true }).click();
    const name = `${template} (from template)`;
    await page.getByLabel('Name', { exact: true }).fill(name);
    const code = await page.getByLabel('Code', { exact: true }).inputValue();
    await page.getByRole('button', { name: 'Create draft' }).click();
    await expect(page.getByText(`"${name}" was created as a draft.`)).toBeVisible();

    // Open it in the builder: nothing to fix, so it publishes as it is.
    await page.getByText(name, { exact: true }).click();
    await expect(page.getByLabel('Field palette')).toBeVisible();
    await expect(page.getByText(/to fix before publishing/)).toHaveCount(0);
    await page.getByRole('button', { name: 'Publish' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText(new RegExp(`Published ${code} v1`))).toBeVisible();

    const form = await context.newPage();
    const formProblems = watchForProblems(form);
    await form.goto(formUrl(org, code));
    await expect(form.getByRole('heading', { name })).toBeVisible();
    await expect(form.getByRole('button', { name: /submit|next/i }).first()).toBeVisible();
    // Empty, it is refused with its mistakes listed rather than sent.
    await form.getByRole('button', { name: /submit|next/i }).first().click();
    await expect(form.getByText(/is required|Please/).first()).toBeVisible();
    expect(problems).toEqual([]);
    expect(formProblems).toEqual([]);
  });
}
