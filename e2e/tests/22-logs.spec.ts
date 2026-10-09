import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { addMember, call, createOrg, publishForm, signIn, watchForProblems, type Org } from './helpers';

/**
 * The organisation's log: what the product did for it, line by line with a level,
 * read live in the browser, narrowed, downloaded, and set up per part of the product.
 */

let org: Org;
let ref: string;

async function accessibilityProblems(page: Page) {
  // Cards fade in; a check made halfway through a fade measures the fade, not the page.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(450);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.help} e.g. ${v.nodes[0]?.html.slice(0, 140)}`);
}
const send = (code: string, values: object, expected = 201) => call(expected, `/public/forms/${code}/submissions?org=${org.orgId}`, { method: 'POST', body: { values } });

test.beforeAll(async () => {
  org = await createOrg('Logging');
  const base = {
    fields: [
      { id: 'a', type: 'TEXT', name: 'name', label: 'Name', required: true },
      { id: 'b', type: 'EMAIL', name: 'email', label: 'Email', required: true },
    ],
    workflow: { enabled: true, refPrefix: 'LG', statuses: [{ key: 'NEW', label: 'New', category: 'OPEN' }, { key: 'DONE', label: 'Done', category: 'DONE' }] },
  };
  await publishForm(org, { ...base, name: 'Enquiry', code: 'LOG_OK', automations: [{ id: 'a1', name: 'Thank them', enabled: true, when: 'SUBMITTED', actions: [{ id: 'mail', type: 'EMAIL', to: [{ kind: 'FIELD', field: 'email' }], subject: 'Thanks', body: 'Hello {{name}}' }] }] });
  // A step that cannot work: its address is not one the server may call.
  await publishForm(org, { ...base, workflow: { ...base.workflow, refPrefix: 'BD' }, name: 'Broken hand-over', code: 'LOG_BAD', automations: [{ id: 'a1', name: 'Hand over', enabled: true, when: 'SUBMITTED', actions: [{ id: 'hook', type: 'WEBHOOK', url: 'https://not-allowed.example/in' }] }] });
  ref = (await send('LOG_OK', { name: 'Private Person', email: 'private.person@customer.test' })).ref;
  await send('LOG_BAD', { name: 'Other Person', email: 'other@customer.test' });
});

test('an admin reads what happened, with levels, and finds the failure', async ({ page }) => {
  const problems = watchForProblems(page);
  await signIn(page, org.email);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Logs' }).click();
  await expect(page.getByRole('heading', { name: 'Logs', exact: true })).toBeVisible();
  const log = page.getByRole('log', { name: 'Log lines' });
  await expect(log.getByRole('button').filter({ hasText: 'Response received' }).first()).toBeVisible();
  await expect(log.getByRole('button').filter({ hasText: 'Email sent' }).first()).toContainText('to=p***@customer.test');
  // Never what people answered.
  await expect(log).not.toContainText('Private Person');
  await expect(log).not.toContainText('private.person@customer.test');
  expect(await accessibilityProblems(page)).toEqual([]);

  // Errors only: the step that failed, said in plain words, with where it happened.
  await page.getByLabel('Show').selectOption('ERROR');
  const failed = log.getByRole('button').filter({ hasText: 'Hand over: WEBHOOK failed' });
  await expect(failed).toBeVisible();
  await expect(log.getByRole('button').filter({ hasText: 'Email sent' })).toHaveCount(0);
  await failed.click();
  await expect(failed.getByText('LOG_BAD')).toBeVisible();
  await expect(failed.getByText('Workflow and automations')).toBeVisible();

  // By a reference, and by part of the product.
  await page.getByLabel('Show').selectOption('INFO');
  await page.getByLabel('Find').fill(ref);
  await expect(log.getByRole('button').filter({ hasText: 'Response received' })).toHaveCount(1);
  // Only lines about that response.
  await expect(log.getByRole('button').filter({ hasNotText: ref })).toHaveCount(0);
  await page.getByLabel('Find').fill('');
  await page.getByLabel('From').selectOption('mail');
  await expect(log.getByRole('button').first()).toContainText('[mail]');
  await expect(log.getByRole('button').filter({ hasText: '[workflow]' })).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('debug is switched on for one part, shows more, and says when it will switch itself back', async ({ page }) => {
  const problems = watchForProblems(page);
  await signIn(page, org.email);
  await page.goto('/logs');
  // A response with a mistake leaves no line at the usual level.
  await send('LOG_OK', { name: 'No email' }, 422);
  await page.getByLabel('Show').selectOption('DEBUG');
  const log = page.getByRole('log', { name: 'Log lines' });
  await expect(log.getByRole('button').filter({ hasText: 'Response received' }).first()).toBeVisible();
  await expect(log.getByRole('button').filter({ hasText: 'sent back with mistakes' })).toHaveCount(0);

  await page.getByRole('button', { name: /What is recorded/ }).click();
  const levels = page.getByRole('group', { name: 'Level for each part' });
  await levels.getByLabel('Responses coming in').selectOption('DEBUG');
  await page.getByLabel('Keep debug on for').selectOption('4');
  await page.getByLabel('Keep lines for').selectOption('7');
  expect(await accessibilityProblems(page)).toEqual([]);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved. Debug runs for 4 hours, then goes back to Info by itself.')).toBeVisible();
  await expect(page.getByText(/Debug is on for Responses coming in until/)).toBeVisible();

  // The same mistake now leaves a line: which question, not what was typed. It appears by itself (following).
  await send('LOG_OK', { name: 'Still no email' }, 422);
  const debug = log.getByRole('button').filter({ hasText: 'sent back with mistakes' });
  await expect(debug.first()).toBeVisible({ timeout: 15_000 });
  await expect(debug.first()).toContainText('fields=email');
  await expect(log).not.toContainText('Still no email');
  expect(problems).toEqual([]);
});

test('the log is taken away as a file, and belongs to its organisation alone', async ({ page }) => {
  await signIn(page, org.email);
  await page.goto('/logs');
  await page.getByLabel('From').selectOption('workflow');
  await expect(page.getByRole('log', { name: 'Log lines' }).getByRole('button').first()).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download/ }).click()]);
  expect(download.suggestedFilename()).toMatch(/^form-builder-\d{4}-\d{2}-\d{2}\.log$/);
  const rows = readFileSync(await download.path(), 'utf8').trim().split('\n');
  expect(rows.every((r) => /^\d{4}-\d{2}-\d{2}T[\d:.]+Z (DEBUG|INFO |WARN |ERROR) \[workflow\] /.test(r))).toBe(true);
  expect(rows.some((r) => r.includes('Hand over: WEBHOOK failed'))).toBe(true);

  // Another organisation sees nothing of it; a designer here has no Logs at all.
  const other = await createOrg('Elsewhere');
  const theirs = await call<{ lines: { message: string; context: Record<string, unknown> }[] }>(200, '/org/logs?limit=500', { token: other.token });
  expect(JSON.stringify(theirs)).not.toMatch(/LOG_OK|LOG_BAD|Hand over/);
  const designer = await addMember(org, 'Dee Designer', 'DESIGNER');
  await call(403, '/org/logs', { token: designer.token });
});

test('the audit trail names what was done in words', async ({ page }) => {
  await signIn(page, org.email);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Audit trail' }).click();
  await expect(page.getByRole('heading', { name: 'Audit trail' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Changed what the log records' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Published a form' }).first()).toBeVisible();
  // No raw action names left showing.
  for (const what of await page.locator('tbody tr td:nth-child(3)').allTextContents()) expect(what).not.toMatch(/^[a-z_]+\.[a-z_.]+$/);
});
