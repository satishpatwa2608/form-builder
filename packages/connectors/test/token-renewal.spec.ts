import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultRegistry, type ConnectorRecord } from '../src';

/**
 * A token we were given can stop working before it said it would: it lasted seconds, or the other system withdrew
 * it. (Found against a real identity provider, whose tokens lasted three seconds while we kept them for thirty.)
 */
const reg = defaultRegistry();
const limits = { timeoutMs: 5000, maxRows: 100 };
const entity = { key: 'customers', fields: ['id', 'name'], keyField: 'id' };

describe('a token that stops working early', () => {
  let server: Server;
  let base: string;
  const state = { issued: 0, accepted: 0, lifetime: 3600, alwaysRefuse: false, apiCalls: 0, writes: 0 };
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const json = (status: number, data: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
        if (req.url === '/token') {
          state.issued++;
          // Only the newest token is any good.
          state.accepted = state.issued;
          return json(200, { access_token: `tok-${state.issued}`, expires_in: state.lifetime });
        }
        state.apiCalls++;
        const allowed = req.headers.authorization === `Bearer tok-${state.accepted}` || req.headers.authorization === `Basic ${Buffer.from('forms:right').toString('base64')}`;
        if (state.alwaysRefuse || !allowed) return json(401, {});
        if (req.method === 'POST') {
          state.writes++;
          return json(201, { id: 7, name: JSON.parse(body).name });
        }
        json(200, [{ id: 1, name: 'Asha' }]);
      });
    }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));
  beforeEach(() => Object.assign(state, { lifetime: 3600, alwaysRefuse: false, apiCalls: 0, writes: 0 }));

  const ctx = (id: string, auth = 'oauth', secrets: Record<string, string> = { clientSecret: 's3cret' }) => ({
    connector: { id, orgId: 'o1', type: 'rest', name: 'CRM', settings: { baseUrl: `${base}/v1`, auth, tokenUrl: `${base}/token`, clientId: 'forms', resources: [{ key: 'customers', path: '/customers', fields: ['id', 'name'] }] }, secretRef: 'x', writable: true } as unknown as ConnectorRecord,
    secrets,
    allowPrivateNetwork: true,
  });

  it('withdrawn by the other system: a new one is fetched and the call is made again, once', async () => {
    const c = ctx('c-withdrawn');
    expect((await reg.run(c, { entity, kind: 'list', params: {}, limits })).rows).toEqual([{ id: 1, name: 'Asha' }]);
    const issued = state.issued;
    // The other system forgets the token it gave us (a restart, a sign-out, a policy).
    state.accepted = -1;
    state.apiCalls = 0;
    expect((await reg.run(c, { entity, kind: 'list', params: {}, limits })).rows).toEqual([{ id: 1, name: 'Asha' }]);
    expect(state.issued).toBe(issued + 1);
    expect(state.apiCalls).toBe(2);
    // A write that was refused for the same reason is sent again, and so lands exactly once.
    state.accepted = -1;
    expect((await reg.run(c, { entity, kind: 'insert', params: { name: 'Ravi' }, limits })).rows).toEqual([{ id: 7, name: 'Ravi' }]);
    expect(state.writes).toBe(1);
  });

  it('a token that lasts a second is not used after it', async () => {
    state.lifetime = 1;
    const c = ctx('c-short');
    await reg.run(c, { entity, kind: 'list', params: {}, limits });
    const issued = state.issued;
    await reg.run(c, { entity, kind: 'list', params: {}, limits });
    // Straight away it is still good, and is used again.
    expect(state.issued).toBe(issued);
    await new Promise((r) => setTimeout(r, 900));
    state.apiCalls = 0;
    await reg.run(c, { entity, kind: 'list', params: {}, limits });
    // A new one was asked for before calling, not after being refused.
    expect(state.issued).toBe(issued + 1);
    expect(state.apiCalls).toBe(1);
  });

  it('a system that refuses us whatever the token is asked twice and no more', async () => {
    const c = ctx('c-refused');
    await reg.run(c, { entity, kind: 'list', params: {}, limits });
    state.alwaysRefuse = true;
    state.apiCalls = 0;
    const issued = state.issued;
    await expect(reg.run(c, { entity, kind: 'list', params: {}, limits })).rejects.toThrow('The API answered 401');
    expect(state.apiCalls).toBe(2);
    expect(state.issued).toBe(issued + 1);
  });

  it('a connector with no token to renew is not asked twice', async () => {
    const good = ctx('c-basic', 'basic', { username: 'forms', password: 'right' });
    expect((await reg.run(good, { entity, kind: 'list', params: {}, limits })).rows).toHaveLength(1);
    state.apiCalls = 0;
    await expect(reg.run(ctx('c-basic-bad', 'basic', { username: 'forms', password: 'wrong' }), { entity, kind: 'list', params: {}, limits })).rejects.toThrow('The API answered 401');
    expect(state.apiCalls).toBe(1);
  });
});
