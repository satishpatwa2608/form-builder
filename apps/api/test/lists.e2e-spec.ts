import { startApp, type Harness } from './harness';

/** Master data: a list of choices kept once for the organisation and read by dropdowns on many forms. */
describe('Shared lists (e2e)', () => {
  let h: Harness;
  let owner: string;
  let designer: string;
  let orgId: string;
  let folder: string;
  type List = { id: string; key: string; name: string; dependsOn: string; items: { value: string; label: string; parent?: string; retired?: boolean }[]; usedBy: { name: string }[] };
  const lists = async (token = owner) => (await h.api().get('/lists').set(h.bearer(token)).expect(200)).body as List[];
  const options = async (code: string, key: string, params: Record<string, string> = {}) => (await h.api().post(`/public/data-sources/query?org=${orgId}`).send({ formCode: code, key, params }).expect(200)).body as { value: string; label: string }[];

  beforeAll(async () => {
    h = await startApp();
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    await h.addMember(owner, 'Dev', 'dev@acme.test', 'DESIGNER');
    designer = (await h.login('dev@acme.test')).token;
    folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Forms' }).expect(201)).body[0].id;
  });
  afterAll(async () => h?.close());

  it('an administrator makes a list; each item gets a value that stays, and everyone can read it', async () => {
    await h.api().post('/lists').set(h.bearer(designer)).send({ name: 'Cities', items: [{ label: 'Pune' }] }).expect(403);
    await h.api().post('/lists').set(h.bearer(owner)).send({ name: '', items: [{ label: 'Pune' }] }).expect(400);
    await h.api().post('/lists').set(h.bearer(owner)).send({ name: 'Cities', items: [] }).expect(400);
    const cities = (await h.api().post('/lists').set(h.bearer(owner)).send({ name: 'Cities', description: 'Where we have offices', items: [{ label: 'Pune' }, { label: 'Mumbai' }, { label: 'New Delhi' }] }).expect(201)).body as List;
    expect(cities).toMatchObject({ key: 'cities', name: 'Cities', dependsOn: '', usedBy: [] });
    expect(cities.items).toEqual([{ value: 'PUNE', label: 'Pune' }, { value: 'MUMBAI', label: 'Mumbai' }, { value: 'NEW_DELHI', label: 'New Delhi' }]);
    expect((await lists(designer)).map((l) => l.name)).toEqual(['Cities']);
    // A second list of the same name is told apart.
    expect(((await h.api().post('/lists').set(h.bearer(owner)).send({ name: 'Cities', items: [{ label: 'X' }] }).expect(201)).body as List).key).toBe('cities-2');
  });

  it('a list can depend on another: each item says which choice there it belongs to', async () => {
    await h.api().post('/lists').set(h.bearer(owner)).send({ name: 'Branches', dependsOn: 'cities', items: [{ label: 'Camp' }] }).expect(400);
    await h.api().post('/lists').set(h.bearer(owner)).send({ name: 'Branches', dependsOn: 'cities', items: [{ label: 'Camp', parent: 'NOWHERE' }] }).expect(400);
    await h.api().post('/lists').set(h.bearer(owner)).send({ name: 'Branches', dependsOn: 'no-such-list', items: [{ label: 'Camp', parent: 'PUNE' }] }).expect(400);
    const branches = (await h.api().post('/lists').set(h.bearer(owner)).send({ name: 'Branches', dependsOn: 'cities', items: [{ label: 'Camp', parent: 'PUNE' }, { label: 'Kothrud', parent: 'PUNE' }, { label: 'Fort', parent: 'MUMBAI' }] }).expect(201)).body as List;
    expect(branches.items.map((i) => `${i.value}@${i.parent}`)).toEqual(['CAMP@PUNE', 'KOTHRUD@PUNE', 'FORT@MUMBAI']);
    const sources = (await h.api().get('/lists/sources').set(h.bearer(designer)).expect(200)).body as { key: string; name: string; params: string[]; dependsOnName: string; list: boolean }[];
    expect(sources.find((s) => s.key === '/lists/branches')).toMatchObject({ name: 'Branches', params: ['parent'], valueField: 'value', labelField: 'label', list: true, dependsOnName: 'Cities' });
    expect(sources.find((s) => s.key === '/lists/cities')).toMatchObject({ params: [], dependsOnName: '' });
  });

  it('dropdowns on a form read the lists: the second offers what belongs to the choice in the first, and the server checks it', async () => {
    const dropdown = (id: string, name: string, key: string, params?: Record<string, string>) => ({ id, type: 'DROPDOWN', name, label: name, required: true, dataSource: { type: 'API', api: { url: key, method: 'GET', valueField: 'value', labelField: 'label', ...(params ? { params } : {}) } } });
    const definition = { name: 'Visit', code: 'VISIT', businessId: '', access: 'PUBLIC', submission: { method: 'POST', endpointId: 'default-submit' }, fields: [dropdown('c', 'city', '/lists/cities'), dropdown('b', 'branch', '/lists/branches', { parent: '{{city}}' })] };
    const id = (await h.api().post('/forms').set(h.bearer(designer)).send({ folderId: folder, definition }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);

    expect((await options('VISIT', '/lists/cities')).map((o) => o.label)).toEqual(['Pune', 'Mumbai', 'New Delhi']);
    expect((await options('VISIT', '/lists/branches', { parent: 'PUNE' })).map((o) => o.value)).toEqual(['CAMP', 'KOTHRUD']);
    expect((await options('VISIT', '/lists/branches', { parent: 'MUMBAI' })).map((o) => o.value)).toEqual(['FORT']);
    // A list no published form reads is not handed to the public.
    await h.api().post(`/public/data-sources/query?org=${orgId}`).send({ formCode: 'VISIT', key: '/lists/cities-2', params: {} }).expect(404);

    await h.api().post(`/public/forms/VISIT/submissions?org=${orgId}`).send({ values: { city: 'PUNE', branch: 'CAMP' } }).expect(201);
    const wrong = await h.api().post(`/public/forms/VISIT/submissions?org=${orgId}`).send({ values: { city: 'PUNE', branch: 'FORT' } }).expect(422);
    expect(wrong.body.errors[0].field).toBe('branch');
    await h.api().post(`/public/forms/VISIT/submissions?org=${orgId}`).send({ values: { city: 'ATLANTIS', branch: 'CAMP' } }).expect(422);
    expect((await lists()).find((l) => l.key === 'branches')!.usedBy).toEqual([expect.objectContaining({ name: 'Visit' })]);
  });

  it('changing the list changes every form at once: a renamed item keeps its value, a removed one is retired', async () => {
    const cities = (await lists()).find((l) => l.key === 'cities')!;
    const saved = (await h.api().put(`/lists/${cities.id}`).set(h.bearer(owner)).send({ name: 'Cities', items: [{ value: 'PUNE', label: 'Pune (HQ)' }, { value: 'MUMBAI', label: 'Mumbai' }, { label: 'Nagpur' }] }).expect(200)).body as List;
    expect(saved.items).toEqual([{ value: 'PUNE', label: 'Pune (HQ)' }, { value: 'MUMBAI', label: 'Mumbai' }, { value: 'NAGPUR', label: 'Nagpur' }, { value: 'NEW_DELHI', label: 'New Delhi', retired: true }]);
    // No republishing: the form already offers the new list.
    expect((await options('VISIT', '/lists/cities')).map((o) => o.label)).toEqual(['Pune (HQ)', 'Mumbai', 'Nagpur']);
    await h.api().post(`/public/forms/VISIT/submissions?org=${orgId}`).send({ values: { city: 'NEW_DELHI', branch: 'CAMP' } }).expect(422);
    await h.api().put(`/lists/${cities.id}`).set(h.bearer(designer)).send({ name: 'Cities', items: [{ label: 'Only' }] }).expect(403);
    const trail = (await h.api().get('/audit').set(h.bearer(owner)).expect(200)).body.entries as { action: string }[];
    expect(trail.map((e) => e.action)).toEqual(expect.arrayContaining(['list.created', 'list.saved']));
  });

  it('a list in use, or one another list depends on, cannot be deleted; an unused one can', async () => {
    const all = await lists();
    const used = await h.api().delete(`/lists/${all.find((l) => l.key === 'branches')!.id}`).set(h.bearer(owner)).expect(409);
    expect(used.body.message).toMatch(/used by Visit/);
    await h.api().delete(`/lists/${all.find((l) => l.key === 'cities')!.id}`).set(h.bearer(owner)).expect(409);
    await h.api().delete(`/lists/${all.find((l) => l.key === 'cities-2')!.id}`).set(h.bearer(designer)).expect(403);
    await h.api().delete(`/lists/${all.find((l) => l.key === 'cities-2')!.id}`).set(h.bearer(owner)).expect(204);
    expect((await lists()).map((l) => l.key)).toEqual(['branches', 'cities']);
  });

  it('another organisation sees none of it', async () => {
    await h.signUp('Omar', 'omar@other.test', 'Other');
    const other = (await h.login('omar@other.test')).token;
    expect(await lists(other)).toEqual([]);
    const mine = (await lists()).find((l) => l.key === 'cities')!;
    await h.api().put(`/lists/${mine.id}`).set(h.bearer(other)).send({ name: 'Mine now', items: [{ label: 'x' }] }).expect(404);
  });
});
