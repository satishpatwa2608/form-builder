import { expect, test } from '@playwright/test';
import { addMember, call, createOrg, formUrl, signIn, submissions, watchForProblems, type Org } from './helpers';

/** One workflow in the library, used by two forms: built on the Workflows page, chosen from a list in each form. */

let org: Org;
let designer: Awaited<ReturnType<typeof addMember>>;

const base = { businessId: '', access: 'PUBLIC', submission: { method: 'POST', endpointId: 'default-submit' } };
const draft = async (definition: Record<string, unknown>) =>
  (await call<{ definition: { id: string } }>(201, '/forms', { method: 'POST', token: org.token, body: { folderId: org.folderId, definition: { ...base, ...definition } } })).definition.id;
const library = () => call<{ id: string; name: string; fields: { name: string; type: string }[]; usedBy: { code: string }[] }[]>(200, '/workflows', { token: org.token });

test.beforeAll(async () => {
  org = await createOrg('Service');
  designer = await addMember(org, 'Dev Designer', 'DESIGNER');
});

test('an admin builds a workflow in the library, saying in plain words what it reads from a form', async ({ page }) => {
  const problems = watchForProblems(page);
  await signIn(page, org.email);
  await page.getByRole('link', { name: 'Workflows' }).click();
  await expect(page.getByText(/No shared workflows yet/)).toBeVisible();

  await page.getByRole('button', { name: 'New workflow' }).click();
  // The workflow is built on a page of its own, not in a pop-up.
  const dialog = page.getByRole('region', { name: 'Workflow designer' });
  await expect(dialog.getByRole('heading', { name: 'New workflow' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Save workflow' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Give the workflow a name');

  await dialog.getByLabel('Name', { exact: true }).fill('Request handling');
  await dialog.getByLabel('What it is for').fill('New, in progress, closed.');
  await dialog.getByRole('button', { name: 'Add an answer' }).click();
  await dialog.getByLabel('Answer 1', { exact: true }).fill("Requester's email");
  await expect(dialog.getByText('Matches a form field named requestersEmail')).toBeVisible();
  await dialog.getByRole('combobox', { name: 'Kind of answer 1' }).click();
  await page.getByRole('option', { name: 'Email address' }).click();
  await dialog.getByRole('button', { name: 'Save workflow' }).click();

  const row = page.getByRole('row').filter({ hasText: 'Request handling' });
  await expect(row).toContainText('New → In progress → Closed');
  await expect(row).toContainText("Requester's email");
  await expect(row).toContainText('No form yet');
  expect((await library())[0].fields).toEqual([{ name: 'requestersEmail', label: "Requester's email", type: 'EMAIL' }]);
  expect(problems).toEqual([]);
});

test('a designer uses it on a form: picks it, is told what is missing, chooses the field from a list', async ({ page }) => {
  const problems = watchForProblems(page);
  const id = await draft({
    name: 'Return request',
    code: 'RETURN_REQUEST',
    fields: [
      { id: 'a', type: 'TEXT', name: 'fullName', label: 'Full name', required: true },
      { id: 'b', type: 'EMAIL', name: 'contactEmail', label: 'Contact email', required: true },
    ],
  });
  await signIn(page, designer.email);
  await page.goto(`/forms/${id}/edit`);
  await page.getByRole('button', { name: 'Workflow' }).click();
  const dialog = page.getByRole('dialog', { name: 'Workflow' });
  // A designer picks from the library but does not add to it.
  await expect(dialog.getByRole('button', { name: 'Save to library' })).toHaveCount(0);
  await dialog.getByRole('combobox', { name: 'Workflow for this form' }).click();
  await page.getByRole('option', { name: 'Request handling' }).click();
  await expect(dialog.getByText('New → In progress → Closed')).toBeVisible();
  await expect(dialog.getByText('Needed before publishing')).toBeVisible();
  await page.keyboard.press('Escape');

  // Saved as it is, it cannot be published, and the reason says what to do.
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved')).toBeVisible();
  const refused = await call<{ errors: { message: string }[] }>(400, `/forms/${id}/publish`, { method: 'POST', token: org.token });
  expect(refused.errors.map((e) => e.message)).toEqual(['"Request handling" needs "Requester\'s email". Choose which of this form\'s fields that is.']);

  await page.getByRole('button', { name: 'Workflow' }).click();
  await dialog.getByRole('combobox', { name: "Requester's email" }).click();
  await page.getByRole('option', { name: 'Contact email' }).click();
  await expect(dialog.getByText('Needed before publishing')).toHaveCount(0);
  await dialog.getByLabel('Reference prefix').fill('ret');
  await page.keyboard.press('Escape');

  // The publish button belongs to a publisher; the designer saves, the owner publishes.
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved').last()).toBeVisible();
  await expect.poll(async () => (await call<{ definition: { workflowRef?: { refPrefix?: string } } }>(200, `/forms/${id}`, { token: org.token })).definition.workflowRef?.refPrefix).toBe('RET');
  await call(200, `/forms/${id}/publish`, { method: 'POST', token: org.token });

  const form = await page.context().newPage();
  await form.goto(formUrl(org, 'RETURN_REQUEST'));
  await form.getByLabel(/^Full name/).fill('Meera');
  await form.getByLabel(/^Contact email/).fill('meera@customer.test');
  await form.getByRole('button', { name: 'Submit' }).click();
  await expect(form.getByText(/RET-000001/)).toBeVisible();
  expect((await submissions(org, id))[0]).toMatchObject({ ref: 'RET-000001', status: 'NEW' });
  expect((await library())[0].usedBy.map((u) => u.code)).toEqual(['RETURN_REQUEST']);
  expect(problems).toEqual([]);
});

test("an admin puts a form's own workflow in the library with one button; a workflow in use cannot be deleted", async ({ page }) => {
  const problems = watchForProblems(page);
  const id = await draft({
    name: 'Complaint',
    code: 'COMPLAINT',
    fields: [
      { id: 'a', type: 'TEXT', name: 'name', label: 'Your name', required: true },
      { id: 'b', type: 'EMAIL', name: 'email', label: 'Email', required: true },
    ],
    workflow: {
      enabled: true,
      refPrefix: 'CMP',
      statuses: [
        { key: 'NEW', label: 'New', category: 'OPEN' },
        { key: 'CLOSED', label: 'Closed', category: 'DONE' },
      ],
      assignment: { type: 'NONE' },
      contactEmailField: 'email',
    },
  });
  await signIn(page, org.email);
  await page.goto(`/forms/${id}/edit`);
  await page.getByRole('button', { name: 'Workflow' }).click();
  const dialog = page.getByRole('dialog', { name: 'Workflow' });
  await dialog.getByRole('button', { name: 'Save to library' }).click();
  await dialog.getByLabel('Name in the library').fill('Complaints');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('"Complaints" is in the library. This form now uses it from there.')).toBeVisible();
  await expect(dialog.getByText('New → Closed')).toBeVisible();
  await expect(dialog.getByText('Matched by name')).toBeVisible();
  await expect(dialog.getByLabel('Reference prefix')).toHaveValue('CMP');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText(/Published COMPLAINT v1/)).toBeVisible();

  await page.goto('/workflows');
  const row = page.getByRole('row').filter({ hasText: 'Complaints' });
  await expect(row).toContainText('Complaint');
  await row.getByRole('button', { name: 'Delete Complaints' }).click();
  await expect(page.getByText('"Complaints" is used by Complaint. Give those forms another workflow first.')).toBeVisible();
  expect((await library()).map((w) => w.name)).toEqual(['Complaints', 'Request handling']);
  expect(problems).toEqual([]);
});

test('a designer sees the library but cannot change it', async ({ page }) => {
  await signIn(page, designer.email);
  await page.goto('/workflows');
  await expect(page.getByRole('row').filter({ hasText: 'Request handling' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New workflow' })).toHaveCount(0);
  await page.getByRole('button', { name: 'View Request handling' }).click();
  const dialog = page.getByRole('region', { name: 'Workflow designer' });
  // It opens on the picture of the workflow, which anyone may look at.
  await expect(dialog.getByRole('img', { name: /The process: New, then In progress, then Closed/ })).toBeVisible();
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/workflow-designer.png` });
  await expect(dialog.getByLabel('Name', { exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Save workflow' })).toHaveCount(0);
});
