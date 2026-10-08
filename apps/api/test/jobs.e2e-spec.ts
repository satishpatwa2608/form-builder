import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { JobQueue, retryDelayMs } from '../src/jobs/job-queue.service';
import { Job } from '../src/jobs/job.schema';
import { startApp, type Harness } from './harness';

const HOUR = 3_600_000;
const later = (ms = 2 * HOUR) => new Date(Date.now() + ms);

async function waitFor(check: () => Promise<boolean> | boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor timed out');
}

/** A form whose automation sends an email, then notifies, then calls a webhook. */
const form = (code: string) => ({
  name: 'Request',
  code,
  businessId: '',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [
    { id: 'f1', type: 'TEXT', name: 'name', label: 'Name', required: true },
    { id: 'f2', type: 'EMAIL', name: 'email', label: 'Email', required: true },
  ],
  workflow: {
    enabled: true,
    refPrefix: 'REQ',
    statuses: [
      { key: 'NEW', label: 'New', category: 'OPEN' },
      { key: 'DONE', label: 'Done', category: 'DONE' },
    ],
    assignment: { type: 'NONE' },
    actions: [{ key: 'finish', label: 'Finish', from: ['NEW'], to: 'DONE' }],
  },
  automations: [
    {
      id: 'a1',
      name: 'Acknowledge',
      enabled: true,
      when: 'SUBMITTED',
      actions: [
        { id: 's1', type: 'EMAIL', to: [{ kind: 'FIELD', field: 'email' }], subject: 'Got it {{$record.ref}}', body: 'Thanks {{name}}' },
        { id: 's2', type: 'EMAIL', to: [{ kind: 'FIELD', field: 'email' }], subject: 'Second {{$record.ref}}', body: 'More' },
      ],
    },
  ],
});

describe('Job queue (e2e)', () => {
  let h: Harness;
  let queue: JobQueue;
  let jobs: Model<Job>;
  let calls: Record<string, number>;

  beforeAll(async () => {
    h = await startApp();
    queue = h.app.get(JobQueue);
    jobs = h.app.get(getModelToken(Job.name));
  });
  afterAll(() => h?.close());
  beforeEach(() => {
    calls = {};
  });

  const count = (key: string) => (calls[key] = (calls[key] ?? 0) + 1);
  const statusOf = async (type: string) => (await jobs.find({ type }).sort({ createdAt: 1 }).lean()).map((j) => j.status);

  it('runs a job once, as soon as it is queued', async () => {
    queue.register('test.once', async (p: { key: string }) => void count(p.key));
    await queue.enqueue('test.once', { key: 'a' });
    await waitFor(() => calls.a === 1);
    await queue.drain(later());
    expect(calls.a).toBe(1);
    expect(await statusOf('test.once')).toEqual(['DONE']);
  });

  it('retries a failed job after a delay, and not before', async () => {
    queue.register('test.flaky', async () => {
      if (count('flaky') === 1) throw new Error('receiver was down');
    });
    await queue.enqueue('test.flaky', {});
    await waitFor(async () => (await jobs.findOne({ type: 'test.flaky' }).lean())?.lastError === 'receiver was down');
    const waiting = (await jobs.findOne({ type: 'test.flaky' }).lean())!;
    expect(waiting).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(waiting.runAt.getTime()).toBeGreaterThan(Date.now() + retryDelayMs(1) - 5_000);

    await queue.drain();
    expect(calls.flaky).toBe(1); // not due yet
    await queue.drain(later());
    expect(calls.flaky).toBe(2);
    expect(await statusOf('test.flaky')).toEqual(['DONE']);
  });

  it('waits longer after each failure, up to an hour', () => {
    expect([1, 2, 3, 4, 20].map(retryDelayMs)).toEqual([30_000, 60_000, 120_000, 240_000, HOUR]);
  });

  it('gives up after its attempts and keeps the job as failed', async () => {
    queue.register('test.broken', async () => {
      count('broken');
      throw new Error('always broken');
    }, { maxAttempts: 2 });
    await queue.enqueue('test.broken', {});
    await waitFor(() => calls.broken === 1);
    await queue.drain(later());
    await queue.drain(later(10 * HOUR));
    expect(calls.broken).toBe(2);
    expect(await jobs.findOne({ type: 'test.broken' }).lean()).toMatchObject({ status: 'FAILED', attempts: 2, lastError: 'always broken' });
  });

  it('queues the same key only once', async () => {
    queue.register('test.dedupe', async () => void count('dedupe'));
    expect(await queue.enqueue('test.dedupe', {}, { dedupeKey: 'order-1' })).toBe(true);
    expect(await queue.enqueue('test.dedupe', {}, { dedupeKey: 'order-1' })).toBe(false);
    await queue.drain(later());
    expect(calls.dedupe).toBe(1);
  });

  it('never runs a job twice when several runners take from the queue at once', async () => {
    queue.register('test.crowd', async (p: { n: number }) => {
      count(`crowd-${p.n}`);
      await new Promise((r) => setTimeout(r, 5));
    });
    // Stored directly so nothing starts until all of them are there.
    await jobs.insertMany(Array.from({ length: 40 }, (_, n) => ({ uuid: `crowd-${n}`, type: 'test.crowd', payload: { n }, status: 'PENDING', runAt: new Date(), maxAttempts: 3 })));
    await Promise.all([queue.drain(), queue.drain(), queue.drain()]);
    expect(Object.keys(calls)).toHaveLength(40);
    expect(Object.values(calls).every((n) => n === 1)).toBe(true);
    expect(new Set(await statusOf('test.crowd'))).toEqual(new Set(['DONE']));
  });

  it('takes over a job whose worker died, and gives up on one that keeps dying', async () => {
    queue.register('test.orphan', async (p: { key: string }) => void count(p.key));
    const past = new Date(Date.now() - 60_000);
    await jobs.insertMany([
      { uuid: 'orphan-1', type: 'test.orphan', payload: { key: 'orphan' }, status: 'RUNNING', attempts: 1, maxAttempts: 3, runAt: past, lockedUntil: past },
      { uuid: 'orphan-2', type: 'test.orphan', payload: { key: 'still-held' }, status: 'RUNNING', attempts: 1, maxAttempts: 3, runAt: past, lockedUntil: later() },
      { uuid: 'orphan-3', type: 'test.orphan', payload: { key: 'cursed' }, status: 'RUNNING', attempts: 3, maxAttempts: 3, runAt: past, lockedUntil: past },
    ]);
    await queue.drain();
    expect(calls).toEqual({ orphan: 1 });
    expect((await jobs.findOne({ uuid: 'orphan-1' }).lean())!.status).toBe('DONE');
    expect((await jobs.findOne({ uuid: 'orphan-2' }).lean())!.status).toBe('RUNNING');
    expect(await jobs.findOne({ uuid: 'orphan-3' }).lean()).toMatchObject({ status: 'FAILED', lastError: 'its worker stopped before finishing' });
  });
});

