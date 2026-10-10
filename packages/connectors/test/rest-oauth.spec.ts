import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultRegistry, type ConnectorRecord } from '../src';

const limits = { timeoutMs: 5000, maxRows: 100 };
const reg = defaultRegistry();

/** A REST API that hands out tokens to applications: the connector signs in as one (OAuth client credentials). */
describe('REST connector signing in with OAuth (against a stand-in API)', () => {
  let server: Server;
  let base: string;
  const state = { tokens: 0 };
  const seen: { url: string; auth?: string }[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const json = (status: number, data: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
        seen.push({ url: req.url!, auth: req.headers.authorization });
        if (req.url === '/oauth/token') {
          state.tokens++;
          const p = new URLSearchParams(body);
          return p.get('grant_type') === 'client_credentials' && p.get('client_id') === 'forms' && p.get('client_secret') === 's3cret' ? json(200, { access_token: 'tok-9', expires_in: 3600 }) : json(401, { error: 'invalid_client' });
        }
        if (req.headers.authorization !== 'Bearer tok-9') return json(401, {});
        if (req.url!.startsWith('/v1/customers')) return json(200, { data: [{ id: 1, name: 'Asha', internal: 'x' }] });
        json(200, {});
      });
    }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  const record = (id: string): ConnectorRecord =>
    ({
      id,
      orgId: 'o1',
      type: 'rest',
      name: 'CRM',
      settings: { baseUrl: `${base}/v1`, auth: 'oauth', tokenUrl: `${base}/oauth/token`, clientId: 'forms', resources: [{ key: 'customers', path: '/customers', fields: ['id', 'name'], dataPath: 'data' }] },
      secretRef: 'x',
      writable: false,
    }) as unknown as ConnectorRecord;
  const ctx = (secret = 's3cret', id = 'c-rest-oauth') => ({ connector: record(id), secrets: { clientSecret: secret }, allowPrivateNetwork: true });
  const entity = { key: 'customers', fields: ['id', 'name'], keyField: 'id' };

  it('asks for a token once, sends it with every call, and passes on only the exposed fields', async () => {
    const first = await reg.run(ctx(), { entity, kind: 'list', params: {}, limits });
    expect(first.rows).toEqual([{ id: 1, name: 'Asha' }]);
    await reg.run(ctx(), { entity, kind: 'list', params: {}, limits });
    expect(state.tokens).toBe(1);
    expect(seen.filter((s) => s.url.startsWith('/v1/customers')).every((s) => s.auth === 'Bearer tok-9')).toBe(true);
  });

  it('a wrong secret is refused plainly, and the secret is never in what is said', async () => {
    const failed = await reg.run(ctx('wrong-secret', 'c-rest-other'), { entity, kind: 'list', params: {}, limits }).then(
      () => '',
      (e: Error) => e.message,
    );
    expect(failed).toContain('Sign-in was refused');
    expect(failed).not.toContain('wrong-secret');
  });

  it('without a token address or client ID it says what is missing, before calling anything', async () => {
    const before = seen.length;
    const bare = { ...ctx(), connector: { ...record('c-bare'), settings: { ...record('c-bare').settings, tokenUrl: undefined } } as unknown as ConnectorRecord };
    await expect(reg.run(bare, { entity, kind: 'list', params: {}, limits })).rejects.toThrow('Sign-in needs a token address');
    expect(seen.length).toBe(before);
  });
});
