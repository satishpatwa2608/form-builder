import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { startApp, type Harness } from './harness';

interface Received {
  from: string;
  to: string[];
  raw: string;
  user: string;
  secure: boolean;
}

/** A mail server on this machine: asks for a sign-in, speaks STARTTLS, keeps what it is given. */
function fakeSmtp() {
  const inbox: Received[] = [];
  const state = { refuseSender: false };
  const server = new SMTPServer({
    authMethods: ['PLAIN', 'LOGIN'],
    onAuth(auth, _session, done) {
      if (auth.username === 'mailer@acme.test' && auth.password === 'app-password') return done(null, { user: auth.username });
      done(new Error('Invalid login'));
    },
    onMailFrom(address, _session, done) {
      done(state.refuseSender ? Object.assign(new Error('Sender not allowed'), { responseCode: 550 }) : undefined);
    },
    onData(stream, session, done) {
      let raw = '';
      stream.on('data', (c: Buffer) => (raw += c.toString()));
      stream.on('end', () => {
        inbox.push({ from: (session.envelope.mailFrom as { address: string }).address, to: session.envelope.rcptTo.map((r) => r.address), raw, user: String(session.user), secure: session.secure });
        done();
      });
    },
    logger: false,
  });
  return { server, inbox, state, port: () => (server.server.address() as AddressInfo).port };
}

