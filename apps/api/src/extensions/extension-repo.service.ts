import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { BatchGetBuildsCommand, CodeBuildClient, StartBuildCommand } from '@aws-sdk/client-codebuild';
import type { Model } from 'mongoose';
import { actorOf, AuditService } from '../audit/audit.service';
import { hashToken, newId, randomToken } from '../common/crypto';
import { KEY_PROVIDER, openWith, sealWith, type KeyProvider } from '../common/key-provider';
import { APP_CONFIG, type AppConfig } from '../config';
import { orgLog } from '../logs/org-log';
import { ExtensionDeployService, type DeployCaller } from './extension-deploy.service';
import { ExtensionDeploy, type ExtensionDeployDocument } from './extension-deploy.schema';
import { ExtensionBuild, ExtensionRepo, type ExtensionBuildDocument, type ExtensionRepoDocument } from './extension-repo.schema';
import { newSshKey } from './ssh-key';

/** Reading a repository with the organisation's key. Swapped for a stand-in in tests. */
export interface GitRemote {
  branches(sshUrl: string, privateKey: string): Promise<string[]>;
}
export const GIT_REMOTE = Symbol('GIT_REMOTE');

/** The machine a build runs on: one of its own for each build, thrown away afterwards. Never this server. */
export interface BuildRunner {
  /** Starts a build that will come back to `api` with `token` for what it needs. Returns the machine's name for the run. */
  start(job: { buildId: string; api: string; token: string }): Promise<string>;
  state(runId: string): Promise<'RUNNING' | 'SUCCEEDED' | 'FAILED'>;
}
export const BUILD_RUNNER = Symbol('BUILD_RUNNER');

const HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org'];
const PATH = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}(\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}){1,3}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const validBranch = (b: string) => BRANCH.test(b) && !b.includes('..') && !b.endsWith('/') && !b.endsWith('.lock');

/** A repository's address, as people paste it (the page's address, or the one git shows), taken apart. */
export function parseRepo(input: string): { host: string; path: string } | null {
  const text = input.trim();
  const m = /^https:\/\/([a-z.]+)\/(.+?)(?:\.git)?\/?$/.exec(text) ?? /^(?:ssh:\/\/)?git@([a-z.]+)[:/](.+?)(?:\.git)?\/?$/.exec(text);
  if (!m || !HOSTS.includes(m[1]!) || !PATH.test(m[2]!) || m[2]!.includes('..')) return null;
  return { host: m[1]!, path: m[2]! };
}
const sshUrl = (r: { host: string; path: string }) => `git@${r.host}:${r.path}.git`;

