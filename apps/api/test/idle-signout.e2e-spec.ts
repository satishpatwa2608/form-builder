import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Session } from '../src/auth/auth.schemas';
import { startApp, type Harness } from './harness';

/** Someone who walks away from an open session is signed out after the time their organisation allows. */
describe('Signing out after time away (e2e)', () => {
  let h: Harness;
  let owner: { token: string; cookie: string };
  let sessions: Model<Session>;
  const refresh = (cookie: string) => h.api().post('/auth/refresh').set('Cookie', cookie);
  const awayFor = (minutes: number) => sessions.updateMany({ revokedAt: null }, { $set: { lastActiveAt: new Date(Date.now() - minutes * 60_000) } });

  beforeAll(async () => {
    h = await startApp();
    sessions = h.app.get(getModelToken(Session.name));
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = await h.login('asha@acme.test');
  });
  afterAll(async () => h?.close());

  it('is thirty minutes unless the organisation says otherwise, and only its administrators can change it', async () => {
    const me = (await h.api().get('/auth/me').set(h.bearer(owner.token)).expect(200)).body;
    expect(me.org.idleMinutes).toBe(30);
    for (const idleMinutes of [7, -1, 100000, 1.5]) await h.api().patch('/org').set(h.bearer(owner.token)).send({ security: { idleMinutes } }).expect(400);
    await h.addMember(owner.token, 'Dev', 'dev@acme.test', 'DESIGNER');
    await h.api().patch('/org').set(h.bearer((await h.login('dev@acme.test')).token)).send({ security: { idleMinutes: 0 } }).expect(403);
    await h.api().patch('/org').set(h.bearer(owner.token)).send({ security: { idleMinutes: 15 } }).expect(200);
    expect((await h.api().get('/auth/me').set(h.bearer(owner.token)).expect(200)).body.org.idleMinutes).toBe(15);
    const trail = (await h.api().get('/audit').set(h.bearer(owner.token)).expect(200)).body.entries as { action: string }[];
    expect(trail.some((e) => e.action === 'org.updated' || e.action.startsWith('org.'))).toBe(true);
  });

  it('a session that is being used carries on; one left alone past the time is ended and cannot be picked up again', async () => {
    const working = await h.login('asha@acme.test');
    await awayFor(10);
    const renewed = await refresh(working.cookie).expect(200);
    const cookie = h.refreshCookie(renewed);
    // Renewing is what says "I am here": the clock starts again.
    expect(Date.now() - (await sessions.findOne({ revokedAt: null }).sort({ lastActiveAt: -1 }).lean())!.lastActiveAt!.getTime()).toBeLessThan(5000);

    await awayFor(25);
    const ended = await refresh(cookie).expect(401);
    expect(ended.body).toMatchObject({ message: 'You were signed out after 15 minutes away', code: 'IDLE' });
    // It is over for good: coming back to the keyboard does not revive it.
    await sessions.updateMany({}, { $set: { lastActiveAt: new Date() } });
    await refresh(cookie).expect(401);
    const fresh = await h.login('asha@acme.test');
    const trail = (await h.api().get('/audit?action=auth.idle_signout').set(h.bearer(fresh.token)).expect(200)).body.entries as { action: string }[];
    expect(trail).toHaveLength(1);
  });

  it('a minute or two over is forgiven, so the screen and the server do not race', async () => {
    const s = await h.login('asha@acme.test');
    await awayFor(16);
    await refresh(s.cookie).expect(200);
  });

  it('"never" means a session lasts until it expires or is signed out', async () => {
    const admin = await h.login('asha@acme.test');
    await h.api().patch('/org').set(h.bearer(admin.token)).send({ security: { idleMinutes: 0 } }).expect(200);
    await awayFor(60 * 24 * 3);
    await refresh(admin.cookie).expect(200);
  });
});