/** Microsoft's two addresses: sign-in for the application, and "send mail as this mailbox". */
function fakeMicrosoft() {
  const sent: { mailbox: string; body: any; auth: string }[] = [];
  const state = { tokens: 0, consent: true };
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const json = (status: number, body: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
      if (req.method === 'POST' && req.url === '/acme.onmicrosoft.com/oauth2/v2.0/token') {
        const p = new URLSearchParams(raw);
        state.tokens++;
        if (p.get('client_id') !== 'app-1' || p.get('client_secret') !== 'ms-secret' || p.get('grant_type') !== 'client_credentials') return json(401, { error: 'invalid_client' });
        return json(200, { access_token: 'graph-token', expires_in: 3600 });
      }
      const m = /^\/v1\.0\/users\/([^/]+)\/sendMail$/.exec(req.url ?? '');
      if (req.method === 'POST' && m) {
        if (req.headers.authorization !== 'Bearer graph-token') return json(401, {});
        if (!state.consent) return json(403, { error: { code: 'ErrorAccessDenied', message: 'internal detail that must not be shown' } });
        sent.push({ mailbox: decodeURIComponent(m[1]!), body: JSON.parse(raw), auth: String(req.headers.authorization) });
        return res.writeHead(202).end();
      }
      json(404, {});
    });
  });
  return { server, sent, state, url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const form = {
  name: 'Callback',
  code: 'CALLBACK',
  businessId: '',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [
    { id: 'a', type: 'TEXT', name: 'name', label: 'Name', required: true },
    { id: 'b', type: 'EMAIL', name: 'email', label: 'Email', required: true },
  ],
  workflow: { enabled: true, refPrefix: 'CB', statuses: [{ key: 'NEW', label: 'New', category: 'OPEN' }, { key: 'DONE', label: 'Done', category: 'DONE' }], assignment: { type: 'NONE' } },
  automations: [{ id: 'a1', name: 'Thanks', enabled: true, when: 'SUBMITTED', actions: [{ id: 'mail', type: 'EMAIL', to: [{ kind: 'FIELD', field: 'email' }], subject: 'Thanks {{name}} ({{$record.ref}})', body: 'We will call you, {{name}}.' }] }],
};

describe("An organisation's own mail server (e2e)", () => {
  let h: Harness;
  let owner: string;
  let orgId: string;
  const smtp = fakeSmtp();
  const ms = fakeMicrosoft();
  const put = (body: object) => h.api().put('/org/mail').set(h.bearer(owner)).send(body);
  const submit = async (email: string) => (await h.api().post(`/public/forms/CALLBACK/submissions?org=${orgId}`).send({ values: { name: 'Ravi', email } }).expect(201)).body as { submissionId: string; ref: string };
  const waitFor = async <T>(get: () => T | undefined | Promise<T | undefined>, what: string): Promise<T> => {
    for (let i = 0; i < 200; i++) {
      const v = await get();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const events = async (id: string) => ((await h.api().get(`/records/${id}`).set(h.bearer(owner)).expect(200)).body.events as { message: string }[]).map((e) => e.message);

  beforeAll(async () => {
    process.env.MAIL_ALLOW_INSECURE = 'true';
    await new Promise<void>((r) => smtp.server.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => ms.server.listen(0, '127.0.0.1', r));
    process.env.MAIL_MICROSOFT_LOGIN_URL = ms.url();
    process.env.MAIL_MICROSOFT_GRAPH_URL = ms.url();
    h = await startApp();
    await h.signUp('Asha', 'asha@acme.test', 'Acme Trading');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    const folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Web' }).expect(201)).body[0].id;
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: form }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
  });
  afterAll(async () => {
    delete process.env.MAIL_ALLOW_INSECURE;
    delete process.env.MAIL_MICROSOFT_LOGIN_URL;
    delete process.env.MAIL_MICROSOFT_GRAPH_URL;
    await h?.close();
    await new Promise<void>((r) => smtp.server.close(() => r()));
    ms.server.close();
  });

  it('until one is set up, emails to respondents go out from us', async () => {
    expect((await h.api().get('/org/mail').set(h.bearer(owner)).expect(200)).body).toMatchObject({ provider: 'DEFAULT', enabled: false, smtp: { port: 587, security: 'STARTTLS', passwordSet: false } });
    const sub = await submit('first@customer.test');
    await waitFor(() => h.outbox.find((m) => m.to === 'first@customer.test' && m.subject === `Thanks Ravi (${sub.ref})`), 'the email from us');
    expect(smtp.inbox).toEqual([]);
    await h.api().get('/org/mail').expect(401);
  });

  it('is saved with its password sealed, and cannot be used before a test email has gone through', async () => {
    expect((await put({ provider: 'SMTP', from: 'not an address' }).expect(400)).body.errors[0]).toMatchObject({ field: 'from' });
    const saved = (await put({ provider: 'SMTP', from: 'Hello@Acme.test', fromName: 'Acme "Help" <desk>', smtp: { host: '127.0.0.1', port: smtp.port(), security: 'STARTTLS', username: 'mailer@acme.test', password: 'wrong-password' } }).expect(200)).body;
    expect(saved).toMatchObject({ provider: 'SMTP', enabled: false, from: 'hello@acme.test', fromName: 'Acme Help desk', smtp: { host: '127.0.0.1', username: 'mailer@acme.test', passwordSet: true }, testedAt: null });
    expect(JSON.stringify(saved)).not.toContain('wrong-password');
    expect((await h.api().post('/org/mail/use').set(h.bearer(owner)).send({ enabled: true }).expect(400)).body.message).toContain('Send yourself a test email first');

    // A wrong password: said plainly, kept on the card, still not usable.
    expect((await h.api().post('/org/mail/test').set(h.bearer(owner)).expect(400)).body.message).toBe('The mail server refused the user name or password.');
    expect((await h.api().get('/org/mail').set(h.bearer(owner)).expect(200)).body).toMatchObject({ lastError: 'The mail server refused the user name or password.', testedAt: null });
    await h.api().post('/org/mail/use').set(h.bearer(owner)).send({ enabled: true }).expect(400);
  });

  it('a test email goes to the admin through the server, over an encrypted connection, signed in', async () => {
    await put({ smtp: { password: 'app-password' } }).expect(200);
    const tested = (await h.api().post('/org/mail/test').set(h.bearer(owner)).expect(200)).body;
    expect(tested).toMatchObject({ sentTo: 'asha@acme.test', lastError: '' });
    expect(tested.testedAt).toBeTruthy();
    expect(smtp.inbox).toHaveLength(1);
    expect(smtp.inbox[0]).toMatchObject({ from: 'hello@acme.test', to: ['asha@acme.test'], user: 'mailer@acme.test', secure: true });
    expect(smtp.inbox[0]!.raw).toMatch(/From: "?Acme Help desk"? <hello@acme\.test>/);
    expect(smtp.inbox[0]!.raw).toContain('Subject: Test email from Acme Trading');
    expect((await h.api().post('/org/mail/use').set(h.bearer(owner)).send({ enabled: true }).expect(200)).body.enabled).toBe(true);
  });

  it('workflow emails then go from the organisation\'s address, and its staff emails still come from us', async () => {
    const before = h.outbox.length;
    const sub = await submit('second@customer.test');
    const got = await waitFor(() => smtp.inbox.find((m) => m.to.includes('second@customer.test')), 'the email through their server');
    expect(got.from).toBe('hello@acme.test');
    expect(got.raw).toContain(`Subject: Thanks Ravi (${sub.ref})`);
    expect(got.raw).toContain('We will call you, Ravi.');
    expect(h.outbox.slice(before).filter((m) => m.to === 'second@customer.test')).toEqual([]);

    // An invitation to a colleague is ours to send, not theirs.
    await h.api().post('/invitations').set(h.bearer(owner)).send({ email: 'colleague@acme.test', role: 'VIEWER' }).expect(201);
    expect(h.outbox.some((m) => m.to === 'colleague@acme.test')).toBe(true);
    expect(smtp.inbox.some((m) => m.to.includes('colleague@acme.test'))).toBe(false);
  });

  it('when their server refuses a message the step fails with the reason, and nothing is sent from our address instead', async () => {
    smtp.state.refuseSender = true;
    const before = h.outbox.length;
    const sub = await submit('third@customer.test');
    const said = await waitFor(async () => (await events(sub.submissionId)).find((m) => /email to third@customer\.test failed/.test(m)), 'the failed step');
    expect(said).toContain('The mail server refused the message');
    expect(h.outbox.slice(before).filter((m) => m.to === 'third@customer.test')).toEqual([]);
    expect((await h.api().get('/org/mail').set(h.bearer(owner)).expect(200)).body.lastError).toContain('refused the message');
    smtp.state.refuseSender = false;
  });

  it('any change to the settings switches it off until tested again', async () => {
    const changed = (await put({ smtp: { port: smtp.port() } }).expect(200)).body;
    expect(changed).toMatchObject({ enabled: false, testedAt: null });
    const before = smtp.inbox.length;
    const sub = await submit('fourth@customer.test');
    await waitFor(() => h.outbox.find((m) => m.to === 'fourth@customer.test' && m.subject.includes(sub.ref)), 'the email from us again');
    expect(smtp.inbox).toHaveLength(before);
  });

  it('Microsoft 365: signs in as an application and sends from the mailbox', async () => {
    expect((await put({ provider: 'MICROSOFT', from: 'helpdesk@acme.test', microsoft: { tenantId: 'not a tenant!' } }).expect(400)).body.errors[0].field).toBe('microsoft.tenantId');
    const saved = (await put({ provider: 'MICROSOFT', from: 'helpdesk@acme.test', fromName: '', microsoft: { tenantId: 'acme.onmicrosoft.com', clientId: 'app-1', clientSecret: 'wrong' } }).expect(200)).body;
    expect(saved.microsoft).toEqual({ tenantId: 'acme.onmicrosoft.com', clientId: 'app-1', clientSecretSet: true });
    expect(JSON.stringify(saved)).not.toContain('wrong');
    expect((await h.api().post('/org/mail/test').set(h.bearer(owner)).expect(400)).body.message).toBe('Microsoft 365 refused the directory (tenant) ID, application ID or secret.');

    await put({ microsoft: { clientSecret: 'ms-secret' } }).expect(200);
    expect((await h.api().post('/org/mail/test').set(h.bearer(owner)).expect(200)).body.sentTo).toBe('asha@acme.test');
    expect(ms.sent).toHaveLength(1);
    expect(ms.sent[0]).toMatchObject({ mailbox: 'helpdesk@acme.test', body: { message: { subject: 'Test email from Acme Trading', toRecipients: [{ emailAddress: { address: 'asha@acme.test' } }] }, saveToSentItems: true } });
    await h.api().post('/org/mail/use').set(h.bearer(owner)).send({ enabled: true }).expect(200);

    const tokensBefore = ms.state.tokens;
    const sub = await submit('fifth@customer.test');
    const got = await waitFor(() => ms.sent.find((m) => m.body.message.toRecipients[0].emailAddress.address === 'fifth@customer.test'), 'the email through Microsoft 365');
    expect(got.body.message).toMatchObject({ subject: `Thanks Ravi (${sub.ref})`, body: { contentType: 'HTML' } });
    expect(got.body.message.body.content).toContain('We will call you, Ravi.');
    // The sign-in is reused while it lasts, not repeated for every email.
    expect(ms.state.tokens).toBe(tokensBefore);
    expect(smtp.inbox.some((m) => m.to.includes('fifth@customer.test'))).toBe(false);
  });

  it('Microsoft 365: without permission to send, the step says what to grant and shows none of Microsoft\'s own text', async () => {
    ms.state.consent = false;
    const sub = await submit('sixth@customer.test');
    const said = await waitFor(async () => (await events(sub.submissionId)).find((m) => /email to sixth@customer\.test failed/.test(m)), 'the failed step');
    expect(said).toContain('Give it the Mail.Send application permission');
    const card = (await h.api().get('/org/mail').set(h.bearer(owner)).expect(200)).body;
    expect(card.lastError).toContain('did not let the application send from helpdesk@acme.test');
    expect(JSON.stringify([said, card])).not.toContain('internal detail');
    ms.state.consent = true;
  });

  it('a private address is refused as a mail server outside development', async () => {
    delete process.env.MAIL_ALLOW_INSECURE;
    expect((await put({ provider: 'SMTP', smtp: { host: '10.0.0.5' } }).expect(400)).body.errors[0].field).toBe('smtp.host');
    expect((await put({ provider: 'SMTP', smtp: { host: 'smtp.acme.test', port: 6379 } }).expect(400)).body.errors[0]).toMatchObject({ field: 'smtp.port', message: 'Use 587, 465, 25 or 2525' });
    // A name that points inside our network is caught when it is looked up, at the moment of sending.
    await put({ provider: 'SMTP', from: 'hello@acme.test', smtp: { host: 'localhost.localdomain.example', port: 587, password: 'x' } }).expect(200);
    expect((await h.api().post('/org/mail/test').set(h.bearer(owner)).expect(400)).body.message).toMatch(/could not be found|private address/);
    process.env.MAIL_ALLOW_INSECURE = 'true';
  });
});
