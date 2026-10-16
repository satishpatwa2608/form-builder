import { startApp, type Harness } from './harness';

describe('A person changes their own name (e2e)', () => {
  let h: Harness;
  let token: string;

  beforeAll(async () => {
    h = await startApp();
    await h.signUp('Satish', 'satish@acme.test', 'Acme');
    token = (await h.login('satish@acme.test')).token;
  });
  afterAll(() => h?.close());

  it('the new name is what /auth/me and colleagues see, and it is in the audit trail', async () => {
    const me = (await h.api().patch('/auth/me').set(h.bearer(token)).send({ name: '  Satish Narayan ' }).expect(200)).body;
    expect(me.user).toMatchObject({ name: 'Satish Narayan', email: 'satish@acme.test' });
    const members = (await h.api().get('/members').set(h.bearer(token)).expect(200)).body;
    expect(JSON.stringify(members)).toContain('Satish Narayan');
    const audit = (await h.api().get('/audit?limit=5').set(h.bearer(token)).expect(200)).body.entries;
    expect(audit.map((e: { action: string }) => e.action)).toContain('auth.profile_changed');
  });

  it('a name is needed; the email cannot be changed this way; signed out, nothing', async () => {
    await h.api().patch('/auth/me').set(h.bearer(token)).send({ name: '   ' }).expect(400);
    await h.api().patch('/auth/me').set(h.bearer(token)).send({ name: 'x'.repeat(101) }).expect(400);
    await h.api().patch('/auth/me').set(h.bearer(token)).send({ name: 'S', email: 'other@evil.test' }).expect(200);
    expect((await h.api().get('/auth/me').set(h.bearer(token)).expect(200)).body.user.email).toBe('satish@acme.test');
    await h.api().patch('/auth/me').send({ name: 'Nobody' }).expect(401);
  });
});
