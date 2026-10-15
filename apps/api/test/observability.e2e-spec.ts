import { getModelToken, getConnectionToken } from '@nestjs/mongoose';
import type { Connection, Model } from 'mongoose';
import { JsonLogger } from '../src/common/json-logger';
import { withRequest } from '../src/common/request-context';
import { Job } from '../src/jobs/job.schema';
import { startApp, type Harness } from './harness';

const METRICS_TOKEN = 'metrics-token-for-the-tests';

async function waitFor(check: () => Promise<boolean> | boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor timed out');
}

const form = {
  name: 'Request',
  code: 'REQUEST',
  businessId: '',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [{ id: 'f1', type: 'TEXT', name: 'name', label: 'Name', required: true }],
  workflow: { enabled: true, refPrefix: 'REQ', statuses: [{ key: 'NEW', label: 'New', category: 'OPEN' }, { key: 'DONE', label: 'Done', category: 'DONE' }], assignment: { type: 'NONE' } },
  automations: [{ id: 'a1', name: 'Tell the CRM', enabled: true, when: 'SUBMITTED', actions: [{ id: 'w1', type: 'WEBHOOK', url: 'https://hooks.example.com/crm' }] }],
};

describe('Seeing what is happening: request IDs, logs, health and numbers (e2e)', () => {
  let h: Harness;
  let owner: string;
  let orgId: string;
  const sentWith: (string | null)[] = [];
  const realFetch = globalThis.fetch;
  const printed: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);

  beforeAll(async () => {
    process.env.FORM_WEBHOOK_ALLOWLIST = 'hooks.example.com';
    // JSON lines, as in production: the access log is read from what is printed.
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      const text = String(chunk);
      if (text.startsWith('{"at"')) {
        printed.push(text);
        return true;
      }
      return (realWrite as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
    h = await startApp({ LOG_FORMAT: 'json', METRICS_TOKEN });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).startsWith('https://hooks.example.com')) return realFetch(input, init);
      sentWith.push(new Headers(init?.headers).get('x-request-id'));
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    const folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Ops' }).expect(201)).body[0].id;
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: form }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    process.stdout.write = realWrite;
    delete process.env.FORM_WEBHOOK_ALLOWLIST;
    await h?.close();
  });

  it('every answer carries a request ID: the caller\'s when it sent a sensible one, a new one otherwise', async () => {
    const made = (await h.api().get('/health').expect(200)).headers['x-request-id'];
    expect(made).toMatch(/^[0-9a-f-]{36}$/);
    expect((await h.api().get('/health').set('x-request-id', 'lb-7f3a9c21').expect(200)).headers['x-request-id']).toBe('lb-7f3a9c21');
    const odd = (await h.api().get('/health').set('x-request-id', 'no spaces <b>').expect(200)).headers['x-request-id'];
    expect(odd).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('the ID goes with the response into its background work, the calls that work makes, and the log', async () => {
    const sent = await h.api().post(`/public/forms/REQUEST/submissions?org=${orgId}`).set('x-request-id', 'trace-submit-0001').send({ values: { name: 'Ravi' } }).expect(201);
    expect(sent.headers['x-request-id']).toBe('trace-submit-0001');
    const jobs = h.app.get<Model<Job>>(getModelToken(Job.name));
    await waitFor(async () => (await jobs.findOne({ type: 'automation.submitted', 'payload.submissionId': sent.body.submissionId }).lean())?.status === 'DONE');
    expect((await jobs.findOne({ type: 'automation.submitted', 'payload.submissionId': sent.body.submissionId }).lean())!.requestId).toBe('trace-submit-0001');
    // The webhook the automation posted says which request it came from.
    expect(sentWith).toContain('trace-submit-0001');
    // One line for the request, in JSON, with the route as written (no ids or tokens from the address).
    await waitFor(() => printed.some((l) => l.includes('trace-submit-0001')));
    const line = JSON.parse(printed.find((l) => l.includes('trace-submit-0001') && l.includes('"message":"request"'))!);
    expect(line).toMatchObject({ level: 'info', service: 'api', message: 'request', requestId: 'trace-submit-0001', method: 'POST', route: '/public/forms/:code/submissions', status: 201 });
    expect(typeof line.ms).toBe('number');
    // A signed-in request's line names the organisation.
    await h.api().get('/forms').set(h.bearer(owner)).set('x-request-id', 'trace-forms-0002').expect(200);
    await waitFor(() => printed.some((l) => l.includes('trace-forms-0002')));
    expect(JSON.parse(printed.find((l) => l.includes('trace-forms-0002'))!)).toMatchObject({ orgId, route: '/forms' });
  });

  it('a log line from inside a request names the request and the organisation', () => {
    const lines: string[] = [];
    const logger = new JsonLogger('worker', (l) => lines.push(l));
    withRequest({ requestId: 'r-12345678', orgId: 'org-1' }, () => logger.warn('slow reply', 'Connectors'));
    logger.error('broke', 'at x.ts:1', 'Jobs');
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'warn', service: 'worker', context: 'Connectors', message: 'slow reply', requestId: 'r-12345678', orgId: 'org-1' });
    expect(JSON.parse(lines[1]!)).toMatchObject({ level: 'error', context: 'Jobs', message: 'broke', stack: 'at x.ts:1' });
    expect(JSON.parse(lines[1]!).requestId).toBeUndefined();
  });

  it('/health looks at the database, the queue and the gateways, and tells nothing of any organisation', async () => {
    const jobs = h.app.get<Model<Job>>(getModelToken(Job.name));
    await jobs.create({ uuid: 'obs-failed', type: 'webhook.deliver', orgId, payload: {}, status: 'FAILED', runAt: new Date(), lastError: 'Acme secret host down' });
    await jobs.create({ uuid: 'obs-waiting', type: 'test.nobody-runs-this', orgId, payload: {}, status: 'PENDING', runAt: new Date(Date.now() - 90_000) });
    const health = (await h.api().get('/health').expect(200)).body;
    expect(health).toMatchObject({ status: 'ok', service: 'api', checks: { database: 'ok', failedJobsLastHour: 1, gatewaysConnected: 0 } });
    expect(health.checks.oldestWaitingJobSeconds).toBeGreaterThanOrEqual(89);
    expect(JSON.stringify(health)).not.toMatch(/Acme|secret/);
    await jobs.deleteOne({ uuid: 'obs-waiting' });
  });

  it('/metrics: numbers for a monitor, only with the token, labelled by route and never by what was in the address', async () => {
    await h.api().get('/metrics').expect(404);
    await h.api().get('/metrics').set('Authorization', 'Bearer wrong-token-of-same-size-xx').expect(404);
    const record = (await h.api().post(`/public/forms/REQUEST/submissions?org=${orgId}`).send({ values: { name: 'Mira' } }).expect(201)).body.submissionId;
    await h.api().post(`/public/forms/REQUEST/submissions?org=${orgId}`).send({ values: {} }).expect((r) => expect(r.status).toBeGreaterThanOrEqual(400));
    await h.api().get(`/records/${record}`).set(h.bearer(owner)).expect(200);
    const res = await h.api().get('/metrics').set('Authorization', `Bearer ${METRICS_TOKEN}`).expect(200);
    expect(res.headers['content-type']).toContain('text/plain');
    const text = res.text;
    expect(text).toContain('fb_http_request_duration_seconds_bucket{method="GET",route="/records/:id",status="200",le="+Inf"}');
    expect(text).toMatch(/fb_submissions_accepted_total [1-9]/);
    expect(text).toMatch(/fb_submissions_refused_total\{why="mistakes"\} [1-9]/);
    expect(text).toMatch(/fb_jobs\{state="FAILED"\} 1/);
    expect(text).toContain('fb_jobs_failed_last_hour 1');
    expect(text).toContain('fb_gateways_connected 0');
    expect(text).toMatch(/fb_jobs_finished_total\{outcome="done",type="automation.submitted"\} [1-9]/);
    expect(text).not.toContain(record);
    expect(text).not.toContain(orgId);
  });

  it('/health answers 503 when the database cannot be reached', async () => {
    await h.app.get<Connection>(getConnectionToken()).close();
    expect((await h.api().get('/health').expect(503)).body).toEqual({ status: 'down', service: 'api', checks: { database: 'down' } });
  });
});
