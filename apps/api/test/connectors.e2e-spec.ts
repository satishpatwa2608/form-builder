import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Connector } from '../src/connectors/connector.schema';
import { startApp, type Harness } from './harness';

describe('Connectors: a customer database behind forms (e2e)', () => {
  let h: Harness;
  let customerDb: MongoMemoryServer;
  let uri: string;
  let owner: string;
  let designer: string;
  let viewer: string;
  let orgId: string;
  let connectorId: string;
  let ref: string;

  beforeAll(async () => {
    process.env.CONNECTOR_ALLOW_PRIVATE_NETWORK = 'true'; // the test's customer database is on localhost
    customerDb = await MongoMemoryServer.create();
    uri = customerDb.getUri();
    const c = await MongoClient.connect(uri);
    await c.db('crm').collection('plants').insertMany([
      { code: 'P1', name: 'Pune plant', region: 'WEST', budget: 900 },
      { code: 'P2', name: 'Delhi plant', region: 'NORTH', budget: 700 },
    ]);
    await c.close();
    h = await startApp();
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    await h.addMember(owner, 'Dev', 'dev@acme.test', 'DESIGNER');
    const vivId = await h.addMember(owner, 'Viv', 'viv@acme.test', 'VIEWER');
    designer = (await h.login('dev@acme.test')).token;
    viewer = (await h.login('viv@acme.test')).token;
    expect(vivId).toBeTruthy();
  });
  afterAll(async () => {
    delete process.env.CONNECTOR_ALLOW_PRIVATE_NETWORK;
    await h?.close();
    await customerDb?.stop();
  });

  it('only connector managers create connectors; credentials are sealed and never returned', async () => {
    const body = { type: 'mongodb', name: 'Plant CRM', settings: { database: 'crm' }, secrets: { uri }, writable: true };
    await h.api().post('/connectors').set(h.bearer(designer)).send(body).expect(403);
    await h.api().post('/connectors').set(h.bearer(owner)).send({ ...body, secrets: { uri: 'http://nope' } }).expect(400);
    const created = (await h.api().post('/connectors').set(h.bearer(owner)).send(body).expect(201)).body;
    connectorId = created.id;
    ref = created.ref;
    expect(created).toMatchObject({ type: 'mongodb', credentialsSet: true, writable: true, entities: [] });
    expect(JSON.stringify(created)).not.toContain(uri);
    // Stored sealed (envelope: a wrapped data key + ciphertext), never in the clear.
    const stored = await h.app.get<Model<Connector>>(getModelToken(Connector.name)).findOne({ id: connectorId }).lean();
    expect(stored!.sealedSecrets).toMatch(/^v1\./);
    expect(stored!.wrappedKey).toBeTruthy();
    expect(JSON.stringify(stored)).not.toContain('mongodb://');
  });

  it('test, discover, then expose chosen fields and operations', async () => {
    expect((await h.api().post(`/connectors/${connectorId}/test`).set(h.bearer(owner)).expect(200)).body).toMatchObject({ ok: true });
    const found = (await h.api().post(`/connectors/${connectorId}/discover`).set(h.bearer(owner)).expect(200)).body;
    expect(found.find((e: { key: string }) => e.key === 'plants').fields.map((f: { name: string }) => f.name)).toEqual(expect.arrayContaining(['code', 'name', 'region', 'budget']));
    await h.api().put(`/connectors/${connectorId}/entities`).set(h.bearer(owner)).send({ entities: [{ key: 'plants', label: 'Plants', fields: ['code', 'name', 'region'], keyField: 'budget', operations: ['list'] }] }).expect(400); // keyField must be exposed
    await h.api()
      .put(`/connectors/${connectorId}/entities`)
      .set(h.bearer(owner))
      .send({
        entities: [
          { key: 'plants', label: 'Plants', fields: ['code', 'name', 'region'], keyField: 'code', operations: ['list', 'get'], valueField: 'code', labelField: 'name' },
          { key: 'complaints', label: 'Complaints', fields: ['plant', 'description', 'reporter'], operations: ['insert'] },
        ],
      })
      .expect(200);
    // Designers see usable sources (no credentials); viewers don't use connectors.
    const sources = (await h.api().get('/connectors/sources').set(h.bearer(designer)).expect(200)).body;
    expect(sources).toEqual([expect.objectContaining({ key: `/connectors/${ref}/plants`, name: 'Plant CRM · Plants', valueField: 'code', labelField: 'name' })]);
    expect((await h.api().get('/connectors/sources').set(h.bearer(viewer)).expect(200)).body).toEqual([]);
    const rows = (await h.api().post('/connectors/query').set(h.bearer(designer)).send({ key: `/connectors/${ref}/plants`, params: { region: 'WEST' } }).expect(200)).body;
    expect(rows).toEqual([{ code: 'P1', name: 'Pune plant', region: 'WEST' }]); // budget isn't exposed
  });

  it('a form bound to it: public reads only through the binding, options checked on submit, answers written by a step', async () => {
    const actions = (await h.api().get('/custom-workflows').set(h.bearer(owner)).expect(200)).body;
    const insert = actions.find((a: { label: string }) => a.label === 'Plant CRM: insert Complaints');
    expect(insert.key).toMatch(/^c-[a-z0-9]{8}-[a-f0-9]{8}$/);

    const folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Plants' }).expect(201)).body[0].id;
    const definition = {
      name: 'Plant issue',
      code: 'PLANT_ISSUE',
      businessId: '',
      access: 'PUBLIC',
      submission: { method: 'POST', endpointId: 'default-submit' },
      fields: [
        { id: 'f1', type: 'DROPDOWN', name: 'plant', label: 'Plant', required: true, dataSource: { type: 'API', api: { url: `/connectors/${ref}/plants`, method: 'GET', valueField: 'code', labelField: 'name' } } },
        { id: 'f2', type: 'TEXTAREA', name: 'description', label: 'What happened?', required: true },
        { id: 'f3', type: 'TEXT', name: 'reporter', label: 'Your name', required: true },
      ],
      automations: [{ id: 'a1', name: 'Save to CRM', enabled: true, when: 'SUBMITTED', actions: [{ id: 's1', type: 'HANDLER', key: insert.key, label: 'Save' }] }],
    };
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);

    const query = (body: object) => h.api().post(`/public/data-sources/query?org=${orgId}`).send(body);
    expect((await query({ formCode: 'PLANT_ISSUE', key: `/connectors/${ref}/plants`, params: {} }).expect(200)).body.map((r: { code: string }) => r.code).sort()).toEqual(['P1', 'P2']);
    await query({ key: `/connectors/${ref}/plants`, params: {} }).expect(404); // no form named
    await query({ formCode: 'PLANT_ISSUE', key: `/connectors/${ref}/complaints`, params: {} }).expect(404); // not bound
    await query({ formCode: 'PLANT_ISSUE', key: `/connectors/${ref}/plants`, params: { region: 'WEST' } }).expect(404); // param the field doesn't declare

    const submit = (values: object) => h.api().post(`/public/forms/PLANT_ISSUE/submissions?org=${orgId}`).send({ values, idempotencyKey: `k${Math.random()}` });
    await submit({ plant: 'P9', description: 'x', reporter: 'Ravi' }).expect(422); // not a real option
    await submit({ plant: 'P2', description: 'Boiler leak', reporter: 'Ravi' }).expect(201);
    const c = await MongoClient.connect(uri);
    let saved: unknown = null;
    for (let i = 0; i < 40 && !saved; i++) {
      saved = await c.db('crm').collection('complaints').findOne({ plant: 'P2' });
      if (!saved) await new Promise((r) => setTimeout(r, 50));
    }
    await c.close();
    expect(saved).toMatchObject({ plant: 'P2', description: 'Boiler leak', reporter: 'Ravi' });

    // Turning writes off breaks the step at the next publish, not silently.
    await h.api().patch(`/connectors/${connectorId}`).set(h.bearer(owner)).send({ writable: false }).expect(200);
    const v2 = (await h.api().post(`/forms/${id}/new-version`).set(h.bearer(owner)).expect(200)).body.definition.id;
    const refused = await h.api().post(`/forms/${v2}/publish`).set(h.bearer(owner)).expect(400);
    expect(refused.body.errors[0].message).toContain('writes are off');
  });

  it('per-connector grants, the call log, and the audit trail', async () => {
    const vivId = (await h.api().get('/members').set(h.bearer(owner))).body.find((m: { email: string }) => m.email === 'viv@acme.test').userId;
    await h.api().post('/grants').set(h.bearer(owner)).send({ userId: vivId, role: 'CONNECTOR_USER', scope: { type: 'connector', id: connectorId } }).expect(201);
    expect((await h.api().get('/connectors/sources').set(h.bearer(viewer)).expect(200)).body).toHaveLength(1);
    await h.api().post(`/connectors/${connectorId}/test`).set(h.bearer(viewer)).expect(403); // use, not manage

    const calls = (await h.api().get(`/connectors/${connectorId}/calls`).set(h.bearer(owner)).expect(200)).body;
    expect(calls.some((x: { actor: string; kind: string }) => x.actor === 'form:PLANT_ISSUE' && x.kind === 'list')).toBe(true);
    expect(calls.some((x: { actor: string; kind: string; ok: boolean }) => x.actor === 'automation:PLANT_ISSUE' && x.kind === 'insert' && x.ok)).toBe(true);
    expect(JSON.stringify(calls)).not.toContain('Boiler leak');

    const actions = (await h.api().get('/audit?limit=200').set(h.bearer(owner))).body.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['connector.created', 'connector.tested', 'connector.entities_changed', 'connector.updated']));
    await h.api().put(`/connectors/${connectorId}/secrets`).set(h.bearer(owner)).send({ secrets: { uri } }).expect(200);
    expect((await h.api().get('/audit?limit=5').set(h.bearer(owner))).body.entries[0].action).toBe('connector.credentials_changed');
  });
});
