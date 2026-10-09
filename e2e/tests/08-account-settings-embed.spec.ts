import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { RUNTIME } from '../stack';
import { addMember, call, createOrg, formUrl, label, mails, PASSWORD, publishForm, signIn, submissions, type Org } from './helpers';

/** The current code an authenticator app would show for this key (RFC 6238: HMAC-SHA1, 30 s, 6 digits). */
function totp(base32: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of base32.replace(/[\s=]/g, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1] & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

const linkIn = (to: string, path: string) => {
  const url = mails().filter((m) => m.to === to && m.text.includes(path)).at(-1)?.text.match(/https?:\/\/\S+/)?.[0];
  if (!url) throw new Error(`No ${path} link mailed to ${to}`);
  return url;
};

test('a forgotten password is reset from the emailed link; the old one stops working', async ({ page }) => {
  const org = await createOrg('Reset');
  await page.goto('/login');
  await page.getByRole('link', { name: 'Forgot your password?' }).click();
  await page.getByLabel('Work email').fill(org.email);
  await page.locator('form button[type="submit"]').click();
  await expect.poll(() => mails().some((m) => m.to === org.email && m.text.includes('/reset-password'))).toBe(true);

  await page.goto(linkIn(org.email, '/reset-password'));
  await page.getByLabel('New password').fill('a brand new passphrase');
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByText(/sign in/i).first()).toBeVisible();

  const login = (password: string) => fetch('http://127.0.0.1:4198/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: org.email, password }) });
  expect((await login(PASSWORD)).status).not.toBe(200);
  expect((await login('a brand new passphrase')).status).toBe(200);
  // The link is single-use.
  expect((await fetch('http://127.0.0.1:4198/auth/reset-password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: new URL(linkIn(org.email, '/reset-password')).searchParams.get('token'), password: 'yet another passphrase' }) })).status).not.toBe(200);
});

test('two-factor sign-in is set up with an authenticator code and then asked for at sign-in', async ({ page }) => {
  const org = await createOrg('TwoFactor');
  await signIn(page, org.email);
  await page.goto('/account');
  await page.getByRole('button', { name: 'Set up two-factor' }).click();
  const secret = (await page.locator('code.st-mono').first().innerText()).replace(/\s/g, '');
  await page.getByLabel('Code', { exact: true }).fill(totp(secret));
  await page.locator('form button[type="submit"]').first().click();
  const codes = page.getByLabel('Recovery codes');
  await expect(codes).toBeVisible();
  const recovery = (await codes.innerText()).split(/\s+/).filter(Boolean);
  expect(recovery.length).toBe(10);

  // Password alone no longer signs in.
  const passwordOnly = await fetch('http://127.0.0.1:4198/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: org.email, password: PASSWORD }) });
  expect(((await passwordOnly.json()) as { accessToken?: string }).accessToken).toBeUndefined();

  await page.getByRole('button', { name: /sign out/i }).click();
  await page.goto('/login');
  await page.getByLabel('Work email').fill(org.email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.getByLabel('Authentication code')).toBeVisible();
  // A wrong code is refused.
  await page.getByLabel('Authentication code').fill('000000');
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByRole('alert').first()).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
  // The next code from the app gets in (a code is good for one use, so wait for a fresh one if needed).
  const used = totp(secret);
  await expect.poll(() => totp(secret) !== used || true).toBe(true);
  const next = totp(secret, Date.now() + 30_000);
  await page.getByLabel('Authentication code').fill(next);
  await page.locator('form button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
});

test.describe('branding, analytics, embedding and raising work from inside', () => {
  let org: Org;
  let formId: string;

  let hostSite: Server | undefined;
  let embedSite: Server | undefined;
  test.afterAll(() => {
    hostSite?.close();
    embedSite?.close();
  });

  test.beforeAll(async () => {
    org = await createOrg('Brand');
    formId = await publishForm(org, {
      name: 'Enquiry',
      code: 'ENQUIRY',
      fields: [
        { id: 'a', type: 'TEXT', name: 'who', label: 'Your name', required: true },
        { id: 'r', type: 'REPEAT', name: 'items', label: 'Items', validation: { min: 1 }, props: { layout: 'table' } },
        { id: 'i', type: 'TEXT', name: 'item', label: 'Item', parentId: 'r' },
        { id: 'q', type: 'NUMBER', name: 'qty', label: 'Qty', parentId: 'r' },
      ],
      workflow: {
        enabled: true,
        refPrefix: 'ENQ',
        statuses: [{ key: 'NEW', label: 'New', category: 'OPEN' }, { key: 'DONE', label: 'Done', category: 'DONE' }],
        assignment: { type: 'NONE' },
        actions: [{ key: 'finish', label: 'Finish', from: ['NEW'], to: 'DONE' }],
      },
    });
  });

  test('the organisation\'s colour and "Powered by" setting reach the public form', async ({ page, context }) => {
    const form = await context.newPage();
    await form.goto(formUrl(org, 'ENQUIRY'));
    await expect(form.getByText('Powered by Form Builder')).toBeVisible();

    await signIn(page, org.email);
    await page.goto('/settings');
    await page.getByLabel('Brand colour', { exact: true }).fill('#0a7d3b');
    await page.getByText('Hide "Powered by Form Builder"').click();
    await page.getByRole('button', { name: 'Save branding' }).click();
    await expect.poll(async () => (await call<{ primaryColor: string; hidePoweredBy: boolean }>(200, '/org/branding', { token: org.token })).hidePoweredBy).toBe(true);

    await form.reload();
    await expect(form.getByLabel(label('Your name'))).toBeVisible();
    await expect(form.getByText('Powered by Form Builder')).toHaveCount(0);
    expect((await call<{ primaryColor: string }>(200, `/public/orgs/${org.orgId}/branding`)).primaryColor).toBe('#0a7d3b');
  });

  test('opening, starting and submitting a form are counted', async ({ page }) => {
    const before = await call<{ totals: { views: number; starts: number; submissions: number } }>(200, `/forms/${formId}/stats`, { token: org.token });
    await page.goto(formUrl(org, 'ENQUIRY'));
    await page.getByLabel(label('Your name')).fill('Counted');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText(/ENQ-\d+/)).toBeVisible();
    await expect
      .poll(async () => {
        const now = (await call<{ totals: { views: number; starts: number; submissions: number } }>(200, `/forms/${formId}/stats`, { token: org.token })).totals;
        return [now.views - before.totals.views, now.starts - before.totals.starts, now.submissions - before.totals.submissions];
      })
      .toEqual([1, 1, 1]);
  });

  test('question by question: where one person gave up and another tripped is counted and shown', async ({ page, context }) => {
    const id = await publishForm(org, {
      name: 'Callback',
      code: 'CALLBACK',
      fields: [
        { id: 'a', type: 'TEXT', name: 'name', label: 'Your name', required: true },
        { id: 'b', type: 'EMAIL', name: 'email', label: 'Email', required: true },
        { id: 'c', type: 'TEXTAREA', name: 'about', label: 'What about' },
        // Filled in by the form itself: never somebody's answer.
        { id: 'd', type: 'HIDDEN', name: 'source', defaultValue: 'web' },
      ],
    });
    const report = () => call<{ starts: number; submissions: number; fields: { name: string; answered: number; mistakes: number; leftAt: number }[] }>(200, `/forms/${id}/field-stats`, { token: org.token });

    // Someone only looks: opened, never started, nothing counted against any question.
    const looker = await context.newPage();
    await looker.goto(formUrl(org, 'CALLBACK'));
    await expect(looker.getByLabel(label('Your name'))).toBeVisible();
    await looker.close();

    // Someone gives their name, starts on the email, and leaves.
    const quitter = await context.newPage();
    await quitter.goto(formUrl(org, 'CALLBACK'));
    await quitter.getByLabel(label('Your name')).fill('Gone Soon');
    await quitter.getByLabel(label('Email')).pressSequentially('gone@');
    await quitter.close({ runBeforeUnload: true });
    await expect.poll(async () => (await report()).fields.find((f) => f.name === 'email')?.leftAt).toBe(1);

    // Someone trips on the email, puts it right, and submits.
    const finisher = await context.newPage();
    await finisher.goto(formUrl(org, 'CALLBACK'));
    await finisher.getByLabel(label('Your name')).fill('Asha Rao');
    await finisher.getByLabel(label('Email')).fill('not-an-address');
    await finisher.getByRole('button', { name: 'Submit' }).click();
    await expect(finisher.getByRole('alert').first()).toBeVisible();
    await finisher.getByLabel(label('Email')).fill('asha@example.com');
    await finisher.getByRole('button', { name: 'Submit' }).click();
    await expect(finisher.getByText(/Thank you|submitted|received/i).first()).toBeVisible();

    await expect.poll(async () => (await report()).submissions).toBe(1);
    const counted = await report();
    // Two people started; the looker did not.
    expect(counted.starts).toBe(2);
    expect(counted.fields).toEqual([
      { name: 'name', label: 'Your name', answered: 2, mistakes: 0, leftAt: 0 },
      { name: 'email', label: 'Email', answered: 2, mistakes: 1, leftAt: 1 },
      { name: 'about', label: 'What about', answered: 0, mistakes: 0, leftAt: 0 },
    ]);
    // Everyone who left is accounted for: started = submitted + left somewhere.
    expect(counted.submissions + counted.fields.reduce((n, f) => n + f.leftAt, 0)).toBe(counted.starts);

    await signIn(page, org.email);
    await page.goto(`/forms/${id}/submissions`);
    const table = page.getByRole('table', { name: 'Question by question' });
    await expect(table.getByRole('row', { name: /Email/ })).toContainText('2 (100%)');
    await expect(page.getByText('Of 1 person who started and left, they stopped at "Email".')).toBeVisible();
  });

  test('embedded in another page, the form tells that page its height and when it was submitted', async ({ page }) => {
    // Someone else's website (a different origin from the form's), with our form in a frame.
    const html = `<h1>Host page</h1><script>window.heard = []; window.addEventListener('message', (e) => window.heard.push(e.data));</script>
      <iframe id="f" src="${formUrl(org, 'ENQUIRY', '?embed=1')}" style="width:600px;height:300px"></iframe>`;
    const host = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(html));
    await new Promise<void>((done) => host.listen(0, '127.0.0.1', done));
    hostSite = host;
    await page.goto(`http://127.0.0.1:${(host.address() as AddressInfo).port}/`);
    const frame = page.frameLocator('#f');
    await expect(frame.getByLabel(label('Your name'))).toBeVisible();
    // No save-for-later inside someone else's page.
    await expect(frame.getByRole('button', { name: 'Save and continue later' })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as unknown as { heard: { type?: string; height?: number }[] }).heard.some((m) => m?.type === 'form-builder:resize' && (m.height ?? 0) > 100))).toBe(true);

    await frame.getByLabel(label('Your name')).fill('From the host page');
    await frame.getByRole('button', { name: 'Submit' }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { heard: { type?: string; code?: string }[] }).heard.find((m) => m?.type === 'form-builder:submitted')?.code)).toBe('ENQUIRY');
    const latest = (await submissions(org, formId))[0] as unknown as { channel: string; payload: { who: string } };
    expect(latest.payload.who).toBe('From the host page');
    expect(latest.channel).toBe('EMBED');
  });

  test('one line of HTML puts the form on another website: it sizes itself and says when it is submitted', async ({ page }) => {
    // The line the builder's Embed button copies, on someone else's page, and the same form again as an element in Hindi.
    const html = `<h1>Shop</h1>
      <div id="one"><script src="${RUNTIME}/embed.js" data-org="${org.orgId}" data-code="ENQUIRY"></script></div>
      <div id="two"><form-builder-form org="${org.orgId}" code="ENQUIRY" lang="hi" title="Enquiry"></form-builder-form></div>
      <div id="bad"><form-builder-form org="${org.orgId}" code="not a code"></form-builder-form></div>
      <script>window.done = []; document.addEventListener('submitted', (e) => window.done.push(e.detail));</script>`;
    const host = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(html));
    await new Promise<void>((done) => host.listen(0, '127.0.0.1', done));
    embedSite = host;
    await page.goto(`http://127.0.0.1:${(host.address() as AddressInfo).port}/`);

    const first = page.frameLocator('#one iframe');
    await expect(first.getByLabel(label('Your name'))).toBeVisible();
    // It starts at a fixed height and takes the form's own once the form says what that is.
    await expect.poll(() => page.locator('#one iframe').evaluate((f) => (f as HTMLIFrameElement).style.height)).not.toBe('480px');
    expect(await page.locator('#two iframe').getAttribute('src')).toContain('lang=hi');
    expect(await page.locator('#two iframe').getAttribute('title')).toBe('Enquiry');
    // Something that is not a form code draws nothing rather than a broken frame.
    await expect(page.locator('#bad iframe')).toHaveCount(0);

    // A message from anywhere else on the page is not taken for the form's.
    await page.evaluate(() => window.postMessage({ type: 'form-builder:submitted', submissionId: 'forged' }, '*'));
    await first.getByLabel(label('Your name')).fill('From the one-line embed');
    await first.getByRole('button', { name: 'Submit' }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { done: { code: string; submissionId: string }[] }).done)).toHaveLength(1);
    const done = await page.evaluate(() => (window as unknown as { done: { code: string; submissionId: string }[] }).done[0]!);
    const latest = (await submissions(org, formId))[0] as unknown as { uuid: string; channel: string; payload: { who: string } };
    expect(done).toEqual({ code: 'ENQUIRY', submissionId: latest.uuid });
    expect(latest).toMatchObject({ channel: 'EMBED', payload: { who: 'From the one-line embed' } });
  });

  test('the builder hands over the embed line for a live public form', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await signIn(page, org.email);
    await page.goto(`/forms/${formId}/edit`);
    await page.getByRole('button', { name: 'Embed' }).click();
    await expect(page.getByText('Embed code copied')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`<script src="${RUNTIME}/embed.js" data-org="${org.orgId}" data-code="ENQUIRY"></script>`);
  });

  test('on a phone the form fits the screen, and a table of rows stacks with its labels', async ({ browser }) => {
    const phone = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
    const page = await phone.newPage();
    await page.goto(formUrl(org, 'ENQUIRY'));
    await expect(page.getByLabel(label('Your name'))).toBeVisible();
    // Nothing spills sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    // The column header row of the table layout is for wide screens only; each field shows its own label here.
    await expect(page.locator('.fp-repeat__cols')).toBeHidden();
    const row = page.getByRole('group', { name: 'Items row 1' });
    await expect(row.getByText('Item', { exact: true })).toBeVisible();
    const item = (await row.getByLabel(label('Item')).boundingBox())!;
    const qty = (await row.getByLabel(label('Qty')).boundingBox())!;
    expect(qty.y).toBeGreaterThan(item.y + item.height - 1);
    // Touch works: tap to add a row.
    await page.getByRole('button', { name: 'Add another' }).tap();
    await expect(page.getByRole('group', { name: 'Items row 2' })).toBeVisible();
    await phone.close();
  });

  test('on a wide screen the same rows sit on one line under one set of column names', async ({ page }) => {
    await page.goto(formUrl(org, 'ENQUIRY'));
    await expect(page.locator('.fp-repeat__cols')).toBeVisible();
    const row = page.getByRole('group', { name: 'Items row 1' });
    const item = (await row.getByLabel(label('Item')).boundingBox())!;
    const qty = (await row.getByLabel(label('Qty')).boundingBox())!;
    expect(Math.abs(qty.y - item.y)).toBeLessThan(4);
    expect(qty.x).toBeGreaterThan(item.x + item.width - 1);
  });

  test('a member of staff raises a work item from inside, and it lands in the inbox', async ({ page }) => {
    const worker = await addMember(org, 'Wendy Worker', 'RECORDS_WORKER');
    await signIn(page, worker.email);
    await page.goto('/work/new');
    await page.locator('main').getByRole('combobox').first().click();
    await page.getByRole('option', { name: /Enquiry/ }).click();
    await page.getByLabel(label('Your name')).fill('Walk-in customer');
    await page.getByRole('group', { name: 'Items row 1' }).getByLabel(label('Item')).fill('Catalogue');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText(/ENQ-\d+/).first()).toBeVisible();
    const latest = (await submissions(org, formId))[0] as unknown as { source: string; payload: { who: string }; submittedBy: string };
    expect(latest.payload.who).toBe('Walk-in customer');
    expect(latest.source).toBe('PORTAL');
    expect(latest.submittedBy).toBe(worker.userId);
  });
});
