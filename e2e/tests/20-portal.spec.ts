import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { call, createOrg, label, mails, publishForm, signIn, waitForMail, watchForProblems, type Org } from './helpers';
import { RUNTIME } from '../stack';

/**
 * The requests portal: the people an organisation serves start a form there,
 * sign in with a link sent to their email, and follow what they have sent.
 */

let org: Org;
let formId: string;
const stamp = Date.now();
const ravi = `ravi-${stamp}@customer.test`;
const meena = `meena-${stamp}@customer.test`;
const portal = () => `${RUNTIME}/portal/${org.orgId}`;

async function accessibilityProblems(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.help} e.g. ${v.nodes[0]?.html.slice(0, 120)}`);
}
/** The newest sign-in link sent to an address. */
async function linkFor(to: string): Promise<string> {
  const mail = await waitForMail(to, /^Your link to /);
  return mail.text.match(/https?:\/\/\S+\/portal\/\S+\?key=fbportal_[A-Za-z0-9_-]+/)![0];
}

test.beforeAll(async () => {
  org = await createOrg('Helpdesk');
  formId = await publishForm(org, {
    name: 'Laptop request',
    code: 'LAPTOP',
    description: 'Ask for a new or replacement laptop',
    fields: [
      { id: 'a', type: 'TEXT', name: 'what', label: 'What do you need', required: true },
      { id: 'b', type: 'EMAIL', name: 'email', label: 'Your email', required: true },
    ],
    workflow: {
      enabled: true,
      refPrefix: 'LAP',
      statuses: [
        { key: 'NEW', label: 'Received', category: 'OPEN' },
        { key: 'ORDERED', label: 'Ordered', category: 'IN_PROGRESS' },
        { key: 'DONE', label: 'Delivered', category: 'DONE' },
      ],
    },
  });
});

test('there is no portal until an admin switches it on in Organisation settings', async ({ page, context }) => {
  const problems = watchForProblems(page);
  const visitor = await context.newPage();
  await visitor.goto(portal());
  await expect(visitor.getByRole('heading', { name: "This page isn't available" })).toBeVisible();

  await signIn(page, org.email);
  await page.goto('/settings');
  const card = page.locator('.st-card', { hasText: 'Requests portal' });
  await card.getByRole('checkbox', { name: 'Switch the portal on' }).check();
  await card.getByLabel('Heading', { exact: true }).fill('IT help desk');
  await card.getByLabel('Introduction (optional)').fill('Ask for equipment and follow your requests.');
  await card.getByRole('button', { name: 'Save portal' }).click();
  await expect(card.getByText('Portal saved. It is open at the address below.')).toBeVisible();
  await expect(card.getByRole('link')).toHaveAttribute('href', portal());

  // On, but with nothing listed yet.
  await visitor.reload();
  await expect(visitor.getByRole('heading', { name: 'IT help desk' })).toBeVisible();
  await expect(visitor.getByText('There are no forms here at the moment.')).toBeVisible();
  expect(problems).toEqual([]);
});

test('a designer lists a form on the portal with one switch', async ({ page }) => {
  const problems = watchForProblems(page);
  await signIn(page, org.email);
  await page.goto(`/forms/${formId}/edit`);
  // A live form is changed in a new version; the live one stays as it is until that is published.
  await page.getByRole('button', { name: /Edit as new version/ }).click();
  const settings = page.getByLabel('Form settings');
  await expect(settings.getByRole('switch', { name: 'List on the requests portal' })).toBeEnabled();
  await settings.getByRole('switch', { name: 'List on the requests portal' }).click();
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText(/Published LAPTOP v2/)).toBeVisible();
  expect((await call<{ forms: { code: string }[] }>(200, `/public/portal/${org.orgId}`)).forms).toEqual([{ code: 'LAPTOP', name: 'Laptop request', description: 'Ask for a new or replacement laptop' }]);
  expect(problems).toEqual([]);
});

test('a requester starts a form from the portal, signs in by emailed link, and follows it as staff move it on', async ({ page }) => {
  const problems = watchForProblems(page);
  await page.goto(portal());
  await expect(page.getByText('Ask for equipment and follow your requests.')).toBeVisible();
  expect(await accessibilityProblems(page)).toEqual([]);

  await page.getByRole('link', { name: 'Laptop request' }).click();
  await page.getByLabel(label('What do you need')).fill('A 14 inch laptop');
  await page.getByLabel(label('Your email')).fill(ravi);
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByText(/LAP-000001/)).toBeVisible();

  // Back on the portal: nothing of theirs is shown until they prove the address is theirs.
  await page.goto(portal());
  await expect(page.getByRole('table')).toHaveCount(0);
  await page.getByLabel(/enter your email address/).fill(ravi);
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page.getByRole('status')).toContainText('a link is on its way');

  await page.goto(await linkFor(ravi));
  const table = page.getByRole('table');
  await expect(table.getByRole('row', { name: /LAP-000001/ })).toContainText('Laptop request');
  await expect(table.getByRole('row', { name: /LAP-000001/ })).toContainText('Received');
  await expect(page.getByText('1 open request.')).toBeVisible();
  // The key is gone from the address bar, and what they wrote is not shown back.
  expect(new URL(page.url()).search).toBe('');
  await expect(page.getByText('A 14 inch laptop')).toHaveCount(0);
  expect(await accessibilityProblems(page)).toEqual([]);

  // Staff order it, then deliver it.
  const recordId = (await call<{ rows: { uuid: string }[] }>(200, '/records', { token: org.token })).rows[0]!.uuid;
  await call(200, `/records/${recordId}/status`, { method: 'POST', token: org.token, body: { to: 'ORDERED' } });
  await page.reload();
  await expect(page.getByRole('table').getByRole('row', { name: /LAP-000001/ })).toContainText('Ordered');
  await call(200, `/records/${recordId}/status`, { method: 'POST', token: org.token, body: { to: 'DONE' } });
  await page.reload();
  await expect(page.getByRole('table').getByRole('row', { name: /LAP-000001/ })).toContainText('Delivered');
  await expect(page.getByText('Nothing is open at the moment.')).toBeVisible();

  // Signing out closes it in this tab.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Email me a link' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('table')).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('someone else sees none of it, and a used link does not work twice', async ({ page, context }) => {
  await page.goto(portal());
  await page.getByLabel(/enter your email address/).fill(meena);
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page.getByRole('status')).toBeVisible();
  const link = await linkFor(meena);
  await page.goto(link);
  await expect(page.getByText('Nothing has been sent from this address yet.')).toBeVisible();
  await expect(page.getByText('LAP-000001')).toHaveCount(0);

  // The same link in another browser: used up.
  const second = await (await context.browser()!.newContext()).newPage();
  await second.goto(link);
  await expect(second.getByRole('alert')).toContainText('This link has been used or has run out');
  await expect(second.getByRole('table')).toHaveCount(0);
  await second.context().close();

  // Ravi was never sent Meena's link, and the other way round.
  expect(mails().filter((m) => m.to === ravi && m.text.includes(link))).toEqual([]);
});