/** `git` itself, with the key in a file only this call can read. The address has been checked against a strict pattern. */
export class GitCli implements GitRemote {
  async branches(url: string, privateKey: string): Promise<string[]> {
    const dir = await mkdtemp(join(tmpdir(), 'fbgit-'));
    try {
      const key = join(dir, 'key');
      await writeFile(key, privateKey, { mode: 0o600 });
      const ssh = `ssh -i ${key} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${join(dir, 'hosts')} -o ConnectTimeout=10`;
      const out = await new Promise<string>((resolve, reject) =>
        execFile('git', ['ls-remote', '--heads', '--', url], { env: { PATH: process.env.PATH ?? '', GIT_SSH_COMMAND: ssh, GIT_TERMINAL_PROMPT: '0', HOME: dir }, timeout: 25_000, maxBuffer: 2_000_000 }, (e, stdout) =>
          e ? reject(e) : resolve(stdout),
        ),
      );
      return out
        .split('\n')
        .map((l) => /\trefs\/heads\/(.+)$/.exec(l)?.[1] ?? '')
        .filter(validBranch);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/**
 * What the build machine runs. It asks the API for the repository, the key and a push sign-in (shown to it once),
 * builds with OUR Dockerfile, pushes to the organisation's own image space, and reports back. The machine's own
 * role can do nothing but write its log: everything it is trusted with comes from the API, for this one build.
 */
export const BUILDSPEC = `version: 0.2
env:
  shell: bash
phases:
  build:
    commands:
      - |
        set -uo pipefail
        report() {
          tail -c 6000 /tmp/build.log > /tmp/tail.log 2>/dev/null || : > /tmp/tail.log
          jq -n --arg token "$FB_TOKEN" --argjson ok "$1" --arg commit "\${COMMIT:-}" --arg message "\${SUBJECT:-}" --rawfile log /tmp/tail.log '{token:$token,ok:$ok,commit:$commit,message:$message,log:$log}' \\
            | curl -sS -m 30 -X POST -H 'Content-Type: application/json' -d @- "$FB_API/extensions/builds/$FB_BUILD/result" >/dev/null
        }
        JOB=$(curl -sS -m 30 --fail-with-body -X POST -H 'Content-Type: application/json' -d "{\\"token\\":\\"$FB_TOKEN\\"}" "$FB_API/extensions/builds/$FB_BUILD/job") || { echo "$JOB"; exit 1; }
        mkdir -p ~/.ssh && jq -r .gitKey <<<"$JOB" > ~/.ssh/fb && chmod 600 ~/.ssh/fb
        export GIT_SSH_COMMAND="ssh -i ~/.ssh/fb -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
        IMAGE=$(jq -r .image <<<"$JOB")
        (
          set -e
          git clone --quiet --depth 1 --branch "$(jq -r .branch <<<"$JOB")" -- "$(jq -r .repo <<<"$JOB")" src
          rm -f ~/.ssh/fb
          jq -r .dockerfile <<<"$JOB" > Dockerfile.fb
          docker build --platform "$(jq -r .platform <<<"$JOB")" -f Dockerfile.fb -t "$IMAGE:build" src
        ) > /tmp/build.log 2>&1
        BUILT=$?
        COMMIT=$(git -C src rev-parse HEAD 2>/dev/null || true)
        SUBJECT=$(git -C src log -1 --format=%s 2>/dev/null | cut -c1-200 || true)
        cat /tmp/build.log
        if [ $BUILT -ne 0 ]; then report false; exit 1; fi
        jq -r .password <<<"$JOB" | docker login "$(jq -r .registry <<<"$JOB")" -u AWS --password-stdin >/dev/null 2>&1
        docker tag "$IMAGE:build" "$IMAGE:\${COMMIT:0:7}"
        if ! docker push --quiet "$IMAGE:\${COMMIT:0:7}" >> /tmp/build.log 2>&1; then report false; exit 1; fi
        report true
`;

/** AWS CodeBuild: a machine per build. The project is made once (infra/pilot/README.md); each build brings its own instructions. */
export class CodeBuildRunner implements BuildRunner {
  private readonly client: CodeBuildClient;
  constructor(
    region: string,
    private readonly project: string,
  ) {
    this.client = new CodeBuildClient({ region });
  }
  async start(job: { buildId: string; api: string; token: string }) {
    const env = { FB_BUILD: job.buildId, FB_API: job.api, FB_TOKEN: job.token };
    const out = await this.client.send(
      new StartBuildCommand({ projectName: this.project, buildspecOverride: BUILDSPEC, environmentVariablesOverride: Object.entries(env).map(([name, value]) => ({ name, value, type: 'PLAINTEXT' as const })) }),
    );
    return out.build?.id ?? '';
  }
  async state(runId: string) {
    const status = (await this.client.send(new BatchGetBuildsCommand({ ids: [runId] }))).builds?.[0]?.buildStatus;
    return status === 'IN_PROGRESS' ? ('RUNNING' as const) : status === 'SUCCEEDED' ? ('SUCCEEDED' as const) : ('FAILED' as const);
  }
}

const ACTIVE = ['BUILDING', 'DEPLOYING'] as const;
/** A build that has not reported for this long is asked after. */
const QUIET_FOR = 20 * 60_000;

/**
 * An organisation's extension, built from its own repository: it links the repository, picks the branch, and
 * a build starts when someone presses Deploy or (if they chose so) whenever that branch changes. A finished
 * build becomes a deployment like any other (extension-deploy.service.ts).
 */
@Injectable()
export class ExtensionRepoService {
  private readonly logger = new Logger(ExtensionRepoService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(GIT_REMOTE) private readonly git: GitRemote,
    @Inject(BUILD_RUNNER) private readonly runner: BuildRunner | null,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    private readonly deploys: ExtensionDeployService,
    private readonly audit: AuditService,
    @InjectModel(ExtensionRepo.name) private readonly repos: Model<ExtensionRepoDocument>,
    @InjectModel(ExtensionBuild.name) private readonly builds: Model<ExtensionBuildDocument>,
    @InjectModel(ExtensionDeploy.name) private readonly deployRows: Model<ExtensionDeployDocument>,
  ) {
    // A deployment that came from a build finishes the build too, and lets a waiting commit go next.
    this.deploys.onFinished((deployId) => this.afterDeploy(deployId));
  }

  private available() {
    if (!this.runner || !this.deploys.isAvailable()) throw new ServiceUnavailableException('Building from a repository is not switched on for this installation.');
    return this.runner;
  }

  private async secretsOf(repo: ExtensionRepo) {
    return openWith<{ privateKey: string; hook: string }>(await this.keys.unwrap(repo.wrappedKey, { orgId: repo.orgId, purpose: 'extension-repo' }), repo.sealed);
  }

  /** What the page shows: the link, its settings, what to add on the repository's side, and the latest builds. */
  async view(auth: DeployCaller) {
    await this.settle(auth.orgId);
    const repo = await this.repos.findOne({ orgId: auth.orgId }).lean();
    const rows = await this.builds.find({ orgId: auth.orgId }).sort({ createdAt: -1 }).limit(10).lean();
    return {
      available: !!this.runner && this.deploys.isAvailable(),
      repo: repo && {
        url: `https://${repo.host}/${repo.path}`,
        host: repo.host,
        branch: repo.branch,
        auto: repo.auto,
        // The two things the organisation adds on the repository's side.
        publicKey: repo.publicKey,
        hookUrl: `${this.config.API_URL}/extensions/repo/hook/${(await this.secretsOf(repo)).hook}`,
      },
      builds: rows.map((b) => ({ id: b.id, trigger: b.trigger, branch: b.branch, commit: b.commit.slice(0, 7), commitMessage: b.commitMessage, status: b.status, message: b.message, output: b.output, at: b.createdAt ?? null })),
    };
  }

  /** Links a repository. A new link gets a new key and a new address to call; linking the same one again keeps them. */
  async connect(auth: DeployCaller, url: string) {
    this.available();
    await this.deploys.assertIncluded(auth.orgId);
    const parsed = parseRepo(url);
    if (!parsed) throw new BadRequestException(`Give the repository's address, for example https://github.com/your-company/your-extension (${HOSTS.join(', ')})`);
    const existing = await this.repos.findOne({ orgId: auth.orgId }).lean();
    if (existing?.host === parsed.host && existing.path === parsed.path) return this.view(auth);
    const key = newSshKey('form-builder-deploy');
    const hook = randomToken();
    const { plain, wrapped } = await this.keys.newDataKey({ orgId: auth.orgId, purpose: 'extension-repo' });
    await this.repos.deleteMany({ orgId: auth.orgId });
    await this.repos.create({ orgId: auth.orgId, ...parsed, branch: 'main', auto: false, publicKey: key.publicKey, sealed: sealWith(plain, { privateKey: key.privateKey, hook }), wrappedKey: wrapped, hookHash: hashToken(hook), connectedBy: auth.userId });
    await this.audit.record(actorOf(auth), { action: 'extension.repo_linked', targetType: 'organization', targetId: auth.orgId, after: { repository: `${parsed.host}/${parsed.path}` } });
    orgLog.info(auth.orgId, 'extensions', `Repository linked: ${parsed.host}/${parsed.path}`);
    return this.view(auth);
  }

  private async mustHave(orgId: string) {
    const repo = await this.repos.findOne({ orgId }).lean();
    if (!repo) throw new NotFoundException('No repository is linked yet');
    return repo;
  }

  /** The repository's branches, read with the organisation's key: this is also how the page knows the key was added. */
  async branches(auth: DeployCaller) {
    const repo = await this.mustHave(auth.orgId);
    try {
      return (await this.git.branches(sshUrl(repo), (await this.secretsOf(repo)).privateKey)).sort((a, b) => a.localeCompare(b));
    } catch (e) {
      this.logger.warn(`branches of ${repo.host}/${repo.path}: ${(e as Error).message.split('\n')[0]}`);
      throw new BadRequestException('The repository could not be read. Check its address, and that the key shown here has been added to it (read access is enough).');
    }
  }

  async update(auth: DeployCaller, change: { branch?: string; auto?: boolean }) {
    const repo = await this.mustHave(auth.orgId);
    if (change.branch !== undefined && !validBranch(change.branch)) throw new BadRequestException('Choose one of the repository\'s branches');
    const set = { ...(change.branch !== undefined ? { branch: change.branch } : {}), ...(change.auto !== undefined ? { auto: change.auto } : {}) };
    await this.repos.updateOne({ orgId: auth.orgId }, { $set: set });
    await this.audit.record(actorOf(auth), { action: 'extension.repo_updated', targetType: 'organization', targetId: auth.orgId, before: { branch: repo.branch, auto: repo.auto }, after: set });
    return this.view(auth);
  }

  /** Forgets the repository, its key and its address to call. What is running keeps running. */
  async disconnect(auth: DeployCaller) {
    const gone = await this.repos.findOneAndDelete({ orgId: auth.orgId }).lean();
    if (gone) {
      await this.audit.record(actorOf(auth), { action: 'extension.repo_unlinked', targetType: 'organization', targetId: auth.orgId, before: { repository: `${gone.host}/${gone.path}` } });
      orgLog.info(auth.orgId, 'extensions', `Repository unlinked: ${gone.host}/${gone.path}`);
    }
    return this.view(auth);
  }

  /** "Deploy now": builds the chosen branch as it stands and deploys it. */
  async buildNow(auth: DeployCaller) {
    await this.settle(auth.orgId);
    const repo = await this.mustHave(auth.orgId);
    if (await this.builds.exists({ orgId: auth.orgId, status: { $in: ACTIVE } })) throw new ConflictException('A build is already under way. Wait for it to finish.');
    await this.start(repo, 'MANUAL', auth);
    return this.view(auth);
  }

  /**
   * The repository saying it changed. The address itself is the proof of who is calling; what is sent is only
   * read for which branch moved, and the build fetches that branch as it stands, so a made-up call can start
   * nothing but a build of the organisation's own code.
   */
  async hook(token: string, body: unknown, caller: { ip: string; userAgent: string }): Promise<{ started: boolean; why?: string }> {
    const repo = await this.repos.findOne({ hookHash: hashToken(token) }).lean();
    if (!repo) throw new NotFoundException();
    if (!repo.auto) return { started: false, why: 'Deploying on every commit is switched off' };
    const moved = branchIn(body);
    if (moved !== null && moved !== repo.branch) return { started: false, why: `Not the branch that is deployed (${repo.branch})` };
    await this.settle(repo.orgId);
    if (await this.builds.exists({ orgId: repo.orgId, status: { $in: ACTIVE } })) {
      await this.repos.updateOne({ orgId: repo.orgId }, { $set: { again: true } });
      return { started: false, why: 'A build is under way; this change is built when it finishes' };
    }
    if (!this.runner || !this.deploys.isAvailable()) return { started: false, why: 'Not switched on' };
    await this.start(repo, 'COMMIT', { orgId: repo.orgId, userId: 'commit', ip: caller.ip, userAgent: caller.userAgent.slice(0, 200) });
    return { started: true };
  }

  private async start(repo: ExtensionRepo, trigger: 'MANUAL' | 'COMMIT', auth: DeployCaller) {
    const runner = this.available();
    await this.deploys.assertIncluded(repo.orgId);
    const id = newId();
    const token = randomToken();
    await this.repos.updateOne({ orgId: repo.orgId }, { $set: { again: false } });
    await this.builds.create({ id, orgId: repo.orgId, trigger, branch: repo.branch, status: 'BUILDING', tokenHash: hashToken(token), startedBy: auth.userId });
    await this.audit.record(actorOf(auth), { action: 'extension.build_started', targetType: 'extension', targetId: id, after: { branch: repo.branch, trigger } });
    orgLog.info(repo.orgId, 'extensions', `Build started from ${repo.branch} (${trigger === 'COMMIT' ? 'a commit' : 'asked for by hand'})`, { build: id });
    try {
      const runId = await runner.start({ buildId: id, api: this.config.API_URL, token });
      await this.builds.updateOne({ id }, { $set: { runId } });
    } catch (e) {
      this.logger.error(`build ${id} could not start: ${(e as Error).name}`);
      await this.fail(id, 'The build could not be started. Try again in a moment.', '');
    }
  }

  private async fail(id: string, message: string, output: string) {
    const row = await this.builds.findOneAndUpdate({ id, status: { $in: ACTIVE } }, { $set: { status: 'FAILED', message: message.slice(0, 500), output: clean(output) } }, { new: true }).lean();
    if (row) orgLog.error(row.orgId, 'extensions', `Build failed: ${message}`, { build: id });
  }

  // ── The build machine (it shows the build's own token; nothing else lets it in) ─────────────────────

  private async building(id: string, token: unknown) {
    const row = typeof token === 'string' ? await this.builds.findOne({ id, tokenHash: hashToken(token), status: 'BUILDING' }).lean() : null;
    if (!row) throw new ForbiddenException();
    return row;
  }

  /** Everything the build needs, handed over once: where the code is, the key to read it, and a sign-in to push with. */
  async job(id: string, token: unknown) {
    const row = await this.building(id, token);
    const taken = await this.builds.updateOne({ id, collected: false }, { $set: { collected: true } });
    if (!taken.modifiedCount) throw new ForbiddenException();
    const repo = await this.mustHave(row.orgId);
    const push = await this.deploys.pushLoginFor(row.orgId);
    return { repo: sshUrl(repo), branch: row.branch, gitKey: (await this.secretsOf(repo)).privateKey, registry: push.registry, image: push.image, password: push.password, platform: push.platform, dockerfile: DOCKERFILE };
  }

  /** How the build went. Built and pushed: it becomes a deployment. Not built: the organisation sees why. */
  async result(id: string, body: { token?: unknown; ok?: unknown; commit?: unknown; message?: unknown; log?: unknown }) {
    const row = await this.building(id, body.token);
    const commit = typeof body.commit === 'string' && /^[0-9a-f]{40}$/.test(body.commit) ? body.commit : '';
    const commitMessage = typeof body.message === 'string' ? clean(body.message).slice(0, 200) : '';
    const log = typeof body.log === 'string' ? body.log : '';
    await this.builds.updateOne({ id }, { $set: { commit, commitMessage } });
    if (body.ok !== true || !commit) return this.fail(id, commit ? 'The code did not build. What the build printed is below.' : `The code could not be fetched from the branch ${row.branch}. Check the branch, and that the key has been added to the repository.`, log);
    try {
      const asked = await this.deploys.request({ orgId: row.orgId, userId: row.startedBy === 'commit' ? 'commit' : row.startedBy, ip: '', userAgent: 'build' }, commit.slice(0, 7));
      await this.builds.updateOne({ id }, { $set: { status: 'DEPLOYING', deployId: asked.deploys[0]!.id, output: '' } });
    } catch (e) {
      await this.fail(id, (e as Error).message, log);
    }
  }

  private async afterDeploy(deployId: string) {
    const deploy = await this.deployRows.findOne({ id: deployId }).lean();
    const build = deploy && (await this.builds.findOneAndUpdate({ deployId, status: 'DEPLOYING' }, { $set: { status: deploy.status === 'LIVE' ? 'LIVE' : 'FAILED', message: deploy.message, output: deploy.output } }).lean());
    if (!build) return;
    // The branch moved while this one was being built: build what is there now.
    const repo = await this.repos.findOne({ orgId: build.orgId, again: true, auto: true }).lean();
    if (repo && this.runner) await this.start(repo, 'COMMIT', { orgId: repo.orgId, userId: 'commit', ip: '', userAgent: 'build' }).catch((e: Error) => this.logger.warn(`follow-on build: ${e.message}`));
  }

  /** A build whose machine never reported (it was stopped, or ran out of time) is closed, so the next can start. */
  private async settle(orgId: string) {
    const quiet = await this.builds.find({ orgId, status: 'BUILDING', updatedAt: { $lt: new Date(Date.now() - QUIET_FOR) } }).lean();
    for (const b of quiet) {
      const state = b.runId && this.runner ? await this.runner.state(b.runId).catch(() => 'FAILED' as const) : 'FAILED';
      if (state !== 'RUNNING') await this.fail(b.id, 'The build did not finish. Try again.', '');
    }
  }
}

const clean = (text: string) => text.replace(/[^\x09\x0a\x20-\x7e -￿]/g, '').slice(-4000);

/** The branch a "push" message is about, as GitHub and GitLab (`ref`) or Bitbucket (`push.changes`) say it; null if it does not say. */
export function branchIn(body: unknown): string | null {
  const b = body as { ref?: unknown; push?: { changes?: { new?: { type?: unknown; name?: unknown } | null }[] } } | null;
  if (typeof b?.ref === 'string') return b.ref.startsWith('refs/heads/') ? b.ref.slice('refs/heads/'.length) : '';
  const change = b?.push?.changes?.find((c) => c?.new?.type === 'branch');
  if (typeof change?.new?.name === 'string') return change.new.name;
  return Array.isArray(b?.push?.changes) ? '' : null;
}

/**
 * How every extension is built: ours, never one from the repository, so what runs at build time and how the
 * image starts is not the customer's to choose. Kept the same as infra/docker/extension.Dockerfile (a test checks).
 */
export const DOCKERFILE = `FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY vendor ./vendor
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
`;
