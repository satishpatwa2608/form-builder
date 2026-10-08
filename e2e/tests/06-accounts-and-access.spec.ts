import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { addMember, call, createOrg, formUrl, label, mails, PASSWORD, publishForm, signIn, type Org } from './helpers';

/** Accounts, people, roles and what each may see or change. */

const linkIn = (to: string, path: string) => {
  const mail = mails().filter((m) => m.to === to && m.text.includes(path)).at(-1);
  const url = mail?.text.match(/https?:\/\/\S+/)?.[0];
  if (!url) throw new Error(`No ${path} link mailed to ${to}`);
  return url;
};

test('someone signs up, confirms by the emailed link, and lands in their own workspace', async ({ page }) => {
  const email = `founder-${Date.now()}@e2e.test`;
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Farah Founder');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Organisation name').fill('Farah & Co');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page.getByText('Check your email')).toBeVisible();

  // Not confirmed yet: signing in is refused.
  const early = await fetch('http://127.0.0.1:4198/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  expect(early.status).not.toBe(200);

  await expect.poll(() => mails().some((m) => m.to === email)).toBe(true);
  await page.goto(linkIn(email, '/verify-email'));
  await expect(page.getByText(/confirmed|verified|sign in/i).first()).toBeVisible();
  await signIn(page, email);
  // The workspace switcher at the top shows their organisation.
  await expect(page.locator('select option:checked').first()).toHaveText('Farah & Co');
  await expect(page.getByText('Owner').first()).toBeVisible();
});

