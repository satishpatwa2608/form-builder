import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { JobQueue } from '../src/jobs/job-queue.service';
import { Job } from '../src/jobs/job.schema';
import { startApp, type Harness } from './harness';

async function waitFor(check: () => Promise<boolean> | boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor timed out');
}

/** A response is posted to the CRM, then the requester is emailed. */
const form = {
  name: 'Request',
  code: 'REQUEST',
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
      name: 'Tell the CRM',
      enabled: true,
      when: 'SUBMITTED',
      actions: [
        { id: 'w1', type: 'WEBHOOK', url: 'https://hooks.example.com/crm' },
        { id: 'e1', type: 'EMAIL', to: [{ kind: 'FIELD', field: 'email' }], subject: 'Got it {{$record.ref}}', body: 'Thanks {{name}}' },
      ],
    },
  ],
};

describe('Failed work: seen, and run again (e2e)', () => {
  let h: Harness;
  let owner: string;
  let worker: string;
  let orgId: string;
  let crmDown = true;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    process.env.FORM_WEBHOOK_ALLOWLIST = 'hooks.example.com';
    h = await startApp();
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).startsWith('https://hooks.example.com')) return realFetch(input, init);
      return crmDown ? new Response('down', { status: 503 }) : new Response('{"leadId":"L-7"}', { status: 200 });
    }) as typeof fetch;
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    await h.addMember(owner, 'Wes', 'wes@acme.test', 'RECORDS_WORKER');
    worker = (await h.login('wes@acme.test')).token;
    const folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Ops' }).expect(201)).body[0].id;
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: form }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    delete process.env.FORM_WEBHOOK_ALLOWLIST;
    await h?.close();
  });

  const timeline = async (recordId: string) =>
    ((await h.api().get(`/records/${recordId}`).set(h.bearer(owner)).expect(200)).body.events as { type: string; message: string }[]).filter((e) => e.type === 'AUTOMATION').map((e) => e.message);

  it('a flow that stopped on a failed step is listed, and runs again from that step', async () => {
    const sent = (await h.api().post(`/public/forms/REQUEST/submissions?org=${orgId}`).send({ values: { name: 'Ravi', email: 'ravi@customer.test' } }).expect(201)).body;
    await waitFor(async () => (await timeline(sent.submissionId)).some((m) => m.startsWith('Tell the CRM: stopped')));

    // Only for Forms admins.
    await h.api().get('/failed-work').set(h.bearer(worker)).expect(403);
    const list = (await h.api().get('/failed-work').set(h.bearer(owner)).expect(200)).body;
    expect(list.flows).toEqual([
      expect.objectContaining({ recordId: sent.submissionId, ref: sent.ref, form: 'Request', automation: 'Tell the CRM', step: 1, error: 'hooks.example.com answered 503' }),
    ]);
    const { runId } = list.flows[0];

    // The CRM is back. Someone who is not an admin cannot run it again; an admin can, once.
    crmDown = false;
    await h.api().post(`/records/${sent.submissionId}/runs/${runId}/again`).set(h.bearer(worker)).expect(403);
    await h.api().post(`/records/${sent.submissionId}/runs/${runId}/again`).set(h.bearer(owner)).expect(200);
    await h.api().post(`/records/${sent.submissionId}/runs/${runId}/again`).set(h.bearer(owner)).expect(409);
    await waitFor(() => h.outbox.some((m) => m.to === 'ravi@customer.test'));
    await waitFor(async () => (await timeline(sent.submissionId)).at(-1)!.includes('emailed 1 recipient'));
    expect(await timeline(sent.submissionId)).toEqual([
      'Tell the CRM: WEBHOOK failed - hooks.example.com answered 503',
      'Tell the CRM: stopped after step 1 failed',
      'Run again from step 1',
      'Tell the CRM: posted to hooks.example.com',
      'Tell the CRM: emailed 1 recipient',
    ]);
    // Done now, so no longer listed; and it was not stopped, so it cannot be run again.
    expect((await h.api().get('/failed-work').set(h.bearer(owner)).expect(200)).body.flows).toEqual([]);
    await h.api().post(`/records/${sent.submissionId}/runs/${runId}/again`).set(h.bearer(owner)).expect(409);
    await h.api().post(`/records/${sent.submissionId}/runs/not-a-run/again`).set(h.bearer(owner)).expect(404);
  });

  it('work that gave up after its tries is listed with what it was about, and starts again', async () => {
    crmDown = false;
    const sent = (await h.api().post(`/public/forms/REQUEST/submissions?org=${orgId}`).send({ values: { name: 'Mira', email: 'mira@customer.test' } }).expect(201)).body;
    await waitFor(() => h.outbox.some((m) => m.to === 'mira@customer.test'));
    const jobs = h.app.get<Model<Job>>(getModelToken(Job.name));
    // As if every try of it had failed.
    await jobs.updateOne({ type: 'automation.submitted', 'payload.submissionId': sent.submissionId }, { $set: { status: 'FAILED', attempts: 3, lastError: 'the database did not answer' } });
    const failed = (await h.api().get('/failed-work').set(h.bearer(owner)).expect(200)).body.jobs;
    expect(failed).toEqual([expect.objectContaining({ what: 'Automations after a response', recordId: sent.submissionId, ref: sent.ref, error: 'the database did not answer', attempts: 3 })]);

    await h.api().post(`/failed-work/jobs/${failed[0].id}/retry`).set(h.bearer(worker)).expect(403);
    await h.api().post(`/failed-work/jobs/${failed[0].id}/retry`).set(h.bearer(owner)).expect(200);
    await h.app.get(JobQueue).drain();
    expect(await jobs.findOne({ uuid: failed[0].id }).lean()).toMatchObject({ status: 'DONE', attempts: 1 });
    // What it had done already is not done twice.
    expect(h.outbox.filter((m) => m.to === 'mira@customer.test')).toHaveLength(1);
    expect((await h.api().get('/failed-work').set(h.bearer(owner)).expect(200)).body.jobs).toEqual([]);
    // Only failed work, and only this organisation's.
    await h.api().post(`/failed-work/jobs/${failed[0].id}/retry`).set(h.bearer(owner)).expect(404);
    await h.signUp('Zed', 'zed@other.test', 'Other');
    const other = (await h.login('zed@other.test')).token;
    await jobs.updateOne({ uuid: failed[0].id }, { $set: { status: 'FAILED' } });
    await h.api().post(`/failed-work/jobs/${failed[0].id}/retry`).set(h.bearer(other)).expect(404);
    expect((await h.api().get('/failed-work').set(h.bearer(other)).expect(200)).body).toEqual({ jobs: [], flows: [] });
  });
});
