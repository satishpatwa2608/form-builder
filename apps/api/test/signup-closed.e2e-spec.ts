import { PASSWORD, startApp, type Harness } from './harness';

/**
 * An installation sold to named customers: nobody makes an account by themselves. The people who run it add
 * each customer's organisation, on the plan bought, and invite its owner; everyone else comes in by invitation.
 */
describe('Sign-up closed (e2e)', () => {
  let h: Harness;
  let operator: string;
  const signup = (email: string, orgName = 'Org') => h.api().post('/auth/signup').send({ name: 'Someone', email, password: PASSWORD, orgName });

  beforeAll(async () => {
    h = await startApp({ SIGNUP: 'closed', OPERATOR_EMAILS: ' Ops@Vendor.test , second@vendor.test', DEFAULT_PLAN: 'FREE' });
  });
  afterAll(async () => h?.close());

  it('says so before anyone signs in, and refuses a stranger without making anything', async () => {
    expect((await h.api().get('/auth/config').expect(200)).body).toEqual({ signup: 'closed' });
    const refused = await signup('stranger@elsewhere.test').expect(403);
    expect(refused.body.message).toBe('New accounts are by invitation here. Ask whoever provides Form Builder to you.');
    expect(h.outbox.filter((m) => m.to === 'stranger@elsewhere.test')).toEqual([]);
    await h.api().post('/auth/login').send({ email: 'stranger@elsewhere.test', password: PASSWORD }).expect(401);
  });

  it('the people who run it can still make their own account, whatever the capitals in their address', async () => {
    await h.signUp('Olga Operator', 'ops@vendor.test', 'Vendor');
    operator = (await h.login('ops@vendor.test')).token;
    expect((await h.api().get('/auth/me').set(h.bearer(operator)).expect(200)).body).toMatchObject({ operator: true, canCreateOrgs: true });
  });

  it('an operator adds a customer on the plan bought, invites its owner, hands it over and leaves', async () => {
    const made = (await h.api().post('/orgs').set(h.bearer(operator)).send({ name: 'Sangam', plan: 'ENTERPRISE' }).expect(201)).body;
    const inOrg = (await h.api().post('/auth/switch-org').set(h.bearer(operator)).send({ orgId: made.id }).expect(200)).body.accessToken as string;
    expect((await h.api().get('/org/usage').set(h.bearer(inOrg)).expect(200)).body).toMatchObject({ plan: 'ENTERPRISE' });

    // The customer's person joins by invitation: the one way in when sign-up is closed.
    await h.api().post('/invitations').set(h.bearer(inOrg)).send({ email: 'priya@sangam.test', role: 'ADMIN' }).expect(201);
    await h.api().post('/invitations/accept').send({ token: h.tokenFrom('priya@sangam.test', '/accept-invite'), name: 'Priya', password: PASSWORD }).expect(200);
    const priya = (await h.login('priya@sangam.test')).token;
    const me = (await h.api().get('/auth/me').set(h.bearer(priya)).expect(200)).body;
    expect(me).toMatchObject({ org: { name: 'Sangam', role: 'ADMIN' }, operator: false, canCreateOrgs: false });

    // Made an owner, after which the operator can go.
    const members = (await h.api().get('/members').set(h.bearer(inOrg)).expect(200)).body as { userId: string; email: string }[];
    await h.api().patch(`/members/${members.find((m) => m.email === 'priya@sangam.test')!.userId}`).set(h.bearer(inOrg)).send({ role: 'OWNER' }).expect(200);
    await h.api().delete(`/members/${members.find((m) => m.email === 'ops@vendor.test')!.userId}`).set(h.bearer(inOrg)).expect(200);
    const after = (await h.api().get('/members').set(h.bearer((await h.login('priya@sangam.test')).token)).expect(200)).body as { email: string; role: string }[];
    expect(after.map((m) => [m.email, m.role])).toEqual([['priya@sangam.test', 'OWNER']]);
    // The operator no longer sees inside it.
    await h.api().get('/members').set(h.bearer(inOrg)).expect((r) => expect([401, 403]).toContain(r.status));
  });

  it('a customer cannot add organisations or give out plans', async () => {
    const priya = (await h.login('priya@sangam.test')).token;
    expect((await h.api().post('/orgs').set(h.bearer(priya)).send({ name: 'Side door' }).expect(403)).body.message).toBe('Only the people who run this installation can add an organisation');
    await h.api().post('/orgs').set(h.bearer(priya)).send({ name: 'Side door', plan: 'ENTERPRISE' }).expect(403);
  });
});

describe('Sign-up open, as before (e2e)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startApp({ OPERATOR_EMAILS: 'ops@vendor.test' });
  });
  afterAll(async () => h?.close());

  it('anyone signs up and may add an organisation, but only an operator chooses a plan', async () => {
    expect((await h.api().get('/auth/config').expect(200)).body).toEqual({ signup: 'open' });
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    const asha = (await h.login('asha@acme.test')).token;
    expect((await h.api().get('/auth/me').set(h.bearer(asha)).expect(200)).body).toMatchObject({ operator: false, canCreateOrgs: true });
    await h.api().post('/orgs').set(h.bearer(asha)).send({ name: 'Second' }).expect(201);
    expect((await h.api().post('/orgs').set(h.bearer(asha)).send({ name: 'Third', plan: 'ENTERPRISE' }).expect(403)).body.message).toBe('Only the people who run this installation can choose a plan');
  });
});
