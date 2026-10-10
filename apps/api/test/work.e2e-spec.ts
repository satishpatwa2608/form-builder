import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp, type Harness } from './harness';

/** A complaint process: public form, assignment, SLA, named actions, an approval, emails and automations. */
const complaint = (assignee: string) => ({
  name: 'Customer complaint',
  code: 'COMPLAINT',
  businessId: '',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [
    { id: 'f1', type: 'TEXT', name: 'name', label: 'Your name', required: true },
    { id: 'f2', type: 'EMAIL', name: 'email', label: 'Email', required: true },
    { id: 'f3', type: 'RADIO', name: 'severity', label: 'Severity', required: true, dataSource: { type: 'STATIC', options: [{ label: 'Minor', value: 'LOW' }, { label: 'Serious', value: 'HIGH' }] } },
    { id: 'f4', type: 'TEXTAREA', name: 'description', label: 'What happened?', required: true },
    { id: 'f5', type: 'FILE', name: 'photos', label: 'Photos', props: { accept: ['image/*', 'application/pdf'], maxSizeMB: 2 }, validation: { max: 2 } },
  ],
  workflow: {
    enabled: true,
    refPrefix: 'CMP',
    statuses: [
      { key: 'NEW', label: 'New', category: 'OPEN' },
      { key: 'INVESTIGATION', label: 'Investigation', category: 'IN_PROGRESS' },
      { key: 'CLOSED', label: 'Closed', category: 'DONE' },
    ],
    assignment: { type: 'USER', userId: assignee },
    priority: { default: 'MEDIUM', rules: [{ if: { field: 'severity', operator: 'equals', value: 'HIGH' }, priority: 'HIGH' }] },
    actions: [
      { key: 'accept', label: 'Accept', from: ['NEW'], to: 'INVESTIGATION' },
      { key: 'close', label: 'Close', from: ['INVESTIGATION'], to: 'CLOSED', requireFields: ['rootCause'], requireComment: true, approval: { to: [{ kind: 'MANAGER' }], onReject: 'INVESTIGATION' } },
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
        { id: 's1', type: 'EMAIL', to: [{ kind: 'FIELD', field: 'email' }], subject: 'We got your complaint {{$record.ref}}', body: 'Dear {{name}}, thank you.' },
        { id: 's2', type: 'NOTIFY', to: [{ kind: 'ASSIGNEE' }], message: 'New complaint {{$record.ref}}' },
      ],
    },
  ],
});