test('a wrong password is refused, and so is an address nobody has, in the same words', async ({ page }) => {
  const org = await createOrg('Lock');
  const attempt = async (email: string, password: string) => {
    await page.goto('/login');
    await page.getByLabel('Work email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    const alert = page.getByRole('alert').first();
    await expect(alert).toBeVisible();
    return (await alert.innerText()).trim();
  };
  const wrong = await attempt(org.email, 'not the password');
  const nobody = await attempt('nobody-here@e2e.test', 'not the password');
  // Nothing in the answer says whether the account exists.
  expect(nobody).toBe(wrong);
  await expect(page).toHaveURL(/\/login/);
});

test.describe('people and roles', () => {
  let org: Org;
  let formId: string;

  test.beforeAll(async () => {
    org = await createOrg('Roles');
    formId = await publishForm(org, { name: 'Feedback', code: 'FEEDBACK', fields: [{ id: 'a', type: 'TEXT', name: 'view', label: 'Your view', required: true }] });
  });

  test('the owner invites a viewer from the Members page; the viewer accepts and can look but not change', async ({ page, browser }) => {
    const email = `viewer-${Date.now()}@e2e.test`;
    await signIn(page, org.email);
    await page.goto('/members');
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Role', { exact: true }).selectOption({ label: 'Viewer' });
    await page.getByRole('button', { name: 'Send invitation' }).click();
    await expect(page.getByText(email).first()).toBeVisible();
    await expect.poll(() => mails().some((m) => m.to === email)).toBe(true);

    const theirs = await (await browser.newContext()).newPage();
    await theirs.goto(linkIn(email, '/accept-invite'));
    await theirs.getByLabel('Your name').fill('Vera Viewer');
    await theirs.getByLabel('Choose a password').fill(PASSWORD);
    await theirs.locator('form button[type="submit"]').click();
    await expect(theirs.getByText('You have joined. Sign in to continue.')).toBeVisible();
    await signIn(theirs, email);

    // A viewer sees the form. "New form" is offered to everyone by design; trying it is refused in plain words.
    await theirs.goto('/forms');
    await expect(theirs.getByText('Feedback', { exact: true })).toBeVisible();
    await theirs.getByRole('button', { name: 'New form' }).click();
    await theirs.getByLabel('Name', { exact: true }).fill('Sneaky');
    await theirs.getByRole('button', { name: 'Create draft' }).click();
    await expect(theirs.getByRole('alert').first()).toBeVisible();
    await expect(theirs.getByText('"Sneaky" was created as a draft.')).toHaveCount(0);
    expect((await call<{ name: string }[]>(200, '/forms', { token: org.token })).map((f) => f.name)).not.toContain('Sneaky');
    await theirs.goto(`/forms/${formId}/edit`);
    await expect(theirs.getByRole('button', { name: 'Save draft' })).toHaveCount(0);
    await expect(theirs.getByRole('button', { name: /Edit as new version/ })).toHaveCount(0);
    await theirs.goto('/members');
    await expect(theirs.getByText('Invite someone')).toHaveCount(0);

    // And the server refuses the same things, whatever the page shows.
    const login = await call<{ accessToken: string }>(200, '/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
    expect((await fetch(`http://127.0.0.1:4198/forms/${formId}/new-version`, { method: 'POST', headers: { authorization: `Bearer ${login.accessToken}` } })).status).toBe(403);
    expect((await fetch('http://127.0.0.1:4198/invitations', { method: 'POST', headers: { authorization: `Bearer ${login.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'x@e2e.test', role: 'ADMIN' }) })).status).toBe(403);
    await theirs.context().close();

    // The owner sees them in the team.
    await page.reload();
    await expect(page.getByText('Vera Viewer').first()).toBeVisible();
  });

  test('a designer edits only in the folder they were given', async ({ page }) => {
    const designer = await addMember(org, 'Dev Designer', 'VIEWER');
    const other = await call<{ id: string; name: string }[]>(201, '/folders', { method: 'POST', token: org.token, body: { name: 'HR' } });
    const hr = other.find((f) => f.name === 'HR')!.id;
    await call(201, '/grants', { method: 'POST', token: org.token, body: { userId: designer.userId, role: 'DESIGNER', scope: { type: 'folder', id: hr } } });
    const hrForm = (await call<{ definition: { id: string } }>(201, '/forms', {
      method: 'POST',
      token: org.token,
      body: { folderId: hr, definition: { name: 'Leave', code: 'LEAVE', businessId: '', access: 'PUBLIC', submission: { method: 'POST', endpointId: 'default-submit' }, fields: [{ id: 'a', type: 'TEXT', name: 'why', label: 'Why' }] } },
    })).definition.id;

    await signIn(page, designer.email);
    // In HR they can edit the draft ...
    await page.goto(`/forms/${hrForm}/edit`);
    await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible();
    // ... but not publish it (that is a different role) ...
    await expect(page.getByRole('button', { name: 'Publish' })).toHaveCount(0);
    // ... and the form in the other folder is read-only to them.
    await page.goto(`/forms/${formId}/edit`);
    await expect(page.getByRole('button', { name: 'Save draft' })).toHaveCount(0);
  });

  test('another organisation cannot see or reach this one\'s forms, records or files', async () => {
    const stranger = await createOrg('Stranger');
    const list = await call<{ code: string }[]>(200, '/forms', { token: stranger.token });
    expect(list.map((f) => f.code)).not.toContain('FEEDBACK');
    for (const path of [`/forms/${formId}`, `/forms/${formId}/submissions`, `/forms/${formId}/export`, `/forms/${formId}/versions`]) {
      expect((await fetch(`http://127.0.0.1:4198${path}`, { headers: { authorization: `Bearer ${stranger.token}` } })).status, path).toBe(404);
    }
    // Their public address for our form code finds nothing either.
    expect((await fetch(`http://127.0.0.1:4198/public/forms/FEEDBACK?org=${stranger.orgId}`)).status).toBe(404);
  });

  test('a published form stays live while a new version is edited, and changes only when that is published', async ({ page, context }) => {
    await signIn(page, org.email);
    await page.goto(`/forms/${formId}/edit`);
    await page.getByRole('button', { name: /Edit as new version/ }).click();
    await expect(page.getByText(/Editing v2/)).toBeVisible();
    await page.getByLabel('Form canvas').getByText('Your view').click();
    await page.getByLabel('Field settings').getByLabel('Label', { exact: true }).fill('Tell us what you think');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByText('Draft saved')).toBeVisible();

    const live = await context.newPage();
    await live.goto(formUrl(org, 'FEEDBACK'));
    await expect(live.getByLabel(label('Your view'))).toBeVisible();

    await page.getByRole('button', { name: 'Publish' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText(/Published FEEDBACK v2/)).toBeVisible();
    await live.reload();
    await expect(live.getByLabel(label('Tell us what you think'))).toBeVisible();

    const versions = await call<{ version: number; status: string }[]>(200, `/forms/${formId}/versions`, { token: org.token });
    expect(versions.map((v) => `${v.version}:${v.status}`)).toEqual(['2:PUBLISHED', '1:ARCHIVED']);
  });

  test('a form is exported and imported into another organisation as a draft', async ({ page }) => {
    await signIn(page, org.email);
    await page.goto('/forms');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export Feedback' }).click();
    const file = await (await download).path();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toBeTruthy();

    const target = await createOrg('Importer');
    const other = await page.context().browser()!.newContext();
    const theirs = await other.newPage();
    await signIn(theirs, target.email);
    await theirs.goto('/forms');
    await theirs.getByLabel('Form package file').setInputFiles(file);
    await expect(theirs.getByText('Feedback', { exact: true })).toBeVisible();
    await expect(theirs.getByText(/Draft v1/)).toBeVisible();
    // It arrives as a draft: the public cannot open it there until someone publishes it.
    expect((await fetch(`http://127.0.0.1:4198/public/forms/FEEDBACK?org=${target.orgId}`)).status).toBe(404);
    await other.close();
  });

  test('what was done, and by whom, is in the audit log', async ({ page }) => {
    await signIn(page, org.email);
    await page.goto('/audit');
    const body = page.locator('main');
    await expect(body).toContainText(/publish/i);
    await expect(body).toContainText(/invit/i);
    await expect(body).toContainText('Asha Rao');
  });
});
