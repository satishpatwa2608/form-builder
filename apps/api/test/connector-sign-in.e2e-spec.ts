import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Connector } from '../src/connectors/connector.schema';
import { startApp, type Harness } from './harness';

/**
 * A REST connector that signs in as a person (OAuth authorization code). The other system is played by a small
 * server here: it hands out a code's worth of sign-in at its token address and serves customers to a valid token.
 */
describe('Connectors: signing in as a person (e2e)', () => {
  let h: Harness;
  let other: Server;
  let base: string;
  let owner: string;
  let designer: string;
  let connectorId: string;
  const seen: { grant: string | null; code: string | null; redirect: string | null; refresh: string | null }[] = [];

  beforeAll(async () => {
    process.env.CONNECTOR_ALLOW_PRIVATE_NETWORK = 'true'; // the stand-in is on localhost
    other = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const json = (status: number, data: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
        if (req.url === '/token') {
          const p = new URLSearchParams(body);
          seen.push({ grant: p.get('grant_type'), code: p.get('code'), redirect: p.get('redirect_uri'), refresh: p.get('refresh_token') });
          if (p.get('client_id') !== 'forms' || p.get('client_secret') !== 's3cret') return json(401, { error: 'invalid_client' });
          if (p.get('grant_type') === 'authorization_code') return p.get('code') === 'good-code' ? json(200, { access_token: 'short', refresh_token: 'lasting-1' }) : p.get('code') === 'no-refresh' ? json(200, { access_token: 'short' }) : json(400, { error: 'invalid_grant' });
          if (p.get('grant_type') === 'refresh_token') return p.get('refresh_token') === 'lasting-1' ? json(200, { access_token: 'tok-person', expires_in: 3600 }) : json(400, { error: 'invalid_grant' });
          return json(400, {});
        }
        if (req.headers.authorization !== 'Bearer tok-person') return json(401, {});
        if (req.url!.startsWith('/v1/customers')) return json(200, [{ id: 1, name: 'Asha' }]);
        json(200, {});
      });
    }).listen(0, '127.0.0.1');
    await new Promise((r) => other.once('listening', r));
    base = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    h = await startApp();
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    await h.addMember(owner, 'Dev', 'dev@acme.test', 'DESIGNER');
    designer = (await h.login('dev@acme.test')).token;
    const made = (
      await h
        .api()
        .post('/connectors')
        .set(h.bearer(owner))
        .send({
          type: 'rest',
          name: 'CRM',
          settings: { baseUrl: `${base}/v1`, auth: 'oauthUser', authUrl: `${base}/authorize`, tokenUrl: `${base}/token`, clientId: 'forms', scope: 'read offline_access', resources: JSON.stringify([{ key: 'customers', path: '/customers', fields: ['id', 'name'] }]) },
          secrets: { clientSecret: 's3cret' },
        })
        .expect(201)
    ).body;
    connectorId = made.id;
    await h.api().put(`/connectors/${connectorId}/entities`).set(h.bearer(owner)).send({ entities: [{ key: 'customers', label: 'Customers', fields: ['id', 'name'], keyField: 'id', operations: ['list'] }] }).expect(200);
  });
  afterAll(async () => {
    delete process.env.CONNECTOR_ALLOW_PRIVATE_NETWORK;
    await h?.close();
    await new Promise((r) => other.close(r));
  });

  const read = () => h.api().post('/connectors/query').set(h.bearer(owner)).send({ key: `/connectors/${ref()}/customers`, params: {} });
  let theRef = '';
  const ref = () => theRef;
  const back = (query: string) => h.api().get(`/connectors/oauth/callback?${query}`).redirects(0);
  const said = (res: { headers: Record<string, string> }) => decodeURIComponent(res.headers.location ?? '');

  it('until someone has signed in, the connector says so; only its manager may start', async () => {
    theRef = (await h.api().get('/connectors').set(h.bearer(owner)).expect(200)).body.find((c: { id: string }) => c.id === connectorId).ref;
    expect((await read().expect(400)).body.message ?? JSON.stringify((await read()).body)).toContain('Nobody has signed in');
    expect((await h.api().post(`/connectors/${connectorId}/sign-in`).set(h.bearer(designer))).status).toBeGreaterThanOrEqual(403);
  });

  it('the person is sent to the other system with our return address and a signed note; coming back with a code signs the connector in', async () => {
    const start = (await h.api().post(`/connectors/${connectorId}/sign-in`).set(h.bearer(owner)).expect(200)).body as { url: string; returnAddress: string };
    const url = new URL(start.url);
    expect(url.origin + url.pathname).toBe(`${base}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ response_type: 'code', client_id: 'forms', redirect_uri: start.returnAddress, scope: 'read offline_access' });
    expect(start.returnAddress).toMatch(/\/connectors\/oauth\/callback$/);
    const state = url.searchParams.get('state')!;

    // A note we did not sign, or one that has been altered, is not accepted, and nothing is asked of the other system.
    const before = seen.length;
    expect(said(await back(`state=made-up.note&code=good-code`).expect(302))).toContain('signInFailed=That sign-in was not started here');
    expect(said(await back(`state=${state.slice(0, -2)}xx&code=good-code`).expect(302))).toContain('signInFailed=');
    expect(seen.length).toBe(before);
    // The other system refusing, a wrong code, and a sign-in that does not last are each said plainly.
    expect(said(await back(`state=${state}&error=access_denied`).expect(302))).toContain('did not allow it (access_denied)');
    expect(said(await back(`state=${state}&code=bad-code`).expect(302))).toContain('The sign-in was not accepted');
    expect(said(await back(`state=${state}&code=no-refresh`).expect(302))).toContain('does not last');

    const ok = await back(`state=${state}&code=good-code`).expect(302);
    expect(said(ok)).toMatch(/\/connectors\?signedIn=CRM$/);
    expect(seen.at(-1)).toMatchObject({ grant: 'authorization_code', code: 'good-code', redirect: start.returnAddress });

    // The lasting sign-in is sealed with the other credentials, never stored or returned in the clear.
    const stored = await h.app.get<Model<Connector>>(getModelToken(Connector.name)).findOne({ id: connectorId }).lean();
    expect(JSON.stringify(stored)).not.toContain('lasting-1');
    expect(JSON.stringify((await h.api().get('/connectors').set(h.bearer(owner)).expect(200)).body)).not.toContain('lasting-1');

    // And the connector now reads as that person.
    expect((await read().expect(200)).body).toEqual([{ id: 1, name: 'Asha' }]);
    expect(seen.at(-1)).toMatchObject({ grant: 'refresh_token', refresh: 'lasting-1' });
  });

  it('a connector that does not sign in as a person has no sign-in to start', async () => {
    const plain = (await h.api().post('/connectors').set(h.bearer(owner)).send({ type: 'rest', name: 'Open API', settings: { baseUrl: `${base}/v1`, auth: 'none', resources: '[]' }, secrets: {} }).expect(201)).body;
    expect((await h.api().post(`/connectors/${plain.id}/sign-in`).set(h.bearer(owner)).expect(400)).body.message).toContain('does not sign in as a person');
  });
});