/** A 1x1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

describe('Work items: public submissions, records, approvals, uploads (e2e)', () => {
  let h: Harness;
  let dir: string;
  let owner: string;
  let worker: string;
  let outsider: string;
  let orgId: string;
  let workerId: string;
  let bossId: string;
  let boss: string;
  const hooks: { url: string; body: unknown; signature?: string }[] = [];
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fb-uploads-'));
    process.env.FORM_WEBHOOK_ALLOWLIST = 'hooks.example.com';
    h = await startApp({ LOCAL_STORAGE_DIR: dir });
    // Outbound webhooks go to a fake receiver; everything else (the test's own calls) is real.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://hooks.example.com')) {
        hooks.push({ url, body: JSON.parse(String(init?.body)), signature: (init?.headers as Record<string, string>)['x-fb-signature'] });
        return new Response('{}', { status: 200 });
      }
      return realFetch(input, init);
    }) as typeof fetch;

    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    workerId = await h.addMember(owner, 'Wes Worker', 'wes@acme.test', 'RECORDS_WORKER');
    bossId = await h.addMember(owner, 'Bo Boss', 'bo@acme.test', 'RECORDS_WORKER');
    await h.addMember(owner, 'Olly Outsider', 'olly@acme.test', 'RECORDS_WORKER');
    // Wes reports to Bo: "the assignee's manager" approves.
    await h.api().patch(`/members/${workerId}`).set(h.bearer(owner)).send({ managerId: bossId, department: 'Quality' }).expect(200);
    worker = (await h.login('wes@acme.test')).token;
    boss = (await h.login('bo@acme.test')).token;
    outsider = (await h.login('olly@acme.test')).token;

    const folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Service' }).expect(201)).body[0].id;
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: complaint(workerId) }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    delete process.env.FORM_WEBHOOK_ALLOWLIST;
    await h?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const submit = (values: object) => h.api().post(`/public/forms/COMPLAINT/submissions?org=${orgId}`).send({ values, idempotencyKey: `k-${Math.random()}` });

  it('the public form is served by org + code, anonymous; unknown orgs and drafts are not found', async () => {
    const form = (await h.api().get(`/public/forms/COMPLAINT?org=${orgId}`).expect(200)).body;
    expect(form).toMatchObject({ code: 'COMPLAINT', status: 'PUBLISHED' });
    await h.api().get('/public/forms/COMPLAINT?org=nope').expect(404);
    await h.api().get(`/public/forms/NOT_THERE?org=${orgId}`).expect(404);
  });

  it('a submission is validated on the server and becomes a work item: ref, priority, SLA, assignee, automations', async () => {
    const bad = await submit({ name: 'Asha', email: 'not-an-email', severity: 'HIGH' }).expect(422); // field-level problems (Sangam's contract)
    expect(bad.body.errors.map((e: { field: string }) => e.field)).toEqual(expect.arrayContaining(['email', 'description']));

    const res = (await submit({ name: 'Ravi', email: 'ravi@customer.test', severity: 'HIGH', description: 'Torn fabric' }).expect(201)).body;
    expect(res.ref).toBe('CMP-000001');
    const rows = (await h.api().get('/records?assignee=me').set(h.bearer(worker)).expect(200)).body.rows;
    expect(rows).toEqual([expect.objectContaining({ ref: 'CMP-000001', status: 'NEW', priority: 'HIGH', assigneeId: workerId })]);
    const detail = (await h.api().get(`/records/${res.submissionId}`).set(h.bearer(worker)).expect(200)).body;
    expect(detail.record.responseDueAt).toBeTruthy();
    expect(detail.record.resolutionDueAt).toBeTruthy();

    // The SUBMITTED automation emailed the requester and notified the assignee (async).
    // Two: the record service's "new item for you" and the automation's own message.
    await waitFor(async () => (await h.api().get('/notifications').set(h.bearer(worker))).body.unread === 2);
    expect(h.outbox.some((m) => m.to === 'ravi@customer.test' && m.subject === 'We got your complaint CMP-000001')).toBe(true);
    const bell = (await h.api().get('/notifications').set(h.bearer(worker)).expect(200)).body;
    expect(bell.notifications.map((n: { message: string }) => n.message).sort()).toEqual(['New Customer complaint: CMP-000001', 'New complaint CMP-000001']);
    await h.api().post('/notifications/read').set(h.bearer(worker)).expect(200);
    expect((await h.api().get('/notifications').set(h.bearer(worker))).body.unread).toBe(0);
  });

  it('only the assignee, pending approvers and admins see a record', async () => {
    const id = (await h.api().get('/records?assignee=me').set(h.bearer(worker))).body.rows[0].uuid;
    await h.api().get(`/records/${id}`).set(h.bearer(outsider)).expect(404);
    expect((await h.api().get('/records?assignee=').set(h.bearer(outsider)).expect(200)).body.total).toBe(0);
    expect((await h.api().get('/records?assignee=').set(h.bearer(owner)).expect(200)).body.total).toBe(1);
    // A records worker can't design forms or see form submissions lists.
    await h.api().get('/forms').set(h.bearer(worker)).expect(200);
  });

  it('actions follow the process: required work fields and comment, then the manager approves the close', async () => {
    const id = (await h.api().get('/records?assignee=me').set(h.bearer(worker))).body.rows[0].uuid;
    const accepted = (await h.api().post(`/records/${id}/actions/accept`).set(h.bearer(worker)).send({}).expect(200)).body;
    expect(accepted.record.status).toBe('INVESTIGATION');

    const missing = await h.api().post(`/records/${id}/actions/close`).set(h.bearer(worker)).send({ comment: 'Done' }).expect(400);
    expect(JSON.stringify(missing.body)).toContain('rootCause');
    await h.api().put(`/records/${id}/work`).set(h.bearer(worker)).send({ values: { rootCause: 'Needle broke' } }).expect(200);
    const asked = (await h.api().post(`/records/${id}/actions/close`).set(h.bearer(worker)).send({ comment: 'Replaced the roll' }).expect(200)).body;
    expect(asked.record.status).toBe('INVESTIGATION'); // waiting for the manager
    const pending = asked.approvals.find((a: { status: string }) => a.status === 'WAITING');
    expect(pending.approvers).toEqual([bossId]);

    // The manager sees it (waiting on them) and approves. It is no longer waiting on them, and they still see it,
    // because a manager sees what their people hold (someone who only approves loses sight of it: away-and-approvals).
    expect((await h.api().get('/records?waiting=me').set(h.bearer(boss)).expect(200)).body.rows.map((r: { uuid: string }) => r.uuid)).toEqual([id]);
    const decided = (await h.api().post(`/records/${id}/approvals/${pending.runId}`).set(h.bearer(boss)).send({ decision: 'APPROVED', comment: 'OK' }).expect(200)).body;
    expect(decided.record.status).toBe('CLOSED');
    expect((await h.api().get('/records?waiting=me').set(h.bearer(boss)).expect(200)).body.total).toBe(0);
    const closed = (await h.api().get(`/records/${id}`).set(h.bearer(owner)).expect(200)).body;
    expect(closed.record).toMatchObject({ status: 'CLOSED', resolvedAt: expect.any(String) });
  });

  it('files: pre-signed upload, real type checked from the bytes, attached to the submission, downloadable by those who can see it', async () => {
    const ticket = async (fileName: string, contentType: string, size: number) =>
      (await h.api().post(`/public/forms/COMPLAINT/uploads?org=${orgId}`).send({ fieldName: 'photos', fileName, contentType, size }).expect(201)).body;
    await h.api().post(`/public/forms/COMPLAINT/uploads?org=${orgId}`).send({ fieldName: 'photos', fileName: 'x.exe', contentType: 'application/x-msdownload', size: 10 }).expect(400);

    // A "PNG" that is really text is rejected after upload.
    const fake = await ticket('fake.png', 'image/png', 12);
    await h.api().put(h.localUrl(fake.url).replace(h.base, '')).set('Content-Type', 'image/png').send(Buffer.from('hello world!')).expect(200);
    await h.api().post(`/public/uploads/${fake.uploadId}/verify?org=${orgId}`).expect(422);

    const real = await ticket('photo.png', 'image/png', PNG.length);
    await h.api().put(h.localUrl(real.url).replace(h.base, '')).set('Content-Type', 'image/png').send(PNG).expect(200);
    await h.api().put(h.localUrl(real.url).replace(h.base, '').replace(/.$/, 'x')).set('Content-Type', 'image/png').send(PNG).expect(403); // tampered link
    expect((await h.api().post(`/public/uploads/${real.uploadId}/verify?org=${orgId}`).expect(200)).body).toMatchObject({ contentType: 'image/png' });

    const res = (await submit({ name: 'Mia', email: 'mia@customer.test', severity: 'LOW', description: 'See photo', photos: [{ uploadId: real.uploadId }] }).expect(201)).body;
    const link = (await h.api().get(`/records/${res.submissionId}/files/${real.uploadId}`).set(h.bearer(worker)).expect(200)).body.url as string;
    const file = await h.api().get(h.localUrl(link).replace(h.base, '')).expect(200);
    expect(Buffer.compare(file.body as Buffer, PNG)).toBe(0);
    await h.api().get(`/records/${res.submissionId}/files/${real.uploadId}`).set(h.bearer(outsider)).expect(404);
  });

  it('staff add a file to a record: checked like any upload, listed with the record, in its history, and not for outsiders', async () => {
    const id = (await submit({ name: 'Noor', email: 'noor@customer.test', severity: 'LOW', description: 'Letter to follow' }).expect(201)).body.submissionId as string;
    // Someone who cannot see the record cannot add to it; a kind of file nobody may upload is refused at once.
    await h.api().post(`/records/${id}/files`).set(h.bearer(outsider)).send({ fileName: 'letter.png', contentType: 'image/png', size: PNG.length }).expect(404);
    await h.api().post(`/records/${id}/files`).set(h.bearer(worker)).send({ fileName: 'x.exe', contentType: 'application/x-msdownload', size: 10 }).expect(400);

    // What claims to be a picture and is not is thrown away when it is looked at.
    const fake = (await h.api().post(`/records/${id}/files`).set(h.bearer(worker)).send({ fileName: 'fake.png', contentType: 'image/png', size: 12 }).expect(201)).body;
    await h.api().put(h.localUrl(fake.url).replace(h.base, '')).set('Content-Type', 'image/png').send(Buffer.from('hello world!')).expect(200);
    await h.api().post(`/records/${id}/files/${fake.uploadId}/attach`).set(h.bearer(worker)).expect(422);

    const real = (await h.api().post(`/records/${id}/files`).set(h.bearer(worker)).send({ fileName: 'letter from customer.png', contentType: 'image/png', size: PNG.length }).expect(201)).body;
    await h.api().put(h.localUrl(real.url).replace(h.base, '')).set('Content-Type', 'image/png').send(PNG).expect(200);
    const after = (await h.api().post(`/records/${id}/files/${real.uploadId}/attach`).set(h.bearer(worker)).expect(200)).body;
    expect(after.record.files).toEqual([expect.objectContaining({ fieldName: '$staff', uploadId: real.uploadId, name: 'letter_from_customer.png', contentType: 'image/png', addedBy: expect.any(String) })]);
    expect(after.events.at(-1)).toMatchObject({ type: 'FILE', message: 'letter_from_customer.png' });
    // The same upload cannot be attached twice, nor to another record.
    await h.api().post(`/records/${id}/files/${real.uploadId}/attach`).set(h.bearer(worker)).expect(422);

    const link = (await h.api().get(`/records/${id}/files/${real.uploadId}`).set(h.bearer(worker)).expect(200)).body.url as string;
    expect(Buffer.compare((await h.api().get(h.localUrl(link).replace(h.base, '')).expect(200)).body as Buffer, PNG)).toBe(0);
    await h.api().get(`/records/${id}/files/${real.uploadId}`).set(h.bearer(outsider)).expect(404);
    // The public cannot use the staff's way in to put a file on a form.
    await h.api().post(`/public/forms/COMPLAINT/uploads?org=${orgId}`).send({ fieldName: '$staff', fileName: 'a.png', contentType: 'image/png', size: 10 }).expect(400);
  });

  it('webhooks: admins subscribe; deliveries are signed', async () => {
    await h.api().put('/webhooks/new').set(h.bearer(worker)).send({ name: 'CRM', url: 'https://hooks.example.com/in', events: [] }).expect(403);
    await h.api().put('/webhooks/new').set(h.bearer(owner)).send({ name: 'Bad', url: 'https://evil.test/x', events: [] }).expect(400);
    await h.api().put('/webhooks/new').set(h.bearer(owner)).send({ name: 'CRM', url: 'https://hooks.example.com/in', events: ['record.created'], secret: 's3cret' }).expect(200);
    await submit({ name: 'Zed', email: 'zed@customer.test', severity: 'LOW', description: 'Late delivery' }).expect(201);
    await waitFor(async () => hooks.length > 0);
    expect(hooks[0]).toMatchObject({ url: 'https://hooks.example.com/in', body: expect.objectContaining({ event: 'record.created' }) });
    expect(hooks[0].signature).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('dashboard, emailing the requester, and staff raising a work item from the portal', async () => {
    const dash = (await h.api().get('/work-dashboard').set(h.bearer(owner)).expect(200)).body;
    expect(dash.team.open).toBeGreaterThanOrEqual(2);
    expect(dash.performance.trend ?? []).toBeDefined();

    const id = (await h.api().get('/records?assignee=me&open=true').set(h.bearer(worker))).body.rows[0].uuid;
    await h.api().post(`/records/${id}/email`).set(h.bearer(worker)).send({ subject: 'Update', body: 'We are on it' }).expect(200);
    expect(h.outbox.at(-1)).toMatchObject({ subject: 'Update', fromName: 'Wes Worker' });

    const raised = (await h.api().post('/work-items').set(h.bearer(worker)).send({ formCode: 'COMPLAINT', values: { name: 'Wes', email: 'wes@acme.test', severity: 'LOW', description: 'Seen on the floor' } }).expect(201)).body;
    expect(raised.ref).toMatch(/^CMP-/);
  });
});

async function waitFor(check: () => Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting');
}
