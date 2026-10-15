import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { JobQueue } from '../src/jobs/job-queue.service';
import { startApp, type Harness } from './harness';

/** Somebody else's message service: remembers what it was sent. */
async function standIn() {
  const seen: { path: string; body: string; headers: IncomingMessage['headers'] }[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ path: req.url ?? '', body, headers: req.headers });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

async function waitFor(check: () => Promise<boolean> | boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor timed out');
}

/** WhatsApp only delivers approved templates: the organisation writes its provider's call with the template in it. */
const WHATSAPP_BODY = '{"to":"{{to}}","type":"template","template":{"name":"request_update","parameters":["{{message}}"]}}';

const form = (code: string, steps: Record<string, unknown>[]) => ({
  name: 'Maintenance complaint',
  code,
  businessId: '',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [
    { id: 'n', type: 'TEXT', name: 'name', label: 'Your name', required: true },
    { id: 'm', type: 'PHONE', name: 'mobile', label: 'Mobile' },
  ],
  workflow: { enabled: true, refPrefix: 'MNT', statuses: [{ key: 'NEW', label: 'New', category: 'OPEN' }, { key: 'DONE', label: 'Fixed', category: 'DONE' }], assignment: { type: 'NONE' } },
  automations: [{ id: 'tell', name: 'Tell the resident', enabled: true, when: 'SUBMITTED', actions: steps }],
});

