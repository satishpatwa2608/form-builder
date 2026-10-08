import { mkdtempSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { startAgent, type Agent } from '@fb/gateway';
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

  it('revoking the gateway disconnects the agent and stops its connectors', async () => {
    await h.api().delete(`/gateways/${gatewayId}`).set(h.bearer(owner)).expect(200);
    await new Promise((r) => setTimeout(r, 200));
    expect(logs.some((l) => l.includes('revoked'))).toBe(true);
    await h.api().post('/connectors/query').set(h.bearer(designer)).send({ key: `/connectors/${ref}/vendors`, params: {} }).expect(503);
    expect((await h.api().get('/gateways').set(h.bearer(owner)).expect(200)).body).toEqual([]);
  });
});
