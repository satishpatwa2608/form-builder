import fixture from '../../../packages/engine/test/fixtures/customer-complaint-basic.json';
import { startApp, type Harness } from './harness';

/** A valid definition to send (identity fields are the server's to set). */
type Def = Record<string, unknown> & { fields: Record<string, unknown>[] };
const definition = (code = 'CUSTOMER_COMPLAINT', name = 'Customer complaint'): Def => {
  const { id: _id, orgId: _org, version: _v, status: _s, ...rest } = JSON.parse(JSON.stringify(fixture)) as unknown as Def;
  return { ...rest, code, name } as Def;
};

describe('Forms: versions in folders, with folder permissions (e2e)', () => {
  let h: Harness;
  let owner: string;
  let designer: string;
  let publisher: string;
  let viewer: string;
  let quality: string;
  let hr: string;

  beforeAll(async () => {
    h = await startApp();
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    const folders = async (name: string) =>
      ((await h.api().post('/folders').set(h.bearer(owner)).send({ name }).expect(201)).body as { id: string; name: string }[]).find((f) => f.name === name)!.id;
    quality = await folders('Quality');
    hr = await folders('HR');
    // Org roles: a viewer; a designer and a publisher who get their powers only on Quality.
    const devId = await h.addMember(owner, 'Dev', 'dev@acme.test', 'VIEWER');
    const pubId = await h.addMember(owner, 'Pub', 'pub@acme.test', 'VIEWER');
    await h.addMember(owner, 'Viv', 'viv@acme.test', 'RECORDS_WORKER');
    await h.api().post('/grants').set(h.bearer(owner)).send({ userId: devId, role: 'DESIGNER', scope: { type: 'folder', id: quality } }).expect(201);
    await h.api().post('/grants').set(h.bearer(owner)).send({ userId: pubId, role: 'PUBLISHER', scope: { type: 'folder', id: quality } }).expect(201);
    designer = (await h.login('dev@acme.test')).token;
    publisher = (await h.login('pub@acme.test')).token;
    viewer = (await h.login('viv@acme.test')).token;
  });
  afterAll(() => h?.close());

  it('lifecycle: draft -> publish -> read-only -> new version -> publish archives the old one', async () => {
    const { api, bearer } = h;
    // Engine validation on create: a bad code is a field error.
    const bad = await api().post('/forms').set(bearer(designer)).send({ folderId: quality, definition: { ...definition(), code: 'bad code' } }).expect(400);
    expect(bad.body.errors.some((e: { field: string }) => e.field === 'code')).toBe(true);

    const created = (await api().post('/forms').set(bearer(designer)).send({ folderId: quality, definition: definition() }).expect(201)).body;
    expect(created.definition).toMatchObject({ code: 'CUSTOMER_COMPLAINT', version: 1, status: 'DRAFT' });
    // A designer on Quality edits but doesn't publish.
    expect(created.permissions).toEqual(['form.view', 'form.edit']);
    const v1 = created.definition.id;
    // The code is unique in the org.
    await api().post('/forms').set(bearer(designer)).send({ folderId: quality, definition: definition() }).expect(409);

    await api().put(`/forms/${v1}`).set(bearer(designer)).send({ ...definition(), name: 'Customer complaint (draft 2)' }).expect(200);
    await api().post(`/forms/${v1}/publish`).set(bearer(designer)).expect(403); // designer can't publish
    const published = (await api().post(`/forms/${v1}/publish`).set(bearer(publisher)).expect(200)).body;
    expect(published.definition).toMatchObject({ status: 'PUBLISHED', name: 'Customer complaint (draft 2)' });
    await api().put(`/forms/${v1}`).set(bearer(designer)).send(definition()).expect(409); // published is read-only

    const v2 = (await api().post(`/forms/${v1}/new-version`).set(bearer(designer)).expect(200)).body.definition;
    expect(v2).toMatchObject({ version: 2, status: 'DRAFT' });
    // Asking again returns the open draft instead of a third version.
    expect((await api().post(`/forms/${v1}/new-version`).set(bearer(designer)).expect(200)).body.definition.id).toBe(v2.id);
    await api().post(`/forms/${v2.id}/publish`).set(bearer(publisher)).expect(200);
    const versions = (await api().get(`/forms/${v2.id}/versions`).set(bearer(owner)).expect(200)).body;
    expect(versions.map((v: { version: number; status: string }) => `${v.version}:${v.status}`)).toEqual(['2:PUBLISHED', '1:ARCHIVED']);

    const list = (await api().get('/forms').set(bearer(designer)).expect(200)).body;
    expect(list).toEqual([expect.objectContaining({ code: 'CUSTOMER_COMPLAINT', version: 2, status: 'PUBLISHED', publishedVersion: 2, folderId: quality })]);
    // The list says whether a form has an address to hand out: live, and open to anyone with the link.
    expect(typeof list[0].publicLink).toBe('boolean');
  });

  it('a blank form is a valid draft; the server sets who made it; publishing needs a field', async () => {
    const { api, bearer } = h;
    const blank = { name: 'Leave request', code: 'LEAVE_REQUEST', businessId: '', access: 'PUBLIC', fields: [], submission: { method: 'POST', endpointId: 'default-submit' }, createdBy: 'someone-else' };
    const made = (await api().post('/forms').set(bearer(designer)).send({ folderId: quality, definition: blank }).expect(201)).body.definition;
    const me = (await api().get('/auth/me').set(bearer(designer)).expect(200)).body.user.id;
    expect(made.createdBy).toBe(me);
    const refused = await api().post(`/forms/${made.id}/publish`).set(bearer(owner)).expect(400);
    expect(refused.body.errors[0].message).toContain('at least one field');
    await api().delete(`/forms/${made.id}`).set(bearer(designer)).expect(200);
  });

  it('folder permissions decide who sees and edits a form; outsiders get "not found"', async () => {
    const { api, bearer } = h;
    const inHr = (await api().post('/forms').set(bearer(owner)).send({ folderId: hr, definition: definition('LEAVE', 'Leave request') }).expect(201)).body.definition.id;
    // The designer's grant is on Quality only.
    await api().post('/forms').set(bearer(designer)).send({ folderId: hr, definition: definition('NOPE', 'Nope') }).expect(403);
    await api().put(`/forms/${inHr}`).set(bearer(designer)).send(definition('LEAVE', 'Changed')).expect(403);
    // Org viewers see every form; a records worker sees none (no form.view) - and can't tell they exist.
    expect((await api().get('/forms').set(bearer(designer)).expect(200)).body.map((f: { code: string }) => f.code).sort()).toEqual(['CUSTOMER_COMPLAINT', 'LEAVE']);
    expect((await api().get('/forms').set(bearer(viewer)).expect(200)).body).toEqual([]);
    await api().get(`/forms/${inHr}`).set(bearer(viewer)).expect(404);
    // Per-form permissions in the list follow the folder.
    const list = (await api().get('/forms').set(bearer(designer)).expect(200)).body;
    expect(list.find((f: { code: string }) => f.code === 'LEAVE').permissions).toEqual(['form.view']);

    // Moving needs edit rights in both folders.
    await api().patch(`/forms/${inHr}/folder`).set(bearer(designer)).send({ folderId: quality }).expect(403);
    await api().patch(`/forms/${inHr}/folder`).set(bearer(owner)).send({ folderId: quality }).expect(200);
    await api().put(`/forms/${inHr}`).set(bearer(designer)).send(definition('LEAVE', 'Leave request v1')).expect(200);
  });

  it('publish runs the full checks; drafts can be deleted, published versions cannot', async () => {
    const { api, bearer } = h;
    const withHandler = { ...definition('HOOKED', 'Hooked'), automations: [{ id: 'a', name: 'A', enabled: true, when: 'SUBMITTED', actions: [{ id: 's', type: 'HANDLER', key: 'x' }] }] };
    const hooked = (await api().post('/forms').set(bearer(owner)).send({ folderId: quality, definition: withHandler }).expect(201)).body.definition.id;
    const refused = await api().post(`/forms/${hooked}/publish`).set(bearer(owner)).expect(400);
    expect(refused.body.errors[0].message).toContain('Custom API');
    // Server-only security checks (ReDoS-prone pattern) apply to drafts too.
    const unsafe = definition('UNSAFE', 'Unsafe');
    const text = unsafe.fields.findIndex((f) => f.type === 'TEXT');
    unsafe.fields[text] = { ...unsafe.fields[text], validation: { pattern: '(a+)+$' } };
    const risky = await api().post('/forms').set(bearer(owner)).send({ folderId: quality, definition: unsafe }).expect(400);
    expect(JSON.stringify(risky.body.errors)).toContain('pattern');

    await api().delete(`/forms/${hooked}`).set(bearer(owner)).expect(200);
    await api().get(`/forms/${hooked}`).set(bearer(owner)).expect(404);
    const live = (await api().get('/forms').set(bearer(owner)).expect(200)).body.find((f: { code: string }) => f.code === 'CUSTOMER_COMPLAINT').id;
    await api().delete(`/forms/${live}`).set(bearer(owner)).expect(409);
    // A folder holding forms can't be deleted.
    await api().delete(`/folders/${quality}`).set(bearer(owner)).expect(409);
  });

  it('forms are org-private, and every lifecycle step is audited', async () => {
    const { api, bearer } = h;
    await h.signUp('Bob', 'bob@beta.test', 'Beta');
    const bob = (await h.login('bob@beta.test')).token;
    expect((await api().get('/forms').set(bearer(bob)).expect(200)).body).toEqual([]);
    const acmeForm = (await api().get('/forms').set(bearer(owner)).expect(200)).body[0].id;
    await api().get(`/forms/${acmeForm}`).set(bearer(bob)).expect(404);

    const actions = (await api().get('/audit?limit=200').set(bearer(owner)).expect(200)).body.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['form.created', 'form.published', 'form.version_created', 'form.moved', 'form.deleted']));
  });
});

