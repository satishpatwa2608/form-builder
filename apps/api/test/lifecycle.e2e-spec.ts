import { startApp, type Harness } from './harness';

const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

describe('Opening times and save-for-later (e2e)', () => {
  let h: Harness;
  let owner: string;
  let orgId: string;
  let folder: string;

  const survey = (code: string, extra: Record<string, unknown>) => ({
    name: 'Survey',
    code,
    businessId: '',
    access: 'PUBLIC',
    submission: { method: 'POST', endpointId: 'default-submit' },
    fields: [
      { id: 'a', type: 'TEXT', name: 'view', label: 'Your view', required: true },
      { id: 'f', type: 'FILE', name: 'photo', label: 'Photo', props: { accept: ['image/*'], maxSizeMB: 1 } },
    ],
    workflow: {
      enabled: true,
      refPrefix: 'SUR',
      statuses: [{ key: 'NEW', label: 'New', category: 'OPEN' }, { key: 'DONE', label: 'Done', category: 'DONE' }],
      assignment: { type: 'NONE' },
      actions: [{ key: 'finish', label: 'Finish', from: ['NEW'], to: 'DONE' }],
    },
    ...extra,
  });

  beforeAll(async () => {
    h = await startApp();
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Surveys' }).expect(201)).body[0].id;
  });
  afterAll(() => h?.close());

  const publish = async (definition: object) => {
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
    return id as string;
  };
  const open = (code: string) => h.api().get(`/public/forms/${code}?org=${orgId}`);
  const submit = (code: string) => h.api().post(`/public/forms/${code}/submissions?org=${orgId}`).send({ values: { view: 'Fine' } });

  it('a form that has not opened yet shows a notice, none of its questions, and takes nothing', async () => {
    const opensAt = iso(2 * HOUR);
    await publish(survey('SOON', { opensAt }));
    const page = (await open('SOON').expect(200)).body;
    expect(page).toEqual({ unavailable: 'NOT_YET', name: 'Survey', code: 'SOON', orgId, opensAt });
    expect(JSON.stringify(page)).not.toContain('Your view');

    expect((await submit('SOON').expect(403)).body.message).toBe('This form is not open yet');
    await h.api().post(`/public/forms/SOON/uploads?org=${orgId}`).send({ fieldName: 'photo', fileName: 'a.png', contentType: 'image/png', size: 10 }).expect(403);
    await h.api().post(`/public/forms/SOON/drafts?org=${orgId}`).send({ values: { view: 'x' } }).expect(403);
  });

  it('a form past its closing time shows its own message and takes nothing', async () => {
    await publish(survey('OVER', { opensAt: iso(-48 * HOUR), closesAt: iso(-HOUR), closedMessage: 'The survey ended on Friday. Thank you.' }));
    expect((await open('OVER').expect(200)).body).toMatchObject({ unavailable: 'CLOSED', message: 'The survey ended on Friday. Thank you.' });
    expect((await submit('OVER').expect(403)).body.message).toBe('The survey ended on Friday. Thank you.');
    await publish(survey('OVER_PLAIN', { closesAt: iso(-HOUR) }));
    expect((await submit('OVER_PLAIN').expect(403)).body.message).toBe('This form is closed');
  });

  it('a form inside its times works as usual', async () => {
    await publish(survey('NOW', { opensAt: iso(-HOUR), closesAt: iso(HOUR) }));
    expect((await open('NOW').expect(200)).body.fields).toHaveLength(2);
    await submit('NOW').expect(201);
  });

  it('staff can still raise an item from inside after the form has closed to the public', async () => {
    const res = await h.api().post('/work-items').set(h.bearer(owner)).send({ formCode: 'OVER', values: { view: 'Late paper form' } }).expect(201);
    expect(res.body.ref).toMatch(/^SUR-/);
  });

  it('times that make no sense stop a form from being published', async () => {
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: survey('BACKWARDS', { opensAt: iso(HOUR), closesAt: iso(-HOUR) }) }).expect(201)).body.definition.id;
    const refused = await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(400);
    expect(refused.body.errors).toEqual([{ field: 'closesAt', message: 'The form must close after it opens' }]);
  });

  it('save-for-later is on unless the form turns it off', async () => {
    const save = (code: string) => h.api().post(`/public/forms/${code}/drafts?org=${orgId}`).send({ values: { view: 'Half done' } });
    const saved = (await save('NOW').expect(201)).body;
    expect(saved.token).toMatch(/^fbd_/);
    expect((await h.api().post(`/public/forms/NOW/drafts/load?org=${orgId}`).send({ token: saved.token }).expect(200)).body.values).toEqual({ view: 'Half done' });

    await publish(survey('NO_DRAFTS', { saveForLater: false }));
    expect((await save('NO_DRAFTS').expect(404)).body.message).toBe('This form cannot be saved for later');
    await h.api().post(`/public/forms/NO_DRAFTS/drafts/load?org=${orgId}`).send({ token: saved.token }).expect(404);
    // Submitting still works.
    await submit('NO_DRAFTS').expect(201);
  });
});

