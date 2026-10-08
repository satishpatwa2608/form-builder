import { SiteService, type TxtResolver } from '../src/site/site.service';
import { PlansService } from '../src/plans/plans.service';
import { startApp, type Harness } from './harness';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const form = {
  name: 'Long application',
  code: 'APPLY',
  businessId: '',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [
    { id: 'f1', type: 'TEXT', name: 'name', label: 'Name', required: true },
    { id: 'f2', type: 'TEXTAREA', name: 'story', label: 'Your story', required: true },
  ],
};

describe('Branding, custom domains, save & resume (e2e)', () => {
  let h: Harness;
  let owner: string;
  let other: string;
  let orgId: string;
  const txt = new Map<string, string[][]>();

  beforeAll(async () => {
    h = await startApp({ DEFAULT_PLAN: 'FREE' });
    const fake: TxtResolver = async (name) => {
      const r = txt.get(name);
      if (!r) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      return r;
    };
    (h.app.get(SiteService) as unknown as { resolveTxt: TxtResolver }).resolveTxt = fake;
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    await h.signUp('Mal', 'mal@evil.test', 'Evil');
    owner = (await h.login('asha@acme.test')).token;
    other = (await h.login('mal@evil.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    const folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Forms' }).expect(201)).body[0].id;
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: form }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
  });
  afterAll(() => h?.close());

  it('branding: validated logo and colour; hiding "Powered by" needs a plan that includes it', async () => {
    await h.api().put('/org/branding').set(h.bearer(owner)).send({ logo: 'data:image/svg+xml;base64,PHN2Zz4=' }).expect(400);
    await h.api().put('/org/branding').set(h.bearer(owner)).send({ primaryColor: 'red' }).expect(400);
    await h.api().put('/org/branding').set(h.bearer(owner)).send({ logo: PNG, primaryColor: '#0a7d5a' }).expect(200);
    await h.api().put('/org/branding').set(h.bearer(owner)).send({ hidePoweredBy: true }).expect(402);
    expect((await h.api().get(`/public/orgs/${orgId}/branding`).expect(200)).body).toEqual({ name: 'Acme', logo: PNG, primaryColor: '#0a7d5a', poweredBy: true });

    await h.app.get(PlansService).setPlan(orgId, 'TEAM');
    await h.api().put('/org/branding').set(h.bearer(owner)).send({ hidePoweredBy: true }).expect(200);
    expect((await h.api().get(`/public/orgs/${orgId}/branding`)).body.poweredBy).toBe(false);
    // A downgrade shows it again without anyone touching the setting.
    await h.app.get(PlansService).setPlan(orgId, 'FREE');
    expect((await h.api().get(`/public/orgs/${orgId}/branding`)).body.poweredBy).toBe(true);
    await h.app.get(PlansService).setPlan(orgId, 'TEAM');
  });

  it('custom domains: proven by a TXT record, one org per domain, then resolvable and allowed by CORS', async () => {
    await h.api().post('/org/domains').set(h.bearer(owner)).send({ host: 'not a host' }).expect(400);
    await h.api().post('/org/domains').set(h.bearer(owner)).send({ host: 'localhost' }).expect(400);
    const [d] = (await h.api().post('/org/domains').set(h.bearer(owner)).send({ host: 'Forms.Acme.com' }).expect(201)).body;
    expect(d).toMatchObject({ host: 'forms.acme.com', verified: false, dns: { type: 'TXT', name: '_formbuilder.forms.acme.com' } });
    await h.api().post('/org/domains').set(h.bearer(owner)).send({ host: 'second.acme.com' }).expect(402); // Team: 1 domain
    await h.api().get('/public/domains/forms.acme.com').expect(404);

    // Someone else claims it too.
    const otherOrg = (await h.api().get('/auth/me').set(h.bearer(other))).body.org.id;
    await h.app.get(PlansService).setPlan(otherOrg, 'BUSINESS');
    const [theirs] = (await h.api().post('/org/domains').set(h.bearer(other)).send({ host: 'forms.acme.com' }).expect(201)).body;

    await h.api().post('/org/domains/forms.acme.com/verify').set(h.bearer(owner)).expect(400);
    txt.set('_formbuilder.forms.acme.com', [[d.dns.value.slice(0, 10), d.dns.value.slice(10)]]); // long TXT values arrive in chunks
    expect((await h.api().post('/org/domains/forms.acme.com/verify').set(h.bearer(owner)).expect(200)).body).toMatchObject({ verified: true });
    expect((await h.api().get('/public/domains/forms.acme.com').expect(200)).body).toEqual({ org: orgId });
    // The other org can't prove it; even with its record present, the domain is taken.
    await h.api().post('/org/domains/forms.acme.com/verify').set(h.bearer(other)).expect(400);
    txt.set('_formbuilder.forms.acme.com', [[d.dns.value], [theirs.dns.value]]);
    await h.api().post('/org/domains/forms.acme.com/verify').set(h.bearer(other)).expect(409);

    const cors = await h.api().get(`/public/orgs/${orgId}/branding`).set('Origin', 'https://forms.acme.com').expect(200);
    expect(cors.headers['access-control-allow-origin']).toBe('https://forms.acme.com');
    expect(cors.headers['access-control-allow-credentials']).toBeUndefined();
    const denied = await h.api().get(`/public/orgs/${orgId}/branding`).set('Origin', 'https://evil.example').expect(200);
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    // The custom domain never gets the signed-in API.
    const auth = await h.api().get('/auth/me').set('Origin', 'https://forms.acme.com').set(h.bearer(owner));
    expect(auth.headers['access-control-allow-origin']).toBeUndefined();

    await h.api().delete('/org/domains/forms.acme.com').set(h.bearer(owner)).expect(200);
  });

  it('save & resume: a token brings the answers back, each save gets a fresh token, gone after submitting', async () => {
    const base = `/public/forms/APPLY/drafts?org=${orgId}`;
    const load = (token: string) => h.api().post(`/public/forms/APPLY/drafts/load?org=${orgId}`).send({ token });
    await h.api().post(base).send({ values: { name: 'Ravi', hacker: 1 } }).expect(400);
    const first = (await h.api().post(base).send({ values: { name: 'Ravi' } }).expect(201)).body;
    expect(first.token).toMatch(/^fbd_/);

    // Saving again (e.g. with a token planted in a link) never writes into that token: a new one is issued.
    const planted = (await h.api().post(base).send({ values: { name: 'Attacker' } }).expect(201)).body.token;
    const victim = (await h.api().post(base).send({ values: { name: 'Victim', story: 'private' }, token: planted }).expect(201)).body;
    expect(victim.token).not.toBe(planted);
    await load(planted).expect(404);
    expect((await load(victim.token).expect(200)).body.values).toEqual({ name: 'Victim', story: 'private' });

    const second = (await h.api().post(base).send({ values: { name: 'Ravi', story: 'Once' }, token: first.token }).expect(201)).body;
    await load(first.token).expect(404);
    const loaded = (await load(second.token).expect(200)).body;
    expect(loaded.values).toEqual({ name: 'Ravi', story: 'Once' });
    await load('fbd_wrongwrongwrongwrongwrong').expect(404);

    await h.api().post(`/public/forms/APPLY/submissions?org=${orgId}`).send({ values: loaded.values, idempotencyKey: 'k1' }).expect(201);
    await h.api().post(`/public/forms/APPLY/drafts/discard?org=${orgId}`).send({ token: second.token }).expect(204);
    await load(second.token).expect(404);
  });
});
