#!/usr/bin/env node
/**
 * Form Builder on Docker: installations, and the delivery of customers' extensions into them.
 *
 *   node infra/stack.mjs build                                   the API image (shared by every installation)
 *   node infra/stack.mjs up <project> [--api-port 4100] [--studio-port 5173] [--runtime-port 5174]
 *                                     [--plan ENTERPRISE] [--env development]
 *   node infra/stack.mjs down <project> [--volumes]
 *   node infra/stack.mjs op <project> <command> [args]           an operator command in the API container
 *                                                                (extension ..., set-plan ...)
 *   node infra/stack.mjs ext init <directory>                    a new extension repository, from the starter
 *   node infra/stack.mjs ext deploy <project> <orgId> <repository> [--name main]
 *   node infra/stack.mjs ext remove <project> <orgId> [--name main]
 *
 * Two ways to host a customer, with the same commands:
 *   shared     one project (say "fb") for everyone; `ext deploy fb <orgId> <repo>` per customer
 *   dedicated  a project per customer (say "fb-acme") with its own database, keys and addresses
 *
 * State (generated keys, each extension's secret) is kept in infra/.state/<project>/, readable
 * by the owner only. In production these belong in a secrets manager.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE = join(ROOT, 'infra/docker/compose.yml');
const TAG = 'local';
/** What a customer's container may use, whatever its code asks for. */
const LIMITS = ['--memory', '256m', '--cpus', '0.5', '--pids-limit', '128'];

const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
/** Runs with its output shown as it happens (builds). */
const show = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
  if (r.status !== 0) fail(`${cmd} ${args.slice(0, 3).join(' ')} ... failed`);
};
const quiet = (cmd, args) => spawnSync(cmd, args, { cwd: ROOT, stdio: 'ignore' }).status === 0;

function parse(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[argv[i].slice(2)] = true;
      else flags[argv[i].slice(2)] = argv[++i];
    } else positional.push(argv[i]);
  }
  return { positional, flags };
}

const PROJECT = /^[a-z][a-z0-9-]{1,30}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const stateDir = (project) => join(ROOT, 'infra/.state', project);
const readEnv = (file) => Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const writeEnv = (file, env) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
};

function projectEnv(project) {
  if (!PROJECT.test(project ?? '')) fail('Name the installation: lower-case letters, digits and "-", e.g. fb or fb-acme');
  const file = join(stateDir(project), 'stack.env');
  if (!existsSync(file)) fail(`There is no installation called ${project}. Create it with: stack.mjs up ${project}`);
  return readEnv(file);
}
const compose = (project, env, args, opts) => sh('docker', ['compose', '-p', project, '-f', COMPOSE, ...args], { env: { ...process.env, ...env }, ...opts });
const containerOf = (project, service) => `${project}-${service}-1`;

// ── The API image ──────────────────────────────────────────────────────────

function build() {
  show('docker', ['build', '-f', 'infra/docker/api.Dockerfile', '-t', `fb-api:${TAG}`, '.']);
}

// ── An installation ────────────────────────────────────────────────────────

function up(project, flags) {
  if (!PROJECT.test(project ?? '')) fail('Name the installation: lower-case letters, digits and "-", e.g. fb or fb-acme');
  const file = join(stateDir(project), 'stack.env');
  // Keys are made once and kept: making new ones would lock the installation out of its own data.
  const env = existsSync(file)
    ? readEnv(file)
    : {
        FB_PROJECT: project,
        FB_TAG: TAG,
        FB_JWT_SECRET: randomBytes(48).toString('base64'),
        FB_SECRET_KEY: randomBytes(32).toString('base64'),
        FB_API_PORT: String(flags['api-port'] ?? 4100),
        FB_STUDIO_PORT: String(flags['studio-port'] ?? 5173),
        FB_RUNTIME_PORT: String(flags['runtime-port'] ?? 5174),
        FB_DEFAULT_PLAN: String(flags.plan ?? 'ENTERPRISE'),
        FB_NODE_ENV: String(flags.env ?? 'development'),
      };
  writeEnv(file, env);

  if (!quiet('docker', ['image', 'inspect', `fb-api:${TAG}`])) build();
  // The web apps carry this installation's addresses inside them, so each installation has its own.
  const urls = { VITE_API_URL: `http://localhost:${env.FB_API_PORT}`, VITE_STUDIO_URL: `http://localhost:${env.FB_STUDIO_PORT}`, VITE_RUNTIME_URL: `http://localhost:${env.FB_RUNTIME_PORT}` };
  for (const app of ['studio', 'runtime']) {
    const args = Object.entries({ APP: app, ...urls }).flatMap(([k, v]) => ['--build-arg', `${k}=${v}`]);
    show('docker', ['build', '-f', 'infra/docker/web.Dockerfile', ...args, '-t', `${project}-${app}:${TAG}`, '.']);
  }
  show('docker', ['compose', '-p', project, '-f', COMPOSE, 'up', '-d', '--wait'], { env: { ...process.env, ...env } });
  // Starting again makes new API and worker containers: put them back on each extension's network.
  for (const ext of extensionsOf(project)) attach(project, ext.NETWORK);
  console.log(`\n${project} is up.\n  Builder       http://localhost:${env.FB_STUDIO_PORT}\n  Public forms  http://localhost:${env.FB_RUNTIME_PORT}\n  API           http://localhost:${env.FB_API_PORT}`);
}

