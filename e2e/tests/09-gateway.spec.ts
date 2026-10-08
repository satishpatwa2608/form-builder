import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { MongoClient } from 'mongodb';
import { API, MONGO, ROOT } from '../stack';
import { call, createOrg, formUrl, label, publishForm, type Org } from './helpers';

/**
 * A database the cloud cannot reach: the gateway agent runs "inside the
 * customer's network" as its own process, dials out to the API, and keeps the
 * database credentials on its own disk.
 */

const PRIVATE_DB = MONGO;
let org: Org;
let dir: string;
let agent: ChildProcess;
let agentLog = '';
let gatewayId: string;
let connectorId: string;
let ref: string;
let db: MongoClient;

test.beforeAll(async () => {
  db = await MongoClient.connect(PRIVATE_DB);
  await db.db('e2e_erp').dropDatabase();
  await db.db('e2e_erp').collection('depots').insertMany([{ code: 'D1', name: 'Nagpur depot' }, { code: 'D2', name: 'Kochi depot' }]);

  org = await createOrg('Gateway');
  const created = await call<{ id: string; registrationToken: string }>(201, '/gateways', { method: 'POST', token: org.token, body: { name: 'Plant LAN' } });
  gatewayId = created.id;

  dir = mkdtempSync(join(tmpdir(), 'fb-gw-'));
  writeFileSync(join(dir, 'connectors.json'), '{}', { mode: 0o600 });
  agent = spawn('node', [join(ROOT, 'apps/gateway/dist/main.js')], {
    cwd: dir,
    env: { ...process.env, FB_API_URL: API, FB_GATEWAY_TOKEN: created.registrationToken, FB_GATEWAY_SECRET_FILE: join(dir, 'gateway.secret'), FB_CREDENTIALS_FILE: join(dir, 'connectors.json'), FB_GATEWAY_ALLOW_INSECURE: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  agent.stdout!.on('data', (d) => (agentLog += d));
  agent.stderr!.on('data', (d) => (agentLog += d));
  await expect
    .poll(async () => (await call<{ id: string; connected: boolean }[]>(200, '/gateways', { token: org.token })).find((g) => g.id === gatewayId)?.connected, { timeout: 20_000, message: 'the gateway agent should connect' })
    .toBe(true);
});

// What the agent itself said, when something about it fails.
test.afterEach(({}, info) => {
  if (info.status !== info.expectedStatus) console.log(`gateway agent log:\n${agentLog}`);
});

test.afterAll(async () => {
  agent?.kill();
  await db?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('the agent registers once and keeps its secret to itself', async () => {
  // The one-time token became a long-lived secret, readable by its owner only.
  expect(statSync(join(dir, 'gateway.secret')).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(dir, 'gateway.secret'), 'utf8').length).toBeGreaterThan(20);
});

test('a form reads a private database through the gateway; the credentials never reach the cloud', async ({ page }) => {
  const created = await call<{ id: string; ref: string; gatewayConnected: boolean }>(201, '/connectors', {
    method: 'POST',
    token: org.token,
    body: { type: 'mongodb', name: 'ERP', settings: { database: 'e2e_erp' }, gatewayId },
  });
  connectorId = created.id;
  ref = created.ref;
  expect(created.gatewayConnected).toBe(true);

  // Until the customer puts the credentials on the agent's machine, nothing works.
  expect((await call<{ ok: boolean }>(200, `/connectors/${connectorId}/test`, { method: 'POST', token: org.token })).ok).toBe(false);
  writeFileSync(join(dir, 'connectors.json'), JSON.stringify({ [ref]: { uri: PRIVATE_DB } }), { mode: 0o600 });
  await expect.poll(async () => (await call<{ ok: boolean }>(200, `/connectors/${connectorId}/test`, { method: 'POST', token: org.token })).ok).toBe(true);

  await call(200, `/connectors/${connectorId}/discover`, { method: 'POST', token: org.token });
  await call(200, `/connectors/${connectorId}/entities`, {
    method: 'PUT',
    token: org.token,
    body: { entities: [{ key: 'depots', label: 'Depots', fields: ['code', 'name'], keyField: 'code', operations: ['list', 'get'], valueField: 'code', labelField: 'name' }] },
  });
  await publishForm(org, {
    name: 'Depot visit',
    code: 'DEPOT_VISIT',
    fields: [{ id: 'd', type: 'DROPDOWN', name: 'depot', label: 'Depot', required: true, dataSource: { type: 'API', api: { url: `/connectors/${ref}/depots`, method: 'GET', valueField: 'code', labelField: 'name' } } }],
  });

  await page.goto(formUrl(org, 'DEPOT_VISIT'));
  await page.getByRole('combobox', { name: label('Depot') }).click();
  await expect(page.getByRole('option')).toHaveText(['Nagpur depot', 'Kochi depot']);
  await page.getByRole('option', { name: 'Kochi depot' }).click();
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByText(/Thank you/)).toBeVisible();

  // Nothing the cloud stores or returns holds the connection string.
  const all = await call<unknown[]>(200, '/connectors', { token: org.token });
  expect(JSON.stringify(all)).not.toContain('mongodb://');
  // And the cloud's own copy of the connector cannot be pointed at the database directly:
  // where the agent connects is decided by the file on the customer's machine.
  writeFileSync(join(dir, 'connectors.json'), '{}', { mode: 0o600 });
  await expect.poll(async () => (await call<{ ok: boolean }>(200, `/connectors/${connectorId}/test`, { method: 'POST', token: org.token })).ok).toBe(false);
});

test('revoking the gateway cuts it off at once', async ({ page }) => {
  await call(200, `/gateways/${gatewayId}`, { method: 'DELETE', token: org.token });
  await expect.poll(() => agent.exitCode, { timeout: 15_000, message: 'a revoked agent should exit cleanly' }).toBe(0);
  expect(agentLog).toContain('this gateway was revoked - stopping');
  // The form's options can no longer be read.
  await page.goto(formUrl(org, 'DEPOT_VISIT'));
  const depot = page.getByRole('combobox', { name: label('Depot') });
  await expect(depot).toContainText(/Options unavailable|No options/);
  await expect(depot).toBeDisabled();
});