describe('Automations and webhooks on the queue (e2e)', () => {
  let h: Harness;
  let queue: JobQueue;
  let jobs: Model<Job>;
  let owner: string;
  let orgId: string;
  const hooks: { url: string }[] = [];
  let failNext = 0;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    process.env.FORM_WEBHOOK_ALLOWLIST = 'hooks.example.com';
    h = await startApp();
    queue = h.app.get(JobQueue);
    jobs = h.app.get(getModelToken(Job.name));
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith('https://hooks.example.com')) return realFetch(input, init);
      hooks.push({ url });
      return failNext-- > 0 ? new Response('down', { status: 503 }) : new Response('{}', { status: 200 });
    }) as typeof fetch;
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    const folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Ops' }).expect(201)).body[0].id;
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: form('REQUEST') }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    delete process.env.FORM_WEBHOOK_ALLOWLIST;
    await h?.close();
  });

  const submit = (email: string) => h.api().post(`/public/forms/REQUEST/submissions?org=${orgId}`).send({ values: { name: 'Ravi', email } }).expect(201);
  const mailsTo = (email: string) => h.outbox.filter((m) => m.to === email).map((m) => m.subject);
  const timeline = async (recordId: string) =>
    ((await h.api().get(`/records/${recordId}`).set(h.bearer(owner)).expect(200)).body.events as { type: string; message: string }[]).map((e) => `${e.type}: ${e.message}`);

  it('a submission queues one job, which runs the automation', async () => {
    const res = (await submit('one@customer.test')).body;
    await waitFor(() => mailsTo('one@customer.test').length === 2);
    const job = (await jobs.findOne({ type: 'automation.submitted', 'payload.submissionId': res.submissionId }).lean())!;
    await waitFor(async () => (await jobs.findOne({ uuid: job.uuid }).lean())!.status === 'DONE');
    expect(job.orgId).toBe(orgId);
  });

  it('a job started again after a crash does not repeat what it already did', async () => {
    const res = (await submit('two@customer.test')).body;
    await waitFor(() => mailsTo('two@customer.test').length === 2);
    const job = (await jobs.findOne({ type: 'automation.submitted', 'payload.submissionId': res.submissionId }).lean())!;
    await waitFor(async () => (await jobs.findOne({ uuid: job.uuid }).lean())!.status === 'DONE');
    const before = await timeline(res.submissionId);

    // As if the worker died after doing the work but before marking the job done.
    await jobs.updateOne({ uuid: job.uuid }, { $set: { status: 'RUNNING', lockedUntil: new Date(Date.now() - 1000) } });
    await queue.drain();
    expect((await jobs.findOne({ uuid: job.uuid }).lean())!).toMatchObject({ status: 'DONE', attempts: 2 });
    expect(mailsTo('two@customer.test')).toEqual(['Got it REQ-000002', 'Second REQ-000002']);
    expect(await timeline(res.submissionId)).toEqual(before);
  });

  it('a job that died half way carries on from the next step', async () => {
    const res = (await submit('three@customer.test')).body;
    await waitFor(() => mailsTo('three@customer.test').length === 2);
    const job = (await jobs.findOne({ type: 'automation.submitted', 'payload.submissionId': res.submissionId }).lean())!;
    await waitFor(async () => (await jobs.findOne({ uuid: job.uuid }).lean())!.status === 'DONE');

    // Forget the second step, as if the worker died right after the first.
    const events = h.app.get(getModelToken('FormRecordEvent')) as Model<{ recordId: string; type: string; data: { stepIndex?: number } }>;
    expect((await events.deleteOne({ recordId: res.submissionId, type: 'AUTOMATION', 'data.stepIndex': 1 })).deletedCount).toBe(1);
    await jobs.updateOne({ uuid: job.uuid }, { $set: { status: 'RUNNING', lockedUntil: new Date(Date.now() - 1000) } });
    await queue.drain();
    expect(mailsTo('three@customer.test')).toEqual(['Got it REQ-000003', 'Second REQ-000003', 'Second REQ-000003']);
  });

  it('a webhook receiver that is down is tried again later', async () => {
    await h.api().put('/webhooks/new').set(h.bearer(owner)).send({ name: 'CRM', url: 'https://hooks.example.com/in', events: ['record.created'] }).expect(200);
    failNext = 1;
    hooks.length = 0;
    await submit('four@customer.test');
    await waitFor(async () => (await jobs.findOne({ type: 'webhook.deliver' }).lean())?.status === 'PENDING' && hooks.length === 1);
    const sub = async () => (await h.api().get('/webhooks').set(h.bearer(owner)).expect(200)).body.webhooks[0];
    expect(await sub()).toMatchObject({ failures: 1, lastResult: 'record.created: hooks.example.com answered 503' });

    await queue.drain(later());
    expect(hooks).toHaveLength(2);
    expect(await sub()).toMatchObject({ failures: 0, lastResult: 'record.created: 200' });
    expect((await jobs.findOne({ type: 'webhook.deliver' }).lean())!).toMatchObject({ status: 'DONE', attempts: 2 });
  });
});

