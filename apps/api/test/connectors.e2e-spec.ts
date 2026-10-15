import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Connector } from '../src/connectors/connector.schema';
import { JobQueue } from '../src/jobs/job-queue.service';
import { MAY_HAVE_RUN } from '../src/work/services/form-automation.service';
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
          // What the source said about each field goes with it, so a form started from the table has the table's limits.
          { key: 'plants', label: 'Plants', fields: ['code', 'name', 'region'], keyField: 'code', operations: ['list', 'get'], valueField: 'code', labelField: 'name', about: [{ name: 'code', type: 'string', nullable: false, maxLength: 12, minLength: 3, pattern: '^[A-Z]+$' }, { name: 'name', type: 'string', nullable: true }, { name: 'region', type: 'number', min: 1, max: 9 }] },
          { key: 'complaints', label: 'Complaints', fields: ['plant', 'description', 'reporter'], operations: ['insert'] },
        ],
      })
      .expect(200);
    const kept = (await h.api().get('/connectors').set(h.bearer(owner)).expect(200)).body.find((c: { id: string }) => c.id === connectorId).entities;
    expect(kept.find((e: { key: string }) => e.key === 'plants').about).toEqual([{ name: 'code', type: 'string', nullable: false, maxLength: 12, minLength: 3, pattern: '^[A-Z]+$' }, { name: 'name', type: 'string', nullable: true }, { name: 'region', type: 'number', min: 1, max: 9 }]);
    expect(kept.find((e: { key: string }) => e.key === 'complaints').about).toEqual([]);
    // Designers see usable sources (no credentials); viewers don't use connectors.
    const sources = (await h.api().get('/connectors/sources').set(h.bearer(designer)).expect(200)).body;
    expect(sources).toEqual([expect.objectContaining({ key: `/connectors/${ref}/plants`, name: 'Plant CRM · Plants', valueField: 'code', labelField: 'name' })]);
    expect((await h.api().get('/connectors/sources').set(h.bearer(viewer)).expect(200)).body).toEqual([]);
    const rows = (await h.api().post('/connectors/query').set(h.bearer(designer)).send({ key: `/connectors/${ref}/plants`, params: { region: 'WEST' } }).expect(200)).body;
    expect(rows).toEqual([{ code: 'P1', name: 'Pune plant', region: 'WEST' }]); // budget isn't exposed
  });

  it('trying a write adds one real row, for whoever manages the connector, where writes are allowed and the table takes new rows', async () => {
    const tryIt = (token: string, body: object) => h.api().post(`/connectors/${connectorId}/try-insert`).set(h.bearer(token)).send(body);
    await h.api().patch(`/connectors/${connectorId}`).set(h.bearer(owner)).send({ writable: false }).expect(200);
    expect((await tryIt(owner, { entity: 'complaints', values: { plant: 'P1', description: 'A test' } }).expect(400)).body.message).toContain('read only');
    await h.api().patch(`/connectors/${connectorId}`).set(h.bearer(owner)).send({ writable: true }).expect(200);
    // A designer may use the connector in forms, and may not write through it by hand.
    expect((await tryIt(designer, { entity: 'complaints', values: { plant: 'P1' } })).status).toBeGreaterThanOrEqual(403);
    // Plants are exposed for reading only.
    expect((await tryIt(owner, { entity: 'plants', values: { code: 'P9' } }).expect(400)).body.message).toBe('That table is not exposed for adding rows');
    expect((await tryIt(owner, { entity: 'complaints', values: { budget: 5 } }).expect(400)).body.message).toBe('Type a value for at least one of its fields');
    // A field that is not exposed is not written, however it is sent.
    const done = (await tryIt(owner, { entity: 'complaints', values: { plant: 'P1', description: 'Tried from the Connectors page', secret: 'x' } }).expect(200)).body;
    expect(done.added).toBe(1);
    expect(JSON.stringify(done)).not.toContain('secret');
  });

  it('a "look up" event binds a source too, with its own parameters', async () => {
    const folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Lookups' }).expect(201)).body[0].id;
    const lookup = (disabled: boolean) => ({
      name: 'Plant lookup',
      code: 'PLANT_LOOKUP',
      businessId: '',
      access: 'PUBLIC',
      submission: { method: 'POST', endpointId: 'default-submit' },
      fields: [
        { id: 'f1', type: 'TEXT', name: 'region', label: 'Region' },
        { id: 'f2', type: 'TEXT', name: 'plantName', label: 'Plant' },
        { id: 'f3', type: 'BUTTON', name: 'find', label: 'Find plant' },
      ],
      events: [
        {
          id: 'e1',
          disabled,
          on: { type: 'CLICK', field: 'find' },
          do: [{ type: 'FETCH', source: { url: `/connectors/${ref}/plants`, method: 'GET', params: { region: '{{region}}' } }, set: { plantName: 'name' } }],
        },
      ],
    });
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: lookup(false) }).expect(201)).body.definition.id;
    const query = (body: object) => h.api().post(`/public/data-sources/query?org=${orgId}`).send(body);
    const key = `/connectors/${ref}/plants`;
    await query({ formCode: 'PLANT_LOOKUP', key, params: { region: 'WEST' } }).expect(404); // not published yet
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);

    expect((await query({ formCode: 'PLANT_LOOKUP', key, params: { region: 'WEST' } }).expect(200)).body).toEqual([{ code: 'P1', name: 'Pune plant', region: 'WEST' }]);
    await query({ formCode: 'PLANT_LOOKUP', key, params: { code: 'P1' } }).expect(404); // a parameter the event doesn't declare
    await query({ formCode: 'PLANT_LOOKUP', key: `/connectors/${ref}/complaints`, params: {} }).expect(404); // a source it doesn't use

    // Switched off, the event no longer opens the source.
    const v2 = (await h.api().post(`/forms/${id}/new-version`).set(h.bearer(owner)).expect(200)).body.definition.id;
    await h.api().put(`/forms/${v2}`).set(h.bearer(owner)).send(lookup(true)).expect(200);
    await h.api().post(`/forms/${v2}/publish`).set(h.bearer(owner)).expect(200);
    await query({ formCode: 'PLANT_LOOKUP', key, params: { region: 'WEST' } }).expect(404);
  });

  it('a write step fills each field from the answer whose name matches, or the one the designer chose', async () => {
    const insert = (await h.api().get('/custom-workflows').set(h.bearer(owner)).expect(200)).body.find((a: { label: string }) => a.label === 'Plant CRM: insert Complaints');
    // The builder is told which fields the step fills.
    expect(insert.inputs).toEqual(['plant', 'description', 'reporter']);
    const folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Loose names' }).expect(201)).body[0].id;
    const definition = {
      name: 'Issue (other names)',
      code: 'ISSUE_OTHER_NAMES',
      businessId: '',
      access: 'PUBLIC',
      submission: { method: 'POST', endpointId: 'default-submit' },
      fields: [
        { id: 'f1', type: 'TEXT', name: 'Plant_Code', label: 'Plant code', required: true },
        { id: 'f2', type: 'TEXTAREA', name: 'details', label: 'Details', required: true },
        // Differs from the connector's "reporter" only by its capital: matched without anyone choosing.
        { id: 'f3', type: 'TEXT', name: 'Reporter', label: 'Your name', required: true },
        { id: 'f4', type: 'TEXT', name: 'internal', label: 'Internal' },
      ],
      automations: [{ id: 'a1', name: 'Save', enabled: true, when: 'SUBMITTED', actions: [{ id: 's1', type: 'HANDLER', key: insert.key, map: { plant: 'Plant_Code', description: 'details' } }] }],
    };
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
    await h.api().post(`/public/forms/ISSUE_OTHER_NAMES/submissions?org=${orgId}`).send({ values: { Plant_Code: 'P7', details: 'Valve stuck', Reporter: 'Meera', internal: 'not for the CRM' } }).expect(201);
    const c = await MongoClient.connect(uri);
    let saved: Record<string, unknown> | null = null;
    for (let i = 0; i < 40 && !saved; i++) {
      saved = await c.db('crm').collection('complaints').findOne({ plant: 'P7' });
      if (!saved) await new Promise((r) => setTimeout(r, 50));
    }
    await c.close();
    expect(saved).toMatchObject({ plant: 'P7', description: 'Valve stuck', reporter: 'Meera' });
    expect(saved).not.toHaveProperty('internal');
    expect(saved).not.toHaveProperty('Plant_Code');
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
    const record = (await submit({ plant: 'P2', description: 'Boiler leak', reporter: 'Ravi' }).expect(201)).body.submissionId as string;
    const c = await MongoClient.connect(uri);
    let saved: unknown = null;
    for (let i = 0; i < 40 && !saved; i++) {
      saved = await c.db('crm').collection('complaints').findOne({ plant: 'P2' });
      if (!saved) await new Promise((r) => setTimeout(r, 50));
    }
    await c.close();
    expect(saved).toMatchObject({ plant: 'P2', description: 'Boiler leak', reporter: 'Ravi' });

    // The worker dies after the row is written and before the timeline says so: the job is taken again, and the
    // row is not written a second time. The step is stopped for a person to check instead.
    const jobs = h.app.get<Model<{ uuid: string; status: string; type: string; payload: { submissionId?: string } }>>(getModelToken('Job'));
    const job = (await jobs.findOne({ type: 'automation.submitted', 'payload.submissionId': record }).lean())!;
    for (let i = 0; i < 40 && (await jobs.findOne({ uuid: job.uuid }).lean())!.status !== 'DONE'; i++) await new Promise((r) => setTimeout(r, 50));
    const events = h.app.get<Model<{ recordId: string; type: string; data: { stepIndex?: number } }>>(getModelToken('FormRecordEvent'));
    expect((await events.deleteMany({ recordId: record, type: 'AUTOMATION', 'data.stepIndex': 0 })).deletedCount).toBe(1);
    await jobs.updateOne({ uuid: job.uuid }, { $set: { status: 'RUNNING', lockedUntil: new Date(Date.now() - 1000) } });
    await h.app.get(JobQueue).drain();
    const again = await MongoClient.connect(uri);
    expect(await again.db('crm').collection('complaints').countDocuments({ plant: 'P2' })).toBe(1);
    await again.close();
    const timeline = (await h.api().get(`/records/${record}`).set(h.bearer(owner)).expect(200)).body.events.map((e: { message: string }) => e.message);
    expect(timeline).toContain(`Save to CRM: HANDLER failed - ${MAY_HAVE_RUN}`);
    // A person looked, found it was not there after all, and ran it again: now it is written.
    const stopped = (await h.api().get('/failed-work').set(h.bearer(owner)).expect(200)).body.flows.find((f: { recordId: string }) => f.recordId === record);
    expect(stopped).toMatchObject({ automation: 'Save to CRM', step: 1, error: MAY_HAVE_RUN });
    await h.api().post(`/records/${record}/runs/${stopped.runId}/again`).set(h.bearer(owner)).expect(200);
    await h.app.get(JobQueue).drain();
    const third = await MongoClient.connect(uri);
    expect(await third.db('crm').collection('complaints').countDocuments({ plant: 'P2' })).toBe(2);
    await third.close();

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