function down(project, flags) {
  const env = projectEnv(project);
  for (const ext of extensionsOf(project)) {
    quiet('docker', ['rm', '-f', ext.CONTAINER]);
    for (const service of ['api', 'worker']) quiet('docker', ['network', 'disconnect', '-f', ext.NETWORK, containerOf(project, service)]);
    quiet('docker', ['network', 'rm', ext.NETWORK]);
  }
  compose(project, env, ['down', ...(flags.volumes ? ['--volumes'] : [])], { stdio: 'inherit' });
  // Without its data the installation is gone: so are its keys and its extensions' secrets.
  if (flags.volumes) rmSync(stateDir(project), { recursive: true, force: true });
}

/** An operator command inside the API container, with the installation's own database and keys. */
function op(project, args) {
  projectEnv(project);
  const scripts = { extension: 'dist/cli/extension.js', 'set-plan': 'dist/cli/set-plan.js' };
  const script = scripts[args[0]];
  if (!script) fail(`Operator commands: ${Object.keys(scripts).join(', ')}`);
  return sh('docker', ['exec', containerOf(project, 'api'), 'node', script, ...args.slice(1)]);
}

// ── Extensions ─────────────────────────────────────────────────────────────

const SLUG = /^[a-z][a-z0-9-]{0,20}$/;
function extensionState(project, orgId, name) {
  if (!UUID.test(orgId ?? '')) fail('Give the organisation id (shown in the builder under Organisation)');
  if (!SLUG.test(name)) fail('--name is lower-case letters, digits and "-"');
  const id = `${orgId.slice(0, 8)}-${name}`;
  return { file: join(stateDir(project), `ext-${id}.env`), container: `${project}-ext-${id}`, network: `${project}-ext-${id}` };
}
const extensionsOf = (project) =>
  existsSync(stateDir(project)) ? readdirSync(stateDir(project)).filter((f) => /^ext-.*\.env$/.test(f)).map((f) => readEnv(join(stateDir(project), f))) : [];

