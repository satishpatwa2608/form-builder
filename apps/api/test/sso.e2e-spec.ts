import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PlansService } from '../src/plans/plans.service';
import { SsoService } from '../src/sso/sso.service';
import type { TxtResolver } from '../src/site/site.service';
import { startApp, type Harness } from './harness';

/** A tiny OpenID provider: discovery, token (checks secret + PKCE), userinfo. */
function fakeIdp() {
  const state = { email: 'new.person@acme.test', verified: true as boolean | undefined, challenge: '', tokenCalls: 0 };
  const server: Server = createServer((req, res) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/.well-known/openid-configuration') return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, userinfo_endpoint: `${base}/userinfo` });
    if (req.url === '/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        state.tokenCalls++;
        const p = new URLSearchParams(raw);
        const pkce = createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url');
        if (p.get('code') !== 'good-code' || p.get('client_secret') !== 's3cret' || p.get('client_id') !== 'fb-client' || pkce !== state.challenge) return json(400, { error: 'invalid_grant' });
        json(200, { access_token: 'at-1', token_type: 'Bearer' });
      });
      return;
    }
    if (req.url === '/userinfo') {
      if (req.headers.authorization !== 'Bearer at-1') return json(401, {});
      return json(200, { sub: 'u1', email: state.email, email_verified: state.verified, name: 'New Person' });
    }
    json(404, {});
  });
  return { server, state, url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('Single sign-on (OIDC) (e2e)', () => {
  let h: Harness;
  let owner: string;
  let orgId: string;
  const idp = fakeIdp();
  const txt = new Map<string, string[][]>();
  const cookieOf = (res: { headers: Record<string, unknown> }, name: string) =>
    ([] as string[]).concat((res.headers['set-cookie'] as string[]) ?? []).find((c) => c.startsWith(`${name}=`))?.split(';')[0] ?? '';

  beforeAll(async () => {
    process.env.SSO_ALLOW_INSECURE_ISSUER = 'true';
    await new Promise<void>((r) => idp.server.listen(0, '127.0.0.1', r));
    h = await startApp({ DEFAULT_PLAN: 'TEAM' });
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    (h.app.get(SsoService) as unknown as { resolveTxt: TxtResolver }).resolveTxt = async (name) => {
      const r = txt.get(name);
      if (!r) throw new Error('ENOTFOUND');
      return r;
    };
  });
  afterAll(async () => {
    delete process.env.SSO_ALLOW_INSECURE_ISSUER;
    await h?.close();
    idp.server.close();
  });

  const STUDIO = 'http://localhost:5173';
  const ssoStart = (email: string) => h.api().post('/auth/sso/start').set('Origin', STUDIO).send({ email });

  /** start -> (provider) -> callback; returns the callback response. */
  async function signIn(email: string, code = 'good-code') {
    const start = await ssoStart(email);
    if (start.status !== 200) return start;
    const auth = new URL(start.body.url);
    if (!auth.href.startsWith(idp.url())) return start;
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('redirect_uri')).toMatch(/\/auth\/sso\/callback$/);
    idp.state.challenge = auth.searchParams.get('code_challenge')!;
    return h.api().get(`/auth/sso/callback?code=${code}&state=${auth.searchParams.get('state')}`).set('Cookie', cookieOf(start, 'fb_sso')).expect(302);
  }

  it('is a paid feature, and needs a working provider and domains before it can be turned on', async () => {
    await h.api().put('/org/sso').set(h.bearer(owner)).send({ issuer: idp.url() }).expect(402); // Team has no SSO
    await h.app.get(PlansService).setPlan(orgId, 'BUSINESS');
    await h.api().put('/org/sso').set(h.bearer(owner)).send({ issuer: 'http://127.0.0.1:1' }).expect(400); // nothing there
    await h.api().put('/org/sso').set(h.bearer(owner)).send({ enabled: true }).expect(400);
    const pending = (
      await h.api().put('/org/sso').set(h.bearer(owner)).send({ issuer: idp.url(), clientId: 'fb-client', clientSecret: 's3cret', domains: ['Acme.test'], autoProvision: true, defaultRole: 'DESIGNER' }).expect(200)
    ).body;
    // Typing a domain proves nothing: it waits for a DNS TXT record, and SSO can't be turned on without one.
    expect(pending).toMatchObject({ domains: [], pendingDomains: [{ domain: 'acme.test', dns: { name: '_formbuilder-sso.acme.test' } }] });
    await h.api().put('/org/sso').set(h.bearer(owner)).send({ enabled: true }).expect(400);
    await h.api().post('/org/sso/domains/acme.test/verify').set(h.bearer(owner)).expect(400);

    // Another org lists the same domain; neither can use it until proven, and only one can prove it.
    await h.signUp('Mal', 'mal@evil.test', 'Evil');
    const mal = (await h.login('mal@evil.test')).token;
    const malOrg = (await h.api().get('/auth/me').set(h.bearer(mal))).body.org.id;
    await h.app.get(PlansService).setPlan(malOrg, 'BUSINESS');
    const malPending = (await h.api().put('/org/sso').set(h.bearer(mal)).send({ issuer: idp.url(), clientId: 'x', clientSecret: 'y', domains: ['acme.test'] }).expect(200)).body.pendingDomains[0];

    txt.set('_formbuilder-sso.acme.test', [[pending.pendingDomains[0].dns.value]]);
    await h.api().post('/org/sso/domains/acme.test/verify').set(h.bearer(mal)).expect(400); // their token isn't there
    await h.api().post('/org/sso/domains/acme.test/verify').set(h.bearer(owner)).expect(200);
    txt.set('_formbuilder-sso.acme.test', [[pending.pendingDomains[0].dns.value], [malPending.dns.value]]);
    await h.api().post('/org/sso/domains/acme.test/verify').set(h.bearer(mal)).expect(409);

    const saved = (await h.api().put('/org/sso').set(h.bearer(owner)).send({ enabled: true }).expect(200)).body;
    expect(saved).toMatchObject({ enabled: true, clientSecretSet: true, domains: ['acme.test'], pendingDomains: [], defaultRole: 'DESIGNER', available: true });
    expect(JSON.stringify(saved)).not.toContain('s3cret');
    // Can't require it before it has worked once.
    await h.api().put('/org/sso').set(h.bearer(owner)).send({ enforce: true }).expect(400);
  });

  it('signs in (and provisions) someone from a listed domain; the studio then gets a session from the cookie', async () => {
    const done = await signIn('new.person@acme.test');
    expect(done.headers.location).toMatch(/\/sso\/complete$/);
    const cookie = h.refreshCookie(done);
    expect(cookie).toMatch(/^fb_rt=/);
    const access = (await h.api().post('/auth/refresh').set('Cookie', cookie).expect(200)).body.accessToken;
    const me = (await h.api().get('/auth/me').set(h.bearer(access)).expect(200)).body;
    expect(me).toMatchObject({ user: { email: 'new.person@acme.test' }, org: { id: orgId, role: 'DESIGNER' } });

    // The SSO session is good for this org only, even if the person belongs to others.
    await h.api().post('/orgs').set(h.bearer(access)).send({ name: 'Side project' }).expect(201);
    const other = (await h.api().get('/auth/me').set(h.bearer(access))).body.orgs?.find((o: { id: string }) => o.id !== orgId)?.id;
    expect(other).toBeTruthy();
    expect((await h.api().post('/auth/switch-org').set(h.bearer(access)).send({ orgId: other }).expect(403)).body.code).toBe('SSO_SESSION_SCOPED');
  });

  it('refuses a replayed state, a wrong code, unverified or foreign emails - with a message, never provider details', async () => {
    // A callback link from someone else's browser (login CSRF) is refused.
    // Another site can't start one in the victim's browser...
    await h.api().post('/auth/sso/start').set('Origin', 'https://evil.example').send({ email: 'x@acme.test' }).expect(403);
    await h.api().get('/auth/sso/start?email=x@acme.test').expect(404);
    // ...nor finish one started elsewhere.
    const theirs = await ssoStart('x@acme.test').expect(200);
    const csrf = await h.api().get(`/auth/sso/callback?code=good-code&state=${new URL(theirs.body.url).searchParams.get('state')}`).expect(302);
    expect(decodeURIComponent(csrf.headers.location)).toContain('start single sign-on again');

    const start = await ssoStart('x@acme.test').expect(200);
    const state = new URL(start.body.url).searchParams.get('state');
    const browser = cookieOf(start, 'fb_sso');
    idp.state.challenge = new URL(start.body.url).searchParams.get('code_challenge')!;
    const bad = await h.api().get(`/auth/sso/callback?code=wrong&state=${state}`).set('Cookie', browser).expect(302);
    expect(decodeURIComponent(bad.headers.location)).toContain('did not accept the sign-in');
    const replay = await h.api().get(`/auth/sso/callback?code=good-code&state=${state}`).set('Cookie', browser).expect(302);
    expect(decodeURIComponent(replay.headers.location)).toContain('expired');

    idp.state.verified = false;
    expect(decodeURIComponent((await signIn('new.person@acme.test')).headers.location)).toContain('verified email');
    idp.state.verified = true;
    idp.state.email = 'intruder@elsewhere.test';
    expect(decodeURIComponent((await signIn('someone@acme.test')).headers.location)).toContain("elsewhere.test addresses can't sign in");
    idp.state.email = 'new.person@acme.test';
    expect((await ssoStart('a@unknown.test').expect(400)).body.message).toContain('not set up for that email domain');
  });

  it('once it has worked it can be required: password sign-in is refused for that domain', async () => {
    await h.api().put('/org/sso').set(h.bearer(owner)).send({ enforce: true }).expect(200);
    const refused = await h.api().post('/auth/login').send({ email: 'asha@acme.test', password: 'correct horse battery' }).expect(403);
    expect(refused.body.code).toBe('SSO_REQUIRED');
    // Wrong passwords still look like wrong passwords.
    await h.api().post('/auth/login').send({ email: 'asha@acme.test', password: 'nope nope nope' }).expect(401);
    await h.api().put('/org/sso').set(h.bearer(owner)).send({ enabled: false }).expect(200);
    await h.api().post('/auth/login').send({ email: 'asha@acme.test', password: 'correct horse battery' }).expect(200);
  });
});