describe('An API that only stores jobs (JOBS_ROLE=enqueue)', () => {
  let h: Harness;
  afterAll(() => h?.close());

  it('leaves the work for a worker', async () => {
    h = await startApp({ JOBS_ROLE: 'enqueue' });
    const queue = h.app.get(JobQueue);
    const jobs = h.app.get(getModelToken(Job.name)) as Model<Job>;
    expect(queue.runsJobs).toBe(false);
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    const owner = (await h.login('asha@acme.test')).token;
    const orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    const folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Ops' }).expect(201)).body[0].id;
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: form('REQUEST') }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);

    await h.api().post(`/public/forms/REQUEST/submissions?org=${orgId}`).send({ values: { name: 'Ravi', email: 'r@customer.test' } }).expect(201);
    await waitFor(async () => (await jobs.countDocuments({ type: 'automation.submitted' })) === 1);
    await new Promise((r) => setTimeout(r, 150));
    expect((await jobs.findOne({ type: 'automation.submitted' }).lean())!).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect(h.outbox.filter((m) => m.to === 'r@customer.test')).toHaveLength(0);

    // What the worker process does with the same queue.
    await queue.drain();
    expect(h.outbox.filter((m) => m.to === 'r@customer.test')).toHaveLength(2);
  });
});
