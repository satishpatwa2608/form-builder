import { expect, test, type Page } from '@playwright/test';
import { addMember, call, createOrg, publishForm, signIn, watchForProblems, type Org } from './helpers';

/**
 * A team working a queue: someone is away, work nobody holds is taken, handed over with a note, a colleague is
 * asked for their view, and several items are dealt with at once. Each in the screens people use.
 */
let org: Org;
let nia: Awaited<ReturnType<typeof addMember>>;
let sam: Awaited<ReturnType<typeof addMember>>;
const ids: string[] = [];

const dialog = (page: Page) => page.getByRole('dialog');
const send = async (what: string) =>
  (await call<{ submissionId: string }>(201, `/public/forms/HELP/submissions?org=${org.orgId}`, { method: 'POST', body: { values: { what } } })).submissionId;
const owner = async (id: string) => (await call<{ record: { assigneeId: string } }>(200, `/records/${id}`, { token: org.token })).record.assigneeId;

test.beforeAll(async () => {
  org = await createOrg('Helpdesk');
  nia = await addMember(org, 'Nia Nair', 'RECORDS_WORKER');
  sam = await addMember(org, 'Sam Shah', 'RECORDS_WORKER');
  for (const m of [nia, sam]) await call(200, `/members/${m.userId}`, { method: 'PATCH', token: org.token, body: { department: 'Helpdesk' } });
  await publishForm(org, {
    name: 'Help request',
    code: 'HELP',
    fields: [{ id: 'w', type: 'TEXT', name: 'what', label: 'What do you need', required: true }],
    recordAccess: { mode: 'TEAM', userIds: [], departments: ['Helpdesk'] },
    workflow: {
      enabled: true,
      refPrefix: 'HLP',
      statuses: [
        { key: 'NEW', label: 'New', category: 'OPEN' },
        { key: 'DONE', label: 'Done', category: 'DONE' },
      ],
      assignment: { type: 'NONE' },
    },
  });
  for (const what of ['A new badge', 'A parking pass', 'A locker key', 'A desk lamp']) ids.push(await send(what));
});

test('a team member finds work nobody holds in their queue and takes it', async ({ page }) => {
  const problems = watchForProblems(page);
  await signIn(page, nia.email);
  await page.goto('/work');
  await page.getByRole('group', { name: 'Views' }).getByRole('button', { name: "My team's queue" }).click();
  await expect(page.getByRole('button', { name: 'HLP-000001' })).toBeVisible();
  await page.getByRole('button', { name: 'HLP-000001' }).click();
  await dialog(page).getByRole('button', { name: 'Take it' }).click();
  await expect.poll(() => owner(ids[0]!)).toBe(nia.userId);
  await expect(dialog(page).getByRole('button', { name: 'Take it' })).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('she asks a colleague, who answers without the record leaving her; then hands it over with a note', async ({ page, browser }) => {
  await signIn(page, nia.email);
  await page.goto('/work');
  await page.getByRole('button', { name: 'HLP-000001' }).click();
  const d = dialog(page);
  await d.getByRole('button', { name: 'Ask a colleague' }).click();
  const ask = d.getByRole('group', { name: 'Ask a colleague' });
  await ask.getByRole('combobox', { name: 'Ask' }).click();
  await page.getByRole('option', { name: 'Sam Shah' }).click();
  await ask.getByRole('textbox', { name: 'Your question' }).fill('Do badges need a photo?');
  await ask.getByRole('button', { name: 'Ask' }).click();
  await expect(d).toContainText("Waiting for Sam Shah's view");

  const his = await (await browser.newContext()).newPage();
  await signIn(his, sam.email);
  await his.goto('/work');
  await his.getByRole('group', { name: 'Views' }).getByRole('button', { name: 'Everything' }).click();
  await his.getByRole('button', { name: 'HLP-000001' }).click();
  const asked = dialog(his).getByRole('group', { name: 'Your view is asked' });
  await expect(asked).toContainText('Nia Nair asks for your view');
  await expect(asked).toContainText('Do badges need a photo?');
  await asked.getByRole('textbox', { name: 'Your answer' }).fill('Yes, a passport photo.');
  await asked.getByRole('button', { name: 'Send answer' }).click();
  // Answered: it is no longer his to see.
  await expect(dialog(his)).toBeHidden();
  await his.context().close();
  expect(await owner(ids[0]!)).toBe(nia.userId);

  await page.reload();
  await dialog(page).getByRole('tab', { name: 'History' }).click();
  await expect(dialog(page)).toContainText('Yes, a passport photo.');
  await dialog(page).getByRole('button', { name: 'Hand over with a note' }).click();
  const over = dialog(page).getByRole('group', { name: 'Hand over' });
  await over.getByRole('combobox', { name: 'Hand over to' }).click();
  await page.getByRole('option', { name: 'Sam Shah' }).click();
  await over.getByRole('textbox', { name: 'Note for them' }).fill('Photo is in the shared folder.');
  await over.getByRole('button', { name: 'Hand over' }).click();
  await expect.poll(() => owner(ids[0]!)).toBe(sam.userId);
});

test('someone says they are away; what is given to them goes to their stand-in, and Members shows it', async ({ page, browser }) => {
  await signIn(page, sam.email);
  await page.goto('/account');
  await page.getByLabel('Give my new work to').selectOption({ label: 'Nia Nair' });
  await page.getByRole('button', { name: 'Set as away' }).click();
  await expect(page.getByText('Away now')).toBeVisible();
  await expect(page.getByText(/new work goes to Nia Nair/)).toBeVisible();

  // The administrator gives him a record; it lands with Nia, and the history says why.
  await call(200, `/records/${ids[1]}/assign`, { method: 'POST', token: org.token, body: { userId: sam.userId } });
  expect(await owner(ids[1]!)).toBe(nia.userId);

  const admin = await (await browser.newContext()).newPage();
  await signIn(admin, org.email);
  await admin.goto('/members');
  await expect(admin.getByRole('row', { name: /Sam Shah/ }).getByText('Away', { exact: true })).toBeVisible();
  await admin.goto('/work');
  await admin.getByRole('group', { name: 'Views' }).getByRole('button', { name: 'Everything' }).click();
  await admin.getByRole('button', { name: 'HLP-000002' }).click();
  await dialog(admin).getByRole('tab', { name: 'History' }).click();
  await expect(dialog(admin)).toContainText('Assigned to Nia Nair (Sam Shah is away)');
  await admin.context().close();

  // Back again.
  await page.getByRole('button', { name: "I'm back" }).click();
  await expect(page.getByText('Here', { exact: true })).toBeVisible();
});

test('several at once: two items are ticked and given to one person', async ({ page }) => {
  const problems = watchForProblems(page);
  await signIn(page, org.email);
  await page.goto('/work');
  await page.getByRole('group', { name: 'Views' }).getByRole('button', { name: 'Unassigned' }).click();
  await page.getByRole('checkbox', { name: 'Tick HLP-000003' }).click();
  await page.getByRole('checkbox', { name: 'Tick HLP-000004' }).click();
  const bar = page.getByRole('group', { name: 'Ticked items' });
  await expect(bar).toContainText('2 ticked');
  await bar.getByRole('combobox', { name: 'Give ticked items to' }).click();
  await page.getByRole('option', { name: 'Nia Nair' }).click();
  await expect.poll(() => owner(ids[2]!)).toBe(nia.userId);
  await expect.poll(() => owner(ids[3]!)).toBe(nia.userId);
  await expect(bar).toHaveCount(0);
  expect(problems).toEqual([]);
});
