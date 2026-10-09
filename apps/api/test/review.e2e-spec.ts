import { startApp, type Harness } from './harness';

const form = (code: string, label = 'Your name') => ({
  name: code,
  code,
  businessId: '',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [
    { id: 'a', type: 'TEXT', name: 'name', label, required: true },
    { id: 'b', type: 'EMAIL', name: 'email', label: 'Email' },
  ],
});

describe('Review before publish (e2e)', () => {
  let h: Harness;
  let owner: string;
  let designer: string;
  let publisher: string;
  let viewer: string;
  let folder: string;

  beforeAll(async () => {
    h = await startApp();
    await h.signUp('Asha Owner', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'HR' }).expect(201)).body[0].id;
    await h.addMember(owner, 'Dev Designer', 'dev@acme.test', 'DESIGNER');
    await h.addMember(owner, 'Pia Publisher', 'pia@acme.test', 'PUBLISHER');
    await h.addMember(owner, 'Vik Viewer', 'vik@acme.test', 'VIEWER');
    designer = (await h.login('dev@acme.test')).token;
    publisher = (await h.login('pia@acme.test')).token;
    viewer = (await h.login('vik@acme.test')).token;
  });
  afterAll(() => h?.close());

  const draft = async (definition: object, token = designer) => (await h.api().post('/forms').set(h.bearer(token)).send({ folderId: folder, definition }).expect(201)).body.definition.id as string;
  const review = (id: string, token: string) => h.api().get(`/forms/${id}/review`).set(h.bearer(token));
  const act = (id: string, what: string, token: string, body: object = {}) => h.api().post(`/forms/${id}/review/${what}`).set(h.bearer(token)).send(body);
  const publish = (id: string, token = owner) => h.api().post(`/forms/${id}/publish`).set(h.bearer(token));
  const requireReview = (on: boolean) => h.api().patch('/org').set(h.bearer(owner)).send({ security: { requireReview: on } }).expect(200);

  it('a designer asks for a review; a publisher approves it or asks for changes, with a reason', async () => {
    const id = await draft(form('LEAVE'));
    const start = (await review(id, designer).expect(200)).body;
    expect(start).toMatchObject({ required: false, review: { status: 'NONE', stale: false }, comments: [], can: { request: true, decide: false, comment: true } });

    const asked = (await act(id, 'request', designer, { note: 'Please check the wording.' }).expect(200)).body;
    expect(asked.review).toMatchObject({ status: 'REQUESTED', note: 'Please check the wording.', requestedBy: { name: 'Dev Designer' } });
    expect(asked.can).toMatchObject({ request: false, decide: false });
    await act(id, 'request', designer).expect(409);
    // It shows in the list of forms, where a reviewer will see it.
    expect((await h.api().get('/forms').set(h.bearer(publisher)).expect(200)).body.find((f: { id: string }) => f.id === id).review).toBe('REQUESTED');

    // A designer cannot decide; a publisher can.
    await act(id, 'approve', designer).expect(403);
    expect((await review(id, publisher).expect(200)).body.can).toMatchObject({ decide: true, request: false });
    expect((await act(id, 'changes', publisher, {}).expect(400)).body.message).toBe('Say what needs to change');
    const back = (await act(id, 'changes', publisher, { note: 'Ask for the employee id too.' }).expect(200)).body;
    expect(back.review).toMatchObject({ status: 'CHANGES_REQUESTED', decisionNote: 'Ask for the employee id too.', decidedBy: { name: 'Pia Publisher' } });
    await act(id, 'approve', publisher).expect(409);

    await act(id, 'request', designer).expect(200);
    const approved = (await act(id, 'approve', publisher, { note: 'Good.' }).expect(200)).body;
    expect(approved.review).toMatchObject({ status: 'APPROVED', stale: false, decisionNote: 'Good.' });
    // A review can be taken back only while it is waiting.
    await act(id, 'cancel', designer).expect(409);
  });

  it('review is advice unless the organisation requires it', async () => {
    const id = await draft(form('ADVICE'));
    await act(id, 'request', designer).expect(200);
    await publish(id).expect(200);
    // What is live is not reviewed: a new version starts clean.
    await act(id, 'request', designer).expect(409);
    const next = (await h.api().post(`/forms/${id}/new-version`).set(h.bearer(owner)).expect(200)).body.definition.id;
    expect((await review(next, designer).expect(200)).body.review.status).toBe('NONE');
  });

  describe('when the organisation requires review', () => {
    beforeAll(() => requireReview(true));
    afterAll(() => requireReview(false));

    it('a form is not published until it is approved, and the reason says what to do next', async () => {
      const id = await draft(form('GATED'));
      const refusal = async () => (await publish(id).expect(400)).body.errors[0].message;
      expect((await review(id, designer).expect(200)).body.required).toBe(true);
      expect(await refusal()).toBe('Your organisation requires a review before a form is published. Ask for a review.');
      await act(id, 'request', designer).expect(200);
      expect(await refusal()).toBe('This form is waiting for its review. It can be published once a reviewer approves it.');
      await act(id, 'changes', publisher, { note: 'Fix the title.' }).expect(200);
      expect(await refusal()).toBe('The reviewer asked for changes. Make them, then ask for a review again.');
      await act(id, 'request', designer).expect(200);
      await act(id, 'approve', publisher).expect(200);
      await publish(id).expect(200);
    });

    it('an approval stands only for what was approved: any change after it needs a new review', async () => {
      const id = await draft(form('CHANGED'));
      await act(id, 'request', designer).expect(200);
      await act(id, 'approve', publisher).expect(200);
      // Saving it unchanged does not undo the approval.
      await h.api().put(`/forms/${id}`).set(h.bearer(designer)).send(form('CHANGED')).expect(200);
      expect((await review(id, designer).expect(200)).body.review).toMatchObject({ status: 'APPROVED', stale: false });
      await h.api().put(`/forms/${id}`).set(h.bearer(designer)).send(form('CHANGED', 'Your full legal name')).expect(200);
      expect((await review(id, designer).expect(200)).body.review).toMatchObject({ status: 'APPROVED', stale: true });
      expect((await publish(id).expect(400)).body.errors[0].message).toBe('This form was changed after it was approved. Ask for a review again.');
      // Scheduling it for later is refused for the same reason.
      await h.api().post(`/forms/${id}/schedule`).set(h.bearer(owner)).send({ at: new Date(Date.now() + 3_600_000).toISOString() }).expect(400);
      await act(id, 'request', designer).expect(200);
      await act(id, 'approve', publisher).expect(200);
      await publish(id).expect(200);
    });

    it('nobody approves their own work: not the one who asked, nor the one who last changed it', async () => {
      const id = await draft(form('SELF'), owner);
      await act(id, 'request', owner).expect(200);
      const mine = (await review(id, owner).expect(200)).body;
      expect(mine.can).toMatchObject({ decide: false, decideBlocked: 'Someone other than the person who asked for the review, or last changed the form, must decide.' });
      expect((await act(id, 'approve', owner).expect(403)).body.message).toBe(mine.can.decideBlocked);

      // The designer asks; the owner edits it and then cannot approve their own edit.
      const other = await draft(form('EDITED'));
      await act(other, 'request', designer).expect(200);
      await h.api().put(`/forms/${other}`).set(h.bearer(owner)).send(form('EDITED', 'Changed by the owner')).expect(200);
      await act(other, 'approve', owner).expect(403);
      await act(other, 'approve', publisher).expect(200);
      await publish(other).expect(200);
    });
  });

  it('people who design or publish a form comment on it and on its fields; comments are resolved, reopened and taken back', async () => {
    const id = await draft(form('COMMENTS'));
    const say = (token: string, body: object) => h.api().post(`/forms/${id}/comments`).set(h.bearer(token)).send(body);
    await say(viewer, { text: 'Hello' }).expect(403);
    expect((await say(designer, { text: ' ' }).expect(400)).body.message).toBe('Write the comment');
    expect((await say(designer, { text: 'x', fieldId: 'nope' }).expect(400)).body.message).toBe('That field is not on this form');

    await say(publisher, { text: 'Is email needed?', fieldId: 'b' }).expect(200);
    const all = (await say(designer, { text: 'Overall this reads well.' }).expect(200)).body.comments;
    expect(all.map((c: { text: string; fieldLabel: string; author: { name: string } }) => [c.text, c.fieldLabel, c.author.name])).toEqual([
      ['Is email needed?', 'Email', 'Pia Publisher'],
      ['Overall this reads well.', '', 'Dev Designer'],
    ]);
    // A viewer can read them with the form, but not add to them.
    expect((await review(id, viewer).expect(200)).body).toMatchObject({ can: { comment: false, request: false, decide: false }, comments: [{ text: 'Is email needed?' }, { text: 'Overall this reads well.' }] });

    const [first, second] = all as { id: string }[];
    const resolved = (await h.api().post(`/forms/${id}/comments/${first.id}/resolve`).set(h.bearer(designer)).expect(200)).body.comments[0];
    expect(resolved).toMatchObject({ resolvedBy: { name: 'Dev Designer' } });
    expect(resolved.resolvedAt).toBeTruthy();
    expect((await h.api().post(`/forms/${id}/comments/${first.id}/reopen`).set(h.bearer(publisher)).expect(200)).body.comments[0].resolvedAt).toBeNull();
    // Only its author takes a comment back.
    await h.api().delete(`/forms/${id}/comments/${second.id}`).set(h.bearer(publisher)).expect(404);
    expect((await h.api().delete(`/forms/${id}/comments/${second.id}`).set(h.bearer(designer)).expect(200)).body.comments).toHaveLength(1);

    // A field renamed or removed later: the comment still says what it was about.
    await h.api().put(`/forms/${id}`).set(h.bearer(designer)).send({ ...form('COMMENTS'), fields: [form('COMMENTS').fields[0]] }).expect(200);
    expect((await review(id, designer).expect(200)).body.comments[0]).toMatchObject({ fieldId: 'b', fieldLabel: 'Email' });
  });

  it('another organisation cannot see or touch any of it, and the setting is the admins\' to change', async () => {
    const id = await draft(form('PRIVATE'));
    await h.signUp('Zed', 'zed@other.test', 'Other');
    const stranger = (await h.login('zed@other.test')).token;
    await review(id, stranger).expect(404);
    await act(id, 'request', stranger).expect(404);
    await h.api().post(`/forms/${id}/comments`).set(h.bearer(stranger)).send({ text: 'x' }).expect(404);
    await h.api().patch('/org').set(h.bearer(designer)).send({ security: { requireReview: true } }).expect(403);
    expect((await h.api().get('/auth/me').set(h.bearer(owner)).expect(200)).body.org.requireReview).toBe(false);
  });
});
