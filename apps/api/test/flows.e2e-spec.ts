import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Form } from '../src/forms/form.schema';
import { startApp, type Harness } from './harness';

const PA = 'https://prod-12.centralindia.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?api-version=2016-06-01&sig=TOPSECRETSIG';
const form = (code: string, actions: object[]) => ({
  name: `${code} request`,
  code,
  businessId: '',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [
    { id: 'a', type: 'TEXT', name: 'name', label: 'Name', required: true },
    { id: 'b', type: 'EMAIL', name: 'email', label: 'Email', required: true },
  ],
  workflow: { enabled: true, refPrefix: code.slice(0, 3), statuses: [{ key: 'NEW', label: 'New', category: 'OPEN' }, { key: 'DONE', label: 'Done', category: 'DONE' }], assignment: { type: 'NONE' } },
  automations: [{ id: 'a1', name: 'Hand over', enabled: true, when: 'SUBMITTED', actions }],
});

describe('Handing a response to an automation tool (e2e)', () => {
  let h: Harness;
  let owner: string;
  let orgId: string;
  let folder: string;
  const calls: { url: string; body: any }[] = [];
  const answer = { status: 200, body: '{"ticket":"T-77"}' };
  const realFetch = globalThis.fetch;

  const create = async (definition: object) => (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition }).expect(201)).body.definition.id as string;
  const submit = async (code: string) => (await h.api().post(`/public/forms/${code}/submissions?org=${orgId}`).send({ values: { name: 'Ravi', email: 'ravi@customer.test' } }).expect(201)).body as { submissionId: string; ref: string };
  const events = async (id: string) => ((await h.api().get(`/records/${id}`).set(h.bearer(owner)).expect(200)).body.events as { message: string }[]).map((e) => e.message);
  const waitFor = async <T>(get: () => T | undefined | Promise<T | undefined>, what: string): Promise<T> => {
    for (let i = 0; i < 200; i++) {
      const v = await get();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  beforeAll(async () => {
    h = await startApp();
    // The tools themselves are stood in for; the test's own calls to the API are real.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith('http://127.0.0.1')) {
        calls.push({ url, body: JSON.parse(String(init?.body)) });
        return new Response(answer.body, { status: answer.status });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Ops' }).expect(201)).body[0].id;
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    await h?.close();
  });

  it('a form cannot go live with an address that is not that tool\'s', async () => {
    const id = await create(form('BAD', [{ id: 'flow', type: 'FLOW', service: 'POWER_AUTOMATE', url: 'https://evil.example/collect' }]));
    const refused = await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(400);
    expect(JSON.stringify(refused.body)).toContain('that is not a Power Automate address');
    const empty = await create(form('EMPTY', [{ id: 'flow', type: 'FLOW', service: 'ZAPIER', url: '' }]));
    expect(JSON.stringify((await h.api().post(`/forms/${empty}/publish`).set(h.bearer(owner)).expect(400)).body)).toContain("paste the Zapier flow's address");
  });

  it('the response goes to the flow, and what the flow answers is there for the next step', async () => {
    const id = await create(
      form('OK', [
        { id: 'flow', type: 'FLOW', service: 'POWER_AUTOMATE', url: PA },
        { id: 'mail', type: 'EMAIL', to: [{ kind: 'FIELD', field: 'email' }], subject: 'Ticket {{$steps.flow.ticket}}', body: 'Logged as {{$steps.flow.ticket}}.' },
      ]),
    );
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
    const sub = await submit('OK');
    await waitFor(() => h.outbox.find((m) => m.to === 'ravi@customer.test' && m.subject === 'Ticket T-77'), 'the email that uses the flow\'s answer');
    expect(calls).toHaveLength(1);
    // (The usual port is left out when the address is written back.)
    expect(calls[0]!.url).toBe(PA.replace(':443', ''));
    expect(calls[0]!.body).toMatchObject({ event: 'SUBMITTED', form: { code: 'OK' }, record: { ref: sub.ref }, values: { name: 'Ravi', email: 'ravi@customer.test' } });
    // The record says where it went, never the address that would let anyone start the flow.
    const said = await events(sub.submissionId);
    expect(said).toEqual(expect.arrayContaining([expect.stringContaining('handed to Power Automate')]));
    expect(JSON.stringify(said)).not.toContain('TOPSECRETSIG');
    // Nor does the public copy of the form.
    expect(JSON.stringify((await h.api().get(`/public/forms/OK?org=${orgId}`).expect(200)).body)).not.toMatch(/TOPSECRETSIG|logic\.azure/);
  });

  it('a flow that fails stops the automation with the tool\'s host and status, and nothing of its address', async () => {
    answer.status = 502;
    const before = h.outbox.length;
    const sub = await submit('OK');
    const said = await waitFor(async () => (await events(sub.submissionId)).find((m) => /failed/.test(m)), 'the failed step');
    expect(said).toContain('prod-12.centralindia.logic.azure.com answered 502');
    expect(said).not.toContain('TOPSECRETSIG');
    expect(h.outbox.slice(before).filter((m) => m.to === 'ravi@customer.test')).toEqual([]);
    answer.status = 200;
  });

  it('an address changed behind the check is still refused when it comes to sending', async () => {
    const id = await create(form('SWAP', [{ id: 'flow', type: 'FLOW', service: 'ZAPIER', url: 'https://hooks.zapier.com/hooks/catch/1/abc/' }]));
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
    // As if the stored form were tampered with after it was checked.
    await h.app.get<Model<Form>>(getModelToken(Form.name)).updateOne({ id }, { $set: { 'definition.automations.0.actions.0.url': 'https://169.254.169.254/latest/meta-data' } });
    const before = calls.length;
    const sub = await submit('SWAP');
    const said = await waitFor(async () => (await events(sub.submissionId)).find((m) => /failed/.test(m)), 'the refused step');
    expect(said).toContain('that is not a Zapier address');
    expect(calls).toHaveLength(before);
  });
});
