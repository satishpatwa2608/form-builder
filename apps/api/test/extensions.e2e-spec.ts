import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createExtension, type CheckContext, type CheckResult, type StepContext } from '@fb/sdk';
import { ExtensionsService } from '../src/extensions/extensions.service';
import { PlansService } from '../src/plans/plans.service';
import { startApp, type Harness } from './harness';

/** An organisation's own code, written with the SDK and run as its own service, as it will be in its container. */
function acme(secret: string, orgId: string, seen: { steps: StepContext[]; checks: CheckContext[]; lists: unknown[] }) {
  return createExtension({ name: 'Acme rules', secret, orgId })
    .step({ key: 'credit-check', label: 'Check credit', description: 'Asks the credit bureau', outputs: ['score', 'verdict'] }, (ctx) => {
      seen.steps.push(ctx);
      if (ctx.values.customer === 'Bureau down') throw new Error('The credit bureau is closed');
      const score = ctx.values.customer === 'Ravi' ? 710 : 320;
      return { summary: `Credit score ${score}`, data: { score, verdict: score > 500 ? 'GOOD' : 'POOR' } };
    })
    .list({ key: 'branches', label: 'Branches', params: ['city'] }, ({ params }) => {
      seen.lists.push(params);
      const all = [
        { value: 'PUN1', label: 'Pune Camp', city: 'Pune' },
        { value: 'PUN2', label: 'Pune Kothrud', city: 'Pune' },
        { value: 'MUM1', label: 'Mumbai Fort', city: 'Mumbai' },
      ];
      return params.city ? all.filter((b) => b.city === params.city) : all;
    })
    .check({ key: 'one-claim-per-invoice', label: 'One claim per invoice' }, (ctx): CheckResult => {
      seen.checks.push(ctx);
      if (ctx.values.invoice === 'INV-1') return { errors: { invoice: 'This invoice has already been claimed' } };
      if (ctx.values.invoice === 'INV-ODD') return { errors: { noSuchField: 'Ask finance first.' } };
      if (ctx.values.invoice === 'INV-CLOSED') return { message: 'Claims for last year are closed' };
      return undefined;
    });
}

const form = (code: string, ref: string, extra: object = {}) => ({
  name: code,
  code,
  businessId: '',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [
    { id: 'a', type: 'TEXT', name: 'customer', label: 'Customer', required: true },
    { id: 'b', type: 'TEXT', name: 'invoice', label: 'Invoice' },
    { id: 'c', type: 'DROPDOWN', name: 'city', label: 'City', dataSource: { type: 'STATIC', options: [{ label: 'Pune', value: 'Pune' }, { label: 'Mumbai', value: 'Mumbai' }] } },
    { id: 'd', type: 'DROPDOWN', name: 'branch', label: 'Branch', dataSource: { type: 'API', api: { url: `/extensions/${ref}/branches`, method: 'POST', valueField: 'value', labelField: 'label', params: { city: '{{city}}' } } } },
  ],
  workflow: {
    enabled: true,
    statuses: [
      { key: 'NEW', label: 'New', category: 'OPEN' },
      { key: 'DECLINED', label: 'Declined', category: 'DONE' },
      { key: 'CLOSED', label: 'Closed', category: 'DONE' },
    ],
    assignment: { type: 'NONE' },
  },
  automations: [
    {
      id: 'a1',
      name: 'Credit',
      enabled: true,
      when: 'SUBMITTED',
      actions: [
        { id: 'credit', type: 'HANDLER', key: `x-${ref}-credit-check` },
        { id: 'decline', type: 'SET_STATUS', status: 'DECLINED', if: { field: '$steps.credit.verdict', operator: 'equals', value: 'POOR' } },
      ],
    },
  ],
  ...extra,
});

