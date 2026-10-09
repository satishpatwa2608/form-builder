import { PASSWORD, startApp, type Harness } from './harness';

/** The operator's console: the customers of an installation, seen from outside, by the people who run it. */
describe('Operator: customers (e2e)', () => {
  let h: Harness;
  let operator: string;
  type Row = { id: string; name: string; plan: string; planName: string; owners: { name: string; email: string }[]; invitedOwners: string[]; members: number; memberLimit: number | null; forms: number; responsesThisMonth: number; lastActiveAt: string | null };
  const list = async (token = operator) => (await h.api().get('/operator/customers').set(h.bearer(token)).expect(200)).body as Row[];

  beforeAll(async () => {
    h = await startApp({ SIGNUP: 'closed', OPERATOR_EMAILS: 'ops@vendor.test', DEFAULT_PLAN: 'FREE' });
    await h.signUp('Olga Operator', 'ops@vendor.test', 'Vendor');
    operator = (await h.login('ops@vendor.test')).token;
  });
  afterAll(async () => h?.close());

  it('adds a customer on the plan bought and invites its owner, without becoming a member of it', async () => {
    const rows = (await h.api().post('/operator/customers').set(h.bearer(operator)).send({ name: 'Sangam', plan: 'ENTERPRISE', ownerEmail: 'Priya@Sangam.test' }).expect(201)).body as Row[];
    const sangam = rows.find((r) => r.name === 'Sangam')!;
    expect(sangam).toMatchObject({ plan: 'ENTERPRISE', planName: 'Enterprise', owners: [], invitedOwners: ['priya@sangam.test'], members: 0, memberLimit: null, forms: 0, responsesThisMonth: 0 });
    const invite = h.outbox.find((m) => m.to === 'priya@sangam.test')!;
    expect(invite.subject).toBe("You're invited to Sangam on Form Builder");
    // The operator's own list of organisations does not gain it.
    expect((await h.api().get('/auth/me').set(h.bearer(operator)).expect(200)).body.orgs.map((o: { name: string }) => o.name)).toEqual(['Vendor']);

    // The owner accepts and is in, as owner, on that plan.
    await h.api().post('/invitations/accept').send({ token: h.tokenFrom('priya@sangam.test', '/accept-invite'), name: 'Priya', password: PASSWORD }).expect(200);
    const priya = (await h.login('priya@sangam.test')).token;
    expect((await h.api().get('/auth/me').set(h.bearer(priya)).expect(200)).body).toMatchObject({ org: { name: 'Sangam', role: 'OWNER' }, operator: false });
    expect((await h.api().get('/org/usage').set(h.bearer(priya)).expect(200)).body.plan).toBe('ENTERPRISE');
    const after = (await list()).find((r) => r.name === 'Sangam')!;
    expect(after).toMatchObject({ owners: [{ name: 'Priya', email: 'priya@sangam.test' }], invitedOwners: [], members: 1 });
    expect(after.lastActiveAt).toBeTruthy();
  });

  it('shows how big and busy each customer is, and nothing of what is inside', async () => {
    const priya = (await h.login('priya@sangam.test')).token;
    const orgId = (await h.api().get('/auth/me').set(h.bearer(priya))).body.org.id;
    const folder = (await h.api().post('/folders').set(h.bearer(priya)).send({ name: 'HR' }).expect(201)).body[0].id;
    const definition = { name: 'Secret salary review', code: 'SALARY', businessId: '', access: 'PUBLIC', submission: { method: 'POST', endpointId: 'default-submit' }, fields: [{ id: 'a', type: 'TEXT', name: 'who', label: 'Who', required: true }] };
    const id = (await h.api().post('/forms').set(h.bearer(priya)).send({ folderId: folder, definition }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(priya)).expect(200);
    await h.api().post(`/public/forms/SALARY/submissions?org=${orgId}`).send({ values: { who: 'Confidential Person' } }).expect(201);

    const rows = await list();
    expect(rows.map((r) => r.name).sort()).toEqual(['Sangam', 'Vendor']);
    expect(rows.find((r) => r.name === 'Sangam')).toMatchObject({ forms: 1, responsesThisMonth: 1, members: 1 });
    expect(JSON.stringify(rows)).not.toMatch(/Secret salary|SALARY|Confidential Person/);
    // Being the operator opens nothing inside the customer.
    await h.api().get(`/forms/${id}`).set(h.bearer(operator)).expect((r) => expect([403, 404]).toContain(r.status));
  });

  it('changes a customer\'s plan, and the customer sees in their own audit trail that it was changed for them', async () => {
    const sangam = (await list()).find((r) => r.name === 'Sangam')!;
    const rows = (await h.api().patch(`/operator/customers/${sangam.id}`).set(h.bearer(operator)).send({ plan: 'TEAM' }).expect(200)).body as Row[];
    expect(rows.find((r) => r.name === 'Sangam')).toMatchObject({ plan: 'TEAM', memberLimit: 10 });
    await h.api().patch(`/operator/customers/${sangam.id}`).set(h.bearer(operator)).send({ plan: 'PLATINUM' }).expect(400);
    await h.api().patch('/operator/customers/no-such-org').set(h.bearer(operator)).send({ plan: 'TEAM' }).expect(404);
    const priya = (await h.login('priya@sangam.test')).token;
    expect((await h.api().get('/org/usage').set(h.bearer(priya)).expect(200)).body.plan).toBe('TEAM');
    const entry = (await h.api().get('/audit?action=org.plan_changed').set(h.bearer(priya)).expect(200)).body.entries[0];
    expect(entry).toMatchObject({ before: { plan: 'ENTERPRISE' }, after: { plan: 'TEAM', by: 'operator' } });
  });

  it('an owner invitation can be sent again, or to someone else', async () => {
    const sangam = (await list()).find((r) => r.name === 'Sangam')!;
    const rows = (await h.api().post(`/operator/customers/${sangam.id}/owner-invitations`).set(h.bearer(operator)).send({ email: 'ravi@sangam.test' }).expect(200)).body as Row[];
    expect(rows.find((r) => r.name === 'Sangam')!.invitedOwners).toEqual(['ravi@sangam.test']);
    await h.api().post(`/operator/customers/${sangam.id}/owner-invitations`).set(h.bearer(operator)).send({ email: 'priya@sangam.test' }).expect(409); // already a member
  });

  it('if the invitation cannot be sent, no half-made customer is left behind', async () => {
    const send = h.mailer.send;
    h.mailer.send = async () => {
      throw new Error('MessageRejected');
    };
    const refused = await h.api().post('/operator/customers').set(h.bearer(operator)).send({ name: 'Ghost Ltd', plan: 'TEAM', ownerEmail: 'nobody@ghost.test' }).expect(400);
    h.mailer.send = send;
    expect(refused.body.message).toContain('The invitation could not be sent');
    expect((await list()).map((r) => r.name)).not.toContain('Ghost Ltd');
  });

  it('to anyone else there is no such place, whatever their role', async () => {
    const priya = (await h.login('priya@sangam.test')).token;
    await h.api().get('/operator/customers').expect(401);
    await h.api().get('/operator/customers').set(h.bearer(priya)).expect(404);
    await h.api().post('/operator/customers').set(h.bearer(priya)).send({ name: 'Mine', plan: 'ENTERPRISE', ownerEmail: 'x@y.test' }).expect(404);
    const sangam = (await list()).find((r) => r.name === 'Sangam')!;
    await h.api().patch(`/operator/customers/${sangam.id}`).set(h.bearer(priya)).send({ plan: 'ENTERPRISE' }).expect(404);
    expect((await list()).find((r) => r.name === 'Sangam')!.plan).toBe('TEAM');
  });
});
