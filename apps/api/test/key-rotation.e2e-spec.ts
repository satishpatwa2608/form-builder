import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MongoClient } from 'mongodb';
import { installationBox, SecretBox } from '../src/common/crypto';
import { rotateSecrets } from '../src/common/rotate-secrets';
import { startApp, type Harness } from './harness';

/** An SMS service that remembers the headers it was called with (one of them is a sealed secret). */
async function smsService() {
  const seen: IncomingMessage['headers'][] = [];
  const server: Server = createServer((req, res) => {
    seen.push(req.headers);
    req.resume();
    req.on('end', () => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

const form = {
  name: 'Account opening',
  code: 'ACCOUNT',
  businessId: '',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [
    { id: 'n', type: 'TEXT', name: 'fullName', label: 'Full name', required: true },
    { id: 'i', type: 'TEXT', name: 'idNumber', label: 'ID number', sensitive: true },
  ],
  workflow: { enabled: true, refPrefix: 'ACC', statuses: [{ key: 'NEW', label: 'New', category: 'OPEN' }, { key: 'DONE', label: 'Done', category: 'DONE' }], assignment: { type: 'NONE' } },
};

describe('Changing the installation key (SECRET_KEY) (e2e)', () => {
  const apps: Harness[] = [];
  let sms: Awaited<ReturnType<typeof smsService>>;

  beforeAll(async () => {
    process.env.SMS_ALLOW_PRIVATE = 'true';
    sms = await smsService();
  });
  afterAll(async () => {
    delete process.env.SMS_ALLOW_PRIVATE;
    // The first app owns the database: closed last.
    for (const h of apps.reverse()) await h.close();
    await sms.close();
  });

  it('the old key keeps opening what it sealed; rotate-secrets seals it again; then the old key can go', async () => {
    // Before: everything sealed with the first key.
    const first = await startApp();
    apps.push(first);
    const oldKey = first.config.SECRET_KEY;
    await first.signUp('Asha', 'asha@acme.test', 'Acme');
    const owner = (await first.login('asha@acme.test')).token;
    const orgId = (await first.api().get('/auth/me').set(first.bearer(owner))).body.org.id;
    await first.api().put('/org/sms').set(first.bearer(owner)).send({ url: `${sms.url}/send`, headers: [{ name: 'Authorization', value: 'Bearer sms-secret' }] }).expect(200);
    await first.api().post('/org/sms/test').set(first.bearer(owner)).send({ to: '+919812345678' }).expect(200);
    const folder = (await first.api().post('/folders').set(first.bearer(owner)).send({ name: 'Forms' }).expect(201)).body[0].id;
    const id = (await first.api().post('/forms').set(first.bearer(owner)).send({ folderId: folder, definition: form }).expect(201)).body.definition.id;
    await first.api().post(`/forms/${id}/publish`).set(first.bearer(owner)).expect(200);
    const record = (await first.api().post(`/public/forms/ACCOUNT/submissions?org=${orgId}`).send({ values: { fullName: 'Ravi', idNumber: 'ABCDE1234F' } }).expect(201)).body.submissionId;

    // The key is changed: the new one in SECRET_KEY, the old one in SECRET_KEY_PREVIOUS.
    const newKey = randomBytes(32).toString('base64');
    const shared = { MONGODB_URL: first.config.MONGODB_URL, JWT_SECRET: first.config.JWT_SECRET };
    const during = await startApp({ ...shared, SECRET_KEY: newKey, SECRET_KEY_PREVIOUS: oldKey });
    apps.push(during);
    const token = (await during.login('asha@acme.test')).token;
    await during.api().post('/org/sms/test').set(during.bearer(token)).send({ to: '+919812345678' }).expect(200);
    expect(sms.seen.at(-1)!.authorization).toBe('Bearer sms-secret');
    expect((await during.api().get(`/records/${record}`).set(during.bearer(token)).expect(200)).body.record.payload.idNumber).toBe('ABCDE1234F');

    // The operator seals everything again with the new key.
    const client = await MongoClient.connect(first.config.MONGODB_URL);
    try {
      const db = client.db();
      const box = installationBox({ SECRET_KEY: newKey, SECRET_KEY_PREVIOUS: oldKey });
      const before = await rotateSecrets(db, box, true);
      expect(before.resealed).toMatchObject({ organizations: 1, form_submissions: 1 });
      const done = await rotateSecrets(db, box);
      expect(done).toMatchObject({ resealed: before.resealed, skipped: 0 });
      expect((await rotateSecrets(db, box, true)).resealed).toEqual({});
      // Nothing that is not this installation's own was touched: a value another key sealed is left as it was.
      const stranger = new SecretBox(randomBytes(32)).seal('not ours');
      await db.collection('organizations').updateOne({ id: orgId }, { $set: { other: stranger } });
      expect((await rotateSecrets(db, box)).resealed).toEqual({});
      expect((await db.collection('organizations').findOne({ id: orgId }))!.other).toBe(stranger);
    } finally {
      await client.close();
    }

    // After: the old key is gone, and everything still opens.
    const after = await startApp({ ...shared, SECRET_KEY: newKey });
    apps.push(after);
    const t = (await after.login('asha@acme.test')).token;
    await after.api().post('/org/sms/test').set(after.bearer(t)).send({ to: '+919812345678' }).expect(200);
    expect(sms.seen.at(-1)!.authorization).toBe('Bearer sms-secret');
    expect((await after.api().get(`/records/${record}`).set(after.bearer(t)).expect(200)).body.record.payload.idNumber).toBe('ABCDE1234F');
  });
});

describe('a box with the keys it replaced', () => {
  const a = randomBytes(32);
  const b = randomBytes(32);
  it('opens what either sealed, seals with the current one, and re-seals only what the old one sealed', () => {
    const old = new SecretBox(a).seal('secret');
    const box = new SecretBox(b, [a]);
    expect(box.open(old)).toBe('secret');
    const fresh = box.reseal(old)!;
    expect(new SecretBox(b).open(fresh)).toBe('secret');
    expect(box.reseal(fresh)).toBeNull();
    expect(box.reseal(new SecretBox(randomBytes(32)).seal('x'))).toBeNull();
    expect(() => new SecretBox(b).open(old)).toThrow();
  });
});