describe('Style library (e2e)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startApp();
  });
  afterAll(() => h?.close());

  it('admins manage styles; publishing freezes the styles a form uses; a missing style blocks publishing', async () => {
    const { api, bearer } = h;
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    const owner = (await h.login('asha@acme.test')).token;
    const viewerId = await h.addMember(owner, 'Viv', 'viv@acme.test', 'VIEWER');
    expect(viewerId).toBeTruthy();
    const viewer = (await h.login('viv@acme.test')).token;
    await api().put('/styles/brand').set(bearer(viewer)).send({ name: 'Brand', props: {} }).expect(403);
    await api().put('/styles/brand').set(bearer(owner)).send({ name: 'Brand', props: { labelColor: '#1458e2', borderRadius: 8 } }).expect(200);
    expect((await api().get('/styles').set(bearer(viewer)).expect(200)).body).toEqual([expect.objectContaining({ id: 'brand', name: 'Brand' })]);

    const folder = (await api().post('/folders').set(bearer(owner)).send({ name: 'Forms' }).expect(201)).body[0].id;
    const def = definition('STYLED', 'Styled');
    def.fields[0] = { ...def.fields[0], styleId: 'brand' };
    const id = (await api().post('/forms').set(bearer(owner)).send({ folderId: folder, definition: def }).expect(201)).body.definition.id;
    const published = (await api().post(`/forms/${id}/publish`).set(bearer(owner)).expect(200)).body.definition;
    expect(published.styles).toEqual([expect.objectContaining({ id: 'brand', props: expect.objectContaining({ labelColor: '#1458e2' }) })]);

    // Changing the library doesn't touch the published version; deleting a used style blocks the next publish.
    await api().put('/styles/brand').set(bearer(owner)).send({ name: 'Brand', props: { labelColor: '#000000' } }).expect(200);
    expect((await api().get(`/forms/${id}`).set(bearer(owner)).expect(200)).body.definition.styles[0].props.labelColor).toBe('#1458e2');
    const v2 = (await api().post(`/forms/${id}/new-version`).set(bearer(owner)).expect(200)).body.definition.id;
    await api().delete('/styles/brand').set(bearer(owner)).expect(200);
    const refused = await api().post(`/forms/${v2}/publish`).set(bearer(owner)).expect(400);
    expect(refused.body.errors[0].message).toContain('no longer exists');
  });
});

