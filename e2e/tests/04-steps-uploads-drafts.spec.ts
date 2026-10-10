import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { call, createOrg, formUrl, label, publishForm, signIn, submissions, watchForProblems, type Org } from './helpers';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

let org: Org;

test.beforeAll(async () => {
  org = await createOrg('Service');
});

test.describe('a stepped form', () => {
  let formId: string;
  const visit = {
    name: 'Site visit',
    code: 'SITE_VISIT',
    layout: { mode: 'steps', review: true },
    fields: [
      { id: 's1', type: 'SECTION', name: 'who', label: 'Who' },
      { id: 'n', type: 'TEXT', name: 'visitor', label: 'Visitor', required: true, parentId: 's1' },
      { id: 'sk', type: 'BUTTON', name: 'skip', label: 'Nothing to declare: skip to the end', parentId: 's1' },
      { id: 's2', type: 'SECTION', name: 'declare', label: 'Declarations' },
      { id: 'ac', type: 'ACCORDION', name: 'topics', label: 'Topics', parentId: 's2' },
      { id: 'a1', type: 'SECTION', name: 'health', label: 'Health', parentId: 'ac' },
      { id: 'h', type: 'SWITCH', name: 'unwell', label: 'I feel unwell today', parentId: 'a1' },
      { id: 'a2', type: 'SECTION', name: 'kit', label: 'Equipment', parentId: 'ac' },
      { id: 'k', type: 'TEXT', name: 'laptop', label: 'Laptop serial', parentId: 'a2', required: true },
      { id: 's3', type: 'SECTION', name: 'end', label: 'Finish' },
      { id: 'c', type: 'TEXTAREA', name: 'comment', label: 'Anything else', parentId: 's3' },
    ],
    events: [{ id: 'skip', on: { type: 'CLICK', field: 'skip' }, do: [{ type: 'SET_VALUE', target: 'comment', value: '"Nothing to declare"' }, { type: 'GO_TO_STEP', step: 'end' }] }],
  };

  test.beforeAll(async () => {
    formId = await publishForm(org, visit);
  });

  test('steps check only their own fields; an accordion opens the panel with the mistake; then review and submit', async ({ page }) => {
    const problems = watchForProblems(page);
    await page.goto(formUrl(org, 'SITE_VISIT'));
    await expect(page.getByText('Step 1 of 3')).toBeVisible();

    // Next is refused until this step is right.
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('Visitor is required')).toBeVisible();
    await expect(page.getByText('Step 1 of 3')).toBeVisible();
    await page.getByLabel(label('Visitor')).fill('Kiran');
    await expect(page.getByText('Visitor is required')).toHaveCount(0); // goes as it is typed
    await page.getByLabel(label('Visitor')).press('Enter'); // Enter means Next, not submit
    await expect(page.getByText('Step 2 of 3')).toBeVisible();

    // Accordion: one panel open at a time.
    const health = page.getByRole('button', { name: /Health/ });
    const kit = page.getByRole('button', { name: /Equipment/ });
    await expect(health).toHaveAttribute('aria-expanded', 'true');
    await expect(kit).toHaveAttribute('aria-expanded', 'false');
    await page.getByRole('switch', { name: /I feel unwell today/ }).click();

    // The required field is in the closed panel: Next flags that panel and opens it.
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('Step 2 of 3')).toBeVisible();
    await expect(page.getByRole('button', { name: /Equipment \(needs attention\)/ })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByLabel(label('Laptop serial'))).toBeFocused();
    await page.getByLabel(label('Laptop serial')).fill('LT-778');
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('Step 3 of 3')).toBeVisible();

    // Back keeps everything.
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByRole('button', { name: /Equipment/ }).click();
    await expect(page.getByLabel(label('Laptop serial'))).toHaveValue('LT-778');
    await page.getByRole('button', { name: 'Next' }).click();

    await page.getByRole('button', { name: 'Submit' }).click();
    const review = page.getByRole('region', { name: 'Check your answers' });
    await expect(review).toContainText('Kiran');
    await expect(review).toContainText('LT-778');
    await expect(review).toContainText('Yes');
    // Changing an answer from an earlier step goes to that step.
    await review.getByRole('button', { name: 'Change Visitor' }).click();
    await expect(page.getByText('Step 1 of 3')).toBeVisible();
    await expect(page.getByLabel(label('Visitor'))).toBeFocused();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Submit' }).click();
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText(/Thank you/)).toBeVisible();
    expect((await submissions(org, formId))[0].payload).toEqual({ visitor: 'Kiran', unwell: true, laptop: 'LT-778' });
    expect(problems).toEqual([]);
  });

  test('a button fills a field and jumps to another step', async ({ page }) => {
    await page.goto(formUrl(org, 'SITE_VISIT'));
    await page.getByLabel(label('Visitor')).fill('Quick');
    await page.getByRole('button', { name: 'Nothing to declare: skip to the end' }).click();
    await expect(page.getByText('Step 3 of 3')).toBeVisible();
    await expect(page.getByLabel(label('Anything else'))).toHaveValue('Nothing to declare');
    // Skipping there does not skip the checks: the laptop serial on step 2 is still required.
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Please fix' })).toContainText('Laptop serial is required');
  });
});

