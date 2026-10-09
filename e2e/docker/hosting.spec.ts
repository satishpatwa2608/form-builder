import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * A customer has bought the product and wants their own code in it. Both ways of
 * hosting them, for real, in Docker:
 *   shared     one installation for everyone; each customer's code in a container of its own
 *   dedicated  an installation of their own, with their code beside it
 * The customers' code is delivered by the pipeline (infra/stack.mjs ext deploy).
 */

const ROOT = resolve(__dirname, '../..');
const PASSWORD = 'correct horse battery';
const SHARED = { project: 'fbt-shared', api: 'http://localhost:4310', studio: 'http://localhost:5310', runtime: 'http://localhost:5311', ports: ['--api-port', '4310', '--studio-port', '5310', '--runtime-port', '5311'] };
const DEDICATED = { project: 'fbt-acme', api: 'http://localhost:4320', studio: 'http://localhost:5320', runtime: 'http://localhost:5321', ports: ['--api-port', '4320', '--studio-port', '5320', '--runtime-port', '5321'] };
type Site = typeof SHARED;

const stack = (...args: string[]) => {
  const r = spawnSync('node', [join(ROOT, 'infra/stack.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
};
const must = (...args: string[]) => {
  const r = stack(...args);
  expect(r.ok, `stack.mjs ${args.join(' ')}\n${r.out.slice(-3000)}`).toBe(true);
  return r.out;
};
const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });

async function call<T = any>(site: Site, expected: number, path: string, { method = 'GET', body, token }: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const send = () => fetch(`${site.api}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  // Putting the API on a new extension's network closes connections that were being kept open; a new one works at once.
  const res = await send().catch(() => send());
  const text = await res.text();
  expect(res.status, `${method} ${path} -> ${text.slice(0, 400)}`).toBe(expected);
  return (text ? JSON.parse(text) : undefined) as T;
}

/** The installation "sends" mail by printing it in the API container's log. */
async function tokenFromMail(site: Site, to: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const log = docker('logs', `${site.project}-api-1`).stdout.replace(/\x1b\[[0-9;]*m/g, '');
    const at = log.lastIndexOf(`to=${to}`);
    const token = at === -1 ? undefined : /token=([A-Za-z0-9_-]+)/.exec(log.slice(at))?.[1];
    if (token) return token;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no mail for ${to}`);
}

interface Org {
  email: string;
  token: string;
  orgId: string;
  folderId: string;
}
let n = 0;
async function createOrg(site: Site, name: string): Promise<Org> {
  const email = `owner${++n}-${Date.now()}@docker.test`;
  await call(site, 202, '/auth/signup', { method: 'POST', body: { name: 'Asha Rao', email, password: PASSWORD, orgName: name } });
  await call(site, 200, '/auth/verify-email', { method: 'POST', body: { token: await tokenFromMail(site, email) } });
  const login = await call<{ accessToken: string }>(site, 200, '/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  const me = await call<{ org: { id: string } }>(site, 200, '/auth/me', { token: login.accessToken });
  const folders = await call<{ id: string }[]>(site, 201, '/folders', { method: 'POST', token: login.accessToken, body: { name: 'Forms' } });
  return { email, token: login.accessToken, orgId: me.org.id, folderId: folders[0].id };
}

const extName = (site: Site, org: Org) => `${site.project}-ext-${org.orgId.slice(0, 8)}-main`;
const inside = (container: string, script: string) => docker('exec', container, 'node', '-e', script);
const offered = async (site: Site, org: Org) => (await call<{ name: string; status: string; steps: { key: string }[] }[]>(site, 200, '/extensions', { token: org.token }))[0];

/** A loan form that uses everything the Acme extension offers. */
const loan = (ref: string) => ({
  name: 'Loan request',
  code: 'LOAN_REQUEST',
  businessId: '',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [
    { id: 'a', type: 'TEXT', name: 'customer', label: 'Customer', required: true },
    { id: 'b', type: 'NUMBER', name: 'amount', label: 'Amount', required: true },
    { id: 'c', type: 'TEXT', name: 'gstin', label: 'GST number' },
    { id: 'd', type: 'DROPDOWN', name: 'city', label: 'City', dataSource: { type: 'STATIC', options: [{ label: 'Pune', value: 'Pune' }, { label: 'Mumbai', value: 'Mumbai' }] } },
    { id: 'e', type: 'DROPDOWN', name: 'branch', label: 'Branch', dataSource: { type: 'API', api: { url: `/extensions/${ref}/branches`, method: 'POST', valueField: 'value', labelField: 'label', params: { city: '{{city}}' } } } },
  ],
  workflow: {
    enabled: true,
    refPrefix: 'LN',
    statuses: [
      { key: 'NEW', label: 'New', category: 'OPEN' },
      { key: 'REVIEW', label: 'Senior review', category: 'IN_PROGRESS' },
      { key: 'CLOSED', label: 'Closed', category: 'DONE' },
    ],
    assignment: { type: 'NONE' },
  },
  automations: [
    {
      id: 'a1',
      name: 'Score',
      enabled: true,
      when: 'SUBMITTED',
      actions: [
        { id: 'risk', type: 'HANDLER', key: `x-${ref}-risk-score` },
        { id: 'escalate', type: 'SET_STATUS', status: 'REVIEW', if: { field: '$steps.risk.band', operator: 'equals', value: 'HIGH' } },
      ],
    },
  ],
  submitChecks: [`x-${ref}-gstin`],
});

async function publishLoan(site: Site, org: Org) {
  const ref = (await call<{ ref: string }[]>(site, 200, '/extensions', { token: org.token }))[0].ref;
  const made = await call<{ definition: { id: string } }>(site, 201, '/forms', { method: 'POST', token: org.token, body: { folderId: org.folderId, definition: loan(ref) } });
  await call(site, 200, `/forms/${made.definition.id}/publish`, { method: 'POST', token: org.token });
  return made.definition.id;
}
const submit = (site: Site, org: Org, values: object) => {
  const send = () => fetch(`${site.api}/public/forms/LOAN_REQUEST/submissions?org=${org.orgId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values }) });
  return send().catch(() => send());
};
const statusOf = async (site: Site, org: Org, formId: string, customer: string) =>
  (await call<{ rows: { status: string; payload: { customer: string } }[] }>(site, 200, `/forms/${formId}/submissions`, { token: org.token })).rows.find((r) => r.payload.customer === customer)?.status;

const work = mkdtempSync(join(tmpdir(), 'fb-docker-'));
const acmeRepo = join(work, 'acme-extension');
const boltRepo = join(work, 'bolt-extension');
let acme: Org;
let bolt: Org;
let acmeForm: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(30 * 60_000);
  expect(docker('info').status, 'Docker must be running').toBe(0);
  for (const site of [SHARED, DEDICATED]) if (existsSync(join(ROOT, 'infra/.state', site.project))) stack('down', site.project, '--volumes');
  must('build');
  must('up', SHARED.project, ...SHARED.ports, '--env', 'test');
});

test.afterAll(async () => {
  test.setTimeout(5 * 60_000);
  if (!process.env.E2E_KEEP) {
    for (const site of [SHARED, DEDICATED]) if (existsSync(join(ROOT, 'infra/.state', site.project))) stack('down', site.project, '--volumes');
  }
  rmSync(work, { recursive: true, force: true });
});

test.describe('Shared hosting: one installation, each customer\'s code in its own container', () => {
  test('the installation runs as separate containers, and only the web addresses are open', async () => {
    const names = docker('ps', '--filter', `name=${SHARED.project}-`, '--format', '{{.Names}}').stdout.trim().split('\n').sort();
    expect(names).toEqual(['api', 'mongo', 'runtime', 'studio', 'worker'].map((s) => `${SHARED.project}-${s}-1`));
    expect((await fetch(`${SHARED.api}/health`)).status).toBe(200);
    expect(await (await fetch(`${SHARED.studio}/forms`)).text()).toContain('<div id="root">');
    expect(await (await fetch(`${SHARED.runtime}/f/x/Y`)).text()).toContain('<div id="root">');
    // The database is published nowhere, and the API does not run as root.
    expect(docker('port', `${SHARED.project}-mongo-1`).stdout.trim()).toBe('');
    expect(docker('exec', `${SHARED.project}-api-1`, 'id', '-u').stdout.trim()).not.toBe('0');
  });

  test('two customers each get their own repository, and the pipeline delivers both', async () => {
    acme = await createOrg(SHARED, 'Acme');
    bolt = await createOrg(SHARED, 'Bolt');

    // Each customer starts from the starter, in a repository of their own, outside ours.
    must('ext', 'init', acmeRepo);
    must('ext', 'init', boltRepo);
    expect(JSON.parse(readFileSync(join(acmeRepo, 'package.json'), 'utf8')).dependencies['@fb/sdk']).toMatch(/^file:\.\/vendor\/fb-sdk-.*\.tgz$/);
    writeFileSync(
      join(boltRepo, 'src/index.ts'),
      `import { createExtension, type CheckResult } from '@fb/sdk';
const ext = createExtension({ name: 'Bolt logic' });
ext.step({ key: 'greet', label: 'Greet', outputs: ['greeting'] }, async ({ values }) => ({ summary: 'Hello ' + String(values.customer), data: { greeting: 'hello' } }));
ext.check({ key: 'no-tests', label: 'No test entries' }, async ({ values }): Promise<CheckResult> => (String(values.customer).toLowerCase() === 'test' ? { message: 'Test entries are not accepted.' } : undefined));
void ext.listen();
`,
    );

    expect(must('ext', 'deploy', SHARED.project, acme.orgId, acmeRepo)).toContain('Acme rules: 1 step(s), 1 list(s), 1 check(s)');
    expect(must('ext', 'deploy', SHARED.project, bolt.orgId, boltRepo)).toContain('Bolt logic: 1 step(s), 0 list(s), 1 check(s)');

    // Each organisation sees its own, running, with nothing to do by hand.
    expect(await offered(SHARED, acme)).toMatchObject({ name: 'Acme rules', status: 'OK' });
    expect(await offered(SHARED, bolt)).toMatchObject({ name: 'Bolt logic', status: 'OK', steps: [{ key: 'greet' }] });
    expect(await call<unknown[]>(SHARED, 200, '/extensions', { token: acme.token })).toHaveLength(1);
  });

  test("a customer's form runs their code: in the browser, on the server and in the worker", async ({ page }) => {
    acmeForm = await publishLoan(SHARED, acme);
    await page.goto(`${SHARED.runtime}/f/${acme.orgId}/LOAN_REQUEST`);
    await page.getByLabel(/^Customer/).fill('Asha Textiles');
    await page.getByLabel(/^Amount/).fill('90000');
    await page.getByRole('combobox', { name: /^City/ }).click();
    await page.getByRole('option', { name: 'Pune' }).click();
    await page.getByRole('combobox', { name: /^Branch/ }).click();
    await expect(page.getByRole('option')).toHaveText(['Pune Camp', 'Pune Kothrud']);
    await page.getByRole('option', { name: 'Pune Camp' }).click();
    await page.getByLabel(/^GST number/).fill('27AAPFU0939F1ZX');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText('This is not a valid GST number. Please check it against your certificate.').first()).toBeVisible();
    await page.getByLabel(/^GST number/).fill('27AAPFU0939F1ZV');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText(/LN-000001/)).toBeVisible();
    // The step ran in the worker container, which reaches the customer's container too.
    await expect.poll(() => statusOf(SHARED, acme, acmeForm, 'Asha Textiles'), { timeout: 30_000 }).toBe('REVIEW');
  });

  test("a customer's container is shut in: no way in from outside, no way out to anything of ours or anyone else's", async () => {
    const mine = extName(SHARED, acme);
    const theirs = extName(SHARED, bolt);
    const info = JSON.parse(docker('inspect', mine).stdout)[0];
    expect(info.HostConfig.ReadonlyRootfs).toBe(true);
    expect(info.HostConfig.CapDrop).toEqual(['ALL']);
    expect(info.HostConfig.SecurityOpt).toContain('no-new-privileges');
    expect(info.HostConfig.Memory).toBe(256 * 1024 * 1024);
    expect(info.HostConfig.PidsLimit).toBe(128);
    expect(Object.keys(info.NetworkSettings.Networks)).toEqual([mine]);
    // No port of it is published on the host.
    expect(docker('port', mine).stdout.trim()).toBe('');
    expect(docker('exec', mine, 'id', '-u').stdout.trim()).toBe('1000');
    expect(docker('exec', mine, 'touch', '/app/dist/x').status).not.toBe(0);
    expect(JSON.parse(docker('network', 'inspect', mine).stdout)[0].Internal).toBe(true);

    const reach = (target: string) => inside(mine, `require('net').connect({host:'${target.split(':')[0]}',port:${target.split(':')[1]},timeout:3000}).on('connect',()=>process.exit(0)).on('error',()=>process.exit(1)).on('timeout',()=>process.exit(1))`).status === 0;
    // It can be reached by the API...
    expect(inside(`${SHARED.project}-api-1`, `fetch('http://${mine}:8080/fb/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))`).status).toBe(0);
    // ...but it cannot reach the database, another customer's container, or the internet.
    expect(reach('mongo:27017')).toBe(false);
    expect(reach(`${SHARED.project}-mongo-1:27017`)).toBe(false);
    expect(reach(`${theirs}:8080`)).toBe(false);
    expect(reach('1.1.1.1:443')).toBe(false);
    // (The other customer's container is there and answering: the API reaches it. Only this one cannot.)
    expect(inside(`${SHARED.project}-api-1`, `fetch('http://${theirs}:8080/fb/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))`).status).toBe(0);

    // One customer's forms cannot name the other's code.
    const boltRef = (await call<{ ref: string }[]>(SHARED, 200, '/extensions', { token: bolt.token }))[0].ref;
    const made = await call<{ definition: { id: string } }>(SHARED, 201, '/forms', { method: 'POST', token: acme.token, body: { folderId: acme.folderId, definition: { ...loan(boltRef), code: 'STOLEN', submitChecks: [] } } });
    const refused = await call<{ errors: { message: string }[] }>(SHARED, 400, `/forms/${made.definition.id}/publish`, { method: 'POST', token: acme.token });
    expect(refused.errors[0].message).toContain("isn't available");
  });

  test('a new version is delivered with one command, and appears without anyone touching the builder', async () => {
    const before = JSON.parse(docker('inspect', extName(SHARED, acme)).stdout)[0].Image;
    const source = readFileSync(join(acmeRepo, 'src/index.ts'), 'utf8');
    writeFileSync(
      join(acmeRepo, 'src/index.ts'),
      source.replace("// ── A list for dropdowns", "ext.step({ key: 'second-opinion', label: 'Ask for a second opinion' }, async () => 'Second opinion requested');\n\n// ── A list for dropdowns"),
    );
    const out = must('ext', 'deploy', SHARED.project, acme.orgId, acmeRepo);
    expect(out).toContain('Updated');
    expect(out).toContain('Acme rules: 2 step(s), 1 list(s), 1 check(s)');
    expect((await offered(SHARED, acme)).steps.map((s) => s.key)).toEqual(['risk-score', 'second-opinion']);
    expect(JSON.parse(docker('inspect', extName(SHARED, acme)).stdout)[0].Image).not.toBe(before);
    // The same secret as before: forms already live keep working.
    expect((await submit(SHARED, acme, { customer: 'After update', amount: 10, gstin: '27AAPFU0939F1ZV' })).status).toBe(201);
  });

  test("the customer's code may call their own systems once we agree which, and nothing else", async () => {
    const mine = extName(SHARED, acme);
    // What their code does: an ordinary fetch, with nothing special in it.
    const get = (url: string) => {
      const r = inside(mine, `fetch(${JSON.stringify(url)}).then(async (r) => { console.log(r.status + ' ' + (await r.text()).slice(0, 60)); }, (e) => { console.log('failed ' + (e.cause?.code ?? e.message)); })`);
      return r.stdout.trim();
    };
    const server = (says: string) => `require('http').createServer((q,s)=>s.end('${says} '+q.url)).listen(8080)`;

    // Before anything is agreed there is no way out at all.
    expect(get('http://fbt-erp:8080/customers/7')).toMatch(/^failed/);

    expect(must('ext', 'allow', SHARED.project, acme.orgId, 'fbt-erp:8080=private', 'example.com')).toContain(`${mine} may call: fbt-erp:8080=private, example.com:443`);
    // The customer's ERP, and something else that happens to sit beside it, both where the proxy could reach them.
    for (const [name, says] of [['fbt-erp', 'ERP'], ['fbt-other', 'OTHER']]) {
      docker('rm', '-f', name);
      expect(docker('run', '-d', '--name', name, '--network', `${SHARED.project}-egress`, 'node:24-alpine', 'node', '-e', server(says)).status).toBe(0);
    }
    try {
      await expect.poll(() => get('http://fbt-erp:8080/customers/7'), { timeout: 30_000 }).toBe('200 ERP /customers/7');
      // Not agreed: refused by the proxy, in words.
      // Not agreed: refused by the proxy. Their code sees a failed call; why is in our record.
      expect(get('http://fbt-other:8080/x')).toMatch(/^failed/);
      expect(get('http://fbt-erp:9090/x')).toMatch(/^failed/);
      // A public address is agreed by name; anything else on the internet is not.
      const online = await fetch('https://example.com', { signal: AbortSignal.timeout(8000) }).then((r) => r.ok, () => false);
      if (online) expect(get('https://example.com/')).toMatch(/^200 /);
      expect(get('https://www.wikipedia.org/')).toMatch(/^failed/);
      // Going round the proxy is not possible: the container still has no route of its own.
      expect(inside(mine, `require('net').connect({host:'1.1.1.1',port:443,timeout:3000}).on('connect',()=>process.exit(0)).on('error',()=>process.exit(1)).on('timeout',()=>process.exit(1))`).status).not.toBe(0);
      // (Changing the list starts a fresh proxy, so keep what the first one recorded.)
      const earlier = docker('logs', `${mine}-egress`).stdout;
      // The proxy cannot be used to reach what is ours.
      must('ext', 'allow', SHARED.project, acme.orgId, 'fbt-erp:8080=private', `${SHARED.project}-mongo-1:27017=private`, `${SHARED.project}-api-1:4100=private`);
      expect(get(`http://${SHARED.project}-api-1:4100/health`)).toMatch(/^failed/);
      expect(get('http://fbt-erp:8080/after')).toBe('200 ERP /after');

      // Every attempt is on record, and the proxy is as locked down as the extension.
      const log = docker('logs', `${mine}-egress`).stdout;
      expect(earlier).toContain('"host":"fbt-other","port":8080,"verdict":"refused","why":"not on the list"');
      expect(log).toContain('"host":"fbt-erp","port":8080,"verdict":"allowed"');
      expect(log).toContain(`"host":"${SHARED.project}-api-1","port":4100,"verdict":"refused","why":"an address that is never allowed"`);
      expect(docker('logs', `${mine}-egress`).stdout).toMatch(/"verdict":"refused"/);
      const info = JSON.parse(docker('inspect', `${mine}-egress`).stdout)[0];
      expect(info.HostConfig.ReadonlyRootfs).toBe(true);
      expect(Object.keys(info.NetworkSettings.Networks).sort()).toEqual([mine, `${SHARED.project}-egress`].sort());
      // The form keeps working through all of this.
      expect((await submit(SHARED, acme, { customer: 'With a way out', amount: 10, gstin: '27AAPFU0939F1ZV' })).status).toBe(201);

      // Taking the agreement away closes the way out again.
      expect(must('ext', 'allow', SHARED.project, acme.orgId)).toContain('may call nothing outside');
      expect(docker('ps', '-a', '--filter', `name=${mine}-egress`, '--format', '{{.Names}}').stdout.trim()).toBe('');
      expect(get('http://fbt-erp:8080/customers/7')).toMatch(/^failed/);
      expect(stack('ext', 'allow', SHARED.project, acme.orgId, '*.acme.com').out).toContain('is not host, host:port or host:port=private');
    } finally {
      docker('rm', '-f', 'fbt-erp', 'fbt-other');
    }
  });

  test('a version that does not start, or does not build, never replaces the one that works', async () => {
    const good = readFileSync(join(acmeRepo, 'src/index.ts'), 'utf8');
    const running = JSON.parse(docker('inspect', extName(SHARED, acme)).stdout)[0].Image;

    writeFileSync(join(acmeRepo, 'src/index.ts'), `throw new Error('forgot the configuration');\nexport {};\n`);
    const crashed = stack('ext', 'deploy', SHARED.project, acme.orgId, acmeRepo);
    expect(crashed.ok).toBe(false);
    expect(crashed.out).toContain('The new version did not start; the previous one is running again.');
    expect(crashed.out).toContain('forgot the configuration');
    expect(JSON.parse(docker('inspect', extName(SHARED, acme)).stdout)[0].Image).toBe(running);

    writeFileSync(join(acmeRepo, 'src/index.ts'), `const broken: number = 'not a number';\n`);
    expect(stack('ext', 'deploy', SHARED.project, acme.orgId, acmeRepo).ok).toBe(false);
    expect(JSON.parse(docker('inspect', extName(SHARED, acme)).stdout)[0].Image).toBe(running);

    writeFileSync(join(acmeRepo, 'src/index.ts'), good);
    expect((await submit(SHARED, acme, { customer: 'Still fine', amount: 10, gstin: '27AAPFU0939F1ZV' })).status).toBe(201);
    expect((await offered(SHARED, acme)).status).toBe('OK');
  });

  test('if the customer\'s container stops, their forms refuse politely and others are unaffected; it comes back by itself', async () => {
    docker('stop', extName(SHARED, acme));
    const res = await submit(SHARED, acme, { customer: 'While down', amount: 10, gstin: '27AAPFU0939F1ZV' });
    expect(res.status).toBe(503);
    expect((await res.json()).message).toBe("We couldn't check your answers just now. Nothing was sent. Please try again in a moment.");
    expect((await offered(SHARED, acme)).status).toBe('UNREACHABLE');
    expect((await offered(SHARED, bolt)).status).toBe('OK');
    docker('start', extName(SHARED, acme));
    await expect.poll(async () => (await submit(SHARED, acme, { customer: 'Back', amount: 10, gstin: '27AAPFU0939F1ZV' })).status, { timeout: 30_000 }).toBe(201);
    expect((await offered(SHARED, acme)).status).toBe('OK');
  });

  test('restarting the installation puts every customer\'s code back in reach', async () => {
    docker('rm', '-f', `${SHARED.project}-api-1`, `${SHARED.project}-worker-1`);
    must('up', SHARED.project);
    await expect.poll(async () => (await fetch(`${SHARED.api}/health`).catch(() => null))?.status, { timeout: 60_000 }).toBe(200);
    expect((await submit(SHARED, acme, { customer: 'After restart', amount: 95000, gstin: '27AAPFU0939F1ZV' })).status).toBe(201);
    await expect.poll(() => statusOf(SHARED, acme, acmeForm, 'After restart'), { timeout: 30_000 }).toBe('REVIEW');
  });

  test('a plan that does not include extensions gets none, and nothing is left running', async () => {
    const small = await createOrg(SHARED, 'Small');
    must('op', SHARED.project, 'set-plan', small.orgId, 'TEAM');
    // The API notices a changed plan within a minute.
    await expect
      .poll(
        () => {
          const r = stack('ext', 'deploy', SHARED.project, small.orgId, boltRepo);
          return r.ok ? 'installed' : r.out;
        },
        { timeout: 120_000, intervals: [15_000] },
      )
      .toContain("The Team plan doesn't include extensions");
    const name = extName(SHARED, small);
    expect(docker('ps', '-a', '--filter', `name=${name}`, '--format', '{{.Names}}').stdout.trim()).toBe('');
    expect(docker('network', 'ls', '--filter', `name=${name}`, '--format', '{{.Name}}').stdout.trim()).toBe('');
    expect(await call<unknown[]>(SHARED, 200, '/extensions', { token: small.token })).toEqual([]);
  });

  test('removing a customer\'s extension takes away its container, its network and what it offered', async () => {
    const name = extName(SHARED, bolt);
    must('ext', 'remove', SHARED.project, bolt.orgId);
    expect(docker('ps', '-a', '--filter', `name=${name}`, '--format', '{{.Names}}').stdout.trim()).toBe('');
    expect(docker('network', 'ls', '--filter', `name=${name}`, '--format', '{{.Name}}').stdout.trim()).toBe('');
    expect(await call<unknown[]>(SHARED, 200, '/extensions', { token: bolt.token })).toEqual([]);
    expect((await offered(SHARED, acme)).status).toBe('OK');
  });
});

test.describe('Dedicated hosting: an installation of the customer\'s own', () => {
  let own: Org;

  test('it is a second, separate installation: own database, own keys, own addresses', async () => {
    test.setTimeout(20 * 60_000);
    must('up', DEDICATED.project, ...DEDICATED.ports, '--env', 'test');
    expect((await fetch(`${DEDICATED.api}/health`)).status).toBe(200);
    // Nobody from the shared installation exists here, and a session from there means nothing here.
    await call(DEDICATED, 401, '/auth/login', { method: 'POST', body: { email: acme.email, password: PASSWORD } });
    await call(DEDICATED, 401, '/auth/me', { token: acme.token });
    const volumes = docker('volume', 'ls', '--format', '{{.Name}}').stdout;
    expect(volumes).toContain(`${DEDICATED.project}_mongo`);
    expect(volumes).toContain(`${SHARED.project}_mongo`);
    const key = (project: string) => /FB_SECRET_KEY=(.+)/.exec(readFileSync(join(ROOT, 'infra/.state', project, 'stack.env'), 'utf8'))![1];
    expect(key(DEDICATED.project)).not.toBe(key(SHARED.project));
    // The builder there talks to its own API.
    const html = await (await fetch(`${DEDICATED.studio}/`)).text();
    const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)![1];
    const bundle = await (await fetch(`${DEDICATED.studio}${script}`)).text();
    expect(bundle).toContain('localhost:4320');
    expect(bundle).not.toContain('localhost:4310');
  });

  test('the same repository is delivered into it with the same command, and works the same', async ({ page }) => {
    test.setTimeout(10 * 60_000);
    own = await createOrg(DEDICATED, 'Acme');
    expect(must('ext', 'deploy', DEDICATED.project, own.orgId, acmeRepo)).toContain('Acme rules: 2 step(s), 1 list(s), 1 check(s)');
    const formId = await publishLoan(DEDICATED, own);
    await page.goto(`${DEDICATED.runtime}/f/${own.orgId}/LOAN_REQUEST`);
    await page.getByLabel(/^Customer/).fill('Own installation');
    await page.getByLabel(/^Amount/).fill('80000');
    await page.getByLabel(/^GST number/).fill('27AAPFU0939F1ZV');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText(/LN-000001/)).toBeVisible();
    await expect.poll(() => statusOf(DEDICATED, own, formId, 'Own installation'), { timeout: 30_000 }).toBe('REVIEW');
    // Its container is on this installation's network only.
    const info = JSON.parse(docker('inspect', extName(DEDICATED, own)).stdout)[0];
    expect(Object.keys(info.NetworkSettings.Networks)).toEqual([extName(DEDICATED, own)]);
  });

  test('taking the dedicated installation away removes all of it and leaves the shared one working', async () => {
    must('down', DEDICATED.project, '--volumes');
    expect(docker('ps', '-a', '--filter', `name=${DEDICATED.project}-`, '--format', '{{.Names}}').stdout.trim()).toBe('');
    expect(docker('volume', 'ls', '--filter', `name=${DEDICATED.project}_`, '--format', '{{.Name}}').stdout.trim()).toBe('');
    expect(existsSync(join(ROOT, 'infra/.state', DEDICATED.project))).toBe(false);
    expect((await submit(SHARED, acme, { customer: 'Shared still up', amount: 10, gstin: '27AAPFU0939F1ZV' })).status).toBe(201);
  });
});