describe('Telling the requester by text message and WhatsApp (e2e)', () => {
  let h: Harness;
  let service: Awaited<ReturnType<typeof standIn>>;
  let owner: string;
  let orgId: string;
  let folder: string;

  beforeAll(async () => {
    process.env.SMS_ALLOW_PRIVATE = 'true';
    service = await standIn();
    h = await startApp();
    await h.signUp('Asha', 'asha@acme.test', 'Acme Homes');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Maintenance' }).expect(201)).body[0].id;
  });
  afterAll(async () => {
    delete process.env.SMS_ALLOW_PRIVATE;
    await service.close();
    await h?.close();
  });

  const publish = async (code: string, steps: Record<string, unknown>[], expected = 200) => {
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: form(code, steps) }).expect(201)).body.definition.id;
    return h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(expected);
  };
  const timeline = async (recordId: string) =>
    ((await h.api().get(`/records/${recordId}`).set(h.bearer(owner)).expect(200)).body.events as { type: string; message: string }[]).filter((e) => e.type === 'AUTOMATION').map((e) => e.message);

  it('a step whose service is not set up fails with that reason, and the flow says so', async () => {
    await publish('NOT_SET_UP', [{ id: 'sms', type: 'SMS', field: 'mobile', message: 'Got it {{$record.ref}}' }]);
    const sent = (await h.api().post(`/public/forms/NOT_SET_UP/submissions?org=${orgId}`).send({ values: { name: 'Ravi', mobile: '+919812345678' } }).expect(201)).body;
    await waitFor(async () => (await timeline(sent.submissionId)).some((m) => m.includes('stopped')));
    expect(await timeline(sent.submissionId)).toContain("Tell the resident: SMS failed - the organisation's SMS service is not set up and tested yet (Organisation settings)");
    expect(service.seen).toEqual([]);
  });

  it('a WhatsApp service is set up like the SMS one, apart from it, and tested before it is used', async () => {
    await h.api().put('/org/sms').set(h.bearer(owner)).send({ url: `${service.url}/sms` }).expect(200);
    await h.api().post('/org/sms/test').set(h.bearer(owner)).send({ to: '+919800000001' }).expect(200);
    const saved = (await h.api().put('/org/whatsapp').set(h.bearer(owner)).send({ url: `${service.url}/whatsapp`, body: WHATSAPP_BODY, headers: [{ name: 'Authorization', value: 'Bearer wa-secret' }] }).expect(200)).body;
    expect(saved).toMatchObject({ url: `${service.url}/whatsapp`, enabled: false, headers: [{ name: 'Authorization', valueSet: true }] });
    expect(JSON.stringify(saved)).not.toContain('wa-secret');
    expect((await h.api().post('/org/whatsapp/test').set(h.bearer(owner)).send({ to: '+919800000002' }).expect(200)).body).toMatchObject({ enabled: true });
    expect(service.seen.at(-1)).toMatchObject({ path: '/whatsapp' });
    expect(service.seen.at(-1)!.headers.authorization).toBe('Bearer wa-secret');
    // The SMS settings are untouched by it.
    expect((await h.api().get('/org/sms').set(h.bearer(owner)).expect(200)).body).toMatchObject({ url: `${service.url}/sms`, enabled: true });
  });

  it('after a response: a text message and a WhatsApp message to the number in the answer, with the answer in the words', async () => {
    await publish('TOLD', [
      { id: 'sms', type: 'SMS', field: 'mobile', message: 'Dear {{name}}, we have your report {{$record.ref}}.' },
      { id: 'wa', type: 'WHATSAPP', field: 'mobile', message: 'Report {{$record.ref}} "received"' },
    ]);
    service.seen.length = 0;
    const sent = (await h.api().post(`/public/forms/TOLD/submissions?org=${orgId}`).send({ values: { name: 'Ravi', mobile: '+91 98123 45678' } }).expect(201)).body;
    await waitFor(() => service.seen.length === 2);
    expect(service.seen.map((s) => s.path)).toEqual(['/sms', '/whatsapp']);
    expect(JSON.parse(service.seen[0]!.body)).toEqual({ to: '+919812345678', message: `Dear Ravi, we have your report ${sent.ref}.` });
    expect(JSON.parse(service.seen[1]!.body)).toEqual({ to: '+919812345678', type: 'template', template: { name: 'request_update', parameters: [`Report ${sent.ref} "received"`] } });
    await waitFor(async () => (await timeline(sent.submissionId)).length === 2);
    expect(await timeline(sent.submissionId)).toEqual(['Tell the resident: text message sent to …5678', 'Tell the resident: WhatsApp message sent to …5678']);

    // Taken again after the worker died between sending and writing it down: not sent twice.
    const jobs = h.app.get<Model<{ uuid: string; type: string; status: string; payload: { submissionId?: string } }>>(getModelToken('Job'));
    const job = (await jobs.findOne({ type: 'automation.submitted', 'payload.submissionId': sent.submissionId }).lean())!;
    await waitFor(async () => (await jobs.findOne({ uuid: job.uuid }).lean())!.status === 'DONE');
    const events = h.app.get<Model<{ recordId: string; type: string; data: { stepIndex?: number } }>>(getModelToken('FormRecordEvent'));
    await events.deleteOne({ recordId: sent.submissionId, type: 'AUTOMATION', 'data.stepIndex': 1 });
    await jobs.updateOne({ uuid: job.uuid }, { $set: { status: 'RUNNING', lockedUntil: new Date(Date.now() - 1000) } });
    await h.app.get(JobQueue).drain();
    expect(service.seen).toHaveLength(2);
    expect((await timeline(sent.submissionId)).at(-1)).toBe('Tell the resident: WhatsApp message already sent before an interruption, not sent again');
  });

  it('no number in the answer: the step says so', async () => {
    const sent = (await h.api().post(`/public/forms/TOLD/submissions?org=${orgId}`).send({ values: { name: 'Mira' } }).expect(201)).body;
    await waitFor(async () => (await timeline(sent.submissionId)).some((m) => m.includes('stopped')));
    expect(await timeline(sent.submissionId)).toContain('Tell the resident: SMS failed - there is no phone number in "mobile"');
  });

  it('a message step must go to a phone question, and say something', async () => {
    const refused = (await publish('BAD', [{ type: 'SMS', field: 'name', message: '' }], 400)).body.errors.map((e: { message: string }) => e.message);
    expect(refused).toEqual(expect.arrayContaining(['"Tell the resident": the text message needs a message', '"Tell the resident": the text message goes to a phone number: choose the phone question it goes to']));
  });
});
