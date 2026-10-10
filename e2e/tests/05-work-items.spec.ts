import { expect, test, type Page } from '@playwright/test';
import { addMember, call, createOrg, publishForm, signIn, waitForMail, watchForProblems, type Org } from './helpers';

/** A submission becomes a work item: assigned, worked through its actions, approved by a manager, closed. */

let org: Org;
let worker: Awaited<ReturnType<typeof addMember>>;
let boss: Awaited<ReturnType<typeof addMember>>;
let outsider: Awaited<ReturnType<typeof addMember>>;
let recordId: string;

const complaint = () => ({
  name: 'Complaint',
  code: 'COMPLAINT',
  fields: [
    { id: 'f1', type: 'TEXT', name: 'name', label: 'Your name', required: true },
    { id: 'f2', type: 'EMAIL', name: 'email', label: 'Email', required: true },
    { id: 'f3', type: 'RADIO', name: 'severity', label: 'Severity', required: true, dataSource: { type: 'STATIC', options: [{ label: 'Minor', value: 'LOW' }, { label: 'Serious', value: 'HIGH' }] } },
    { id: 'r', type: 'REPEAT', name: 'items', label: 'Items', validation: { min: 1 } },
    { id: 'i', type: 'TEXT', name: 'item', label: 'Item', parentId: 'r' },
    { id: 'q', type: 'NUMBER', name: 'qty', label: 'Qty', parentId: 'r' },
    { id: 's', type: 'SIGNATURE', name: 'sign', label: 'Signature' },
  ],
  workflow: {
    enabled: true,
    refPrefix: 'CMP',
    statuses: [
      { key: 'NEW', label: 'New', category: 'OPEN' },
      { key: 'INVESTIGATION', label: 'Investigation', category: 'IN_PROGRESS' },
      { key: 'CLOSED', label: 'Closed', category: 'DONE' },
    ],
    assignment: { type: 'USER', userId: worker.userId },
    priority: { default: 'MEDIUM', rules: [{ if: { field: 'severity', operator: 'equals', value: 'HIGH' }, priority: 'HIGH' }] },
    actions: [
      { key: 'accept', label: 'Accept', from: ['NEW'], to: 'INVESTIGATION' },
      { key: 'close', label: 'Resolve', from: ['INVESTIGATION'], to: 'CLOSED', requireFields: ['rootCause'], requireComment: true, approval: { to: [{ kind: 'MANAGER' }], onReject: 'INVESTIGATION' } },
    ],
    sla: { responseHours: 4, resolutionHours: 72 },
    contactEmailField: 'email',
    workFields: [{ id: 'w1', type: 'TEXTAREA', name: 'rootCause', label: 'Root cause' }],
  },
  automations: [
    {
      id: 'a1',
      name: 'Acknowledge',
      enabled: true,
      when: 'SUBMITTED',
      actions: [
        { id: 's1', type: 'EMAIL', to: [{ kind: 'FIELD', field: 'email' }], subject: 'We got your complaint {{$record.ref}}', body: 'Dear {{name}}, thank you. Items: {{items}}' },
        { id: 's2', type: 'NOTIFY', to: [{ kind: 'ASSIGNEE' }], message: 'New complaint {{$record.ref}}' },
      ],
    },
    { id: 'a2', name: 'Tell the customer', enabled: true, when: 'STATUS_CHANGED', toStatus: 'CLOSED', actions: [{ id: 's1', type: 'EMAIL', to: [{ kind: 'FIELD', field: 'email' }], subject: 'Complaint {{$record.ref}} closed', body: 'Cause: {{$work.rootCause}}' }] },
  ],
});

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test.beforeAll(async () => {
  org = await createOrg('Quality');
  worker = await addMember(org, 'Wes Worker', 'RECORDS_WORKER');
  boss = await addMember(org, 'Bo Boss', 'RECORDS_WORKER');
  outsider = await addMember(org, 'Olly Outsider', 'RECORDS_WORKER');
  // Wes reports to Bo: "the assignee's manager" approves.
  await call(200, `/members/${worker.userId}`, { method: 'PATCH', token: org.token, body: { managerId: boss.userId, department: 'Quality' } });
  await publishForm(org, complaint());
  const res = await call<{ submissionId: string }>(201, `/public/forms/COMPLAINT/submissions?org=${org.orgId}`, {
    method: 'POST',
    body: { values: { name: 'Ravi', email: 'ravi@customer.test', severity: 'HIGH', items: [{ item: 'Shirt', qty: 2 }, { item: 'Belt', qty: 1 }], sign: PNG } },
  });
  recordId = res.submissionId;
});

const drawer = (page: Page) => page.getByRole('dialog');
const openRecord = async (page: Page) => {
  await page.goto('/work');
  await page.getByText('CMP-000001').first().click();
  await expect(drawer(page)).toContainText('CMP-000001 · Complaint');
};

test('the customer is acknowledged and the assignee is told', async () => {
  const mail = await waitForMail('ravi@customer.test', /We got your complaint CMP-000001/);
  expect(mail.text).toContain('Dear Ravi, thank you.');
  expect(mail.text).toContain('item: Shirt; qty: 2 | item: Belt; qty: 1');
  const notes = await call<{ unread: number }>(200, '/notifications', { token: worker.token });
  expect(notes.unread).toBeGreaterThanOrEqual(1);
});