describe('Extensions: an organisation\'s own code, beside the product (e2e)', () => {
  let h: Harness;
  let extensions: ExtensionsService;
  let owner: string;
  let designer: string;
  let orgId: string;
  let folder: string;
  let server: Server;
  let url: string;
  let ref: string;
  let id: string;
  let secret: string;
  const seen = { steps: [] as StepContext[], checks: [] as CheckContext[], lists: [] as unknown[] };

  const serve = async (ext: ReturnType<typeof createExtension>, port = 0) => {
    const s = await ext.listen(port, '127.0.0.1');
    return { server: s, port: (s.address() as AddressInfo).port };
  };
  const stop = (s: Server) => new Promise<void>((done) => s.close(() => done()));

  beforeAll(async () => {
    h = await startApp({ JOBS_POLL: 'true' });
    extensions = h.app.get(ExtensionsService);
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Finance' }).expect(201)).body[0].id;
    await h.addMember(owner, 'Dev', 'dev@acme.test', 'DESIGNER');
    designer = (await h.login('dev@acme.test')).token;
  });
  afterAll(async () => {
    if (server) await stop(server);
    await h?.close();
  });

  const publish = async (definition: object) => {
    const made = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition }).expect(201)).body.definition.id as string;
    return { id: made, res: await h.api().post(`/forms/${made}/publish`).set(h.bearer(owner)) };
  };
  const submit = (code: string, values: object) => h.api().post(`/public/forms/${code}/submissions?org=${orgId}`).send({ values });
  const record = async (recordId: string) => (await h.api().get(`/records/${recordId}`).set(h.bearer(owner)).expect(200)).body;
  const settle = async (recordId: string, done: (r: { record: { status: string }; events: { message: string }[] }) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const r = await record(recordId);
      if (done(r)) return r;
      await new Promise((ok) => setTimeout(ok, 50));
    }
    throw new Error(`record ${recordId} did not settle: ${JSON.stringify((await record(recordId)).events)}`);
  };

  it('an operator installs it and gets the secret once; the address must be a bare origin', async () => {
    await expect(extensions.install(orgId, 'http://user:pw@10.0.0.5:8080', 'op')).rejects.toThrow(/http\(s\):\/\/host:port/);
    await expect(extensions.install(orgId, 'http://10.0.0.5:8080/admin', 'op')).rejects.toThrow(/nothing after it/);
    await expect(extensions.install(orgId, 'file:///etc/passwd', 'op')).rejects.toThrow();

    // The container gets its address first, its secret from the installation, and is then started.
    const placeholder = await serve(createExtension({ name: 'x', secret: 'x' }));
    await stop(placeholder.server);
    url = `http://127.0.0.1:${placeholder.port}`;
    const made = await extensions.install(orgId, url, 'op');
    ({ ref, id, secret } = made);
    expect(ref).toMatch(/^[a-z0-9]{8}$/);
    expect(secret.length).toBeGreaterThan(30);

    // Until it has answered it offers nothing, and nothing about it shows the secret or the address.
    const before = (await h.api().get('/extensions').set(h.bearer(owner)).expect(200)).body;
    expect(before).toEqual([expect.objectContaining({ ref, status: 'NEW', steps: [], lists: [], checks: [] })]);
    expect(JSON.stringify(before)).not.toContain(secret);
    expect(JSON.stringify(before)).not.toContain('127.0.0.1');
    const refused = await h.api().post(`/extensions/${id}/refresh`).set(h.bearer(owner)).expect(400);
    expect(refused.body.message).toBe('The extension could not be reached');
    expect((await h.api().get('/extensions').set(h.bearer(owner))).body[0]).toMatchObject({ status: 'UNREACHABLE', lastError: 'The extension could not be reached' });

    server = (await serve(acme(secret, orgId, seen), placeholder.port)).server;
  });

  it('an admin reads what it offers; only admins manage it, and designers see what they can pick', async () => {
    await h.api().get('/extensions').set(h.bearer(designer)).expect(403);
    await h.api().post(`/extensions/${id}/refresh`).set(h.bearer(designer)).expect(403);
    const view = (await h.api().post(`/extensions/${id}/refresh`).set(h.bearer(owner)).expect(201)).body;
    expect(view).toMatchObject({
      name: 'Acme rules',
      status: 'OK',
      lastError: '',
      steps: [{ key: 'credit-check', label: 'Check credit', description: 'Asks the credit bureau', outputs: ['score', 'verdict'] }],
      lists: [{ key: 'branches', label: 'Branches', params: ['city'] }],
      checks: [{ key: 'one-claim-per-invoice', label: 'One claim per invoice' }],
    });

    // It appears in the same pickers as what is built in.
    const steps = (await h.api().get('/custom-workflows').set(h.bearer(designer)).expect(200)).body;
    expect(steps).toContainEqual({ key: `x-${ref}-credit-check`, label: 'Acme rules: Check credit', description: 'Asks the credit bureau', outputs: ['score', 'verdict'] });
    expect((await h.api().get('/extensions/sources').set(h.bearer(designer)).expect(200)).body).toEqual([
      { key: `/extensions/${ref}/branches`, name: 'Acme rules · Branches', params: ['city'], valueField: 'value', labelField: 'label' },
    ]);
    expect((await h.api().get('/extensions/checks').set(h.bearer(designer)).expect(200)).body).toEqual([{ key: `x-${ref}-one-claim-per-invoice`, label: 'Acme rules: One claim per invoice' }]);
  });

  it('a workflow step runs the organisation\'s code; what it returns steers the steps after it', async () => {
    expect((await publish(form('LOAN', ref))).res.status).toBe(200);
    const good = (await submit('LOAN', { customer: 'Ravi' }).expect(201)).body;
    const poor = (await submit('LOAN', { customer: 'Meera' }).expect(201)).body;
    const a = await settle(good.submissionId, (r) => r.events.some((e) => e.message.includes('Credit score 710')));
    expect(a.record.status).toBe('NEW');
    const b = await settle(poor.submissionId, (r) => r.record.status === 'DECLINED');
    expect(b.events.some((e: { message: string }) => e.message.includes('Credit score 320'))).toBe(true);

    // What the code was given: the record and the answers, and which organisation it is for.
    const ctx = seen.steps.find((s) => s.values.customer === 'Ravi')!;
    expect(ctx).toMatchObject({ orgId, trigger: 'SUBMITTED', stepKey: 'credit', form: { code: 'LOAN', version: 1 }, record: { id: good.submissionId, ref: good.ref, status: 'NEW' }, values: { customer: 'Ravi' } });
  });

  it('a step that fails says why, in the code\'s own words, on the record', async () => {
    const res = (await submit('LOAN', { customer: 'Bureau down' }).expect(201)).body;
    const r = await settle(res.submissionId, (x) => x.events.some((e) => e.message.includes('The credit bureau is closed')));
    expect(r.record.status).toBe('NEW');
  });

  it('a dropdown takes its options from the code, filtered by another answer, and the server checks the choice', async () => {
    const query = (params: object) => h.api().post(`/public/data-sources/query?org=${orgId}`).send({ formCode: 'LOAN', key: `/extensions/${ref}/branches`, params });
    const rows = (res: { body: { data?: unknown[] } | unknown[] }) => ((res.body as { data?: unknown[] }).data ?? res.body) as { value: string }[];
    expect(rows(await query({ city: 'Pune' }).expect(200)).map((r) => r.value)).toEqual(['PUN1', 'PUN2']);
    expect(rows(await query({}).expect(200))).toHaveLength(3);
    // A parameter the form does not bind is not accepted from the public, and one the list never declared never reaches the code.
    await query({ city: 'Pune', admin: 'true' }).expect(404);
    expect(seen.lists).toEqual([{ city: 'Pune' }, {}]);

    await submit('LOAN', { customer: 'Ravi', city: 'Pune', branch: 'PUN2' }).expect(201);
    const wrong = await submit('LOAN', { customer: 'Ravi', city: 'Pune', branch: 'MUM1' }).expect(422);
    expect(wrong.body.errors).toEqual([{ field: 'branch', message: 'Select a valid option' }]);
  });

  it('a check runs before a submission is accepted: it can refuse a field, or the whole form', async () => {
    expect((await publish(form('CLAIM', ref, { submitChecks: [`x-${ref}-one-claim-per-invoice`], automations: [] }))).res.status).toBe(200);
    const before = seen.checks.length;
    const field = await submit('CLAIM', { customer: 'Ravi', invoice: 'INV-1' }).expect(422);
    expect(field.body.errors).toEqual([{ field: 'invoice', message: 'This invoice has already been claimed' }]);
    const whole = await submit('CLAIM', { customer: 'Ravi', invoice: 'INV-CLOSED' }).expect(422);
    expect(whole.body).toMatchObject({ message: 'Claims for last year are closed', errors: [] });
    // A message for a field the form does not have is still said, for the whole form.
    expect((await submit('CLAIM', { customer: 'Ravi', invoice: 'INV-ODD' }).expect(422)).body).toMatchObject({ message: 'Ask finance first.', errors: [] });
    await submit('CLAIM', { customer: 'Ravi', invoice: 'INV-2' }).expect(201);
    expect(seen.checks.slice(before).map((c) => c.values.invoice)).toEqual(['INV-1', 'INV-CLOSED', 'INV-ODD', 'INV-2']);
    expect(seen.checks[before]).toMatchObject({ orgId, form: { code: 'CLAIM', version: 1, name: 'CLAIM' } });

    // The form's own rules come first: the code is not asked about a submission that is already wrong.
    await submit('CLAIM', { invoice: 'INV-1' }).expect(422);
    expect(seen.checks).toHaveLength(before + 4);
    const stored = (await h.api().get('/forms').set(h.bearer(owner)).expect(200)).body.find((f: { code: string }) => f.code === 'CLAIM');
    const list = (await h.api().get(`/forms/${stored.id}/submissions`).set(h.bearer(owner)).expect(200)).body;
    expect((list.rows ?? list.data?.rows).map((s: { payload: { invoice: string } }) => s.payload.invoice)).toEqual(['INV-2']);
  });

  it('a form cannot be published with a step or a check the extension does not offer', async () => {
    const step = (await publish({ ...form('BAD_STEP', ref), automations: [{ id: 'a1', name: 'X', enabled: true, when: 'SUBMITTED', actions: [{ id: 's', type: 'HANDLER', key: `x-${ref}-no-such-step`, label: 'Risk score' }] }] })).res;
    expect(step.status).toBe(400);
    expect(step.body.errors[0].message).toBe('Custom API step "Risk score" isn\'t available: your extension was removed, or no longer offers it');
    const check = (await publish(form('BAD_CHECK', ref, { submitChecks: [`x-${ref}-no-such-check`], automations: [] }))).res;
    expect(check.status).toBe(400);
    expect(check.body.errors[0].message).toContain('no longer offered by your extension');
    // The key has one shape; anything else is refused when the draft is saved.
    await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: form('BAD_SHAPE', ref, { submitChecks: ['http://evil.test/x'] }) }).expect(400);
  });

  it('another organisation cannot see it, use it or reach it through its own forms', async () => {
    await h.signUp('Zed', 'zed@other.test', 'Other');
    const stranger = (await h.login('zed@other.test')).token;
    const otherOrg = (await h.api().get('/auth/me').set(h.bearer(stranger))).body.org.id;
    expect((await h.api().get('/extensions').set(h.bearer(stranger)).expect(200)).body).toEqual([]);
    expect((await h.api().get('/extensions/sources').set(h.bearer(stranger)).expect(200)).body).toEqual([]);
    expect((await h.api().get('/extensions/checks').set(h.bearer(stranger)).expect(200)).body).toEqual([]);
    await h.api().post(`/extensions/${id}/refresh`).set(h.bearer(stranger)).expect(404);

    const theirFolder = (await h.api().post('/folders').set(h.bearer(stranger)).send({ name: 'F' }).expect(201)).body[0].id;
    const made = (await h.api().post('/forms').set(h.bearer(stranger)).send({ folderId: theirFolder, definition: form('LOAN', ref) }).expect(201)).body.definition.id;
    const refused = await h.api().post(`/forms/${made}/publish`).set(h.bearer(stranger)).expect(400);
    expect(refused.body.errors[0].message).toContain("isn't available");
    await expect(extensions.readList(otherOrg, `/extensions/${ref}/branches`, {})).rejects.toThrow(/No data source/);
    await expect(extensions.runStep(otherOrg, `x-${ref}-credit-check`, {})).rejects.toThrow(/not available any more/);
  });

  it('when the extension is down, nothing is let through unchecked and nobody is shown why', async () => {
    await stop(server);
    const before = seen.checks.length;
    const res = await submit('CLAIM', { customer: 'Ravi', invoice: 'INV-9' }).expect(503);
    expect(res.body.message).toBe("We couldn't check your answers just now. Nothing was sent. Please try again in a moment.");
    expect(seen.checks).toHaveLength(before);
    const options = await h.api().post(`/public/data-sources/query?org=${orgId}`).send({ formCode: 'LOAN', key: `/extensions/${ref}/branches`, params: {} }).expect(503);
    expect(options.body.message).toBe('These options are not available right now');
    expect(JSON.stringify(options.body)).not.toContain('127.0.0.1');
    // The admins are told, and what it offered before is kept for when it comes back.
    expect((await h.api().get('/extensions').set(h.bearer(owner))).body[0]).toMatchObject({ status: 'UNREACHABLE', lastError: 'The extension could not be reached', steps: [expect.objectContaining({ key: 'credit-check' })] });
    server = (await serve(acme(secret, orgId, seen), Number(new URL(url).port))).server;
    await submit('CLAIM', { customer: 'Ravi', invoice: 'INV-9' }).expect(201);
    expect((await h.api().get('/extensions').set(h.bearer(owner))).body[0]).toMatchObject({ status: 'OK', lastError: '' });
  });

  it('something else answering at that address without the secret is not believed', async () => {
    await stop(server);
    const port = Number(new URL(url).port);
    const impostor = (await serve(acme('not-the-secret', orgId, seen), port)).server;
    const refused = await h.api().post(`/extensions/${id}/refresh`).set(h.bearer(owner)).expect(400);
    expect(refused.body.message).toBe('The extension refused our signature: its secret does not match the one issued');
    await submit('CLAIM', { customer: 'Ravi', invoice: 'INV-10' }).expect(503);
    await stop(impostor);

    // A reply that is not a well-formed manifest changes nothing a designer could pick.
    const odd = (await serve(createExtension({ name: 'Odd', secret }).step({ key: 'ok', label: 'OK' }, () => {}), port)).server;
    const proto = Object.getPrototypeOf(createExtension({ name: 'p', secret }));
    const original = proto.manifest;
    proto.manifest = () => ({ contract: 99, name: 'Odd', steps: [], lists: [], checks: [] });
    try {
      const old = await h.api().post(`/extensions/${id}/refresh`).set(h.bearer(owner)).expect(400);
      expect(old.body.message).toBe('It speaks contract 99; this server supports 1. Update the SDK.');
      proto.manifest = () => ({ contract: 1, name: 'Odd', steps: [{ key: 'Bad Key', label: 'x' }], lists: [], checks: [] });
      expect((await h.api().post(`/extensions/${id}/refresh`).set(h.bearer(owner)).expect(400)).body.message).toContain('keys are lower-case letters');
    } finally {
      proto.manifest = original;
    }
    expect((await h.api().get('/extensions').set(h.bearer(owner))).body[0].steps).toEqual([expect.objectContaining({ key: 'credit-check' })]);
    await stop(odd);
    server = (await serve(acme(secret, orgId, seen), port)).server;
  });

  it('running a customer\'s code is something a plan includes or does not', async () => {
    const plans = h.app.get(PlansService);
    await plans.setPlan(orgId, 'TEAM');
    await expect(extensions.install(orgId, 'http://10.0.0.9:8080', 'op')).rejects.toThrow("The Team plan doesn't include extensions (your own code). Upgrade to add them.");
    await plans.setPlan(orgId, 'BUSINESS');
    await expect(extensions.install(orgId, 'http://10.0.0.9:8080', 'op')).rejects.toThrow('The Business plan allows 1 extensions (your own code). Upgrade or remove one first.');
    // What is already installed keeps working on a smaller plan; only adding is refused.
    await submit('CLAIM', { customer: 'Ravi', invoice: 'INV-20' }).expect(201);
    const usage = (await h.api().get('/org/usage').set(h.bearer(owner))).body;
    expect(usage.usage?.extensions ?? usage.extensions).toBe(1);
    await plans.setPlan(orgId, 'ENTERPRISE');
  });

  it('once removed, its steps stop being offered and forms that name them cannot be published', async () => {
    await extensions.uninstall(orgId, ref, 'op');
    expect((await h.api().get('/extensions').set(h.bearer(owner)).expect(200)).body).toEqual([]);
    expect((await h.api().get('/extensions/sources').set(h.bearer(owner))).body).toEqual([]);
    expect((await publish(form('LATER', ref))).res.status).toBe(400);
    await submit('CLAIM', { customer: 'Ravi', invoice: 'INV-11' }).expect(503);
    const audit = (await h.api().get('/audit').set(h.bearer(owner)).expect(200)).body;
    const actions = (audit.entries ?? audit.rows ?? audit).map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['extension.installed', 'extension.refreshed', 'extension.removed']));
  });
});
