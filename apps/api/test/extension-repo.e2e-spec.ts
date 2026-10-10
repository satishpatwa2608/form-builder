import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ExtensionDeployService, IMAGE_STORE, spaceOf, type ImageStore } from '../src/extensions/extension-deploy.service';
import { branchIn, BUILD_RUNNER, DOCKERFILE, ExtensionRepoService, GIT_REMOTE, parseRepo, type BuildRunner, type GitRemote } from '../src/extensions/extension-repo.service';
import { startApp, type Harness } from './harness';

const REGISTRY = '123456789012.dkr.ecr.ap-south-1.amazonaws.com';
const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const COMMIT2 = 'ffeeddccbbaa99887766554433221100ffeeddcc';

describe('A repository address, as people paste it', () => {
  it('is understood in the forms the hosts show, and nothing else is', () => {
    expect(parseRepo('https://github.com/hac/plant-tools')).toEqual({ host: 'github.com', path: 'hac/plant-tools' });
    expect(parseRepo(' https://github.com/hac/plant-tools.git/ ')).toEqual({ host: 'github.com', path: 'hac/plant-tools' });
    expect(parseRepo('git@github.com:hac/plant-tools.git')).toEqual({ host: 'github.com', path: 'hac/plant-tools' });
    expect(parseRepo('https://gitlab.com/group/sub/project')).toEqual({ host: 'gitlab.com', path: 'group/sub/project' });
    for (const bad of ['', 'hac/plant-tools', 'http://github.com/a/b', 'https://evil.test/a/b', 'https://github.com/a', 'https://github.com/a/../b', 'https://github.com/-a/b', 'https://github.com/a/b;rm -rf /', 'git@github.com:a/b --upload-pack=x', 'file:///etc/passwd', 'https://user:pw@github.com/a/b'])
      expect(parseRepo(bad)).toBeNull();
  });

  it('a "push" message names its branch the way each host says it', () => {
    expect(branchIn({ ref: 'refs/heads/main' })).toBe('main');
    expect(branchIn({ ref: 'refs/heads/release/2026' })).toBe('release/2026');
    expect(branchIn({ ref: 'refs/tags/v1' })).toBe('');
    expect(branchIn({ push: { changes: [{ new: { type: 'branch', name: 'main' } }] } })).toBe('main');
    expect(branchIn({ push: { changes: [{ new: null }] } })).toBe('');
    expect(branchIn({ zen: 'Keep it logically awesome.' })).toBeNull();
    expect(branchIn(null)).toBeNull();
  });

  it('the Dockerfile every build uses is the one in the repository, less its comments', () => {
    const file = readFileSync(join(__dirname, '../../../infra/docker/extension.Dockerfile'), 'utf8');
    const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    expect(lines(DOCKERFILE)).toEqual(lines(file));
  });
});

