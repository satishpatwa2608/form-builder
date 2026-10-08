import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The whole product, running for real on this machine: MongoDB with an empty
 * data directory, the API, the builder (studio) and the public form app.
 * Nothing here touches a developer's own database or ports.
 */

export const ROOT = resolve(__dirname, '..');
export const PORTS = { mongo: 27098, api: 4198, studio: 5183, runtime: 5184 } as const;
export const API = `http://127.0.0.1:${PORTS.api}`;
export const STUDIO = `http://127.0.0.1:${PORTS.studio}`;
export const RUNTIME = `http://127.0.0.1:${PORTS.runtime}`;

/** Where the running stack records itself, so teardown (a separate process) can find it. */
export const STATE_FILE = join(ROOT, 'e2e', '.stack.json');

export interface StackState {
  dir: string;
  apiLog: string;
  pids: number[];
}

export const readState = (): StackState => JSON.parse(readFileSync(STATE_FILE, 'utf8')) as StackState;

async function waitFor(what: string, check: () => Promise<boolean>, ms = 90_000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() > end) throw new Error(`${what} did not come up in ${ms / 1000}s`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

const up = (url: string) => async () => (await fetch(url)).status < 500;

function run(name: string, dir: string, command: string, args: string[], cwd: string, env: Record<string, string>): ChildProcess {
  const log = createWriteStream(join(dir, `${name}.log`));
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout!.pipe(log);
  child.stderr!.pipe(log);
  child.on('exit', (code) => log.write(`\n[${name} exited with ${code}]\n`));
  return child;
}

export async function startStack(): Promise<StackState> {
  if (existsSync(STATE_FILE)) stopStack();
  // The API runs from its build, like production; the engine and connectors are its dependencies.
  execSync('pnpm --filter @fb/engine --filter @fb/connectors --filter @fb/api --filter @fb/gateway build', { cwd: ROOT, stdio: 'inherit' });

  const dir = mkdtempSync(join(tmpdir(), 'fb-e2e-'));
  mkdirSync(join(dir, 'db'));
  mkdirSync(join(dir, 'uploads'));
  const children: ChildProcess[] = [];
  const state = (): StackState => ({ dir, apiLog: join(dir, 'api.log'), pids: children.map((c) => c.pid!).filter(Boolean) });
  const save = () => writeFileSync(STATE_FILE, JSON.stringify(state()));

  try {
    children.push(run('mongod', dir, 'mongod', ['--dbpath', join(dir, 'db'), '--port', String(PORTS.mongo), '--bind_ip', '127.0.0.1'], dir, {}));
    save();
    children.push(
      run('api', dir, 'node', ['dist/main.js'], join(ROOT, 'apps/api'), {
        // "test" switches off rate limits, which a suite submitting from one address would trip.
        NODE_ENV: 'test',
        PORT: String(PORTS.api),
        MONGODB_URL: `mongodb://127.0.0.1:${PORTS.mongo}/fb-e2e`,
        JWT_SECRET: randomBytes(48).toString('base64'),
        SECRET_KEY: randomBytes(32).toString('base64'),
        APP_URL: STUDIO,
        API_URL: API,
        FORM_APP_URL: RUNTIME,
        CORS_ORIGINS: `${STUDIO},${RUNTIME}`,
        COOKIE_SECURE: 'false',
        MAIL_PROVIDER: 'console',
        STORAGE_PROVIDER: 'local',
        LOCAL_STORAGE_DIR: join(dir, 'uploads'),
        DEFAULT_PLAN: 'ENTERPRISE',
        JOBS_ROLE: 'all',
        FILE_SCANNER: 'none',
        FORM_ALLOW_MOCK_CAPTCHA: 'true',
        // The "customer database" the connector scenario reads is on this machine.
        CONNECTOR_ALLOW_PRIVATE_NETWORK: 'true',
      }),
    );
    save();
    const web = { VITE_API_URL: API, VITE_RUNTIME_URL: RUNTIME, VITE_STUDIO_URL: STUDIO };
    children.push(run('studio', dir, 'npx', ['vite', '--port', String(PORTS.studio), '--strictPort', '--host', '127.0.0.1'], join(ROOT, 'apps/studio'), web));
    children.push(run('runtime', dir, 'npx', ['vite', '--port', String(PORTS.runtime), '--strictPort', '--host', '127.0.0.1'], join(ROOT, 'apps/runtime'), web));
    save();

    await waitFor('The API', up(`${API}/health`));
    await waitFor('The builder', up(STUDIO));
    await waitFor('The public form app', up(RUNTIME));
    return state();
  } catch (e) {
    save();
    const tail = (name: string) => (existsSync(join(dir, `${name}.log`)) ? readFileSync(join(dir, `${name}.log`), 'utf8').slice(-1500) : '(no log)');
    const logs = ['mongod', 'api', 'studio', 'runtime'].map((n) => `--- ${n} ---\n${tail(n)}`).join('\n');
    stopStack();
    throw new Error(`${(e as Error).message}\n${logs}`);
  }
}

export function stopStack() {
  if (!existsSync(STATE_FILE)) return;
  const { pids, dir } = readState();
  for (const pid of pids) {
    try {
      // Each was started as the leader of its own process group, so this takes its children too.
      process.kill(-pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  rmSync(STATE_FILE, { force: true });
  // Leave the logs if asked to (E2E_KEEP=1), to look at after a failure.
  if (!process.env.E2E_KEEP) setTimeout(() => rmSync(dir, { recursive: true, force: true }), 1500).unref();
}
