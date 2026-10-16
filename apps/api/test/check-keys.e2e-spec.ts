import { randomBytes } from 'node:crypto';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { checkKeys } from '../src/common/check-keys';
import { installationBox } from '../src/common/crypto';
import { LocalKeyProvider, sealWith } from '../src/common/key-provider';
import { startApp, type Harness } from './harness';

describe('The restore drill checks that the real keys open what was sealed (e2e)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startApp();
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    const owner = (await h.login('asha@acme.test')).token;
    const orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    // One value sealed with the installation key (the SMS service's secret header)...
    await h.api().put('/org/sms').set(h.bearer(owner)).send({ url: 'https://sms.example.com/send', headers: [{ name: 'Authorization', value: 'Bearer sms-secret' }] }).expect(200);
    // ...and one sealed with a data key, the way a connector's credentials are.
    const keys = new LocalKeyProvider(Buffer.from(h.config.SECRET_KEY, 'base64'), []);
    const { plain, wrapped } = await keys.newDataKey({ orgId, connectorId: 'c1' });
    const db = h.app.get<Connection>(getConnectionToken()).db!;
    await db.collection('connectors').insertOne({ id: 'c1', orgId, sealedSecrets: sealWith(plain, { password: 'p' }), wrappedKey: wrapped, isDeleted: false });
  });
  afterAll(() => h?.close());

  const db = () => h.app.get<Connection>(getConnectionToken()).db!;

  it('with the right keys everything opens, and only counts are reported', async () => {
    const r = await checkKeys(db(), installationBox(h.config), new LocalKeyProvider(Buffer.from(h.config.SECRET_KEY, 'base64'), []));
    expect(r.installation.sealed).toBeGreaterThanOrEqual(1);
    expect(r.installation.opened).toBe(r.installation.sealed);
    expect(r.dataKeys).toEqual({ sealed: 1, opened: 1 });
    expect(r.failed).toEqual({});
    expect(JSON.stringify(r)).not.toContain('secret');
  });

  it('with the wrong key it says where things did not open', async () => {
    const wrong = randomBytes(32).toString('base64');
    const r = await checkKeys(db(), installationBox({ SECRET_KEY: wrong }), new LocalKeyProvider(Buffer.from(wrong, 'base64'), []));
    expect(r.installation.opened).toBe(0);
    expect(r.dataKeys).toEqual({ sealed: 1, opened: 0 });
    expect(r.failed).toMatchObject({ organizations: expect.any(Number), 'connectors.sealedSecrets': 1 });
  });
});
