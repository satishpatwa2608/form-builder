import { startApp, type Harness } from './harness';

/** Emails written once for the organisation and used wherever one is sent. */
describe('Saved emails (e2e)', () => {
  let h: Harness;
  let owner: string;
  let designer: string;
  const mail = { name: 'Documents needed', subject: 'We need a few more documents for {{$record.ref}}', body: 'Dear {{name}},\n\nPlease send the documents listed below.' };

  beforeAll(async () => {
    h = await startApp();
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    await h.addMember(owner, 'Dev', 'dev@acme.test', 'DESIGNER');
    designer = (await h.login('dev@acme.test')).token;
  });
  afterAll(async () => h?.close());

  it('administrators write them; everyone who works here can read and use them', async () => {
    await h.api().post('/email-templates').set(h.bearer(designer)).send(mail).expect(403);
    for (const bad of [{ ...mail, name: '' }, { ...mail, subject: ' ' }, { ...mail, body: '' }]) await h.api().post('/email-templates').set(h.bearer(owner)).send(bad).expect(400);
    const made = (await h.api().post('/email-templates').set(h.bearer(owner)).send(mail).expect(201)).body;
    expect(made).toMatchObject(mail);
    expect((await h.api().get('/email-templates').set(h.bearer(designer)).expect(200)).body).toEqual([expect.objectContaining({ id: made.id, name: 'Documents needed' })]);
    // Two of one name would be told apart by nobody.
    expect((await h.api().post('/email-templates').set(h.bearer(owner)).send({ ...mail, name: 'documents NEEDED' }).expect(400)).body.errors[0].field).toBe('name');
  });

  it('they are changed and removed by administrators, and each change is on record', async () => {
    const [first] = (await h.api().get('/email-templates').set(h.bearer(owner)).expect(200)).body as { id: string }[];
    await h.api().put(`/email-templates/${first!.id}`).set(h.bearer(designer)).send(mail).expect(403);
    expect((await h.api().put(`/email-templates/${first!.id}`).set(h.bearer(owner)).send({ ...mail, subject: 'More documents, please' }).expect(200)).body.subject).toBe('More documents, please');
    await h.api().delete(`/email-templates/${first!.id}`).set(h.bearer(designer)).expect(403);
    await h.api().delete(`/email-templates/${first!.id}`).set(h.bearer(owner)).expect(204);
    await h.api().delete(`/email-templates/${first!.id}`).set(h.bearer(owner)).expect(404);
    const trail = (await h.api().get('/audit').set(h.bearer(owner)).expect(200)).body.entries as { action: string }[];
    expect(trail.map((e) => e.action)).toEqual(expect.arrayContaining(['email_template.created', 'email_template.saved', 'email_template.deleted']));
  });

  it('another organisation has its own', async () => {
    await h.api().post('/email-templates').set(h.bearer(owner)).send(mail).expect(201);
    await h.signUp('Omar', 'omar@other.test', 'Other');
    const other = (await h.login('omar@other.test')).token;
    expect((await h.api().get('/email-templates').set(h.bearer(other)).expect(200)).body).toEqual([]);
    await h.api().get('/email-templates').expect(401);
  });
});