describe('Form packages: copy a form to another org or environment (e2e)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startApp();
  });
  afterAll(() => h?.close());

  it('exports a version with its styles; importing creates a draft (then the next version), never publishes', async () => {
    const { api, bearer } = h;
    await h.signUp('Asha', 'asha@dev.test', 'Acme Dev');
    await h.signUp('Bo', 'bo@prod.test', 'Acme Prod');
    const dev = (await h.login('asha@dev.test')).token;
    const prod = (await h.login('bo@prod.test')).token;
    await api().put('/styles/brand').set(bearer(dev)).send({ name: 'Brand', props: { labelColor: '#1458e2' } }).expect(200);
    const devFolder = (await api().post('/folders').set(bearer(dev)).send({ name: 'Forms' }).expect(201)).body[0].id;
    const prodFolder = (await api().post('/folders').set(bearer(prod)).send({ name: 'Forms' }).expect(201)).body[0].id;
    const def = definition('PACKAGED', 'Packaged');
    def.fields[0] = { ...def.fields[0], styleId: 'brand' };
    const id = (await api().post('/forms').set(bearer(dev)).send({ folderId: devFolder, definition: def }).expect(201)).body.definition.id;
    await api().post(`/forms/${id}/publish`).set(bearer(dev)).expect(200);

    const pkg = (await api().get(`/forms/${id}/export`).set(bearer(dev)).expect(200)).body;
    expect(pkg).toMatchObject({ format: 'form-builder/form', formatVersion: 1, source: { code: 'PACKAGED', version: 1, status: 'PUBLISHED' }, styles: [expect.objectContaining({ id: 'brand' })] });
    expect(pkg.definition.id).toBeUndefined();
    expect(pkg.definition.orgId).toBeUndefined();
    // Another org can't export it.
    await api().get(`/forms/${id}/export`).set(bearer(prod)).expect(404);

    await api().post('/forms/import').set(bearer(prod)).send({ folderId: prodFolder, package: { format: 'nope' } }).expect(400);
    const first = (await api().post('/forms/import').set(bearer(prod)).send({ folderId: prodFolder, package: pkg }).expect(201)).body;
    expect(first).toMatchObject({ code: 'PACKAGED', version: 1, stylesCreated: ['brand'], stylesMissing: [], connectorsMissing: [] });
    const imported = (await api().get(`/forms/${first.id}`).set(bearer(prod)).expect(200)).body.definition;
    expect(imported).toMatchObject({ status: 'DRAFT', version: 1, name: 'Packaged' });
    expect((await api().get('/styles').set(bearer(prod)).expect(200)).body).toEqual([expect.objectContaining({ id: 'brand' })]);

    // An open draft blocks a second import; once published, the next import is v2.
    await api().post('/forms/import').set(bearer(prod)).send({ folderId: prodFolder, package: pkg }).expect(409);
    await api().post(`/forms/${first.id}/publish`).set(bearer(prod)).expect(200);
    const second = (await api().post('/forms/import').set(bearer(prod)).send({ folderId: prodFolder, package: pkg }).expect(201)).body;
    expect(second).toMatchObject({ version: 2, stylesCreated: [] });
    // Importing under another code is a new form.
    expect((await api().post('/forms/import').set(bearer(prod)).send({ folderId: prodFolder, package: pkg, code: 'PACKAGED_COPY' }).expect(201)).body).toMatchObject({ code: 'PACKAGED_COPY', version: 1 });
  });
});
