import { mkdtempSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { startAgent, type Agent } from '@fb/gateway';
import { JobQueue } from '../src/jobs/job-queue.service';
import { startApp, type Harness } from './harness';

/** A database only the gateway can reach: the API never sees its address or credentials. */
describe('Gateways: connectors inside a customer network (e2e)', () => {
  let h: Harness;
  let privateDb: MongoMemoryServer;
  let owner: string;
  let designer: string;
  let dir: string;
  let agent: Agent | undefined;
  let gatewayId: string;
  let connectorId: string;
  let ref: string;
  const logs: string[] = [];

  beforeAll(async () => {
    privateDb = await MongoMemoryServer.create();
    const c = await MongoClient.connect(privateDb.getUri());
    await c.db('erp').collection('vendors').insertMany([
      { code: 'V1', name: 'Steel Co', city: 'Pune' },
      { code: 'V2', name: 'Paint Co', city: 'Delhi' },
    ]);
    await c.close();
    dir = mkdtempSync(join(tmpdir(), 'fb-gw-'));
    h = await startApp();
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    await h.addMember(owner, 'Dev', 'dev@acme.test', 'DESIGNER');
    designer = (await h.login('dev@acme.test')).token;
  });
  afterAll(async () => {
    agent?.close();
    await h?.close();
    await privateDb?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a manager creates a gateway; its token registers once and the secret is stored owner-only', async () => {
    await h.api().post('/gateways').set(h.bearer(designer)).send({ name: 'Plant LAN' }).expect(403);
    const created = (await h.api().post('/gateways').set(h.bearer(owner)).send({ name: 'Plant LAN' }).expect(201)).body;
    gatewayId = created.id;
    expect(created.registrationToken).toMatch(/^fbreg_/);

    agent = await startAgent({
      apiUrl: h.base,
      allowInsecure: true,
      registrationToken: created.registrationToken,
      secretFile: join(dir, 'gateway.secret'),
      credentialsFile: join(dir, 'connectors.json'),
      log: (m) => logs.push(m),
    });
    await agent.ready;
    expect(statSync(join(dir, 'gateway.secret')).mode & 0o777).toBe(0o600);
    // The token was single-use.
    await h.api().post('/gateways/register').send({ token: created.registrationToken }).expect(400);
    const list = (await h.api().get('/gateways').set(h.bearer(owner)).expect(200)).body;
    expect(list).toEqual([expect.objectContaining({ id: gatewayId, registered: true, connected: true })]);
  });

  it('refuses a WebSocket without a valid secret', async () => {
    const WebSocket = (await import('ws')).default;
    const ws = new WebSocket(h.base.replace(/^http/, 'ws') + '/gateway/connect', { headers: { Authorization: 'Bearer fbgw_nope' } });
    const status = await new Promise<number>((resolve) => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)));
    expect(status).toBe(401);
  });

  it('a connector via the gateway: no credentials in the cloud, operations run on the agent', async () => {
    const created = (
      await h.api().post('/connectors').set(h.bearer(owner)).send({ type: 'mongodb', name: 'ERP', settings: { database: 'erp' }, gatewayId }).expect(201)
    ).body;
    connectorId = created.id;
    ref = created.ref;
    expect(created).toMatchObject({ gatewayId, gatewayConnected: true })
    expect(JSON.stringify(created)).not.toContain('mongodb://');

    // Not configured on the agent yet: the gateway says so.
    const missing = (await h.api().post(`/connectors/${connectorId}/test`).set(h.bearer(owner)).expect(200)).body;
    expect(missing).toMatchObject({ ok: false });

    writeFileSync(join(dir, 'connectors.json'), JSON.stringify({ [ref]: { uri: privateDb.getUri() } }), { mode: 0o600 });
    expect((await h.api().post(`/connectors/${connectorId}/test`).set(h.bearer(owner)).expect(200)).body).toMatchObject({ ok: true });
    const found = (await h.api().post(`/connectors/${connectorId}/discover`).set(h.bearer(owner)).expect(200)).body;
    expect(found.find((e: { key: string }) => e.key === 'vendors').fields.map((f: { name: string }) => f.name)).toEqual(expect.arrayContaining(['code', 'name', 'city']));
    await h.api()
      .put(`/connectors/${connectorId}/entities`)
      .set(h.bearer(owner))
      .send({ entities: [{ key: 'vendors', label: 'Vendors', fields: ['code', 'name'], keyField: 'code', operations: ['list'], valueField: 'code', labelField: 'name' }] })
      .expect(200);
    const rows = (await h.api().post('/connectors/query').set(h.bearer(designer)).send({ key: `/connectors/${ref}/vendors`, params: {} }).expect(200)).body;
    expect(rows).toEqual(expect.arrayContaining([{ code: 'V1', name: 'Steel Co' }]));
    expect(JSON.stringify(rows)).not.toContain('city');
    // Rotating secrets makes no sense here: they live on the agent.
    await h.api().put(`/connectors/${connectorId}/secrets`).set(h.bearer(owner)).send({ secrets: { uri: 'mongodb://x' } }).expect(400);
  });

  describe('with several API servers', () => {
    let second: Harness;
    beforeAll(async () => {
      // Another API process on the same database and keys. The agent is connected to the first one only.
      second = await startApp({ MONGODB_URL: h.config.MONGODB_URL, JWT_SECRET: h.config.JWT_SECRET, SECRET_KEY: h.config.SECRET_KEY });
    });
    afterAll(() => second?.close());

    it('a request that lands on the other server still reaches the agent, and it shows as connected there too', async () => {
      expect((await second.api().get('/gateways').set(second.bearer(owner)).expect(200)).body).toEqual([expect.objectContaining({ id: gatewayId, connected: true })]);
      expect((await second.api().get(`/connectors/${connectorId}`).set(second.bearer(owner)).expect(200)).body).toMatchObject({ gatewayConnected: true });
      const rows = (await second.api().post('/connectors/query').set(second.bearer(designer)).send({ key: `/connectors/${ref}/vendors`, params: {} }).expect(200)).body;
      expect(rows).toEqual(expect.arrayContaining([{ code: 'V1', name: 'Steel Co' }, { code: 'V2', name: 'Paint Co' }]));
      expect((await second.api().post(`/connectors/${connectorId}/test`).set(second.bearer(owner)).expect(200)).body).toMatchObject({ ok: true });
    });

    it('many at once each get their own answer, and nothing about them is left behind', async () => {
      const answers = await Promise.all(Array.from({ length: 20 }, () => second.api().post('/connectors/query').set(second.bearer(designer)).send({ key: `/connectors/${ref}/vendors`, params: {} })));
      expect(answers.map((a) => a.status)).toEqual(Array(20).fill(200));
      expect(answers.every((a) => a.body.length === 2)).toBe(true);
      const { MongoClient } = await import('mongodb');
      const db = await MongoClient.connect(h.config.MONGODB_URL);
      try {
        await new Promise((r) => setTimeout(r, 300));
        expect(await db.db().collection('gateway_calls').countDocuments()).toBe(0);
      } finally {
        await db.close();
      }
    });

    it('when the agent goes away every server says so at once; when it returns to a different server, the first still reaches it', async () => {
      agent!.close();
      await new Promise((r) => setTimeout(r, 300));
      for (const server of [h, second]) {
        expect((await server.api().get('/gateways').set(server.bearer(owner)).expect(200)).body[0]).toMatchObject({ connected: false });
        const res = await server.api().post('/connectors/query').set(server.bearer(designer)).send({ key: `/connectors/${ref}/vendors`, params: {} });
        expect(res.status).toBeGreaterThanOrEqual(400);
      }
      // It comes back, this time to the second server.
      agent = await startAgent({ apiUrl: second.base, allowInsecure: true, secretFile: join(dir, 'gateway.secret'), credentialsFile: join(dir, 'connectors.json'), log: (m) => logs.push(m) });
      await agent.ready;
      const rows = (await h.api().post('/connectors/query').set(h.bearer(designer)).send({ key: `/connectors/${ref}/vendors`, params: {} }).expect(200)).body;
      expect(rows).toHaveLength(2);
      expect((await h.api().get('/gateways').set(h.bearer(owner)).expect(200)).body[0]).toMatchObject({ connected: true });
      // And back to the first, for the tests that follow.
      agent.close();
      await new Promise((r) => setTimeout(r, 300));
      agent = await startAgent({ apiUrl: h.base, allowInsecure: true, secretFile: join(dir, 'gateway.secret'), credentialsFile: join(dir, 'connectors.json'), log: (m) => logs.push(m) });
      await agent.ready;
    });
  });

  it('a worker, which holds no gateway connection, runs an automation step through the gateway', async () => {
    // The API takes the response and only stores the job; a worker on the same database runs it. The agent is
    // connected to the first server, so the worker's call goes there through the database.
    const front = await startApp({ MONGODB_URL: h.config.MONGODB_URL, JWT_SECRET: h.config.JWT_SECRET, SECRET_KEY: h.config.SECRET_KEY, JOBS_ROLE: 'enqueue' });
    const worker = await startApp({ MONGODB_URL: h.config.MONGODB_URL, JWT_SECRET: h.config.JWT_SECRET, SECRET_KEY: h.config.SECRET_KEY, JOBS_ROLE: 'run' });
    try {
      await h.api().patch(`/connectors/${connectorId}`).set(h.bearer(owner)).send({ writable: true }).expect(200);
      await h.api()
        .put(`/connectors/${connectorId}/entities`)
        .set(h.bearer(owner))
        .send({ entities: [{ key: 'vendors', label: 'Vendors', fields: ['code', 'name'], keyField: 'code', operations: ['list', 'insert'], valueField: 'code', labelField: 'name' }] })
        .expect(200);
      const insert = (await h.api().get('/custom-workflows').set(h.bearer(owner)).expect(200)).body.find((a: { label: string }) => a.label === 'ERP: insert Vendors');
      const orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
      const folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Vendors' }).expect(201)).body[0].id;
      const definition = {
        name: 'New vendor',
        code: 'NEW_VENDOR',
        businessId: '',
        access: 'PUBLIC',
        submission: { method: 'POST', endpointId: 'default-submit' },
        fields: [
          { id: 'f1', type: 'TEXT', name: 'code', label: 'Code', required: true },
          { id: 'f2', type: 'TEXT', name: 'name', label: 'Name', required: true },
        ],
        automations: [{ id: 'a1', name: 'Save vendor', enabled: true, when: 'SUBMITTED', actions: [{ id: 's1', type: 'HANDLER', key: insert.key }] }],
      };
      const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition }).expect(201)).body.definition.id;
      await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);

      await front.api().post(`/public/forms/NEW_VENDOR/submissions?org=${orgId}`).send({ values: { code: 'V3', name: 'Glass Co' } }).expect(201);
      expect(await worker.app.get(JobQueue).drain()).toBeGreaterThan(0);
      const c = await MongoClient.connect(privateDb.getUri());
      try {
        expect(await c.db('erp').collection('vendors').findOne({ code: 'V3' })).toMatchObject({ name: 'Glass Co' });
      } finally {
        await c.close();
      }
    } finally {
      await front.close();
      await worker.close();
    }
  });

  it('revoking the gateway disconnects the agent and stops its connectors', async () => {
    await h.api().delete(`/gateways/${gatewayId}`).set(h.bearer(owner)).expect(200);
    await new Promise((r) => setTimeout(r, 200));
    expect(logs.some((l) => l.includes('revoked'))).toBe(true);
    await h.api().post('/connectors/query').set(h.bearer(designer)).send({ key: `/connectors/${ref}/vendors`, params: {} }).expect(503);
    expect((await h.api().get('/gateways').set(h.bearer(owner)).expect(200)).body).toEqual([]);
  });
});