test('the assignee sees the item with its answers, takes it, and cannot resolve it without a cause and a comment', async ({ page }) => {
  const problems = watchForProblems(page);
  await signIn(page, worker.email);
  await openRecord(page);
  const d = drawer(page);
  // Priority came from the answer; the rows and the signature read as on the form.
  await expect(d).toContainText('High');
  await expect(d.getByRole('cell', { name: 'Shirt' })).toBeVisible();
  await expect(d.getByRole('columnheader', { name: 'Qty' })).toBeVisible();
  await expect(d.getByRole('img', { name: 'Signature, signed' })).toBeVisible();
  await expect(d).not.toContainText('data:image/png');
  await expect(d).toContainText('Assigned to Wes Worker');

  const actions = d.getByRole('group', { name: 'Actions' });
  await expect(actions.getByRole('button')).toHaveText(['Accept']);
  await actions.getByRole('button', { name: 'Accept' }).click();
  await d.getByRole('button', { name: 'Accept' }).last().click();
  await expect(d).toContainText('Investigation');
  await expect(actions.getByRole('button')).toHaveText(['Resolve']);

  // Resolve needs the root cause and a comment.
  await actions.getByRole('button', { name: 'Resolve' }).click();
  await d.getByRole('button', { name: 'Resolve' }).last().click();
  await expect(d.getByRole('alert')).toBeVisible();
  await expect(d).toContainText('Investigation');
  await d.getByRole('button', { name: 'Cancel' }).click();

  // What staff record about the work has its own tab.
  await d.getByRole('tab', { name: 'Work details' }).click();
  await d.getByLabel(/^Root cause/).fill('Stitching fault in batch 14');
  await d.getByRole('button', { name: 'Save' }).click();
  await expect(d).toContainText('Stitching fault in batch 14');

  // A plain comment goes on the timeline.
  await d.getByRole('textbox', { name: 'Comment', exact: true }).fill('Spoke to the customer by phone.');
  await d.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(d).toContainText('Spoke to the customer by phone.');

  // Resolve with a comment: it now waits for the manager.
  await actions.getByRole('button', { name: 'Resolve' }).click();
  await d.getByLabel('Resolve comment').fill('Replacement sent.');
  await d.getByRole('button', { name: 'Resolve' }).last().click();
  await expect(d).toContainText(/approval/i);
  await expect(d).toContainText('Investigation');
  expect(problems.filter((p) => !/4\d\d/.test(p))).toEqual([]);
});

test('someone who is not on the item cannot see it', async ({ page }) => {
  await signIn(page, outsider.email);
  await page.goto('/work');
  await expect(page.getByText('CMP-000001')).toHaveCount(0);
  expect((await fetch(`http://127.0.0.1:4198/records/${recordId}`, { headers: { authorization: `Bearer ${outsider.token}` } })).status).toBe(404);
});

test('the manager rejects once, the assignee tries again, and approval closes the item and tells the customer', async ({ page, browser }) => {
  await signIn(page, boss.email);
  await page.goto('/work');
  await page.getByText('Waiting for my approval').click();
  await page.getByText('CMP-000001').first().click();
  const d = drawer(page);
  await expect(d).toContainText('Replacement sent.');
  await d.getByLabel('Approval comment').fill('Offer a refund too.');
  await d.getByRole('button', { name: 'Reject' }).click();
  // Decided: there is nothing left to answer. The record stays open, because a manager sees what their people hold.
  await expect(d.getByRole('button', { name: 'Reject' })).toHaveCount(0);

  // Back with the assignee, still under investigation, with the manager's reason on record.
  const record = await call<{ record: { status: string }; approvals: { decision?: string; comment?: string }[] }>(200, `/records/${recordId}`, { token: worker.token });
  expect(record.record.status).toBe('INVESTIGATION');
  expect(record.approvals.map((a) => a.decision)).toContain('REJECTED');
  expect(JSON.stringify(record)).toContain('Offer a refund too.');

  const wes = await (await browser.newContext()).newPage();
  await signIn(wes, worker.email);
  await openRecord(wes);
  const wd = drawer(wes);
  await wd.getByRole('group', { name: 'Actions' }).getByRole('button', { name: 'Resolve' }).click();
  await wd.getByLabel('Resolve comment').fill('Refund issued as well.');
  await wd.getByRole('button', { name: 'Resolve' }).last().click();
  await expect(wd).toContainText(/approval/i);
  await wes.context().close();

  // The manager still has the record open; a fresh look shows the second request waiting.
  await page.reload();
  await expect(drawer(page)).toContainText('Refund issued as well.');
  await drawer(page).getByRole('button', { name: 'Approve' }).click();
  await expect.poll(async () => (await call<{ record: { status: string } }>(200, `/records/${recordId}`, { token: org.token })).record.status).toBe('CLOSED');

  const mail = await waitForMail('ravi@customer.test', /Complaint CMP-000001 closed/);
  expect(mail.text).toContain('Cause: Stitching fault in batch 14');
});

test('the dashboard counts it, and the whole story is on the timeline', async ({ page }) => {
  await signIn(page, org.email);
  await page.goto('/work/dashboard');
  await expect(page.getByText('Raised 1')).toBeVisible();
  await expect(page.getByText('Resolved 1')).toBeVisible();
  await expect(page.getByText('100%')).toBeVisible();
  const detail = await call<{ events: { type: string; message: string }[] }>(200, `/records/${recordId}`, { token: org.token });
  const story = detail.events.map((e) => e.type);
  for (const type of ['CREATED', 'ASSIGNED', 'STATUS', 'COMMENT', 'AUTOMATION']) expect(story).toContain(type);
});
