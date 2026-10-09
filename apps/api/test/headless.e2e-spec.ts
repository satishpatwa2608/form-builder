import { buildZodSchema, type FormDefinition, type FormValues } from '@fb/engine';
import { startApp, type Harness } from './harness';

/**
 * Headless use: a customer's own code fetches a published form as JSON, draws
 * it however it likes, and sends the answers. The engine that checks answers
 * in our own form page is the one the server runs, so both give one verdict.
 */
const definition = {
  name: 'Callback request',
  code: 'CALLBACK',
  businessId: '',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [
    { id: 'a', type: 'TEXT', name: 'name', label: 'Your name', required: true, validation: { minLength: 2, maxLength: 40 } },
    { id: 'b', type: 'EMAIL', name: 'email', label: 'Email', required: true },
    { id: 'c', type: 'NUMBER', name: 'people', label: 'People', validation: { min: 1, max: 10 } },
    { id: 'd', type: 'RADIO', name: 'when', label: 'When', required: true, dataSource: { type: 'STATIC', options: [{ label: 'Morning', value: 'AM' }, { label: 'Afternoon', value: 'PM' }] } },
    { id: 'e', type: 'TEXT', name: 'reason', label: 'Reason for a large group' },
  ],
  rules: [{ id: 'r1', when: { expr: 'people > 5' }, then: [{ type: 'REQUIRE', target: 'reason' }] }],
  workflow: { enabled: true, refPrefix: 'CB', statuses: [{ key: 'NEW', label: 'New', category: 'OPEN' }, { key: 'DONE', label: 'Done', category: 'DONE' }], assignment: { type: 'NONE' } },
  automations: [{ id: 'a1', name: 'Tell ops', enabled: true, when: 'SUBMITTED', actions: [{ id: 'm', type: 'EMAIL', to: [{ kind: 'EMAIL', email: 'ops@acme.test' }], subject: 'New callback', body: 'See the inbox.' }] }],
};

const cases: [string, FormValues][] = [
  ['complete', { name: 'Asha Rao', email: 'asha@example.com', people: 2, when: 'AM' }],
  ['nothing filled in', {}],
  ['a name too short and an address that is not one', { name: 'A', email: 'nope', when: 'AM' }],
  ['a number out of range', { name: 'Asha Rao', email: 'asha@example.com', people: 40, when: 'PM' }],
  ['a choice the form does not offer', { name: 'Asha Rao', email: 'asha@example.com', when: 'NIGHT' }],
  ['a large group without the reason a rule asks for', { name: 'Asha Rao', email: 'asha@example.com', people: 8, when: 'PM' }],
  ['a large group with its reason', { name: 'Asha Rao', email: 'asha@example.com', people: 8, when: 'PM', reason: 'Team visit' }],
];

describe('Headless: a form as JSON, answered from someone else\'s code (e2e)', () => {
  let h: Harness;
  let orgId: string;
  let live: FormDefinition;

  beforeAll(async () => {
    h = await startApp();
    await h.signUp('Asha', 'asha@acme.test', 'Acme Trading');
    const owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    const folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Web' }).expect(201)).body[0].id;
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
  });
  afterAll(async () => h?.close());

  it('the published form is plain JSON anyone may fetch, with everything needed to draw it', async () => {
    const res = await h.api().get(`/public/forms/CALLBACK?org=${orgId}`).expect(200);
    live = res.body.data ?? res.body;
    expect(live).toMatchObject({ code: 'CALLBACK', name: 'Callback request', status: 'PUBLISHED', version: 1 });
    expect(live.fields.map((f) => [f.name, f.type, !!f.required])).toEqual([
      ['name', 'TEXT', true],
      ['email', 'EMAIL', true],
      ['people', 'NUMBER', false],
      ['when', 'RADIO', true],
      ['reason', 'TEXT', false],
    ]);
    expect(live.fields[3]!.dataSource).toMatchObject({ type: 'STATIC', options: [{ label: 'Morning', value: 'AM' }, { label: 'Afternoon', value: 'PM' }] });
    expect(live.rules).toHaveLength(1);
    // What happens to a response afterwards is the organisation's business, not the public's.
    for (const key of ['automations', 'workflow', 'recordAccess', 'workflowRef', 'submitChecks', 'document', 'createdBy', 'updatedBy']) expect(live).not.toHaveProperty(key);
    expect(JSON.stringify(live)).not.toMatch(/hooks\.example|ops@acme\.test|Tell ops/);
    // A form that is not published is not there at all.
    await h.api().get(`/public/forms/NOPE?org=${orgId}`).expect(404);
  });

  it.each(cases)('%s: the server and the engine give the same verdict, field by field', async (_name, values) => {
    // What a client running the engine (our form page, or a customer's code) decides before sending.
    const local = buildZodSchema(live, {}).safeParse(values);
    const localFaults = local.success ? [] : [...new Set(local.error.issues.map((i) => i.path.join('.')))].sort();

    const res = await h.api().post(`/public/forms/CALLBACK/submissions?org=${orgId}`).send({ values });
    const body = res.body.data ?? res.body;
    const serverFaults = res.status === 201 ? [] : [...new Set(((res.body.errors ?? []) as { field: string }[]).map((e) => e.field))].sort();

    expect(serverFaults).toEqual(localFaults);
    expect(res.status).toBe(localFaults.length ? 422 : 201);
    if (res.status === 201) expect(body.submissionId).toEqual(expect.any(String));
    // Every fault comes with words a person can read.
    else for (const e of res.body.errors as { message: string }[]) expect(e.message.length).toBeGreaterThan(3);
  });

  it('answers the form does not ask for are refused, not stored', async () => {
    const res = await h.api().post(`/public/forms/CALLBACK/submissions?org=${orgId}`).send({ values: { name: 'Asha Rao', email: 'asha@example.com', when: 'AM', admin: true } }).expect(422);
    expect(JSON.stringify(res.body)).toContain('admin');
  });

  it('a retried send with the same key is stored once', async () => {
    const send = () => h.api().post(`/public/forms/CALLBACK/submissions?org=${orgId}`).send({ values: { name: 'Once Only', email: 'once@example.com', when: 'AM' }, idempotencyKey: '7b0c1f8e-6f1b-4d0a-9a63-0f7f2f1f9c11' });
    const first = await send().expect(201);
    const again = await send().expect(201);
    expect((again.body.data ?? again.body).submissionId).toBe((first.body.data ?? first.body).submissionId);
  });
});
