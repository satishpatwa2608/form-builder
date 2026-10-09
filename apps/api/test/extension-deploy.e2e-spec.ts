import { ExtensionDeployService, IMAGE_STORE, spaceOf, type ImageStore } from '../src/extensions/extension-deploy.service';
import { startApp, type Harness } from './harness';

const REGISTRY = '123456789012.dkr.ecr.ap-south-1.amazonaws.com';

/** A customer deploying their own code by themselves: their own image space, a request, and what came of it. */
describe('Extensions: deployed by the customer (e2e)', () => {
  let h: Harness;
  let hac: string;
  let hacId: string;
  let other: string;
  let otherId: string;
  /** The image store, standing in: what each space holds, and which spaces a password was issued for. */
  const spaces = new Map<string, { tag: string; pushedAt: Date | null; sizeMb: number }[]>();
  const issued: string[] = [];
  let storeDown = false;
  const store: ImageStore = {
    ensureSpace: async (repository) => void (spaces.has(repository) || spaces.set(repository, [])),
    pushPassword: async (repository) => {
      if (storeDown) throw new Error('AccessDenied: arn:aws:iam::123456789012:role/push');
      issued.push(repository);
      return { password: `pw-for-${repository}`, expiresAt: new Date(Date.now() + 3600_000) };
    },
    images: async (repository) => spaces.get(repository) ?? [],
  };
  const status = async (token: string) => (await h.api().get('/extensions/deploy').set(h.bearer(token)).expect(200)).body;
  const deployer = () => h.app.get(ExtensionDeployService);

  beforeAll(async () => {
    h = await startApp({ EXT_REGISTRY: REGISTRY, EXT_PUSH_ROLE_ARN: 'arn:aws:iam::123456789012:role/push' }, (b) => b.overrideProvider(IMAGE_STORE).useValue(store));
    await h.signUp('Hana', 'hana@hac.test', 'HAC');
    hac = (await h.login('hana@hac.test')).token;
    hacId = (await h.api().get('/auth/me').set(h.bearer(hac))).body.org.id;
    await h.signUp('Omar', 'omar@other.test', 'Other');
    other = (await h.login('omar@other.test')).token;
    otherId = (await h.api().get('/auth/me').set(h.bearer(other))).body.org.id;
  });
  afterAll(async () => h?.close());

  it('gives a password for the organisation\'s own image space, and for no other', async () => {
    expect(await status(hac)).toMatchObject({ available: true, included: true, platform: 'linux/arm64', deploys: [] });
    const login = (await h.api().post('/extensions/deploy/login').set(h.bearer(hac)).expect(200)).body;
    expect(login).toMatchObject({ registry: REGISTRY, image: `${REGISTRY}/fb-ext/${hacId}`, username: 'AWS', password: `pw-for-fb-ext/${hacId}`, platform: 'linux/arm64' });
    expect(new Date(login.expiresAt).getTime()).toBeGreaterThan(Date.now());
    // Nothing in the request chooses the space: it is the signed-in organisation's, whatever is sent.
    await h.api().post('/extensions/deploy/login').set(h.bearer(other)).send({ orgId: hacId, repository: spaceOf(hacId) }).expect(200);
    expect(issued).toEqual([spaceOf(hacId), spaceOf(otherId)]);
    const trail = (await h.api().get('/audit').set(h.bearer(hac)).expect(200)).body.entries as { action: string }[];
    expect(trail.some((e) => e.action === 'extension.push_login')).toBe(true);
  });

  it('only administrators may, and nobody who is not signed in', async () => {
    await h.addMember(hac, 'Dev', 'dev@hac.test', 'DESIGNER');
    const dev = (await h.login('dev@hac.test')).token;
    await h.api().get('/extensions/deploy').set(h.bearer(dev)).expect(403);
    await h.api().post('/extensions/deploy/login').set(h.bearer(dev)).expect(403);
    await h.api().post('/extensions/deploy').set(h.bearer(dev)).send({ tag: 'v1' }).expect(403);
    await h.api().delete('/extensions/deploy').set(h.bearer(dev)).expect(403);
    await h.api().post('/extensions/deploy/login').expect(401);
  });

  it('lists what was pushed, newest first, and only the organisation\'s own', async () => {
    spaces.set(spaceOf(hacId), [
      { tag: 'v1', pushedAt: new Date('2026-10-01T10:00:00Z'), sizeMb: 61.2 },
      { tag: 'v2', pushedAt: new Date('2026-10-05T10:00:00Z'), sizeMb: 61.4 },
    ]);
    spaces.set(spaceOf(otherId), [{ tag: 'theirs', pushedAt: new Date(), sizeMb: 10 }]);
    const images = (await h.api().get('/extensions/deploy/images').set(h.bearer(hac)).expect(200)).body as { tag: string }[];
    expect(images.map((i) => i.tag)).toEqual(['v2', 'v1']);
  });

  it('a version that was not pushed, or is another organisation\'s, cannot be asked for', async () => {
    await h.api().post('/extensions/deploy').set(h.bearer(hac)).send({ tag: 'theirs' }).expect(404);
    await h.api().post('/extensions/deploy').set(h.bearer(hac)).send({ tag: 'v9' }).expect(404);
    for (const tag of ['../v1', `v1 && rm -rf /`, `${REGISTRY}/fb-ext/${otherId}:theirs`, '']) await h.api().post('/extensions/deploy').set(h.bearer(hac)).send({ tag }).expect(400);
    expect((await status(hac)).deploys).toEqual([]);
    expect(await deployer().takeNext()).toBeNull();
  });

  it('asks for a version; the deploy service takes it, and its result is what the organisation sees', async () => {
    const asked = (await h.api().post('/extensions/deploy').set(h.bearer(hac)).send({ tag: 'v2' }).expect(202)).body;
    expect(asked.deploys[0]).toMatchObject({ kind: 'DEPLOY', tag: 'v2', status: 'PENDING' });
    // One at a time.
    await h.api().post('/extensions/deploy').set(h.bearer(hac)).send({ tag: 'v1' }).expect(409);
    await h.api().delete('/extensions/deploy').set(h.bearer(hac)).expect(409);

    const job = (await deployer().takeNext())!;
    expect(job).toEqual({ id: asked.deploys[0].id, kind: 'DEPLOY', orgId: hacId, image: `${REGISTRY}/fb-ext/${hacId}:v2` });
    expect((await status(hac)).deploys[0].status).toBe('RUNNING');
    expect(await deployer().takeNext()).toBeNull();

    await deployer().finish(job.id, 'LIVE', 'Version v2 is running: 2 step(s), 1 list(s), 1 check(s)', '');
    expect((await status(hac)).deploys[0]).toMatchObject({ status: 'LIVE', message: 'Version v2 is running: 2 step(s), 1 list(s), 1 check(s)' });
    // Finished is finished: a second report of the same one is refused.
    await expect(deployer().finish(job.id, 'FAILED', 'again', '')).rejects.toThrow('No such deployment under way');
    // The other organisation sees none of it.
    expect((await status(other)).deploys).toEqual([]);
    const trail = (await h.api().get('/audit').set(h.bearer(hac)).expect(200)).body.entries as { action: string }[];
    expect(trail.map((e) => e.action)).toEqual(expect.arrayContaining(['extension.deploy_requested', 'extension.deployed']));
  });

  it('a version that will not start says why, with the end of its own output', async () => {
    await h.api().post('/extensions/deploy').set(h.bearer(hac)).send({ tag: 'v1' }).expect(202);
    const job = (await deployer().takeNext())!;
    await deployer().finish(job.id, 'FAILED', 'The new version did not start; the previous one is running again.', `${'x'.repeat(5000)}\nError: Cannot find module './steps'\u0000\u001b[0m`);
    const last = (await status(hac)).deploys[0];
    expect(last).toMatchObject({ tag: 'v1', status: 'FAILED', message: 'The new version did not start; the previous one is running again.' });
    expect(last.output.length).toBeLessThanOrEqual(4000);
    expect(last.output).toMatch(/Cannot find module '\.\/steps'\[0m$/);
    // The log is written behind the request: give it a moment.
    let found = false;
    for (let i = 0; i < 40 && !found; i++) {
      const lines = (await h.api().get('/org/logs?area=extensions').set(h.bearer(hac)).expect(200)).body.lines as { level: string; message: string }[];
      found = lines.some((l) => l.level === 'ERROR' && /Deployment failed \(version v1\)/.test(l.message));
      if (!found) await new Promise((r) => setTimeout(r, 50));
    }
    expect(found).toBe(true);
  });

  it('a request tampered with on the way is not run', async () => {
    await h.api().post('/extensions/deploy').set(h.bearer(hac)).send({ tag: 'v2' }).expect(202);
    // Somebody with their hands on the database points the request at another organisation's image.
    await h.app.get(ExtensionDeployService)['deploys'].updateOne({ orgId: hacId, status: 'PENDING' }, { $set: { image: `${REGISTRY}/fb-ext/${otherId}:theirs` } });
    expect(await deployer().takeNext()).toBeNull();
    expect((await status(hac)).deploys[0]).toMatchObject({ status: 'FAILED', message: 'The request was not one this installation can run.' });
  });

  it('a deployment left half done is closed, so the next can be asked for', async () => {
    await h.api().post('/extensions/deploy').set(h.bearer(hac)).send({ tag: 'v2' }).expect(202);
    const job = (await deployer().takeNext())!;
    await h.app.get(ExtensionDeployService)['deploys'].collection.updateOne({ id: job.id }, { $set: { updatedAt: new Date(Date.now() - 11 * 60_000) } });
    expect(await deployer().takeNext()).toBeNull();
    expect((await status(hac)).deploys[0]).toMatchObject({ status: 'FAILED', message: 'The deployment was interrupted. Nothing was changed; ask for it again.' });
    await h.api().post('/extensions/deploy').set(h.bearer(hac)).send({ tag: 'v2' }).expect(202);
    await deployer().finish((await deployer().takeNext())!.id, 'LIVE', 'Version v2 is running', '');
  });

  it('asks for it to be taken away', async () => {
    const asked = (await h.api().delete('/extensions/deploy').set(h.bearer(hac)).expect(202)).body;
    expect(asked.deploys[0]).toMatchObject({ kind: 'REMOVE', status: 'PENDING' });
    const job = (await deployer().takeNext())!;
    expect(job).toMatchObject({ kind: 'REMOVE', orgId: hacId });
    await deployer().finish(job.id, 'REMOVED', 'The extension was removed.', '');
    expect((await status(hac)).deploys[0]).toMatchObject({ kind: 'REMOVE', status: 'REMOVED' });
  });

  describe('from a pipeline, with a deploy key', () => {
    let key: string;
    const withKey = (k = key) => ({ Authorization: `Bearer ${k}` });

    it('an administrator makes the key; it is shown once and only its last characters afterwards', async () => {
      expect((await status(hac)).key).toBeNull();
      const made = (await h.api().post('/extensions/deploy/key').set(h.bearer(hac)).expect(200)).body;
      key = made.newKey;
      expect(key).toMatch(/^fbd_[A-Za-z0-9_-]{40,}$/);
      const now = await status(hac);
      expect(now.key).toMatchObject({ hint: key.slice(-4), lastUsedAt: null });
      expect(now.api).toBe(h.config.API_URL);
      expect(JSON.stringify(now)).not.toContain(key);
      const dev = (await h.login('dev@hac.test')).token;
      await h.api().post('/extensions/deploy/key').set(h.bearer(dev)).expect(403);
      await h.api().delete('/extensions/deploy/key').set(h.bearer(dev)).expect(403);
    });

    it('the key pushes and deploys for its own organisation, and the result can be waited for', async () => {
      const login = (await h.api().post('/extensions/pipeline/login').set(withKey()).expect(200)).body;
      expect(login).toMatchObject({ image: `${REGISTRY}/fb-ext/${hacId}`, password: `pw-for-fb-ext/${hacId}` });
      spaces.get(spaceOf(hacId))!.push({ tag: 'abc1234', pushedAt: new Date(), sizeMb: 60 });
      const asked = (await h.api().post('/extensions/pipeline/deploy').set(withKey()).send({ tag: 'abc1234' }).expect(202)).body;
      expect(asked).toMatchObject({ kind: 'DEPLOY', tag: 'abc1234', status: 'PENDING' });
      const job = (await deployer().takeNext())!;
      expect(job.image).toBe(`${REGISTRY}/fb-ext/${hacId}:abc1234`);
      expect((await h.api().get('/extensions/pipeline/latest').set(withKey()).expect(200)).body.status).toBe('RUNNING');
      await deployer().finish(job.id, 'LIVE', 'Version abc1234 is running', '');
      expect((await h.api().get('/extensions/pipeline/latest').set(withKey()).expect(200)).body).toMatchObject({ id: asked.id, status: 'LIVE', message: 'Version abc1234 is running' });
      // It is on record that the pipeline did it, and when the key was last used.
      const trail = (await h.api().get('/audit?action=extension.deploy_requested').set(h.bearer(hac)).expect(200)).body.entries as { actorId: string }[];
      expect(trail[0]!.actorId).toBe(`deploy-key:${key.slice(-4)}`);
      expect((await status(hac)).key.lastUsedAt).toBeTruthy();
    });

    it('the key opens nothing else, and nothing opens without it', async () => {
      await h.api().post('/extensions/pipeline/deploy').set(withKey()).send({ tag: 'theirs' }).expect(404);
      await h.api().get('/forms').set(withKey()).expect(401);
      await h.api().get('/extensions/deploy').set(withKey()).expect(401);
      await h.api().delete('/extensions/deploy').set(withKey()).expect(401);
      for (const bad of ['fbd_' + 'x'.repeat(43), key.slice(0, -1), 'Bearer', '']) await h.api().post('/extensions/pipeline/login').set({ Authorization: `Bearer ${bad}` }).expect(401);
      await h.api().post('/extensions/pipeline/login').expect(401);
      await h.api().get('/extensions/pipeline/latest').set(h.bearer(hac)).expect(401);
    });

    it('a new key replaces the old one at once; taking it back leaves the pipeline with nothing', async () => {
      const second = (await h.api().post('/extensions/deploy/key').set(h.bearer(hac)).expect(200)).body.newKey as string;
      await h.api().post('/extensions/pipeline/login').set(withKey()).expect(401);
      await h.api().post('/extensions/pipeline/login').set(withKey(second)).expect(200);
      expect((await h.api().delete('/extensions/deploy/key').set(h.bearer(hac)).expect(200)).body.key).toBeNull();
      await h.api().post('/extensions/pipeline/login').set(withKey(second)).expect(401);
      const trail = (await h.api().get('/audit').set(h.bearer(hac)).expect(200)).body.entries as { action: string }[];
      expect(trail.map((e) => e.action)).toEqual(expect.arrayContaining(['extension.deploy_key_created', 'extension.deploy_key_revoked']));
    });
  });

  it('when the image store cannot be reached, says so without saying why', async () => {
    storeDown = true;
    const res = await h.api().post('/extensions/deploy/login').set(h.bearer(hac)).expect(503);
    expect(JSON.stringify(res.body)).not.toMatch(/arn:aws|AccessDenied|123456789012:role/);
    storeDown = false;
  });
});

describe('Extensions: deployed by the customer, where it is not set up or not included (e2e)', () => {
  it('an installation without an image store says it is not switched on', async () => {
    const h = await startApp();
    try {
      await h.signUp('Hana', 'hana@hac.test', 'HAC');
      const token = (await h.login('hana@hac.test')).token;
      expect((await h.api().get('/extensions/deploy').set(h.bearer(token)).expect(200)).body).toMatchObject({ available: false, deploys: [] });
      await h.api().post('/extensions/deploy/login').set(h.bearer(token)).expect(503);
      await h.api().post('/extensions/deploy').set(h.bearer(token)).send({ tag: 'v1' }).expect(503);
    } finally {
      await h.close();
    }
  });

  it('a plan without extensions gets no image space', async () => {
    const made: string[] = [];
    const store: ImageStore = { ensureSpace: async (r) => void made.push(r), pushPassword: async () => ({ password: 'x', expiresAt: new Date() }), images: async () => [{ tag: 'v1', pushedAt: null, sizeMb: 1 }] };
    const h = await startApp({ EXT_REGISTRY: REGISTRY, EXT_PUSH_ROLE_ARN: 'arn:aws:iam::123456789012:role/push', DEFAULT_PLAN: 'FREE' }, (b) => b.overrideProvider(IMAGE_STORE).useValue(store));
    try {
      await h.signUp('Fred', 'fred@free.test', 'Free');
      const token = (await h.login('fred@free.test')).token;
      expect((await h.api().get('/extensions/deploy').set(h.bearer(token)).expect(200)).body).toMatchObject({ available: true, included: false });
      await h.api().post('/extensions/deploy/login').set(h.bearer(token)).expect(400);
      await h.api().post('/extensions/deploy').set(h.bearer(token)).send({ tag: 'v1' }).expect(400);
      expect(made).toEqual([]);
    } finally {
      await h.close();
    }
  });
});