/** Puts the API and the worker on an extension's private network. */
function attach(project, network) {
  for (const service of ['api', 'worker']) {
    const attached = sh('docker', ['inspect', '-f', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}', containerOf(project, service)]).split(/\s+/);
    if (!attached.includes(network)) sh('docker', ['network', 'connect', network, containerOf(project, service)]);
  }
}

/** A new extension repository: the starter, standing on its own outside this repository. */
function extInit(directory) {
  if (!directory) fail('Give the directory to create');
  const target = resolve(directory);
  if (existsSync(target) && readdirSync(target).length) fail(`${target} is not empty`);
  cpSync(join(ROOT, 'examples/extension-starter'), target, { recursive: true, filter: (src) => !/node_modules|dist$/.test(src) });
  const sdk = vendorSdk(target);
  const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
  pkg.name = 'my-extension';
  pkg.dependencies['@fb/sdk'] = `file:./vendor/${sdk}`;
  writeFileSync(join(target, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  console.log(`Created ${target}. Edit src/index.ts; deploy it with: stack.mjs ext deploy <project> <orgId> ${directory}`);
}

/** Puts the SDK into the repository's vendor folder (until it is published to a registry). Returns the file name. */
function vendorSdk(repository) {
  if (!existsSync(join(ROOT, 'packages/sdk/dist/index.js'))) show('pnpm', ['--filter', '@fb/sdk', 'build']);
  const vendor = join(repository, 'vendor');
  mkdirSync(vendor, { recursive: true });
  for (const old of readdirSync(vendor)) if (/^fb-sdk-.*\.tgz$/.test(old)) rmSync(join(vendor, old));
  sh('pnpm', ['pack', '--pack-destination', vendor], { cwd: join(ROOT, 'packages/sdk') });
  return readdirSync(vendor).find((f) => /^fb-sdk-.*\.tgz$/.test(f));
}

const healthy = (container) => quiet('docker', ['exec', container, 'node', '-e', "fetch('http://127.0.0.1:8080/fb/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]);
function waitHealthy(container, seconds = 30) {
  for (let i = 0; i < seconds * 2; i++) {
    if (healthy(container)) return true;
    spawnSync('sleep', ['0.5']);
  }
  return false;
}

/** Starts a customer's image, locked down: no root, no writable disk, no extra rights, on its private network only. */
function runExtension(state, image) {
  quiet('docker', ['rm', '-f', state.container]);
  sh('docker', [
    'run', '-d', '--name', state.container, '--restart', 'unless-stopped',
    '--network', state.network, '--env-file', state.file,
    '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000',
    ...LIMITS, image,
  ]);
}

/**
 * The delivery pipeline: builds a customer's repository into an image, runs it beside the
 * installation, and has the API read what it offers. If the new version does not come up,
 * the one that was running is put back.
 */
function extDeploy(project, orgId, repository, flags) {
  projectEnv(project);
  const name = String(flags.name ?? 'main');
  const state = extensionState(project, orgId, name);
  const repo = resolve(repository ?? '');
  if (!repository || !existsSync(join(repo, 'package.json')) || !existsSync(join(repo, 'src'))) fail('Give the extension repository (a directory with package.json and src/)');

  // 1. Build, with our Dockerfile: what runs at build time and how the image starts is not the customer's to choose.
  vendorSdk(repo);
  const image = `${state.container}:${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  show('docker', ['build', '-f', join(ROOT, 'infra/docker/extension.Dockerfile'), '-t', image, repo]);

  // 2. First time: a private network that only this container, the API and the worker are on, and the installation's secret.
  const first = !existsSync(state.file);
  if (first) {
    if (!quiet('docker', ['network', 'inspect', state.network])) sh('docker', ['network', 'create', '--internal', state.network]);
    attach(project, state.network);
    let out;
    try {
      out = op(project, ['extension', 'install', orgId, `http://${state.container}:8080`]);
    } catch (e) {
      // Refused (the plan does not include it, or there is no such organisation): leave nothing behind.
      for (const service of ['api', 'worker']) quiet('docker', ['network', 'disconnect', '-f', state.network, containerOf(project, service)]);
      quiet('docker', ['network', 'rm', state.network]);
      quiet('docker', ['image', 'rm', image]);
      throw e;
    }
    const ref = /Installed as ([a-z0-9]{8})/.exec(out)?.[1];
    const secret = /FB_EXTENSION_SECRET=(\S+)/.exec(out)?.[1];
    if (!ref || !secret) fail(`The installation did not issue a secret:\n${out}`);
    writeEnv(state.file, { FB_EXTENSION_SECRET: secret, FB_ORG_ID: orgId, REF: ref, CONTAINER: state.container, NETWORK: state.network, IMAGE: '' });
  }
  const saved = readEnv(state.file);
  attach(project, state.network);

  // 3. Replace the running version; go back to it if the new one does not answer.
  runExtension(state, image);
  if (!waitHealthy(state.container)) {
    const logs = spawnSync('docker', ['logs', '--tail', '30', state.container], { encoding: 'utf8' });
    if (saved.IMAGE) {
      runExtension(state, saved.IMAGE);
      waitHealthy(state.container);
    } else quiet('docker', ['rm', '-f', state.container]);
    fail(`The new version did not start${saved.IMAGE ? '; the previous one is running again' : ''}.\n${logs.stdout}${logs.stderr}`);
  }
  writeEnv(state.file, { ...saved, IMAGE: image });

  // 4. Have the API read what it offers now.
  const synced = op(project, ['extension', 'sync', orgId, saved.REF]).trim();
  console.log(`${first ? 'Installed' : 'Updated'} ${state.container} (${image}).\n${synced}`);
}

function extRemove(project, orgId, flags) {
  projectEnv(project);
  const state = extensionState(project, orgId, String(flags.name ?? 'main'));
  if (!existsSync(state.file)) fail('No such extension is installed here');
  const saved = readEnv(state.file);
  console.log(op(project, ['extension', 'remove', orgId, saved.REF]).trim());
  quiet('docker', ['rm', '-f', state.container]);
  for (const service of ['api', 'worker']) quiet('docker', ['network', 'disconnect', '-f', state.network, containerOf(project, service)]);
  quiet('docker', ['network', 'rm', state.network]);
  rmSync(state.file);
}

// ── Command line ───────────────────────────────────────────────────────────

const { positional, flags } = parse(process.argv.slice(2));
const [command, ...rest] = positional;
try {
  if (command === 'build') build();
  else if (command === 'up') up(rest[0], flags);
  else if (command === 'down') down(rest[0], flags);
  else if (command === 'op') process.stdout.write(op(rest[0], process.argv.slice(4)));
  else if (command === 'ext' && rest[0] === 'init') extInit(rest[1]);
  else if (command === 'ext' && rest[0] === 'deploy') extDeploy(rest[1], rest[2], rest[3], flags);
  else if (command === 'ext' && rest[0] === 'remove') extRemove(rest[1], rest[2], flags);
  else fail('Commands: build | up <project> | down <project> [--volumes] | op <project> <command> | ext init <dir> | ext deploy <project> <orgId> <repo> | ext remove <project> <orgId>');
} catch (e) {
  fail(e.stderr?.toString().trim() || e.stdout?.toString().trim() || e.message);
}
