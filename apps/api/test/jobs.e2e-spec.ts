import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { APP_CONFIG, type AppConfig } from '../src/config';
import { JobQueue, retryDelayMs, stillHeld, type JobContext } from '../src/jobs/job-queue.service';
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

describe('Job queue: a job longer than its lease (e2e)', () => {
  let h: Harness;
  let jobs: Model<Job>;
  let first: JobQueue;
  let second: JobQueue;
  const LEASE = 300;

  beforeAll(async () => {
    h = await startApp({ JOBS_LEASE_MS: String(LEASE) });
    jobs = h.app.get(getModelToken(Job.name));
    first = h.app.get(JobQueue);
    // A second worker on the same queue, as a second process would be.
    second = new JobQueue(jobs as never, h.app.get<AppConfig>(APP_CONFIG));
  });
  afterAll(async () => {
    await second?.onModuleDestroy();
    await h?.close();
  });

  it('two workers on one queue never run a job twice, however much longer than the lease it takes', async () => {
    let runs = 0;
    const slow = async () => {
      runs++;
      await new Promise((r) => setTimeout(r, LEASE * 4));
    };
    first.register('test.slow', slow);
    second.register('test.slow', slow);
    await jobs.create({ uuid: 'slow-1', type: 'test.slow', payload: {}, status: 'PENDING', runAt: new Date(), maxAttempts: 3 });
    const running = first.drain();
    // The other worker keeps looking while the first is busy, well past the lease.
    for (let i = 0; i < 12; i++) {
      await second.drain();
      await new Promise((r) => setTimeout(r, LEASE / 3));
    }
    await running;
    expect(runs).toBe(1);
    expect(await jobs.findOne({ uuid: 'slow-1' }).lean()).toMatchObject({ status: 'DONE', attempts: 1 });
  });

  it('a worker whose job was taken over stops starting things, and does not write its result over the new holder\'s', async () => {
    const seen: { aborted?: boolean; threw?: string } = {};
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    first.register('test.taken', async (_p: unknown, job: JobContext) => {
      await gate;
      // Give the renewal a moment to notice.
      await new Promise((r) => setTimeout(r, LEASE));
      seen.aborted = job.signal.aborted;
      try {
        stillHeld();
      } catch (e) {
        seen.threw = (e as Error).message;
      }
    });
    await jobs.create({ uuid: 'taken-1', type: 'test.taken', payload: {}, status: 'PENDING', runAt: new Date(), maxAttempts: 3 });
    const running = first.drain();
    await waitFor(async () => (await jobs.findOne({ uuid: 'taken-1' }).lean())?.status === 'RUNNING');
    // Another worker takes it over (as it would after this one stalled past the lease).
    await jobs.updateOne({ uuid: 'taken-1' }, { $set: { lease: 'someone-else', lockedUntil: later() } });
    release();
    await running;
    expect(seen).toEqual({ aborted: true, threw: 'job taken-1 was taken over by another worker' });
    // Still the other worker's: not marked done or failed by this one.
    expect(await jobs.findOne({ uuid: 'taken-1' }).lean()).toMatchObject({ status: 'RUNNING', lease: 'someone-else' });
  });

  it('an automation whose job was taken over starts no further step', async () => {
    await h.signUp('Lease Owner', 'lease@acme.test', 'Lease Co');
    const owner = (await h.login('lease@acme.test')).token;
    const orgId = (await h.api().get('/auth/me').set(h.bearer(owner)).expect(200)).body.org.id;
    const folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'F' }).expect(201)).body[0].id;
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: form('LEASE') }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
    // Hold the first email until the job has been taken over.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const send = h.mailer.send.bind(h.mailer);
    h.mailer.send = async (m: Parameters<typeof send>[0]) => {
      if (String(m.subject).startsWith('Got it')) {
        await gate;
        await new Promise((r) => setTimeout(r, LEASE));
      }
      return send(m);
    };
    try {
      await h.api().post(`/public/forms/LEASE/submissions?org=${orgId}`).send({ values: { name: 'Lee', email: 'lee@customer.test' } }).expect(201);
      await waitFor(async () => (await jobs.findOne({ type: 'automation.submitted', orgId }).lean())?.status === 'RUNNING');
      await jobs.updateOne({ type: 'automation.submitted', orgId }, { $set: { lease: 'someone-else', lockedUntil: later() } });
      release();
      await waitFor(() => h.outbox.some((m) => m.to === 'lee@customer.test' && String(m.subject).startsWith('Got it')));
      await new Promise((r) => setTimeout(r, LEASE * 2));
      // The step in hand finished; the next one was left for the worker that holds the job now.
      expect(h.outbox.filter((m) => m.to === 'lee@customer.test').map((m) => String(m.subject).split(' ')[0])).toEqual(['Got']);
    } finally {
      h.mailer.send = send;
    }
  });
});

