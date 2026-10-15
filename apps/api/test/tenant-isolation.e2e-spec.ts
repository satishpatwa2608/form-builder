import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { OpenWithService } from '../src/work/services/open-with.service';
import { startApp, type Harness } from './harness';

/**
 * Organisation B, signed in as its owner, asks every route the API has for organisation A's things, by A's own
 * identifiers. Nothing of A's may come back, and nothing of A's may change.
 *
 * The routes are read from the running application, so a route added later is walked too without anyone listing
 * it here. Each kind of id in a route (`:id` on forms, on records, on connectors, ...) is given A's id of that kind.
 */
const MARK = 'AlphaSecret';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

describe('Tenant isolation: one organisation cannot reach another (e2e)', () => {
  let h: Harness;
  let dir: string;
  let a: string;
  let b: string;
  let orgA: string;
  let orgB: string;
  const ids: Record<string, string> = {};
  let formDef: Record<string, unknown>;
  /** Everything of A's that must never appear in an answer to B. */
  const secrets: string[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fb-tenants-'));
    process.env.FORM_WEBHOOK_ALLOWLIST = 'hooks.example.com';
    h = await startApp({ LOCAL_STORAGE_DIR: dir });
    await h.signUp('Alpha Owner', 'alpha@alpha.test', `Alpha ${MARK} Ltd`);
    await h.signUp('Beta Owner', 'beta@beta.test', 'Beta Ltd');
    a = (await h.login('alpha@alpha.test')).token;
    b = (await h.login('beta@beta.test')).token;
    orgA = (await h.api().get('/auth/me').set(h.bearer(a))).body.org.id;
    orgB = (await h.api().get('/auth/me').set(h.bearer(b))).body.org.id;
    const as = (method: 'post' | 'put', path: string, body: object, status = 201) =>
      h.api()[method](path).set(h.bearer(a)).send(body).expect((res) => {
        if (res.status !== status && !(status === 201 && res.status === 200)) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
      });

    /** The new thing's id, whether the answer is the thing, a list of things, or a wrapper with one inside. */
    const idOf = (body: unknown, text: string): string => {
      const all: { id: string }[] = [];
      const walk = (v: unknown) => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') {
          const o = v as { id?: unknown; uuid?: unknown };
          const id = typeof o.id === 'string' ? o.id : typeof o.uuid === 'string' ? o.uuid : undefined;
          if (id) all.push({ ...(v as object), id });
          Object.values(v).forEach(walk);
        }
      };
      walk(body);
      return all.find((x) => JSON.stringify(x).includes(text))?.id ?? '';
    };

    // A member of A's, and an invitation still open.
    ids.member = await h.addMember(a, 'Alpha Worker', 'worker@alpha.test', 'RECORDS_WORKER');
    ids.invitation = ((await as('post', '/invitations', { email: 'later@alpha.test', role: 'VIEWER' })).body as { id: string; email: string }[]).find((i) => i.email === 'later@alpha.test')?.id ?? '';
    ids.folder = (await as('post', '/folders', { name: `Folder ${MARK}` })).body[0].id;
    ids.grant = (await as('post', '/grants', { userId: ids.member, role: 'DESIGNER', scope: { type: 'folder', id: ids.folder } })).body[0]?.id ?? '';

    // A published form with a workflow, an approval on every response, a file question and a comment.
    const definition = {
      name: `Form ${MARK}`,
      code: 'ALPHA_FORM',
      businessId: '',
      access: 'PUBLIC',
      submission: { method: 'POST', endpointId: 'default-submit' },
      fields: [
        { id: 'n', type: 'TEXT', name: 'customer', label: 'Customer' },
        { id: 'p', type: 'FILE', name: 'photo', label: 'Photo' },
      ],
      workflow: {
        enabled: true,
        refPrefix: 'ALP',
        statuses: [{ key: 'NEW', label: 'New', category: 'OPEN' }, { key: 'DONE', label: 'Done', category: 'DONE' }],
        assignment: { type: 'NONE' },
        actions: [{ key: 'finish', label: 'Finish', from: ['NEW'], to: 'DONE' }],
      },
      document: { keep: true },
      automations: [{ id: 'ask', name: 'Ask', enabled: true, when: 'SUBMITTED', actions: [{ id: 'ok', type: 'APPROVAL', to: [{ kind: 'USER', userId: (await h.api().get('/auth/me').set(h.bearer(a))).body.user.id }], title: `Approve ${MARK}` }] }],
    };
    formDef = definition;
    ids.form = (await as('post', '/forms', { folderId: ids.folder, definition })).body.definition.id;
    ids.comment = idOf((await as('post', `/forms/${ids.form}/comments`, { text: `Comment ${MARK}` })).body, `Comment ${MARK}`);
    await as('post', `/forms/${ids.form}/publish`, {}, 200);
    const ticket = (await h.api().post(`/public/forms/ALPHA_FORM/uploads?org=${orgA}`).send({ fieldName: 'photo', fileName: 'leak.png', contentType: 'image/png', size: PNG.length }).expect(201)).body;
    await h.api().put(h.localUrl(ticket.url).replace(h.base, '')).set('Content-Type', 'image/png').send(PNG).expect(200);
    await h.api().post(`/public/uploads/${ticket.uploadId}/verify?org=${orgA}`).expect(200);
    ids.upload = ticket.uploadId;
    const sent = (await h.api().post(`/public/forms/ALPHA_FORM/submissions?org=${orgA}`).send({ values: { customer: `Customer ${MARK}`, photo: [{ uploadId: ticket.uploadId }] } }).expect(201)).body;
    ids.record = sent.submissionId;
    secrets.push(sent.ref);
    for (let i = 0; i < 100 && !ids.run; i++) {
      ids.run = ((await h.api().get(`/records/${ids.record}`).set(h.bearer(a))).body.approvals ?? []).find((x: { status: string }) => x.status === 'WAITING')?.runId;
      if (!ids.run) await new Promise((r) => setTimeout(r, 30));
    }

    // One of every other kind of thing an organisation keeps.
    ids.list = (await as('post', '/lists', { name: `List ${MARK}`, items: [{ label: 'Pune' }] })).body.id;
    ids.fragment = (await as('post', '/fragments', { name: `Fragment ${MARK}`, fields: [{ id: 'f', type: 'TEXT', name: 'x', label: 'X' }] })).body.id;
    ids.emailTemplate = (await as('post', '/email-templates', { name: `Mail ${MARK}`, subject: 'Hello', body: 'Hello' })).body.id;
    ids.workflow = (await as('post', '/workflows', { name: `Workflow ${MARK}`, workflow: definition.workflow, fields: [] })).body.id;
    ids.view = idOf((await as('put', '/work-views/new', { name: `View ${MARK}`, filters: {} }, 200)).body, `View ${MARK}`);
    ids.webhook = idOf((await as('put', '/webhooks/new', { name: `Hook ${MARK}`, url: 'https://hooks.example.com/alpha', events: ['submitted'] }, 200)).body, 'hooks.example.com/alpha');
    ids.connector = (await as('post', '/connectors', { type: 'rest', name: `Connector ${MARK}`, settings: { baseUrl: 'https://api.example.com', auth: 'none', resources: '[]' }, secrets: {} })).body.id;
    ids.gateway = (await as('post', '/gateways', { name: `Gateway ${MARK}` })).body.id;
    await as('put', '/styles/alpha', { name: `Style ${MARK}`, props: {} }, 200);
    const pdf = await PDFDocument.create();
    pdf.getForm().createTextField('Customer').addToPage(pdf.addPage([300, 200]), { x: 20, y: 120, width: 200, height: 20 });
    ids.pdf = (await h.api().post(`/pdf-templates?name=${MARK}.pdf`).set(h.bearer(a)).set('Content-Type', 'application/pdf').send(Buffer.from(await pdf.save())).expect(201)).body.id;

    for (const [kind, id] of Object.entries(ids)) if (!id) throw new Error(`could not make A's ${kind}`);
    secrets.push(MARK, ...Object.values(ids));
  }, 120_000);
  afterAll(async () => {
    delete process.env.FORM_WEBHOOK_ALLOWLIST;
    await h?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A's id for a route's parameter, by what the route is about. */
  const idFor = (route: string, param: string): string | undefined => {
    const about = route.split('/')[1];
    if (param === 'userId') return ids.member;
    if (param === 'submissionId') return ids.record;
    if (param === 'uploadId') return ids.upload;
    if (param === 'commentId') return ids.comment;
    if (param === 'runId') return ids.run;
    if (param === 'requestId') return ids.record;
    if (param === 'key') return route.startsWith('/styles') ? 'alpha' : 'finish';
    if (param === 'number') return '1';
    if (param !== 'id') return undefined;
    return {
      forms: ids.form,
      records: ids.record,
      connectors: ids.connector,
      folders: ids.folder,
      workflows: ids.workflow,
      'work-views': ids.view,
      webhooks: ids.webhook,
      lists: ids.list,
      fragments: ids.fragment,
      'email-templates': ids.emailTemplate,
      'pdf-templates': ids.pdf,
      invitations: ids.invitation,
      grants: ids.grant,
      gateways: ids.gateway,
      documents: ids.form,
      extensions: ids.form,
      notifications: ids.record,
    }[about!];
  };

  it("walks every route as organisation B with A's identifiers: nothing of A's comes back, and nothing of A's changes", async () => {
    const router = (h.app.getHttpAdapter().getInstance() as { _router: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] } })._router;
    const routes = router.stack.filter((l) => l.route).map((l) => ({ method: Object.keys(l.route!.methods)[0]!, path: l.route!.path }));
    expect(routes.length).toBeGreaterThan(150);
    // What A sees on every page that lists A's things, before B tries anything.
    const lists = routes.filter((r) => r.method === 'get' && !r.path.includes(':') && !/^\/(auth|operator|public|health|sso|notifications|audit|usage)\b/.test(r.path));
    const seen = async () => {
      const out: Record<string, string> = {};
      for (const r of lists) {
        const res = await h.api().get(r.path).set(h.bearer(a));
        if (res.status === 200) out[r.path] = JSON.stringify(res.body).replace(/"(updatedAt|lastSeenAt|lastUsedAt|now|generatedAt)":"[^"]*"/g, '');
      }
      return out;
    };
    const before = await seen();
    expect(Object.keys(before).length).toBeGreaterThan(20);
    const walked: string[] = [];
    const leaks: string[] = [];
    for (const { method, path } of routes) {
      // Signing in, the operator's own commands, and the public pages (walked separately below) are not about an organisation's things.
      if (/^\/(auth|operator|public|health|sso)\b/.test(path) || path.startsWith('/connectors/oauth')) continue;
      const params = [...path.matchAll(/:(\w+)/g)].map((m) => m[1]!);
      let url = path;
      let usable = true;
      for (const p of params) {
        const id = idFor(path, p);
        if (!id) usable = false;
        else url = url.replace(`:${p}`, encodeURIComponent(id));
      }
      if (!usable) continue;
      const res = await h.api()[method as 'get'](url).set(h.bearer(b)).send({});
      walked.push(`${method.toUpperCase()} ${path} -> ${res.status}`);
      const said = `${JSON.stringify(res.body ?? '')}${res.text ?? ''}${res.headers['content-disposition'] ?? ''}`;
      const found = secrets.filter((s) => s && said.includes(s));
      if (found.length) leaks.push(`${method.toUpperCase()} ${path} (${res.status}) shows ${found.join(', ')}`);
    }
    expect(leaks).toEqual([]);
    // Most routes that take an id were really walked, not skipped for want of one.
    expect(walked.filter((w) => w.includes(':')).length).toBeGreaterThan(80);

    // And nothing of A's changed: every page A lists things on reads exactly as it did. (A route that answers B
    // with B's own list, as some do, passes above; one that reached A's thing would show here.)
    const after = await seen();
    for (const path of Object.keys(before)) expect({ path, now: after[path] }).toEqual({ path, now: before[path] });
    const mine = (path: string) => h.api().get(path).set(h.bearer(a)).expect(200);
    expect((await mine(`/forms/${ids.form}`)).body.definition.name).toBe(`Form ${MARK}`);
    expect((await mine(`/records/${ids.record}`)).body.record.status).toBe('NEW');
    expect(JSON.stringify((await mine('/lists')).body)).toContain(`List ${MARK}`);
    expect(JSON.stringify((await mine('/connectors')).body)).toContain(`Connector ${MARK}`);
    expect(JSON.stringify((await mine('/members')).body)).toContain('worker@alpha.test');
    expect(JSON.stringify((await mine('/folders')).body)).toContain(`Folder ${MARK}`);
  }, 300_000);

  it("the public pages, opened under B's name, do not serve A's form, its files or its data", async () => {
    const pub = (path: string) => h.api().get(path);
    expect((await pub(`/public/forms/ALPHA_FORM?org=${orgB}`)).status).toBe(404);
    expect((await h.api().post(`/public/forms/ALPHA_FORM/submissions?org=${orgB}`).send({ values: { customer: 'x' } })).status).toBe(404);
    expect((await h.api().post(`/public/uploads/${ids.upload}/verify?org=${orgB}`)).status).toBeGreaterThanOrEqual(400);
    expect((await h.api().post(`/public/data-sources/query?org=${orgB}`).send({ formCode: 'ALPHA_FORM', key: '/lists/x', params: {} })).status).toBe(404);
    // And under A's own name it still works, so the refusals above are about the organisation, not a broken form.
    expect((await pub(`/public/forms/ALPHA_FORM?org=${orgA}`)).status).toBe(200);
  });

  it("links and files made for A do not work for B, even where B has a form with the same code", async () => {
    // B publishes a form of its own under the same code, and gets a record of its own.
    const folderB = (await h.api().post('/folders').set(h.bearer(b)).send({ name: 'Beta folder' }).expect(201)).body[0].id;
    const formB = (await h.api().post('/forms').set(h.bearer(b)).send({ folderId: folderB, definition: { ...formDef, name: 'Beta form', automations: [] } }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${formB}/publish`).set(h.bearer(b)).expect(200);
    const recordB = (await h.api().post(`/public/forms/ALPHA_FORM/submissions?org=${orgB}`).send({ values: { customer: 'Beta customer' } }).expect(201)).body.submissionId;

    // A saved-for-later draft of A's opens only on A's form.
    const draft = (await h.api().post(`/public/forms/ALPHA_FORM/drafts?org=${orgA}`).send({ values: { customer: `Draft ${MARK}` } }).expect(201)).body.token;
    expect((await h.api().post(`/public/forms/ALPHA_FORM/drafts/load?org=${orgA}`).send({ token: draft }).expect(200)).body.values.customer).toBe(`Draft ${MARK}`);
    await h.api().post(`/public/forms/ALPHA_FORM/drafts/load?org=${orgB}`).send({ token: draft }).expect(404);
    await h.api().post(`/public/forms/ALPHA_FORM/drafts/discard?org=${orgB}`).send({ token: draft }).expect(204);
    await h.api().post(`/public/forms/ALPHA_FORM/drafts/load?org=${orgA}`).send({ token: draft }).expect(200);

    // A file sent to A's form cannot be put into a response to B's, nor onto B's record by B's staff.
    const ticket = (await h.api().post(`/public/forms/ALPHA_FORM/uploads?org=${orgA}`).send({ fieldName: 'photo', fileName: 'a.png', contentType: 'image/png', size: PNG.length }).expect(201)).body;
    await h.api().put(h.localUrl(ticket.url).replace(h.base, '')).set('Content-Type', 'image/png').send(PNG).expect(200);
    await h.api().post(`/public/uploads/${ticket.uploadId}/verify?org=${orgA}`).expect(200);
    const sent = await h.api().post(`/public/forms/ALPHA_FORM/submissions?org=${orgB}`).send({ values: { customer: 'Beta', photo: [{ uploadId: ticket.uploadId }] } });
    expect(sent.status).toBeGreaterThanOrEqual(400);
    await h.api().post(`/records/${recordB}/files/${ticket.uploadId}/attach`).set(h.bearer(b)).expect((res) => expect(res.status).toBeGreaterThanOrEqual(400));
    await h.api().post(`/records/${recordB}/files/${ids.upload}/attach`).set(h.bearer(b)).expect((res) => expect(res.status).toBeGreaterThanOrEqual(400));
    // ...and no download link for A's file comes through B's own record or B's own form.
    await h.api().get(`/records/${recordB}/files/${ids.upload}`).set(h.bearer(b)).expect(404);
    await h.api().get(`/forms/${formB}/submissions/${recordB}/files/${ids.upload}`).set(h.bearer(b)).expect(404);
    // A's own file is still A's, and still sendable on A's form.
    await h.api().post(`/public/forms/ALPHA_FORM/submissions?org=${orgA}`).send({ values: { customer: 'Alpha again', photo: [{ uploadId: ticket.uploadId }] } }).expect(201);

    // A link that opens a form with one of A's records is A's alone: B's form of the same code does not accept it.
    const openWith = h.app.get(OpenWithService) as unknown as { link: OpenWithService['link']; read(token: string, def: { orgId: string; code: string }): string | undefined };
    const link = openWith.link({ orgId: orgA, code: 'ALPHA_FORM' }, 'CUST-1', 7).token;
    expect(openWith.read(link, { orgId: orgA, code: 'ALPHA_FORM' })).toBe('CUST-1');
    expect(openWith.read(link, { orgId: orgB, code: 'ALPHA_FORM' })).toBeUndefined();

    // A requester signed in to A's portal is not signed in to B's.
    for (const token of [a, b]) await h.api().patch('/org').set(h.bearer(token)).send({ portal: { enabled: true } }).expect(200);
    await h.api().post(`/public/portal/${orgA}/link`).send({ email: 'ravi@customer.test' }).expect(202);
    const mail = [...h.outbox].reverse().find((m) => m.to === 'ravi@customer.test' && m.text.includes(`/portal/${orgA}?key=`))!;
    const key = /key=(fbportal_[A-Za-z0-9_-]+)/.exec(mail.text)![1];
    await h.api().post(`/public/portal/${orgB}/session`).send({ key }).expect(401);
    const session = (await h.api().post(`/public/portal/${orgA}/session`).send({ key }).expect(200)).body.session;
    await h.api().get(`/public/portal/${orgA}/requests`).set({ Authorization: `Portal ${session}` }).expect(200);
    await h.api().get(`/public/portal/${orgB}/requests`).set({ Authorization: `Portal ${session}` }).expect(403);
  });
});
