import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Connector } from '../src/connectors/connector.schema';
import { startApp, type Harness } from './harness';

/**
 * Signing a connector in as a person, against a real identity provider: Keycloak, the open-source one many
 * organisations run, doing what Microsoft's and Google's do (OAuth 2 / OpenID Connect, authorization code).
 * Nothing on the other side is ours: the sign-in page, the code, the tokens and the API that takes them are
 * all Keycloak's. Runs when one is to hand: KEYCLOAK_TEST=http://host:port (admin / admin). CI has one.
 */
const KC = (process.env.KEYCLOAK_TEST ?? '').replace(/\/+$/, '');
const REALM = `fb${Date.now().toString(36)}`;

(KC ? describe : describe.skip)('Connectors: signing in as a person, against Keycloak (e2e)', () => {
  let h: Harness;
  let owner: string;
  let connectorId: string;
  let ref: string;
  let admin: string;
  let userId: string;

  const form = (data: Record<string, string>) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString() });
  const adminApi = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${KC}/admin/realms${path}`, { method, headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status >= 400) throw new Error(`Keycloak admin ${method} ${path}: ${res.status} ${await res.text()}`);
    return res;
  };
  /** What a person does in their browser: opens the address, types their name and password on Keycloak's page, and is sent back. */
  const signInAtKeycloak = async (url: string, username: string, password: string): Promise<{ location?: string; page: string }> => {
    const page = await fetch(url, { redirect: 'manual' });
    const cookies = page.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const html = await page.text();
    const action = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, '&');
    if (!action) return { page: html };
    const sent = await fetch(action, { ...form({ username, password, credentialId: '' }), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies }, redirect: 'manual' });
    return { location: sent.headers.get('location') ?? undefined, page: sent.status === 200 ? await sent.text() : '' };
  };
  const read = () => h.api().post('/connectors/query').set(h.bearer(owner)).send({ key: `/connectors/${ref}/sessions`, params: {} });
  const back = (location: string) => h.api().get(`/connectors/oauth/callback${new URL(location).search}`).redirects(0);

  beforeAll(async () => {
    process.env.CONNECTOR_ALLOW_PRIVATE_NETWORK = 'true'; // this Keycloak is on a local address, over http
    admin = ((await (await fetch(`${KC}/realms/master/protocol/openid-connect/token`, form({ grant_type: 'password', client_id: 'admin-cli', username: 'admin', password: 'admin' }))).json()) as { access_token: string }).access_token;
    // A realm of its own, whose access tokens last three seconds, so that carrying on after one has run out is really tried.
    await adminApi('POST', '', { realm: REALM, enabled: true, accessTokenLifespan: 3 });
    await adminApi('POST', `/${REALM}/users`, { username: 'asha', enabled: true, email: 'asha@acme.test', emailVerified: true, firstName: 'Asha', lastName: 'Rao', credentials: [{ type: 'password', value: 'Correct-Horse-9', temporary: false }] });
    userId = ((await (await adminApi('GET', `/${REALM}/users?username=asha`)).json()) as { id: string }[])[0]!.id;

    h = await startApp();
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    const made = (
      await h
        .api()
        .post('/connectors')
        .set(h.bearer(owner))
        .send({
          type: 'rest',
          name: 'Staff directory',
          settings: {
            baseUrl: `${KC}/realms/${REALM}`,
            auth: 'oauthUser',
            authUrl: `${KC}/realms/${REALM}/protocol/openid-connect/auth`,
            tokenUrl: `${KC}/realms/${REALM}/protocol/openid-connect/token`,
            clientId: 'form-builder',
            scope: 'openid profile email',
            // Keycloak's own API for the signed-in person: it answers only to a token that is really theirs.
            resources: JSON.stringify([{ key: 'sessions', path: '/account/sessions', fields: ['id', 'ipAddress', 'current'] }]),
          },
          secrets: { clientSecret: 'client-s3cret-for-tests' },
        })
        .expect(201)
    ).body;
    connectorId = made.id;
    ref = made.ref;
    await h.api().put(`/connectors/${connectorId}/entities`).set(h.bearer(owner)).send({ entities: [{ key: 'sessions', label: 'Sessions', fields: ['id', 'ipAddress'], keyField: 'id', operations: ['list'] }] }).expect(200);
  }, 60_000);
  afterAll(async () => {
    delete process.env.CONNECTOR_ALLOW_PRIVATE_NETWORK;
    await adminApi('DELETE', `/${REALM}`).catch(() => undefined);
    await h?.close();
  });

  it('Keycloak refuses a return address it was not told about, and accepts ours once it is', async () => {
    const start = (await h.api().post(`/connectors/${connectorId}/sign-in`).set(h.bearer(owner)).expect(200)).body as { url: string; returnAddress: string };
    // The application is registered with another address: Keycloak will not even show its sign-in page.
    await adminApi('POST', `/${REALM}/clients`, { clientId: 'form-builder', secret: 'client-s3cret-for-tests', publicClient: false, standardFlowEnabled: true, directAccessGrantsEnabled: false, redirectUris: ['https://somewhere-else.example/callback'] });
    const refused = await signInAtKeycloak(start.url, 'asha', 'Correct-Horse-9');
    expect(refused.location).toBeUndefined();
    expect(refused.page).toMatch(/Invalid parameter: redirect_uri|invalid redirect/i);
    // Registered with the address the connector screen shows to copy.
    const client = ((await (await adminApi('GET', `/${REALM}/clients?clientId=form-builder`)).json()) as { id: string }[])[0]!;
    await adminApi('PUT', `/${REALM}/clients/${client.id}`, { clientId: 'form-builder', redirectUris: [start.returnAddress] });
  }, 60_000);

  it('a wrong password gets no further than Keycloak; the right one comes back with a code, and the connector is signed in', async () => {
    expect((await read().expect(400)).body.message).toContain('Nobody has signed in');
    const start = (await h.api().post(`/connectors/${connectorId}/sign-in`).set(h.bearer(owner)).expect(200)).body as { url: string; returnAddress: string };
    const wrong = await signInAtKeycloak(start.url, 'asha', 'not-the-password');
    expect(wrong.location).toBeUndefined();
    expect(wrong.page).toMatch(/Invalid username or password/i);

    const right = await signInAtKeycloak(start.url, 'asha', 'Correct-Horse-9');
    expect(right.location).toBeDefined();
    const returned = new URL(right.location!);
    expect(returned.origin + returned.pathname).toBe(start.returnAddress);
    expect(returned.searchParams.get('code')).toBeTruthy();
    // The note we signed came back through Keycloak untouched.
    expect(returned.searchParams.get('state')).toBe(new URL(start.url).searchParams.get('state'));

    const done = await back(right.location!).expect(302);
    expect(decodeURIComponent(done.headers.location!)).toMatch(/\/connectors\?signedIn=Staff directory$/);

    // What Keycloak gave us to carry on with is sealed, never stored or returned in the clear.
    const stored = JSON.stringify(await h.app.get<Model<Connector>>(getModelToken(Connector.name)).findOne({ id: connectorId }).lean());
    expect(stored).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\\./);
    expect(JSON.stringify((await h.api().get('/connectors').set(h.bearer(owner)).expect(200)).body)).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\\./);
  }, 60_000);

  it('the connector reads as that person, and goes on reading after its first token has run out', async () => {
    const first = (await read().expect(200)).body as { id: string; ipAddress: string }[];
    // Keycloak's answer about this very person: the session they signed in with. Only the exposed fields come back.
    expect(first.length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(first[0]!).sort()).toEqual(['id', 'ipAddress']);
    // Tokens in this realm last three seconds.
    await new Promise((r) => setTimeout(r, 4500));
    const later = (await read().expect(200)).body as { id: string }[];
    expect(later.map((s) => s.id)).toEqual(first.map((s) => s.id));
  }, 60_000);

  it('when the person is signed out at Keycloak, the connector stops reading and says to sign in again', async () => {
    await adminApi('POST', `/${REALM}/users/${userId}/logout`);
    await new Promise((r) => setTimeout(r, 3500));
    const refused = await read();
    expect(refused.status).toBe(400);
    expect(String(refused.body.message)).toMatch(/sign in again|signed in|sign-in/i);
  }, 60_000);

  it('a code works once: followed a second time, Keycloak refuses it and ends the sign-in it had given, and we say to sign in again', async () => {
    const start = (await h.api().post(`/connectors/${connectorId}/sign-in`).set(h.bearer(owner)).expect(200)).body as { url: string };
    const { location } = await signInAtKeycloak(start.url, 'asha', 'Correct-Horse-9');
    expect(decodeURIComponent((await back(location!).expect(302)).headers.location!)).toMatch(/signedIn=Staff directory$/);
    await read().expect(200);
    // The same address again (a replayed link): refused, and Keycloak, as the standard advises, withdraws what the code had earned.
    expect(decodeURIComponent((await back(location!).expect(302)).headers.location!)).toContain('signInFailed=');
    const after = await read();
    expect(after.status).toBe(400);
    expect(String(after.body.message)).toContain('Sign in again');
  }, 60_000);
});