describe('Automations and webhooks on the queue (e2e)', () => {
  let h: Harness;
  let queue: JobQueue;
  let jobs: Model<Job>;
  let owner: string;
  let orgId: string;
  const hooks: { url: string; key: string | null }[] = [];
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
      hooks.push({ url, key: new Headers(init?.headers).get('idempotency-key') });
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

  /** Forget a step's outcome on the timeline, and (when it never started) its start mark too; then let the job be taken again. */
  const interrupt = async (recordId: string, stepIndex: number, started: boolean) => {
    const job = (await jobs.findOne({ type: 'automation.submitted', 'payload.submissionId': recordId }).lean())!;
    await waitFor(async () => (await jobs.findOne({ uuid: job.uuid }).lean())!.status === 'DONE');
    const events = h.app.get(getModelToken('FormRecordEvent')) as Model<{ recordId: string; type: string; data: { stepIndex?: number; runId?: string } }>;
    const step = (await events.findOne({ recordId, type: 'AUTOMATION', 'data.stepIndex': stepIndex }).lean())!;
    expect((await events.deleteOne({ recordId, type: 'AUTOMATION', 'data.stepIndex': stepIndex })).deletedCount).toBe(1);
    if (!started) await h.app.get<Model<{ runId: string }>>(getModelToken('FormStepMark')).deleteOne({ runId: step.data.runId, stepIndex });
    await jobs.updateOne({ uuid: job.uuid }, { $set: { status: 'RUNNING', lockedUntil: new Date(Date.now() - 1000) } });
    await queue.drain();
  };

  it('a job that died before a step started carries on from that step', async () => {
    const res = (await submit('three@customer.test')).body;
    await waitFor(() => mailsTo('three@customer.test').length === 2);
    // As if the worker died after the first email, before the second was begun: the second is sent now.
    h.outbox.splice(h.outbox.findIndex((m) => m.to === 'three@customer.test' && m.subject.startsWith('Second')), 1);
    await interrupt(res.submissionId, 1, false);
    expect(mailsTo('three@customer.test')).toEqual(['Got it REQ-000003', 'Second REQ-000003']);
  });

  it('a job that died after sending an email, before writing that it had, does not send it again', async () => {
    const res = (await submit('five@customer.test')).body;
    await waitFor(() => mailsTo('five@customer.test').length === 2);
    await interrupt(res.submissionId, 1, true);
    expect(mailsTo('five@customer.test')).toEqual(['Got it REQ-000004', 'Second REQ-000004']);
    expect((await timeline(res.submissionId)).at(-1)).toBe('AUTOMATION: Acknowledge: emailed 1 recipient (1 of them before an interruption, not sent again)');
  });

  it('a webhook step sent again after an interruption carries the same Idempotency-Key; another response, another key', async () => {
    const folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Hooks' }).expect(201)).body[0].id;
    const def = { ...form('HOOKED'), automations: [{ id: 'a1', name: 'Tell CRM', enabled: true, when: 'SUBMITTED', actions: [{ id: 'w1', type: 'WEBHOOK', url: 'https://hooks.example.com/step' }] }] };
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: def }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
    const send = async (email: string) => (await h.api().post(`/public/forms/HOOKED/submissions?org=${orgId}`).send({ values: { name: 'Ravi', email } }).expect(201)).body.submissionId as string;
    const steps = () => hooks.filter((x) => x.url.endsWith('/step'));
    const first = await send('hook1@customer.test');
    await waitFor(() => steps().length === 1);
    await interrupt(first, 0, true);
    await send('hook2@customer.test');
    await waitFor(() => steps().length === 3);
    const [a, again, other] = steps().map((x) => x.key);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(again).toBe(a);
    expect(other).not.toBe(a);
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
