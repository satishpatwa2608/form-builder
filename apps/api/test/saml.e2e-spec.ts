import { inflateRawSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import selfsigned from 'selfsigned';
import { SignedXml } from 'xml-crypto';
import { PlansService } from '../src/plans/plans.service';
import { SsoService } from '../src/sso/sso.service';
import type { TxtResolver } from '../src/site/site.service';
import { startApp, type Harness } from './harness';

const IDP_ISSUER = 'https://idp.acme.test/saml';
const ENTRY = 'https://idp.acme.test/sso';
const keys = () => selfsigned.generate([{ name: 'commonName', value: 'idp.acme.test' }], { keySize: 2048, days: 30, algorithm: 'sha256' });
const idp = keys();
const stranger = keys();

interface Answer {
  email?: string;
  requestId: string;
  acs: string;
  audience: string;
  issuer?: string;
  /** Minutes from now the statement stops being valid. */
  goodFor?: number;
  sign?: false | { private: string };
  name?: string;
  /** Change the signed text after signing. */
  tamper?: (xml: string) => string;
}

/** What a SAML provider posts back: a response whose assertion it has signed. */
function answer(a: Answer): string {
  const now = Date.now();
  const at = (ms: number) => new Date(now + ms).toISOString();
  const id = () => `_${randomBytes(16).toString('hex')}`;
  const issuer = a.issuer ?? IDP_ISSUER;
  const until = at((a.goodFor ?? 5) * 60_000);
  const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id()}" Version="2.0" IssueInstant="${at(0)}" Destination="${a.acs}" InResponseTo="${a.requestId}"><saml:Issuer>${issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="${id()}" Version="2.0" IssueInstant="${at(0)}"><saml:Issuer>${issuer}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${a.email ?? 'new.person@acme.test'}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${until}" Recipient="${a.acs}" InResponseTo="${a.requestId}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${at(-60_000 + Math.min(0, (a.goodFor ?? 5) * 60_000 - 120_000))}" NotOnOrAfter="${until}"><saml:AudienceRestriction><saml:Audience>${a.audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${at(0)}" SessionIndex="${id()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="displayName"><saml:AttributeValue>${a.name ?? 'New Person'}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion></samlp:Response>`;
  let out = xml;
  if (a.sign !== false) {
    const sig = new SignedXml({ privateKey: (a.sign ?? idp).private, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
    sig.addReference({ xpath: "//*[local-name(.)='Assertion']", digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256', transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'] });
    sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' } });
    out = sig.getSignedXml();
  }
  return Buffer.from(a.tamper ? a.tamper(out) : out).toString('base64');
}

describe('Single sign-on (SAML 2.0) (e2e)', () => {
  let h: Harness;
  let owner: string;
  let orgId: string;
  let otherOrg: string;
  const txt = new Map<string, string[][]>();
  const STUDIO = 'http://localhost:5173';
  const cookieOf = (res: { headers: Record<string, unknown> }, name: string) => ([] as string[]).concat((res.headers['set-cookie'] as string[]) ?? []).find((c) => c.startsWith(`${name}=`)) ?? '';
  const put = (body: object, token = owner) => h.api().put('/org/sso').set(h.bearer(token)).send(body);

  /** Starts a sign-in as the studio does and reads the request the browser carries to the provider. */
  async function begin(email = 'new.person@acme.test') {
    const start = await h.api().post('/auth/sso/start').set('Origin', STUDIO).send({ email }).expect(200);
    const url = new URL(start.body.url);
    const request = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64')).toString();
    return {
      url,
      request,
      relay: url.searchParams.get('RelayState')!,
      requestId: /\bID="([^"]+)"/.exec(request)![1]!,
      acs: /AssertionConsumerServiceURL="([^"]+)"/.exec(request)![1]!,
      audience: /<saml:Issuer[^>]*>([^<]+)</.exec(request)![1]!,
      setCookie: cookieOf(start, 'fb_sso'),
      cookie: cookieOf(start, 'fb_sso').split(';')[0]!,
    };
  }
  const post = (org: string, body: Record<string, string>, cookie?: string) => {
    const req = h.api().post(`/auth/sso/saml/${org}/acs`).type('form');
    return (cookie ? req.set('Cookie', cookie) : req).send(body).expect(302);
  };
  const errorOf = (res: { headers: Record<string, string> }) => new URL(res.headers.location!).searchParams.get('sso_error');

  beforeAll(async () => {
    h = await startApp({ DEFAULT_PLAN: 'BUSINESS' });
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    (h.app.get(SsoService) as unknown as { resolveTxt: TxtResolver }).resolveTxt = async (name) => {
      const r = txt.get(name);
      if (!r) throw new Error('ENOTFOUND');
      return r;
    };
    await h.signUp('Bo', 'bo@beta.test', 'Beta');
    const bo = (await h.login('bo@beta.test')).token;
    otherOrg = (await h.api().get('/auth/me').set(h.bearer(bo))).body.org.id;
    await h.app.get(PlansService).setPlan(otherOrg, 'BUSINESS');
  });
  afterAll(async () => h?.close());

  it('is set up from three things the provider gives, checked as they are saved', async () => {
    const before = (await h.api().get('/org/sso').set(h.bearer(owner)).expect(200)).body;
    expect(before).toMatchObject({ protocol: 'OIDC', saml: { entryPoint: '', certSet: false, acsUrl: expect.stringMatching(new RegExp(`/auth/sso/saml/${orgId}/acs$`)), entityId: expect.stringMatching(/\/metadata$/) } });

    expect((await put({ protocol: 'SAML', saml: { entryPoint: 'http://idp.acme.test/sso' } }).expect(400)).body.errors[0].field).toBe('saml.entryPoint');
    expect((await put({ saml: { cert: 'not a certificate' } }).expect(400)).body.errors[0].message).toContain('That is not a certificate');
    await put({ protocol: 'SAML' }).expect(200);
    expect((await put({ enabled: true }).expect(400)).body.message).toContain("sign-in address, issuer and certificate");

    // The certificate may be pasted with or without its BEGIN and END lines.
    const bare = idp.cert.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
    const pending = (await put({ saml: { entryPoint: ENTRY, idpIssuer: IDP_ISSUER, cert: bare }, domains: ['acme.test'], autoProvision: true, defaultRole: 'DESIGNER' }).expect(200)).body;
    expect(pending.saml).toMatchObject({ entryPoint: ENTRY, idpIssuer: IDP_ISSUER, certSet: true });
    expect(new Date(pending.saml.certExpiresAt).getTime()).toBeGreaterThan(Date.now());
    // Still needs a proven email domain, like any single sign-on.
    await put({ enabled: true }).expect(400);
    txt.set('_formbuilder-sso.acme.test', [[pending.pendingDomains[0].dns.value]]);
    await h.api().post('/org/sso/domains/acme.test/verify').set(h.bearer(owner)).expect(200);
    expect((await put({ enabled: true }).expect(200)).body).toMatchObject({ enabled: true, protocol: 'SAML', domains: ['acme.test'] });
  });

  it('describes itself to the provider: where to post the answer, and who it is for', async () => {
    const res = await h.api().get(`/auth/sso/saml/${orgId}/metadata`).expect(200);
    expect(res.headers['content-type']).toContain('samlmetadata+xml');
    expect(res.text).toContain(`/auth/sso/saml/${orgId}/acs`);
    expect(res.text).toMatch(new RegExp(`entityID="[^"]*/auth/sso/saml/${orgId}/metadata"`));
    await h.api().get('/auth/sso/saml/no-such-org/metadata').expect(404);
  });

  it('signs in (and provisions) someone the provider vouches for', async () => {
    const b = await begin();
    expect(b.url.href.startsWith(`${ENTRY}?`)).toBe(true);
    expect(b.acs).toMatch(new RegExp(`/auth/sso/saml/${orgId}/acs$`));
    // The provider posts back from its own site: the browser's cookie must be one that comes with that.
    expect(b.setCookie).toMatch(/SameSite=None/i);
    expect(b.setCookie).toMatch(/Secure/i);
    expect(b.setCookie).toMatch(/HttpOnly/i);

    const done = await post(orgId, { SAMLResponse: answer(b), RelayState: b.relay }, b.cookie);
    expect(done.headers.location).toMatch(/\/sso\/complete$/);
    const access = (await h.api().post('/auth/refresh').set('Cookie', h.refreshCookie(done)).expect(200)).body.accessToken;
    const me = (await h.api().get('/auth/me').set(h.bearer(access)).expect(200)).body;
    expect(me).toMatchObject({ user: { email: 'new.person@acme.test', name: 'New Person' }, org: { id: orgId, role: 'DESIGNER' } });

    // The same answer a second time: the request it answers is used up.
    expect(errorOf(await post(orgId, { SAMLResponse: answer(b), RelayState: b.relay }, b.cookie))).toMatch(/expired/);
  });

  const refusals: [string, (b: Awaited<ReturnType<typeof begin>>) => { response: string; relay?: string; cookie?: string | null; org?: string }, RegExp][] = [
    ['signed by someone else\'s key', (b) => ({ response: answer({ ...b, sign: stranger }) }), /did not accept/],
    ['not signed at all', (b) => ({ response: answer({ ...b, sign: false }) }), /did not accept/],
    ['changed after it was signed', (b) => ({ response: answer({ ...b, tamper: (x) => x.replace('new.person@acme.test', 'asha@acme.test') }) }), /did not accept/],
    ['meant for another service', (b) => ({ response: answer({ ...b, audience: 'https://someone-else.example/metadata' }) }), /did not accept/],
    ['from a provider that is not the one set up', (b) => ({ response: answer({ ...b, issuer: 'https://evil.example/saml' }) }), /did not accept/],
    ['past its time', (b) => ({ response: answer({ ...b, goodFor: -30 }) }), /did not accept/],
    ['answering a request this browser never made', (b) => ({ response: answer({ ...b, requestId: '_someoneelsesrequest' }) }), /did not accept/],
    ['sent unasked, with no request behind it', (b) => ({ response: answer(b), relay: '' }), /expired/],
    ['arriving in a browser that did not start it', (b) => ({ response: answer(b), cookie: null }), /from this browser/],
    ['arriving with another browser\'s cookie', (b) => ({ response: answer(b), cookie: 'fb_sso=somebodyelse' }), /from this browser/],
    ['posted to another organisation\'s address', (b) => ({ response: answer(b), org: 'OTHER' }), /expired/],
    ['for an address on a domain the organisation has not proven', (b) => ({ response: answer({ ...b, email: 'mal@evil.test' }) }), /evil\.test addresses can't sign in/],
    ['with no usable address in it', (b) => ({ response: answer({ ...b, email: 'not-an-address' }) }), /did not share an email address/],
    // A forged statement placed in front of the signed one (signature wrapping): the signature covers the other.
    [
      'carrying a forged statement beside the signed one',
      (b) => ({
        response: answer({
          ...b,
          tamper: (x) => {
            const signed = /<saml:Assertion[\s\S]*<\/saml:Assertion>/.exec(x)![0];
            const forged = signed.replace(/<(ds:)?Signature[\s\S]*?<\/(ds:)?Signature>/, '').replace('new.person@acme.test', 'asha@acme.test').replace(/ID="[^"]+"/, 'ID="_forged"');
            return x.replace(signed, forged + signed);
          },
        }),
      }),
      /did not accept/,
    ],
  ];
  it.each(refusals)('refuses an answer %s', async (_name, make, message) => {
    const b = await begin();
    const m = make(b);
    const res = await post(m.org === 'OTHER' ? otherOrg : orgId, { SAMLResponse: m.response, RelayState: m.relay ?? b.relay }, m.cookie === null ? undefined : (m.cookie ?? b.cookie));
    expect(res.headers.location).toMatch(/\/login\?sso_error=/);
    expect(errorOf(res)).toMatch(message);
    // No session, and nothing about why beyond the one plain sentence.
    expect(h.refreshCookie(res)).toBeFalsy();
    expect(errorOf(res)).not.toMatch(/signature|xml|audience|InResponseTo/i);
  });

  it('switching to the other kind of provider switches single sign-on off until that one is proven', async () => {
    const saved = (await put({ protocol: 'OIDC' }).expect(200)).body;
    expect(saved).toMatchObject({ protocol: 'OIDC', enabled: false, enforce: false, lastSuccessAt: null });
    // The SAML details are kept, in case it was a slip.
    expect(saved.saml).toMatchObject({ entryPoint: ENTRY, certSet: true });
    expect((await h.api().post('/auth/sso/start').set('Origin', STUDIO).send({ email: 'new.person@acme.test' }).expect(400)).body.message).toMatch(/not set up/);
  });
});
