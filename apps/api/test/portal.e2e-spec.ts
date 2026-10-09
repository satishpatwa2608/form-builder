import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { PortalPass } from '../src/portal/portal.schema';
import { startApp, type Harness } from './harness';

const form = (code: string, extra: object = {}) => ({
  name: `${code} request`,
  code,
  businessId: '',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [
    { id: 'a', type: 'TEXT', name: 'what', label: 'What do you need', required: true },
    { id: 'b', type: 'EMAIL', name: 'email', label: 'Email', required: true },
  ],
  ...extra,
});
const tracked = {
  workflow: {
    enabled: true,
    refPrefix: 'REQ',
    statuses: [
      { key: 'NEW', label: 'Received', category: 'OPEN' },
      { key: 'WORKING', label: 'Being worked on', category: 'IN_PROGRESS' },
      { key: 'DONE', label: 'Completed', category: 'DONE' },
    ],
    assignment: { type: 'NONE' },
  },
};

describe('The requests portal (e2e)', () => {
  let h: Harness;
  let owner: string;
  let orgId: string;
  let folder: string;
  let other: { token: string; orgId: string };

  const publish = async (token: string, folderId: string, definition: object) => {
    const id = (await h.api().post('/forms').set(h.bearer(token)).send({ folderId, definition }).expect(201)).body.definition.id as string;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(token)).expect(200);
    return id;
  };
  const submit = async (org: string, code: string, email: string) => (await h.api().post(`/public/forms/${code}/submissions?org=${org}`).send({ values: { what: 'A laptop', email } }).expect(201)).body as { submissionId: string; ref: string };
  const linkFor = (email: string, org = orgId) => {
    const mail = [...h.outbox].reverse().find((m) => m.to === email && m.text.includes(`/portal/${org}?key=`));
    return mail ? /key=(fbportal_[A-Za-z0-9_-]+)/.exec(mail.text)![1]! : undefined;
  };
  /** Asks for a link, opens it, and returns the header a signed-in requester sends. */
  const signIn = async (email: string, org = orgId) => {
    await h.api().post(`/public/portal/${org}/link`).send({ email }).expect(202);
    const opened = (await h.api().post(`/public/portal/${org}/session`).send({ key: linkFor(email.toLowerCase(), org) }).expect(200)).body;
    return { Authorization: `Portal ${opened.session}` };
  };

  beforeAll(async () => {
    h = await startApp();
    await h.signUp('Asha', 'asha@acme.test', 'Acme Trading');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Service' }).expect(201)).body[0].id;
    await h.signUp('Zed', 'zed@other.test', 'Other Co');
    const token = (await h.login('zed@other.test')).token;
    other = { token, orgId: (await h.api().get('/auth/me').set(h.bearer(token))).body.org.id };
  });
  afterAll(async () => h?.close());

  it('is off until the organisation switches it on, and only an admin can', async () => {
    await h.api().get(`/public/portal/${orgId}`).expect(404);
    expect((await h.api().post(`/public/portal/${orgId}/link`).send({ email: 'ravi@customer.test' }).expect(404)).body.message).toBe('This organisation has no requests portal.');
    expect(h.outbox.filter((m) => m.to === 'ravi@customer.test')).toEqual([]);

    await h.api().patch('/org').send({ portal: { enabled: true } }).expect(401);
    const saved = (await h.api().patch('/org').set(h.bearer(owner)).send({ portal: { enabled: true, title: 'Acme help desk', intro: 'Ask us for what you need.' } }).expect(200)).body;
    expect(saved.portal).toEqual({ enabled: true, title: 'Acme help desk', intro: 'Ask us for what you need.' });
    expect((await h.api().get(`/public/portal/${orgId}`).expect(200)).body).toEqual({ organisation: 'Acme Trading', title: 'Acme help desk', intro: 'Ask us for what you need.', forms: [] });
  });

  it('lists only the published, public, open forms the organisation chose to show', async () => {
    await publish(owner, folder, form('LAPTOP', { ...tracked, listOnPortal: true, description: 'Ask for a new laptop' }));
    await publish(owner, folder, form('HIDDEN_ONE'));
    await publish(owner, folder, form('STAFF_ONLY', { listOnPortal: true, access: 'AUTHENTICATED' }));
    await publish(owner, folder, form('OVER', { listOnPortal: true, closesAt: '2020-01-01T00:00:00.000Z' }));
    await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: form('DRAFTED', { listOnPortal: true }) }).expect(201);
    const front = (await h.api().get(`/public/portal/${orgId}`).expect(200)).body;
    expect(front.forms).toEqual([{ code: 'LAPTOP', name: 'LAPTOP request', description: 'Ask for a new laptop' }]);
    // The builder's own list says which forms have an address to hand out: live and open to anyone, nothing else.
    const mine = (await h.api().get('/forms').set(h.bearer(owner)).expect(200)).body as { code: string; publicLink: boolean }[];
    expect(Object.fromEntries(mine.map((f) => [f.code, f.publicLink]))).toEqual({ LAPTOP: true, HIDDEN_ONE: true, OVER: true, STAFF_ONLY: false, DRAFTED: false });
  });

  it('a requester signs in with a link sent to their email and sees what they sent, without the answers', async () => {
    const mine = await submit(orgId, 'LAPTOP', 'Ravi@Customer.test');
    await submit(orgId, 'HIDDEN_ONE', 'ravi@customer.test');
    await submit(orgId, 'LAPTOP', 'someone.else@customer.test');

    await h.api().get(`/public/portal/${orgId}/requests`).expect(401);
    expect((await h.api().post(`/public/portal/${orgId}/link`).send({ email: 'not an address' }).expect(400)).body.message).toBe('Enter your email address');
    expect((await h.api().post(`/public/portal/${orgId}/link`).send({ email: ' Ravi@customer.test ' }).expect(202)).body).toEqual({ sent: true });
    const mail = h.outbox.find((m) => m.to === 'ravi@customer.test' && m.text.includes('/portal/'))!;
    expect(mail.subject).toBe('Your link to Acme Trading: Acme help desk');
    const key = linkFor('ravi@customer.test')!;

    const opened = (await h.api().post(`/public/portal/${orgId}/session`).send({ key }).expect(200)).body;
    expect(opened).toMatchObject({ email: 'ravi@customer.test', session: expect.stringMatching(/^fbps_/) });
    // The link worked once.
    expect((await h.api().post(`/public/portal/${orgId}/session`).send({ key }).expect(401)).body.message).toBe('This link has been used or has run out. Ask for a new one.');

    const auth = { Authorization: `Portal ${opened.session}` };
    const list = (await h.api().get(`/public/portal/${orgId}/requests`).set(auth).expect(200)).body;
    expect(list.email).toBe('ravi@customer.test');
    expect(list.requests).toEqual([
      // A form that does not track its responses only says it arrived.
      { reference: expect.any(String), form: 'HIDDEN_ONE request', sentAt: expect.any(String), status: 'Received', open: false, updatedAt: expect.any(String) },
      { reference: mine.ref, form: 'LAPTOP request', sentAt: expect.any(String), status: 'Received', open: true, updatedAt: expect.any(String) },
    ]);
    // What was written on the form is not shown back: the address alone does not prove who wrote it.
    expect(JSON.stringify(list)).not.toMatch(/A laptop|someone\.else|submissionId|uuid|payload/);

    // Staff move it on; the requester sees the new status in the form's own words.
    await h.api().post(`/records/${mine.submissionId}/status`).set(h.bearer(owner)).send({ to: 'WORKING' }).expect(200);
    expect((await h.api().get(`/public/portal/${orgId}/requests`).set(auth).expect(200)).body.requests[1]).toMatchObject({ status: 'Being worked on', open: true });
    await h.api().post(`/records/${mine.submissionId}/status`).set(h.bearer(owner)).send({ to: 'DONE' }).expect(200);
    expect((await h.api().get(`/public/portal/${orgId}/requests`).set(auth).expect(200)).body.requests[1]).toMatchObject({ status: 'Completed', open: false });

    // Signing out ends the session.
    await h.api().delete(`/public/portal/${orgId}/session`).set(auth).expect(204);
    await h.api().get(`/public/portal/${orgId}/requests`).set(auth).expect(401);
  });

  it('one person never sees another\'s requests, in this organisation or another', async () => {
    await h.api().patch('/org').set(h.bearer(other.token)).send({ portal: { enabled: true } }).expect(200);
    const theirFolder = (await h.api().post('/folders').set(h.bearer(other.token)).send({ name: 'F' }).expect(201)).body[0].id;
    await publish(other.token, theirFolder, form('LAPTOP', tracked));
    await submit(other.orgId, 'LAPTOP', 'ravi@customer.test');

    const meena = await signIn('meena@customer.test');
    expect((await h.api().get(`/public/portal/${orgId}/requests`).set(meena).expect(200)).body.requests).toEqual([]);

    const ravi = await signIn('ravi@customer.test');
    // Ravi's session is for Acme: it shows Acme's two, and does not open the other organisation's portal.
    expect((await h.api().get(`/public/portal/${orgId}/requests`).set(ravi).expect(200)).body.requests).toHaveLength(2);
    await h.api().get(`/public/portal/${other.orgId}/requests`).set(ravi).expect(403);
    // A link for one organisation does not open a session in another.
    await h.api().post(`/public/portal/${orgId}/link`).send({ email: 'ravi@customer.test' }).expect(202);
    await h.api().post(`/public/portal/${other.orgId}/session`).send({ key: linkFor('ravi@customer.test') }).expect(401);
    // A studio sign-in is not a portal session, and nor is a made-up one.
    await h.api().get(`/public/portal/${orgId}/requests`).set(h.bearer(owner)).expect(401);
    await h.api().get(`/public/portal/${orgId}/requests`).set({ Authorization: `Portal fbps_${'x'.repeat(43)}` }).expect(401);
  });

  it('answers the same for an address that has sent nothing, and will not flood a mailbox', async () => {
    const before = h.outbox.length;
    expect((await h.api().post(`/public/portal/${orgId}/link`).send({ email: 'nobody@nowhere.test' }).expect(202)).body).toEqual({ sent: true });
    expect(h.outbox.length).toBe(before + 1);
    for (let i = 0; i < 8; i++) await h.api().post(`/public/portal/${orgId}/link`).send({ email: 'flood@customer.test' }).expect(202);
    expect(h.outbox.filter((m) => m.to === 'flood@customer.test')).toHaveLength(5);
  });

  it('links and sessions run out, and only their hashes are kept', async () => {
    const passes = h.app.get<Model<PortalPass>>(getModelToken(PortalPass.name));
    await h.api().post(`/public/portal/${orgId}/link`).send({ email: 'late@customer.test' }).expect(202);
    const key = linkFor('late@customer.test')!;
    expect(await passes.countDocuments({ tokenHash: key })).toBe(0);
    await passes.updateMany({ email: 'late@customer.test', kind: 'LINK' }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await h.api().post(`/public/portal/${orgId}/session`).send({ key }).expect(401);

    const auth = await signIn('late@customer.test');
    await h.api().get(`/public/portal/${orgId}/requests`).set(auth).expect(200);
    await passes.updateMany({ email: 'late@customer.test', kind: 'SESSION' }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await h.api().get(`/public/portal/${orgId}/requests`).set(auth).expect(401);

    // Switching the portal off closes it to people already signed in.
    const open = await signIn('still@customer.test');
    await h.api().patch('/org').set(h.bearer(owner)).send({ portal: { enabled: false } }).expect(200);
    await h.api().get(`/public/portal/${orgId}/requests`).set(open).expect(404);
  });
});