describe('Extensions: built from the organisation\'s own repository (e2e)', () => {
  let h: Harness;
  let hac: string;
  let hacId: string;
  let other: string;
  const spaces = new Map<string, { tag: string; pushedAt: Date | null; sizeMb: number }[]>();
  const store: ImageStore = {
    ensureSpace: async (r) => void (spaces.has(r) || spaces.set(r, [])),
    pushPassword: async (r) => ({ password: `pw-for-${r}`, expiresAt: new Date(Date.now() + 3600_000) }),
    images: async (r) => spaces.get(r) ?? [],
  };
  /** The repository's side: which keys it has been given, and its branches. */
  const added = new Set<string>();
  const seen: { url: string; key: string }[] = [];
  const git: GitRemote = {
    branches: async (url, key) => {
      seen.push({ url, key });
      if (!added.has(key)) throw new Error('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.');
      return ['main', 'release/2026', 'dev'];
    },
  };
  /** The build machines: what each was started with. */
  const runs: { buildId: string; api: string; token: string }[] = [];
  let runnerDown = false;
  const runner: BuildRunner = {
    start: async (job) => {
      if (runnerDown) throw new Error('AccessDeniedException: arn:aws:codebuild');
      runs.push(job);
      return `run-${runs.length}`;
    },
    state: async () => 'FAILED',
  };
  const view = async (token = hac) => (await h.api().get('/extensions/repo').set(h.bearer(token)).expect(200)).body;
  const deployer = () => h.app.get(ExtensionDeployService);
  /** What the build machine does: collects its job, "builds", pushes, reports. */
  const machine = async (run: { buildId: string; token: string }, commit: string, ok = true, log = '') => {
    const job = (await h.api().post(`/extensions/builds/${run.buildId}/job`).send({ token: run.token }).expect(200)).body;
    if (ok) spaces.get(spaceOf(hacId))!.push({ tag: commit.slice(0, 7), pushedAt: new Date(), sizeMb: 60 });
    await h.api().post(`/extensions/builds/${run.buildId}/result`).send({ token: run.token, ok, commit, message: 'Tighten the triage rules', log }).expect(204);
    return job;
  };
  /** The server's deploy service taking the request and reporting. */
  const deployed = async (status: 'LIVE' | 'FAILED' = 'LIVE', message = 'It is running') => {
    const job = (await deployer().takeNext())!;
    await deployer().finish(job.id, status, message, status === 'FAILED' ? 'Error: boom' : '');
    return job;
  };

  beforeAll(async () => {
    h = await startApp({ EXT_REGISTRY: REGISTRY, EXT_PUSH_ROLE_ARN: 'arn:aws:iam::123456789012:role/push', EXT_BUILD_PROJECT: 'builds' }, (b) =>
      b.overrideProvider(IMAGE_STORE).useValue(store).overrideProvider(GIT_REMOTE).useValue(git).overrideProvider(BUILD_RUNNER).useValue(runner),
    );
    await h.signUp('Hana', 'hana@hac.test', 'HAC');
    hac = (await h.login('hana@hac.test')).token;
    hacId = (await h.api().get('/auth/me').set(h.bearer(hac))).body.org.id;
    await h.signUp('Omar', 'omar@other.test', 'Other');
    other = (await h.login('omar@other.test')).token;
  });
  afterAll(async () => h?.close());

  it('links a repository and shows the key to add and the address to call, for administrators only', async () => {
    expect(await view()).toEqual({ available: true, repo: null, builds: [] });
    await h.api().put('/extensions/repo').set(h.bearer(hac)).send({ url: 'https://evil.test/a/b' }).expect(400);
    const linked = (await h.api().put('/extensions/repo').set(h.bearer(hac)).send({ url: 'https://github.com/hac/plant-tools.git' }).expect(200)).body;
    expect(linked.repo).toMatchObject({ url: 'https://github.com/hac/plant-tools', host: 'github.com', branch: 'main', auto: false });
    expect(linked.repo.publicKey).toMatch(/^ssh-ed25519 \S+ form-builder-deploy$/);
    expect(linked.repo.hookUrl).toMatch(new RegExp(`^${h.config.API_URL}/extensions/repo/hook/[A-Za-z0-9_-]{40,}$`));
    expect(JSON.stringify(linked)).not.toContain('PRIVATE KEY');
    // Linking the same one again changes nothing; the customer does not have to add a key twice.
    const again = (await h.api().put('/extensions/repo').set(h.bearer(hac)).send({ url: 'git@github.com:hac/plant-tools.git' }).expect(200)).body;
    expect(again.repo.publicKey).toBe(linked.repo.publicKey);
    expect(again.repo.hookUrl).toBe(linked.repo.hookUrl);

    await h.addMember(hac, 'Dev', 'dev@hac.test', 'DESIGNER');
    const dev = (await h.login('dev@hac.test')).token;
    for (const call of [h.api().get('/extensions/repo'), h.api().put('/extensions/repo').send({ url: 'https://github.com/a/b' }), h.api().patch('/extensions/repo').send({ auto: true }), h.api().delete('/extensions/repo'), h.api().get('/extensions/repo/branches'), h.api().post('/extensions/repo/builds')])
      await call.set(h.bearer(dev)).expect(403);
    expect((await view(other)).repo).toBeNull();
  });

  it('reads the branches once the key has been added, and says what to check until then', async () => {
    const refused = await h.api().get('/extensions/repo/branches').set(h.bearer(hac)).expect(400);
    expect(refused.body.message).toMatch(/key shown here has been added/);
    expect(JSON.stringify(refused.body)).not.toMatch(/Permission denied|publickey/);
    expect(seen[0]!.url).toBe('git@github.com:hac/plant-tools.git');
    expect(seen[0]!.key).toContain('BEGIN OPENSSH PRIVATE KEY');
    added.add(seen[0]!.key);
    expect((await h.api().get('/extensions/repo/branches').set(h.bearer(hac)).expect(200)).body).toEqual(['dev', 'main', 'release/2026']);
    await h.api().get('/extensions/repo/branches').set(h.bearer(other)).expect(404);
  });

  it('chooses the branch and whether every commit is deployed', async () => {
    for (const branch of ['', '../main', 'a..b', '-x', 'main --upload-pack=x']) await h.api().patch('/extensions/repo').set(h.bearer(hac)).send({ branch }).expect(400);
    const set = (await h.api().patch('/extensions/repo').set(h.bearer(hac)).send({ branch: 'release/2026' }).expect(200)).body;
    expect(set.repo).toMatchObject({ branch: 'release/2026', auto: false });
  });

  it('"Deploy now" builds the branch on a machine of its own, which is handed what it needs once', async () => {
    const asked = (await h.api().post('/extensions/repo/builds').set(h.bearer(hac)).expect(202)).body;
    expect(asked.builds[0]).toMatchObject({ trigger: 'MANUAL', branch: 'release/2026', status: 'BUILDING', commit: '' });
    await h.api().post('/extensions/repo/builds').set(h.bearer(hac)).expect(409);
    const run = runs[0]!;
    expect(run).toMatchObject({ buildId: asked.builds[0].id, api: h.config.API_URL });

    // Only the build's own token opens its job, and only once.
    await h.api().post(`/extensions/builds/${run.buildId}/job`).send({ token: 'wrong' }).expect(403);
    await h.api().post(`/extensions/builds/${run.buildId}/job`).send({}).expect(403);
    const job = await machine(run, COMMIT);
    expect(job).toMatchObject({ repo: 'git@github.com:hac/plant-tools.git', branch: 'release/2026', registry: REGISTRY, image: `${REGISTRY}/fb-ext/${hacId}`, password: `pw-for-fb-ext/${hacId}`, platform: 'linux/arm64', dockerfile: DOCKERFILE });
    expect(job.gitKey).toBe(seen[0]!.key);
    await h.api().post(`/extensions/builds/${run.buildId}/job`).send({ token: run.token }).expect(403);

    // Built and pushed: it is now a deployment of that commit, like any other.
    expect((await view()).builds[0]).toMatchObject({ status: 'DEPLOYING', commit: COMMIT.slice(0, 7), commitMessage: 'Tighten the triage rules' });
    const deploy = await deployed('LIVE', `Version ${COMMIT.slice(0, 7)} is running. HAC plant tools: 2 step(s), 1 list(s), 1 check(s)`);
    expect(deploy.image).toBe(`${REGISTRY}/fb-ext/${hacId}:${COMMIT.slice(0, 7)}`);
    expect((await view()).builds[0]).toMatchObject({ status: 'LIVE', message: expect.stringContaining('is running') });
    // A report after the end changes nothing.
    await h.api().post(`/extensions/builds/${run.buildId}/result`).send({ token: run.token, ok: false, commit: COMMIT, log: 'late' }).expect(403);
    const trail = (await h.api().get('/audit').set(h.bearer(hac)).expect(200)).body.entries as { action: string }[];
    expect(trail.map((e) => e.action)).toEqual(expect.arrayContaining(['extension.repo_linked', 'extension.repo_updated', 'extension.build_started', 'extension.deployed']));
  });

  it('a commit builds only when asked to, and only for the branch that is deployed', async () => {
    const hook = (await view()).repo.hookUrl.replace(h.config.API_URL, '');
    expect((await h.api().post(hook).send({ ref: 'refs/heads/release/2026' }).expect(202)).body).toEqual({ started: false, why: 'Deploying on every commit is switched off' });
    await h.api().patch('/extensions/repo').set(h.bearer(hac)).send({ auto: true }).expect(200);
    expect((await h.api().post(hook).send({ ref: 'refs/heads/dev' }).expect(202)).body.started).toBe(false);
    expect((await h.api().post(hook).send({ ref: 'refs/tags/v9' }).expect(202)).body.started).toBe(false);
    expect(runs).toHaveLength(1);
    await h.api().post('/extensions/repo/hook/' + 'x'.repeat(43)).send({ ref: 'refs/heads/release/2026' }).expect(404);

    expect((await h.api().post(hook).send({ ref: 'refs/heads/release/2026', after: COMMIT2 }).expect(202)).body).toEqual({ started: true });
    expect((await view()).builds[0]).toMatchObject({ trigger: 'COMMIT', branch: 'release/2026', status: 'BUILDING' });
    expect(runs).toHaveLength(2);
  });

  it('a commit that arrives during a build is built when that one finishes, once', async () => {
    const hook = (await view()).repo.hookUrl.replace(h.config.API_URL, '');
    for (let i = 0; i < 3; i++) expect((await h.api().post(hook).send({ ref: 'refs/heads/release/2026' }).expect(202)).body.started).toBe(false);
    expect(runs).toHaveLength(2);
    await machine(runs[1]!, COMMIT2);
    await deployed();
    expect(runs).toHaveLength(3);
    const builds = (await view()).builds;
    expect(builds.slice(0, 2).map((b: { status: string; trigger: string }) => [b.trigger, b.status])).toEqual([['COMMIT', 'BUILDING'], ['COMMIT', 'LIVE']]);
  });

  it('code that does not build is not deployed, and the organisation sees what the build printed', async () => {
    await machine(runs[2]!, COMMIT, false, `${'.'.repeat(5000)}\nsrc/index.ts(12,3): error TS2304: Cannot find name 'triage'.\u0000`);
    const failed = (await view()).builds[0];
    expect(failed).toMatchObject({ status: 'FAILED', message: 'The code did not build. What the build printed is below.' });
    expect(failed.output).toMatch(/error TS2304: Cannot find name 'triage'\.$/);
    expect(failed.output.length).toBeLessThanOrEqual(4000);
    expect(await deployer().takeNext()).toBeNull();
  });

  it('a branch that cannot be fetched says so; a version that does not start fails the build with its output', async () => {
    await h.api().post('/extensions/repo/builds').set(h.bearer(hac)).expect(202);
    const run = runs[3]!;
    await h.api().post(`/extensions/builds/${run.buildId}/job`).send({ token: run.token }).expect(200);
    await h.api().post(`/extensions/builds/${run.buildId}/result`).send({ token: run.token, ok: false, commit: '', log: 'fatal: Remote branch release/2026 not found' }).expect(204);
    expect((await view()).builds[0]).toMatchObject({ status: 'FAILED', message: expect.stringContaining('could not be fetched from the branch release/2026') });

    await h.api().post('/extensions/repo/builds').set(h.bearer(hac)).expect(202);
    await machine(runs[4]!, COMMIT);
    await deployed('FAILED', `Version ${COMMIT.slice(0, 7)} did not start; the previous one is running again.`);
    expect((await view()).builds[0]).toMatchObject({ status: 'FAILED', message: expect.stringContaining('did not start'), output: 'Error: boom' });
  });

  it('a build machine that never reports is closed, so the next build can start', async () => {
    await h.api().post('/extensions/repo/builds').set(h.bearer(hac)).expect(202);
    await h.app.get(ExtensionRepoService)['builds'].collection.updateOne({ id: runs[5]!.buildId }, { $set: { updatedAt: new Date(Date.now() - 21 * 60_000) } });
    expect((await view()).builds[0]).toMatchObject({ status: 'FAILED', message: 'The build did not finish. Try again.' });
    runnerDown = true;
    const refused = (await h.api().post('/extensions/repo/builds').set(h.bearer(hac)).expect(202)).body;
    expect(refused.builds[0]).toMatchObject({ status: 'FAILED', message: 'The build could not be started. Try again in a moment.' });
    expect(JSON.stringify(refused)).not.toMatch(/arn:aws|AccessDenied/);
    runnerDown = false;
  });

  it('unlinking forgets the key and the address; a new link gets new ones', async () => {
    const before = (await view()).repo;
    expect((await h.api().delete('/extensions/repo').set(h.bearer(hac)).expect(200)).body.repo).toBeNull();
    await h.api().post(before.hookUrl.replace(h.config.API_URL, '')).send({ ref: 'refs/heads/release/2026' }).expect(404);
    await h.api().post('/extensions/repo/builds').set(h.bearer(hac)).expect(404);
    const relinked = (await h.api().put('/extensions/repo').set(h.bearer(hac)).send({ url: 'https://github.com/hac/plant-tools' }).expect(200)).body.repo;
    expect(relinked.publicKey).not.toBe(before.publicKey);
    expect(relinked.hookUrl).not.toBe(before.hookUrl);
  });
});

describe('Extensions: built from a repository, where it is not offered (e2e)', () => {
  it('says so, and links nothing', async () => {
    const h = await startApp();
    try {
      await h.signUp('Hana', 'hana@hac.test', 'HAC');
      const token = (await h.login('hana@hac.test')).token;
      expect((await h.api().get('/extensions/repo').set(h.bearer(token)).expect(200)).body).toEqual({ available: false, repo: null, builds: [] });
      await h.api().put('/extensions/repo').set(h.bearer(token)).send({ url: 'https://github.com/hac/plant-tools' }).expect(503);
    } finally {
      await h.close();
    }
  });
});
