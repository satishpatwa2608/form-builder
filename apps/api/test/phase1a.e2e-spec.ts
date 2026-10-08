import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AuditEntry } from '../src/audit/audit.schema';
import { totpAt } from '../src/common/totp';
import { PASSWORD, startApp, type Harness } from './harness';

describe('Phase 1a: auth, orgs, members, permissions, audit (e2e)', () => {
  let h: Harness;
  // Thin wrappers so the tests read the same as before the shared harness.
  const api = () => h.api();
  const bearer = (token: string) => h.bearer(token);
  const tokenFrom = (to: string, path: string) => h.tokenFrom(to, path);
  const refreshCookie: Harness['refreshCookie'] = (res) => h.refreshCookie(res);
  const signUp: Harness['signUp'] = (...a) => h.signUp(...a);
  const login: Harness['login'] = (...a) => h.login(...a);
  /** Asha has two-factor on: each sign-in burns one of her recovery codes (TOTP steps can't be replayed). */
  let ashaCodes: string[] = [];
  const ashaLogin = () => login('asha@acme.test', { code: ashaCodes.shift() });

  beforeAll(async () => {
    h = await startApp();
  });
  afterAll(() => h?.close());

  it('deny by default: only health and the auth entry points are public', async () => {
    await api().get('/health').expect(200);
    await api().get('/auth/me').expect(401);
    await api().get('/members').set(bearer('not-a-jwt')).expect(401);
  });

  it('sign-up needs a confirmed email; errors never reveal whether an account exists', async () => {
    await api().post('/auth/signup').send({ name: 'Asha', email: 'Asha@Acme.test', password: 'short', orgName: 'Acme' }).expect(400);
    const first = await api().post('/auth/signup').send({ name: 'Asha', email: 'Asha@Acme.test', password: PASSWORD, orgName: 'Acme' }).expect(202);
    const again = await api().post('/auth/signup').send({ name: 'Other', email: 'asha@acme.test', password: PASSWORD, orgName: 'Evil' }).expect(202);
    expect(again.body).toEqual(first.body);
    expect(h.outbox.at(-1)!.subject).toBe('Someone tried to sign up with your email');

    const wrong = await api().post('/auth/login').send({ email: 'asha@acme.test', password: 'wrong password!!' }).expect(401);
    const unknown = await api().post('/auth/login').send({ email: 'nobody@acme.test', password: 'wrong password!!' }).expect(401);
    expect(wrong.body.message).toBe(unknown.body.message);
    const unverified = await api().post('/auth/login').send({ email: 'asha@acme.test', password: PASSWORD }).expect(403);
    expect(unverified.body.code).toBe('EMAIL_NOT_VERIFIED');

    await api().post('/auth/verify-email').send({ token: tokenFrom('asha@acme.test', '/verify-email') }).expect(200);
    const { token, cookie } = await login('asha@acme.test');
    expect(cookie).toMatch(/^fb_rt=/);
    const me = (await api().get('/auth/me').set(bearer(token)).expect(200)).body;
    expect(me.user).toMatchObject({ name: 'Asha', email: 'asha@acme.test', twoFactorEnabled: false });
    expect(me.org).toMatchObject({ name: 'Acme', role: 'OWNER' });
    expect(me.org.permissions).toContain('billing.manage');
    // Single-use link.
    await api().post('/auth/verify-email').send({ token: tokenFrom('asha@acme.test', '/verify-email') }).expect(400);
  });

  it('locks the account after 5 wrong passwords; the right one is refused while locked', async () => {
    await signUp('Lock', 'lock@acme.test', 'Lock Org');
    for (let i = 0; i < 5; i++) await api().post('/auth/login').send({ email: 'lock@acme.test', password: 'nope nope nope' }).expect(401);
    await api().post('/auth/login').send({ email: 'lock@acme.test', password: PASSWORD }).expect(401);
  });

  it('refresh tokens rotate; replaying an old one ends the session', async () => {
    const { token, cookie } = await login('asha@acme.test');
    const r1 = await api().post('/auth/refresh').set('Cookie', cookie).expect(200);
    const next = refreshCookie(r1);
    expect(next).not.toBe(cookie);
    await api().post('/auth/refresh').set('Cookie', cookie).expect(401); // stolen copy used
    await api().post('/auth/refresh').set('Cookie', next).expect(401); // whole session revoked
    await api().get('/auth/me').set(bearer(token)).expect(401);
    await api().get('/auth/me').set(bearer(r1.body.accessToken)).expect(401);
  });

  it('two-factor: set up, required at sign-in, codes and recovery codes work once', async () => {
    const { token } = await login('asha@acme.test');
    const setup = (await api().post('/auth/2fa/setup').set(bearer(token)).expect(200)).body;
    expect(setup.otpauthUrl).toContain('otpauth://totp/');
    const step = Math.floor(Date.now() / 30_000);
    await api().post('/auth/2fa/enable').set(bearer(token)).send({ code: '000000' }).expect(400);
    const enabled = (await api().post('/auth/2fa/enable').set(bearer(token)).send({ code: totpAt(setup.secret, step) }).expect(200)).body;
    expect(enabled.recoveryCodes).toHaveLength(10);

    const needCode = await api().post('/auth/login').send({ email: 'asha@acme.test', password: PASSWORD }).expect(401);
    expect(needCode.body.code).toBe('TWO_FACTOR_REQUIRED');
    // The step used to enable can't be replayed.
    await api().post('/auth/login').send({ email: 'asha@acme.test', password: PASSWORD, code: totpAt(setup.secret, step) }).expect(401);
    const withCode = await login('asha@acme.test', { code: totpAt(setup.secret, step + 1) });
    expect((await api().get('/auth/me').set(bearer(withCode.token)).expect(200)).body.session.mfa).toBe(true);

    const recovery = enabled.recoveryCodes[0];
    await login('asha@acme.test', { code: recovery });
    await api().post('/auth/login').send({ email: 'asha@acme.test', password: PASSWORD, code: recovery }).expect(401);
    ashaCodes = enabled.recoveryCodes.slice(1);
  });

  describe('members, invitations and roles', () => {
    let owner: string;
    beforeAll(async () => {
      owner = (await ashaLogin()).token;
    });

    it('invite -> accept -> sign in with the invited role; no escalation', async () => {
      await api().post('/invitations').set(bearer(owner)).send({ email: 'dev@acme.test', role: 'DESIGNER' }).expect(201);
      await api().post('/invitations').set(bearer(owner)).send({ email: 'viv@acme.test', role: 'VIEWER' }).expect(201);
      await api().post('/invitations').set(bearer(owner)).send({ email: 'ann@acme.test', role: 'ADMIN' }).expect(201);
      await api().post('/invitations/accept').send({ token: tokenFrom('dev@acme.test', '/accept-invite'), password: PASSWORD }).expect(400); // new person needs a name
      await api().post('/invitations/accept').send({ token: tokenFrom('dev@acme.test', '/accept-invite'), name: 'Dev', password: PASSWORD }).expect(200);
      await api().post('/invitations/accept').send({ token: tokenFrom('viv@acme.test', '/accept-invite'), name: 'Viv', password: PASSWORD }).expect(200);
      await api().post('/invitations/accept').send({ token: tokenFrom('ann@acme.test', '/accept-invite'), name: 'Ann', password: PASSWORD }).expect(200);
      await api().post('/invitations/accept').send({ token: tokenFrom('dev@acme.test', '/accept-invite'), name: 'Dev', password: PASSWORD }).expect(400); // used

      const dev = await login('dev@acme.test');
      expect((await api().get('/auth/me').set(bearer(dev.token)).expect(200)).body.org.role).toBe('DESIGNER');
      await api().post('/invitations').set(bearer(dev.token)).send({ email: 'x@acme.test', role: 'VIEWER' }).expect(403);
      await api().get('/audit').set(bearer(dev.token)).expect(403);

      const ann = await login('ann@acme.test');
      const members = (await api().get('/members').set(bearer(ann.token)).expect(200)).body;
      const ashaId = members.find((m: { email: string }) => m.email === 'asha@acme.test').userId;
      const devId = members.find((m: { email: string }) => m.email === 'dev@acme.test').userId;
      // Admins can't make owners, or change an owner.
      await api().patch(`/members/${devId}`).set(bearer(ann.token)).send({ role: 'OWNER' }).expect(403);
      await api().patch(`/members/${ashaId}`).set(bearer(ann.token)).send({ role: 'VIEWER' }).expect(403);
      await api().post('/invitations').set(bearer(ann.token)).send({ email: 'boss@acme.test', role: 'OWNER' }).expect(403);
      // The last owner can't step down.
      await api().patch(`/members/${ashaId}`).set(bearer(owner)).send({ role: 'ADMIN' }).expect(409);
    });

    it('removing or disabling a member cuts access immediately', async () => {
      const viv = await login('viv@acme.test');
      await api().get('/auth/me').set(bearer(viv.token)).expect(200);
      const members = (await api().get('/members').set(bearer(owner)).expect(200)).body;
      const vivId = members.find((m: { email: string }) => m.email === 'viv@acme.test').userId;
      await api().patch(`/members/${vivId}`).set(bearer(owner)).send({ status: 'DISABLED' }).expect(200);
      await api().get('/auth/me').set(bearer(viv.token)).expect(401); // session ended
      await api().post('/auth/login').send({ email: 'viv@acme.test', password: PASSWORD }).expect(403); // no active org
      await api().patch(`/members/${vivId}`).set(bearer(owner)).send({ status: 'ACTIVE' }).expect(200);
      await login('viv@acme.test');
    });

    it('an org can require two-factor: members without it can only reach set-up', async () => {
      // Asha's session used a recovery code, so it has a second factor.
      await api().patch('/org').set(bearer(owner)).send({ security: { require2fa: true } }).expect(200);
      const dev = await login('dev@acme.test');
      const blocked = await api().get('/folders').set(bearer(dev.token)).expect(403);
      expect(blocked.body.code).toBe('TWO_FACTOR_REQUIRED');
      expect((await api().get('/auth/me').set(bearer(dev.token)).expect(200)).body.org.require2fa).toBe(true);
      await api().post('/auth/2fa/setup').set(bearer(dev.token)).expect(200);
      // An admin without a second factor can't switch it on (they'd lock themselves out).
      await api().patch('/org').set(bearer(owner)).send({ security: { require2fa: false } }).expect(200);
      const ann = await login('ann@acme.test');
      await api().patch('/org').set(bearer(ann.token)).send({ security: { require2fa: true } }).expect(400);
    });
  });

  describe('folders and grants', () => {
    it('folder grants inherit downwards; designers organise only inside their folders', async () => {
      const owner = (await ashaLogin()).token;
      const quality = (await api().post('/folders').set(bearer(owner)).send({ name: 'Quality' }).expect(201)).body.find((f: { name: string }) => f.name === 'Quality');
      await api().post('/folders').set(bearer(owner)).send({ name: 'Quality' }).expect(409);
      await api().post('/folders').set(bearer(owner)).send({ name: 'HR' }).expect(201);
      const tree = (await api().post('/folders').set(bearer(owner)).send({ name: 'Audits', parentId: quality.id }).expect(201)).body;
      const audits = tree.find((f: { name: string }) => f.name === 'Audits');
      expect(audits.path).toEqual([quality.id, audits.id]);

      const viv = await login('viv@acme.test');
      const members = (await api().get('/members').set(bearer(owner)).expect(200)).body;
      const vivId = members.find((m: { email: string }) => m.email === 'viv@acme.test').userId;
      // A viewer sees every folder (form.view org-wide)...
      expect((await api().get('/folders').set(bearer(viv.token)).expect(200)).body).toHaveLength(3);
      await api().post('/folders').set(bearer(viv.token)).send({ name: 'Mine', parentId: quality.id }).expect(403);

      // ...and with a DESIGNER grant on Quality can organise inside it (Audits included), not elsewhere.
      await api().post('/grants').set(bearer(owner)).send({ userId: vivId, role: 'PUBLISHER', scope: { type: 'connector', id: 'c1' } }).expect(400);
      await api().post('/grants').set(bearer(owner)).send({ userId: vivId, role: 'DESIGNER', scope: { type: 'folder', id: quality.id } }).expect(201);
      await api().post('/grants').set(bearer(owner)).send({ userId: vivId, role: 'DESIGNER', scope: { type: 'folder', id: quality.id } }).expect(409);
      await api().post('/folders').set(bearer(viv.token)).send({ name: 'Mine', parentId: audits.id }).expect(201);
      await api().post('/folders').set(bearer(viv.token)).send({ name: 'Root one' }).expect(403);
      const perms = (await api().get(`/folders/${audits.id}/permissions`).set(bearer(viv.token)).expect(200)).body.permissions;
      expect(perms).toEqual(expect.arrayContaining(['form.view', 'form.edit']));
      expect(perms).not.toContain('form.publish');

      const grants = (await api().get(`/grants?userId=${vivId}`).set(bearer(owner)).expect(200)).body;
      await api().get('/grants').set(bearer(viv.token)).expect(403);
      await api().delete(`/grants/${grants[0].id}`).set(bearer(owner)).expect(200);
      await api().post('/folders').set(bearer(viv.token)).send({ name: 'Again', parentId: audits.id }).expect(403);
      await api().delete(`/folders/${quality.id}`).set(bearer(owner)).expect(409); // not empty
    });
  });

  it('organisations are isolated from each other', async () => {
    await signUp('Bob', 'bob@beta.test', 'Beta');
    const bob = await login('bob@beta.test');
    expect((await api().get('/folders').set(bearer(bob.token)).expect(200)).body).toEqual([]);
    const members = (await api().get('/members').set(bearer(bob.token)).expect(200)).body;
    expect(members.map((m: { email: string }) => m.email)).toEqual(['bob@beta.test']);
    const acme = (await api().get('/auth/me').set(bearer((await login('dev@acme.test')).token))).body.org.id;
    await api().post('/auth/switch-org').set(bearer(bob.token)).send({ orgId: acme }).expect(403);
    // A second org for Bob; switching works and the new org is empty.
    const second = (await api().post('/orgs').set(bearer(bob.token)).send({ name: 'Beta Labs' }).expect(201)).body;
    const switched = (await api().post('/auth/switch-org').set(bearer(bob.token)).send({ orgId: second.id }).expect(200)).body;
    expect((await api().get('/auth/me').set(bearer(switched.accessToken)).expect(200)).body.org.name).toBe('Beta Labs');
  });

  it('passwords: reset ends every session; change ends the others', async () => {
    const a = await login('bob@beta.test');
    const b = await login('bob@beta.test');
    await api().post('/auth/password').set(bearer(a.token)).send({ currentPassword: PASSWORD, newPassword: 'another long password' }).expect(200);
    await api().get('/auth/me').set(bearer(a.token)).expect(200);
    await api().get('/auth/me').set(bearer(b.token)).expect(401);

    await api().post('/auth/forgot-password').send({ email: 'bob@beta.test' }).expect(202);
    await api().post('/auth/forgot-password').send({ email: 'ghost@beta.test' }).expect(202);
    await api().post('/auth/reset-password').send({ token: tokenFrom('bob@beta.test', '/reset-password'), password: PASSWORD }).expect(200);
    await api().get('/auth/me').set(bearer(a.token)).expect(401);
    await login('bob@beta.test');
  });

  it('sign-in is rate limited per client', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await api().post('/auth/login').set('x-test-throttle', '1').send({ email: 'nobody@acme.test', password: 'whatever at all' })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it('the audit log records who did what, holds no secrets, and cannot be changed', async () => {
    // Bob signs in to his newest org (Beta Labs). User-level security events reach every org he belongs to.
    const owner = (await login('bob@beta.test')).token;
    const { entries } = (await api().get('/audit').set(bearer(owner)).expect(200)).body;
    const actions = entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['org.created', 'auth.login', 'auth.password_changed', 'auth.password_reset']));
    expect(actions).not.toContain('auth.signup'); // that happened in Beta, not Beta Labs
    expect(JSON.stringify(entries)).not.toContain(PASSWORD);

    const acmeOwner = (await ashaLogin()).token;
    const acme = (await api().get('/audit?limit=200').set(bearer(acmeOwner)).expect(200)).body.entries.map((e: { action: string }) => e.action);
    expect(acme).toEqual(
      expect.arrayContaining(['auth.2fa_enabled', 'member.invited', 'invitation.accepted', 'member.updated', 'org.updated', 'folder.created', 'grant.created', 'grant.removed', 'auth.refresh_reused']),
    );
    // Beta's entries never appear in Acme's log.
    expect(acme).not.toContain('auth.password_reset');

    const model = h.app.get<Model<AuditEntry>>(getModelToken(AuditEntry.name));
    await expect(model.updateOne({}, { $set: { action: 'x' } })).rejects.toThrow('append-only');
    await expect(model.deleteMany({})).rejects.toThrow('append-only');
  });
});
