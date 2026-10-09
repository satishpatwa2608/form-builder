import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { SMTPServer } from 'smtp-server';
import { call, createOrg, mails, publishForm, signIn, watchForProblems, type Org } from './helpers';

/**
 * An organisation's own mail server: set up in Organisation settings, proven with
 * a test email, switched on; emails to the people who fill in its forms then come from its address.
 */

interface Received {
  from: string;
  to: string[];
  raw: string;
  user: string;
  secure: boolean;
}
const inbox: Received[] = [];
// One of the ports the settings offer, so the test goes through the same choices an admin has.
const PORT = 2525;
const server = new SMTPServer({
  authMethods: ['PLAIN', 'LOGIN'],
  onAuth: (auth, _session, done) => (auth.username === 'mailer' && auth.password === 'app-password' ? done(null, { user: auth.username }) : done(new Error('Invalid login'))),
  onData(stream, session, done) {
    let raw = '';
    stream.on('data', (c: Buffer) => (raw += c.toString()));
    stream.on('end', () => {
      inbox.push({ from: (session.envelope.mailFrom as { address: string }).address, to: session.envelope.rcptTo.map((r) => r.address), raw, user: String(session.user), secure: session.secure });
      done();
    });
  },
  logger: false,
});

let org: Org;
const customer = `customer-${Date.now()}@customer.test`;

test.beforeAll(async () => {
  await new Promise<void>((done) => server.listen(PORT, '127.0.0.1', done));
  expect((server.server.address() as AddressInfo).port).toBe(PORT);
  org = await createOrg('Posting');
  await publishForm(org, {
    name: 'Callback',
    code: 'CALLBACK_MAIL',
    fields: [
      { id: 'a', type: 'TEXT', name: 'name', label: 'Name', required: true },
      { id: 'b', type: 'EMAIL', name: 'email', label: 'Email', required: true },
    ],
    automations: [{ id: 'a1', name: 'Thanks', enabled: true, when: 'SUBMITTED', actions: [{ id: 'mail', type: 'EMAIL', to: [{ kind: 'FIELD', field: 'email' }], subject: 'Thanks {{name}}', body: 'We will call you, {{name}}.' }] }],
  });
});
test.afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

const send = (email: string) => call(201, `/public/forms/CALLBACK_MAIL/submissions?org=${org.orgId}`, { method: 'POST', body: { values: { name: 'Ravi', email } } });

test('an admin sets up the mail server, proves it with a test email, and switches it on', async ({ page }) => {
  const problems = watchForProblems(page);
  await signIn(page, org.email);
  await page.goto('/settings');
  const card = page.locator('.st-card', { hasText: 'Email sending' });
  await expect(card.getByLabel('Send them through')).toHaveValue('DEFAULT');

  await card.getByLabel('Send them through').selectOption('SMTP');
  await card.getByLabel('Address to send from').fill('helpdesk@posting.test');
  await card.getByLabel('Name shown to the reader').fill('Posting help desk');
  await card.getByLabel('Mail server').fill('127.0.0.1');
  await card.getByLabel('Port').selectOption('2525');
  await card.getByLabel('User name').fill('mailer');
  await card.getByLabel('Password').fill('wrong');
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card.getByText('Saved. Now send yourself a test email.')).toBeVisible();
  await expect(card.getByText('Not tested')).toBeVisible();
  // Nothing to switch on yet.
  await expect(card.getByRole('button', { name: 'Switch it on' })).toHaveCount(0);

  // A wrong password is said in plain words.
  await card.getByRole('button', { name: 'Send me a test email' }).click();
  await expect(card.getByText('The mail server refused the user name or password.').first()).toBeVisible();
  expect(inbox).toHaveLength(0);

  await card.getByLabel('Password').fill('app-password');
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card.getByText('Saved. Now send yourself a test email.')).toBeVisible();
  await card.getByRole('button', { name: 'Send me a test email' }).click();
  await expect(card.getByText(new RegExp(`A test email is on its way to ${org.email}`))).toBeVisible();
  await expect.poll(() => inbox.length).toBe(1);
  expect(inbox[0]).toMatchObject({ from: 'helpdesk@posting.test', to: [org.email], user: 'mailer', secure: true });
  expect(inbox[0]!.raw).toMatch(/From: "?Posting help desk"? <helpdesk@posting\.test>/);

  await card.getByRole('button', { name: 'Switch it on' }).click();
  await expect(card.getByText(/now come from your address/)).toBeVisible();
  await expect(card.getByText('On', { exact: true })).toBeVisible();
  // The password was never sent back to the page.
  await expect(card.getByLabel('Password')).toHaveValue('');
  expect(problems).toEqual([]);
});

test('a workflow email then reaches the customer from the organisation\'s own address, not ours', async () => {
  await send(customer);
  await expect.poll(() => inbox.find((m) => m.to.includes(customer))?.from).toBe('helpdesk@posting.test');
  const got = inbox.find((m) => m.to.includes(customer))!;
  expect(got.raw).toContain('Subject: Thanks Ravi');
  expect(got.raw).toContain('We will call you, Ravi.');
  expect(got.secure).toBe(true);
  expect(mails().filter((m) => m.to === customer)).toEqual([]);
});

test('switched off again, emails go out from Form Builder as before', async ({ page }) => {
  await signIn(page, org.email);
  await page.goto('/settings');
  const card = page.locator('.st-card', { hasText: 'Email sending' });
  await card.getByRole('button', { name: 'Stop using it' }).click();
  await expect(card.getByText(/Emails go out from Form Builder again/)).toBeVisible();
  const later = `later-${Date.now()}@customer.test`;
  const before = inbox.length;
  await send(later);
  await expect.poll(() => mails().some((m) => m.to === later && m.subject === 'Thanks Ravi')).toBe(true);
  expect(inbox).toHaveLength(before);
});
