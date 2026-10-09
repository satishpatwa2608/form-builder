import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { call, createOrg, formUrl, label, signIn, submissions, watchForProblems, type Org } from './helpers';
import { API } from '../stack';

/** The PDF of a response: switched on in the form's settings, made by the server, downloaded from Responses. */

let org: Org;
let formId: string;

test.beforeAll(async () => {
  org = await createOrg('Records');
  formId = (
    await call<{ definition: { id: string } }>(201, '/forms', {
      method: 'POST',
      token: org.token,
      body: {
        folderId: org.folderId,
        definition: {
          name: 'Visitor pass',
          code: 'VISITOR_PASS',
          businessId: '',
          access: 'PUBLIC',
          submission: { method: 'POST', endpointId: 'default-submit' },
          fields: [
            { id: 'a', type: 'TEXT', name: 'visitor', label: 'Visitor', required: true },
            { id: 'b', type: 'TEXT', name: 'host', label: 'Host' },
          ],
        },
      },
    })
  ).definition.id;
});

test('a designer switches on a PDF for each response and gives it a title', async ({ page }) => {
  const problems = watchForProblems(page);
  await signIn(page, org.email);
  await page.goto(`/forms/${formId}/edit`);
  const settings = page.getByLabel('Form settings');
  await settings.getByRole('switch', { name: 'Keep a PDF of each response' }).click();
  await settings.getByLabel('Title on the PDF').fill('Visitor pass record');
  await settings.getByLabel('Line at the foot of each page').fill('Security desk copy');
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText(/Published VISITOR_PASS v1/)).toBeVisible();
  const saved = await call<{ definition: { document: unknown } }>(200, `/forms/${formId}`, { token: org.token });
  expect(saved.definition.document).toEqual({ keep: true, title: 'Visitor pass record', footer: 'Security desk copy' });
  expect(problems).toEqual([]);
});

test('a response gets its PDF from the server, and it is downloaded from Responses', async ({ page }) => {
  const problems = watchForProblems(page);
  const form = await page.context().newPage();
  await form.goto(formUrl(org, 'VISITOR_PASS'));
  await form.getByRole('textbox', { name: label('Visitor') }).fill('Meera Nair');
  await form.getByRole('textbox', { name: label('Host') }).fill('Asha Rao');
  await form.getByRole('button', { name: 'Submit' }).click();
  await expect(form.getByText(/Thank you|submitted|received/i).first()).toBeVisible();
  await form.close();

  // Made in the background, with nobody asking for it.
  await expect.poll(async () => ((await submissions(org, formId))[0] as { document?: { size: number } } | undefined)?.document?.size ?? 0, { timeout: 15_000 }).toBeGreaterThan(2000);
  const sid = (await submissions(org, formId))[0]!.uuid;

  await signIn(page, org.email);
  await page.goto(`/forms/${formId}/submissions`);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download the PDF of this response' }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  const saved = readFileSync(await download.path());
  expect(saved.subarray(0, 5).toString()).toBe('%PDF-');
  // The same document, fetched directly: a real PDF, the one stored for this response.
  const direct = await fetch(`${API}/forms/${formId}/submissions/${sid}/document`, { headers: { authorization: `Bearer ${org.token}` } });
  const pdf = Buffer.from(await direct.arrayBuffer());
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  expect(pdf.length).toBe(((await submissions(org, formId))[0] as unknown as { document: { size: number } }).document.size);
  // What was saved from the page is that same stored document.
  expect(saved.equals(pdf)).toBe(true);

  // Without signing in there is no document to be had.
  expect((await fetch(`${API}/forms/${formId}/submissions/${sid}/document`)).status).toBe(401);
  expect(problems).toEqual([]);
});