test.describe('uploads, drafts, CAPTCHA and sign-in', () => {
  let formId: string;
  const report = {
    name: 'Damage report',
    code: 'DAMAGE',
    captcha: { enabled: true, provider: 'HCAPTCHA', siteKey: '', mode: 'CHECKBOX' },
    fields: [
      { id: 'w', type: 'TEXT', name: 'what', label: 'What was damaged', required: true },
      { id: 'r', type: 'REPEAT', name: 'parts', label: 'Parts', validation: { min: 1 } },
      { id: 'p', type: 'TEXT', name: 'part', label: 'Part', parentId: 'r' },
      { id: 'f', type: 'FILE', name: 'photos', label: 'Photos', props: { accept: ['image/*'], maxSizeMB: 1 }, validation: { max: 2 } },
      { id: 'c', type: 'CAPTCHA', name: 'captchaToken' },
    ],
    workflow: {
      enabled: true,
      refPrefix: 'DMG',
      statuses: [{ key: 'NEW', label: 'New', category: 'OPEN' }, { key: 'DONE', label: 'Done', category: 'DONE' }],
      assignment: { type: 'NONE' },
      actions: [{ key: 'finish', label: 'Finish', from: ['NEW'], to: 'DONE' }],
    },
  };

  test.beforeAll(async () => {
    formId = await publishForm(org, report);
  });

  test('answers saved for later come back from the private link, and the link dies once used up', async ({ page, context }) => {
    await page.goto(formUrl(org, 'DAMAGE'));
    await page.getByLabel(label('What was damaged')).fill('Forklift mirror');
    await page.getByRole('group', { name: 'Parts row 1' }).getByLabel(label('Part')).fill('Left mirror');
    await page.getByRole('button', { name: 'Add another' }).click();
    await page.getByRole('group', { name: 'Parts row 2' }).getByLabel(label('Part')).fill('Bracket');
    await page.getByRole('button', { name: 'Save and continue later' }).click();
    const link = await page.getByLabel('Link to continue later').inputValue();
    expect(link).toContain('resume=');

    const later = await context.newPage();
    await later.goto(link);
    await expect(later.getByText(/Welcome back - your saved answers are filled in/)).toBeVisible();
    await expect(later.getByLabel(label('What was damaged'))).toHaveValue('Forklift mirror');
    await expect(later.getByRole('group', { name: 'Parts row 2' }).getByLabel(label('Part'))).toHaveValue('Bracket');
    // The token is taken out of the address bar straight away.
    expect(later.url()).not.toContain('resume=');

    await later.getByRole('checkbox', { name: /I'm not a robot/ }).click();
    await later.getByRole('button', { name: 'Submit' }).click();
    await expect(later.getByText(/DMG-0+1/)).toBeVisible();
    expect((await submissions(org, formId))[0].payload).toEqual({ what: 'Forklift mirror', parts: [{ part: 'Left mirror' }, { part: 'Bracket' }], photos: [] });

    // Submitted: the saved copy is gone, so the old link no longer opens anything.
    const again = await context.newPage();
    await again.goto(link);
    await expect(again.getByLabel(label('What was damaged'))).toHaveValue('');
  });

  test('a real file is uploaded, checked, attached and can be downloaded by staff; a fake one is refused', async ({ page }) => {
    const problems = watchForProblems(page);
    const good = join(tmpdir(), `fb-e2e-photo-${Date.now()}.png`);
    const fake = join(tmpdir(), `fb-e2e-fake-${Date.now()}.png`);
    writeFileSync(good, PNG);
    writeFileSync(fake, 'this is text, not a picture');

    await page.goto(formUrl(org, 'DAMAGE'));
    await page.getByLabel(label('What was damaged')).fill('Loading bay door');
    await page.getByRole('group', { name: 'Parts row 1' }).getByLabel(label('Part')).fill('Hinge');

    // Without the CAPTCHA nothing is sent.
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText('Please complete the verification').first()).toBeVisible();
    await page.getByRole('checkbox', { name: /I'm not a robot/ }).click();

    // A text file renamed .png is caught by its content.
    await page.locator('input[type="file"]').setInputFiles(fake);
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText(/content doesn't match its type|not allowed|failed/i).first()).toBeVisible();
    expect(await submissions(org, formId)).toHaveLength(1);

    await page.reload();
    await page.getByLabel(label('What was damaged')).fill('Loading bay door');
    await page.getByRole('group', { name: 'Parts row 1' }).getByLabel(label('Part')).fill('Hinge');
    await page.getByRole('checkbox', { name: /I'm not a robot/ }).click();
    await page.locator('input[type="file"]').setInputFiles(good);
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText(/DMG-0+2/)).toBeVisible();

    const [stored] = await submissions(org, formId);
    expect(stored.payload).toMatchObject({ what: 'Loading bay door' });
    // The CAPTCHA token is never kept.
    expect(stored.payload).not.toHaveProperty('captchaToken');
    const files = (stored as unknown as { files: { uploadId: string; name: string; contentType: string }[] }).files;
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ contentType: 'image/png' });

    // Staff download exactly what was uploaded.
    const link = await call<{ url: string }>(200, `/records/${stored.uuid}/files/${files[0].uploadId}`, { token: org.token });
    const bytes = Buffer.from(await (await fetch(link.url)).arrayBuffer());
    expect(Buffer.compare(bytes, PNG)).toBe(0);
    expect(readFileSync(good).length).toBe(bytes.length);
    // Nobody else can: no token, no link.
    expect((await fetch(`http://127.0.0.1:4198/records/${stored.uuid}/files/${files[0].uploadId}`)).status).toBe(401);
    expect(problems.filter((p) => !p.includes('422'))).toEqual([]);
  });

  test('a form for signed-in people only turns the public away and lets a member in', async ({ page, context }) => {
    await publishForm(org, { name: 'Staff survey', code: 'STAFF_SURVEY', access: 'AUTHENTICATED', fields: [{ id: 'a', type: 'TEXT', name: 'view', label: 'Your view', required: true, prefill: { source: 'USER_NAME', lock: true } }] });
    await page.goto(formUrl(org, 'STAFF_SURVEY'));
    await expect(page.getByText(/sign in/i).first()).toBeVisible();
    await expect(page.getByLabel(label('Your view'))).toHaveCount(0);
    // The API refuses too, whatever the page does.
    expect((await fetch(`http://127.0.0.1:4198/public/forms/STAFF_SURVEY/submissions?org=${org.orgId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values: { view: 'x' } }) })).status).toBe(401);

    await signIn(page, org.email);
    const form = await context.newPage();
    await form.goto(formUrl(org, 'STAFF_SURVEY'));
    // Filled from the signed-in person and locked.
    await expect(form.getByLabel(label('Your view'))).toHaveValue('Asha Rao');
    await expect(form.getByLabel(label('Your view'))).toBeDisabled();
  });
});

test.describe('answers that save themselves', () => {
  let formId: string;

  test.beforeAll(async () => {
    formId = await publishForm(org, {
      name: 'Long application',
      code: 'LONG_APP',
      saveAsYouGo: true,
      fields: [
        { id: 'n', type: 'TEXT', name: 'applicant', label: 'Applicant', required: true },
        { id: 'w', type: 'TEXTAREA', name: 'why', label: 'Why you are applying' },
      ],
    });
  });

  test('nothing to press: the answers are there on coming back, can be thrown away, and are gone once sent', async ({ page }) => {
    const problems = watchForProblems(page);
    // The page's own clock, so half a minute of typing takes no time here.
    await page.clock.install();
    await page.goto(formUrl(org, 'LONG_APP'));
    await expect(page.getByText('Your answers are kept on this device as you go.')).toBeVisible();
    await page.getByLabel(label('Applicant')).fill('Kiran Rao');
    await page.getByLabel(label('Why you are applying')).fill('I have driven forklifts for six years.');
    const saved = page.waitForResponse((r) => /\/forms\/LONG_APP\/drafts\?/.test(r.url()) && r.request().method() === 'POST');
    await page.clock.runFor(31_000);
    expect((await saved).status()).toBe(201);

    // Closed and opened again, with no link: the same device has them.
    await page.reload();
    await expect(page.getByText(/We kept the answers you gave here earlier/)).toBeVisible();
    await expect(page.getByLabel(label('Applicant'))).toHaveValue('Kiran Rao');
    await expect(page.getByLabel(label('Why you are applying'))).toHaveValue('I have driven forklifts for six years.');

    // Not mine (a shared computer): start again, and they are gone for good.
    await page.getByRole('button', { name: 'Start again' }).click();
    await expect(page.getByLabel(label('Applicant'))).toHaveValue('');
    await expect(page.getByText(/We kept the answers/)).toHaveCount(0);
    await page.reload();
    await expect(page.getByLabel(label('Applicant'))).toHaveValue('');

    // Saved again, then sent in: nothing is offered next time.
    await page.getByLabel(label('Applicant')).fill('Meera Shah');
    const again = page.waitForResponse((r) => /\/forms\/LONG_APP\/drafts\?/.test(r.url()) && r.request().method() === 'POST');
    await page.clock.runFor(31_000);
    await again;
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect.poll(async () => (await submissions(org, formId)).length).toBe(1);
    expect((await submissions(org, formId))[0].payload).toMatchObject({ applicant: 'Meera Shah' });
    await page.reload();
    await expect(page.getByLabel(label('Applicant'))).toHaveValue('');
    await expect(page.getByText(/We kept the answers/)).toHaveCount(0);
    expect(problems.filter((p) => !/4\d\d/.test(p))).toEqual([]);
  });

  test('a form that has not asked for it keeps nothing by itself', async ({ page }) => {
    await page.goto(formUrl(org, 'SITE_VISIT'));
    await expect(page.getByText('Step 1 of 3')).toBeVisible();
    await expect(page.getByText('Your answers are kept on this device as you go.')).toHaveCount(0);
  });
});