describe('Scheduled publishing (e2e)', () => {
  let h: Harness;
  let owner: string;
  let orgId: string;
  let folder: string;
  let queue: import('../src/jobs/job-queue.service').JobQueue;

  const form = (code: string, label = 'Your view') => ({
    name: 'Notice',
    code,
    businessId: '',
    access: 'PUBLIC',
    submission: { method: 'POST', endpointId: 'default-submit' },
    fields: [{ id: 'a', type: 'TEXT', name: 'view', label }],
  });
  const at = (ms: number) => new Date(Date.now() + ms);
  const draft = async (definition: object) => (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition }).expect(201)).body.definition.id as string;
  const state = async (id: string) => (await h.api().get(`/forms/${id}`).set(h.bearer(owner)).expect(200)).body;
  const schedule = (id: string, when: Date | string, token = owner) => h.api().post(`/forms/${id}/schedule`).set(h.bearer(token)).send({ publishAt: typeof when === 'string' ? when : when.toISOString() });

  beforeAll(async () => {
    h = await startApp();
    const { JobQueue } = await import('../src/jobs/job-queue.service');
    queue = h.app.get(JobQueue);
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Notices' }).expect(201)).body[0].id;
  });
  afterAll(() => h?.close());

  it('a draft goes live by itself at the chosen time, and not before', async () => {
    const id = await draft(form('LATER'));
    const when = at(2 * HOUR);
    expect((await schedule(id, when).expect(200)).body.publishAt).toBe(when.toISOString());
    await queue.drain(at(HOUR));
    expect((await state(id)).definition.status).toBe('DRAFT');
    await h.api().get(`/public/forms/LATER?org=${orgId}`).expect(404);

    await queue.drain(at(3 * HOUR));
    expect(await state(id)).toMatchObject({ definition: { status: 'PUBLISHED' }, publishAt: null, scheduleError: '' });
    await h.api().get(`/public/forms/LATER?org=${orgId}`).expect(200);
    const audit = (await h.api().get('/audit').set(h.bearer(owner)).expect(200)).body.entries.map((e: { action: string }) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['form.publish_scheduled', 'form.published']));
  });

  it('the live version stays until the scheduled new version takes over', async () => {
    const v1 = await draft(form('SWAP', 'Old question'));
    await h.api().post(`/forms/${v1}/publish`).set(h.bearer(owner)).expect(200);
    const v2 = (await h.api().post(`/forms/${v1}/new-version`).set(h.bearer(owner)).expect(200)).body.definition.id;
    await h.api().put(`/forms/${v2}`).set(h.bearer(owner)).send(form('SWAP', 'New question')).expect(200);
    await schedule(v2, at(HOUR)).expect(200);
    const live = async () => (await h.api().get(`/public/forms/SWAP?org=${orgId}`).expect(200)).body.fields[0].label;
    expect(await live()).toBe('Old question');
    await queue.drain(at(2 * HOUR));
    expect(await live()).toBe('New question');
  });

  it('moving or cancelling a schedule leaves the earlier time with nothing to do', async () => {
    const id = await draft(form('MOVED'));
    await schedule(id, at(HOUR)).expect(200);
    await schedule(id, at(5 * HOUR)).expect(200);
    await queue.drain(at(2 * HOUR));
    expect((await state(id)).definition.status).toBe('DRAFT');
    await h.api().delete(`/forms/${id}/schedule`).set(h.bearer(owner)).expect(200);
    expect((await state(id)).publishAt).toBeNull();
    await queue.drain(at(6 * HOUR));
    expect((await state(id)).definition.status).toBe('DRAFT');
  });

  it('refuses a time that is past, unreadable or too far off, and a draft that could not be published', async () => {
    const id = await draft(form('BADTIME'));
    expect((await schedule(id, at(-HOUR)).expect(400)).body.message).toBe('Choose a time in the future, or publish now');
    expect((await schedule(id, 'next tuesday').expect(400)).body.message).toBe('Choose a date and time');
    await schedule(id, at(400 * 24 * HOUR)).expect(400);
    const broken = await draft({ ...form('BROKEN'), rules: [{ id: 'r', then: [{ type: 'SHOW', target: 'missing' }] }] });
    expect((await schedule(broken, at(HOUR)).expect(400)).body.errors[0].message).toBe('Acts on unknown field "missing"');
  });

  it('a problem that appears before the time is recorded on the form instead of publishing it', async () => {
    const id = await draft(form('SPOILED'));
    await schedule(id, at(HOUR)).expect(200);
    // Edited into something that cannot be published after it was scheduled.
    await h.api().put(`/forms/${id}`).set(h.bearer(owner)).send({ ...form('SPOILED'), rules: [{ id: 'r', then: [{ type: 'SHOW', target: 'missing' }] }] }).expect(200);
    await queue.drain(at(2 * HOUR));
    const after = await state(id);
    expect(after.definition.status).toBe('DRAFT');
    expect(after.publishAt).toBeNull();
    expect(after.scheduleError).toContain('Acts on unknown field "missing"');
    const listed = (await h.api().get('/forms').set(h.bearer(owner)).expect(200)).body.find((f: { code: string }) => f.code === 'SPOILED');
    expect(listed.scheduleError).toContain('Acts on unknown field "missing"');
  });

  it('only someone who may publish can schedule, and the publish runs with the rights they hold at the time', async () => {
    const pubId = await h.addMember(owner, 'Pat Publisher', 'pat@acme.test', 'PUBLISHER');
    await h.addMember(owner, 'Vi Viewer', 'vi@acme.test', 'VIEWER');
    const publisher = (await h.login('pat@acme.test')).token;
    const viewer = (await h.login('vi@acme.test')).token;
    const id = await draft(form('RIGHTS'));
    await schedule(id, at(HOUR), viewer).expect(403);
    await schedule(id, at(HOUR), publisher).expect(200);

    // Pat is demoted before the time comes.
    await h.api().patch(`/members/${pubId}`).set(h.bearer(owner)).send({ role: 'VIEWER' }).expect(200);
    await queue.drain(at(2 * HOUR));
    const after = await state(id);
    expect(after.definition.status).toBe('DRAFT');
    expect(after.scheduleError).not.toBe('');

    // Scheduled again by Pat as a publisher, who then leaves the organisation.
    await h.api().patch(`/members/${pubId}`).set(h.bearer(owner)).send({ role: 'PUBLISHER' }).expect(200);
    await schedule(id, at(HOUR), (await h.login('pat@acme.test')).token).expect(200);
    await h.api().delete(`/members/${pubId}`).set(h.bearer(owner)).expect(200);
    await queue.drain(at(2 * HOUR));
    expect((await state(id)).scheduleError).toBe('The person who scheduled it is no longer a member of the organisation');
  });
});
