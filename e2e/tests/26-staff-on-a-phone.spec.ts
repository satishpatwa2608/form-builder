import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { addMember, call, createOrg, publishForm, signIn, watchForProblems, type Org } from './helpers';

/**
 * The staff side on a phone: a maintenance worker takes a complaint, adds a photo of the repair, comments and
 * resolves it, on a phone-sized touch screen. Nothing may need sideways scrolling, and every control used must be
 * on the screen and big enough to tap.
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

let org: Org;
let wes: Awaited<ReturnType<typeof addMember>>;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test.beforeAll(async () => {
  org = await createOrg('Acme Homes');
  wes = await addMember(org, 'Wes Fixer', 'RECORDS_WORKER');
  await call(200, `/members/${wes.userId}`, { method: 'PATCH', token: org.token, body: { department: 'Maintenance' } });
  await publishForm(org, {
    name: 'Maintenance complaint',
    code: 'MAINT',
    fields: [
      { id: 'p', type: 'DROPDOWN', name: 'property', label: 'Which property?', required: true, dataSource: { type: 'STATIC', options: [{ label: 'Tower A', value: 'A' }] } },
      { id: 'd', type: 'TEXTAREA', name: 'details', label: 'What is wrong?', required: true },
    ],
    recordAccess: { mode: 'TEAM', userIds: [], departments: ['Maintenance'] },
    workflow: {
      enabled: true,
      refPrefix: 'MNT',
      statuses: [
        { key: 'NEW', label: 'New', category: 'OPEN' },
        { key: 'WIP', label: 'Being fixed', category: 'IN_PROGRESS' },
        { key: 'DONE', label: 'Fixed', category: 'DONE' },
      ],
      assignment: { type: 'NONE' },
      actions: [
        { key: 'start', label: 'Start work', from: ['NEW'], to: 'WIP' },
        { key: 'resolve', label: 'Resolve', from: ['WIP'], to: 'DONE', requireComment: true, requireFiles: { picturesOnly: true } },
      ],
    },
  });
  await call(201, `/public/forms/MAINT/submissions?org=${org.orgId}`, { method: 'POST', body: { values: { property: 'A', details: 'The kitchen tap in flat 4B drips all night' } } });
});

/** The page itself never scrolls sideways. */
const noSidewaysScroll = async (page: Page, where: string) => {
  const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  expect(scroll, `${where}: the page is ${scroll}px wide on a ${width}px screen`).toBeLessThanOrEqual(width + 1);
};

/** On the screen, inside its width, and at least 32px tall: something a thumb can hit. */
const tappable = async (control: Locator, name: string) => {
  await control.scrollIntoViewIfNeeded();
  const box = await control.boundingBox();
  expect(box, `${name} is not shown`).not.toBeNull();
  const width = control.page().viewportSize()!.width;
  expect(box!.x, `${name} starts off the screen`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${name} runs off the screen`).toBeLessThanOrEqual(width + 1);
  expect(box!.height, `${name} is too small to tap`).toBeGreaterThanOrEqual(32);
};

/** Two things on the screen do not lie on top of each other. */
const apart = async (a: Locator, b: Locator, what: string) => {
  const [x, y] = [await a.boundingBox(), await b.boundingBox()];
  expect(x && y, `${what}: one is not shown`).toBeTruthy();
  const overlap = x!.x < y!.x + y!.width && y!.x < x!.x + x!.width && x!.y < y!.y + y!.height && y!.y < x!.y + x!.height;
  expect(overlap, `${what} overlap`).toBe(false);
};

test('a worker takes a complaint, adds a photo, comments and resolves it, on a phone', async ({ page }) => {
  const problems = watchForProblems(page);
  await signIn(page, wes.email);
  await page.goto('/work');
  await noSidewaysScroll(page, 'the inbox');
  await page.getByRole('group', { name: 'Views' }).getByRole('button', { name: "My team's queue" }).click();
  const item = page.getByRole('button', { name: 'MNT-000001' });
  await tappable(item, 'the complaint in the list');
  await item.tap();

  const record = page.getByRole('dialog');
  await expect(record).toContainText('MNT-000001');
  await noSidewaysScroll(page, 'the record');
  await apart(record.getByRole('tablist'), record.getByRole('button', { name: 'Comment', exact: true }), 'the tabs and the Comment button');
  await page.screenshot({ path: 'test-results/phone-record.png' });
  const take = record.getByRole('button', { name: 'Take it' });
  await tappable(take, 'Take it');
  await take.tap();
  await expect(record.getByRole('button', { name: 'Take it' })).toHaveCount(0);

  const start = record.getByRole('group', { name: 'Actions' }).getByRole('button', { name: 'Start work' });
  await tappable(start, 'Start work');
  await start.tap();
  const confirmStart = record.getByRole('button', { name: 'Start work' }).last();
  await tappable(confirmStart, 'the confirm button');
  await confirmStart.tap();
  await expect(record).toContainText('Being fixed');

  // The photo of the repair, from the Files tab.
  await record.getByRole('tab', { name: /Files/ }).tap();
  await noSidewaysScroll(page, 'the files');
  const photo = join(tmpdir(), 'repair.png');
  writeFileSync(photo, PNG);
  await record.getByLabel('Add a file').setInputFiles(photo);
  await expect(record.getByRole('tab', { name: /Files \(1\)/ })).toBeVisible();

  // Resolve, with the comment it asks for.
  const resolve = record.getByRole('group', { name: 'Actions' }).getByRole('button', { name: 'Resolve' });
  await tappable(resolve, 'Resolve');
  await resolve.tap();
  const comment = record.getByRole('textbox', { name: 'Resolve comment' });
  await tappable(comment, 'the comment box');
  await comment.fill('Washer replaced, no more drips');
  const confirm = record.getByRole('button', { name: 'Resolve' }).last();
  await tappable(confirm, 'the confirm button');
  await confirm.tap();
  await expect(record).toContainText('Fixed');
  await noSidewaysScroll(page, 'the record once resolved');

  const done = await call<{ record: { status: string; files: { name: string }[] } }>(200, '/records?formCode=MAINT', { token: org.token });
  expect(JSON.stringify(done)).toContain('DONE');
  expect(problems).toEqual([]);
});
