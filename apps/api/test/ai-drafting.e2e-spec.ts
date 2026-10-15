import { FORM_DRAFTER, type FormDrafter } from '../src/ai/drafter';
import { startApp, type Harness } from './harness';

/** Stands in for the AI service: answers what the test says, and remembers what it was sent. */
const service = { sent: [] as string[], answer: async (_d: string): Promise<string> => '' };
const fake: FormDrafter = {
  draft: async (description) => {
    service.sent.push(description);
    return service.answer(description);
  },
};

const GOOD = JSON.stringify({
  title: 'Maintenance complaint',
  description: 'Tell us what needs fixing.',
  questions: [
    { label: 'Which property?', type: 'choice', choices: ['Tower A', 'Tower B'], required: true },
    { label: 'What kind of problem?', type: 'choice', choices: ['Leak', 'Electrical', 'Noise'], required: true },
    { label: 'Is water still coming in?', type: 'yes_no', showWhen: { question: 'What kind of problem?', is: ['Leak'] } },
    { label: 'A photo', type: 'file' },
    { label: 'How urgent is it?', type: 'choice', choices: ['Now', 'Today', 'Can wait'] },
  ],
});
const DESCRIPTION = 'A maintenance complaint for our properties: which property, what kind of problem, a photo, how urgent';

describe('Drafting a form from a description (e2e)', () => {
  let h: Harness;
  let owner: string;
  let designer: string;
  let viewer: string;
  let folder: string;

  beforeAll(async () => {
    h = await startApp({ DEFAULT_PLAN: 'TEAM' }, (b) => b.overrideProvider(FORM_DRAFTER).useValue(fake));
    await h.signUp('Asha', 'asha@acme.test', 'Acme Homes');
    owner = (await h.login('asha@acme.test')).token;
    folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Maintenance' }).expect(201)).body[0].id;
    await h.addMember(owner, 'Dev Designer', 'dev@acme.test', 'DESIGNER');
    designer = (await h.login('dev@acme.test')).token;
  });
  afterAll(() => h?.close());
  beforeEach(() => {
    service.sent = [];
    service.answer = async () => GOOD;
  });

  const draft = (token: string, description = DESCRIPTION) => h.api().post('/ai/form-drafts').set(h.bearer(token)).send({ description, folderId: folder });

  it('is off until an admin turns it on, and only admins can', async () => {
    expect((await h.api().get('/ai/status').set(h.bearer(owner)).expect(200)).body).toEqual({ available: true, enabled: false, used: 0, limit: 50 });
    expect((await draft(owner).expect(403)).body.message).toBe('An admin has not turned on drafting forms from a description (Organisation settings)');
    expect(service.sent).toEqual([]);
    await h.api().patch('/org').set(h.bearer(designer)).send({ ai: { drafting: true } }).expect(403);
    expect((await h.api().patch('/org').set(h.bearer(owner)).send({ ai: { drafting: true } }).expect(200)).body.ai).toEqual({ drafting: true });
    expect((await h.api().get('/ai/status').set(h.bearer(designer)).expect(200)).body).toMatchObject({ available: true, enabled: true });
  });

  it('drafts questions only from the description, which is all the service is sent; the draft is a form that publishes', async () => {
    const res = (await draft(designer).expect(200)).body;
    expect(service.sent).toEqual([DESCRIPTION]);
    expect(res).toMatchObject({ name: 'Maintenance complaint', description: 'Tell us what needs fixing.', leftOut: [], used: 1, limit: 50 });
    expect(res.fields.map((f: { name: string; type: string }) => `${f.name}:${f.type}`)).toEqual(['whichProperty:RADIO', 'whatKindOfProblem:RADIO', 'isWaterStillComingIn:RADIO', 'aPhoto:FILE', 'howUrgentIsIt:RADIO']);
    // Made into a form like any draft, it publishes as it is.
    const id = (await h.api().post('/forms').set(h.bearer(designer)).send({ folderId: folder, definition: { name: res.name, code: 'AI_MAINT', businessId: '', access: 'PUBLIC', submission: { method: 'POST', endpointId: 'default-submit' }, fields: res.fields } }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
  });

  it('an answer that tries to add a workflow, a webhook or a script gets questions only, and says what it left out', async () => {
    service.answer = async () =>
      JSON.stringify({
        title: 'Request',
        questions: [{ label: 'Name', type: 'short_text' }, { label: 'x', type: 'html', html: '<script>steal()</script>' }],
        workflow: { enabled: true, statuses: [{ key: 'NEW', label: 'New', category: 'OPEN' }] },
        automations: [{ when: 'SUBMITTED', actions: [{ type: 'WEBHOOK', url: 'https://evil.example/hook' }] }],
      });
    const res = (await draft(designer).expect(200)).body;
    expect(res.fields).toEqual([{ id: 'ai_1', type: 'TEXT', name: 'name', label: 'Name' }]);
    expect(res.leftOut).toEqual(['"workflow" in the answer: only questions are drafted', '"automations" in the answer: only questions are drafted', '"x": "html" is not a kind of question that is drafted']);
    expect(JSON.stringify(res)).not.toMatch(/evil|steal|statuses/);
  });

  it('a broken answer drafts nothing and does not count; a service that takes too long is said so and does not count', async () => {
    const before = (await h.api().get('/ai/status').set(h.bearer(owner))).body.used;
    service.answer = async () => 'I am sorry, I cannot do that';
    const broken = (await draft(designer).expect(200)).body;
    expect(broken.fields).toEqual([]);
    expect(broken.leftOut[0]).toMatch(/not in the form asked for/);
    service.answer = async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    };
    expect((await draft(designer).expect(503)).body.message).toBe('The AI service took too long. Try again in a moment.');
    service.answer = async () => {
      throw new Error('the AI service answered 529');
    };
    expect((await draft(designer).expect(503)).body.message).toBe('The AI service could not be reached. Try again in a moment.');
    expect((await h.api().get('/ai/status').set(h.bearer(owner))).body.used).toBe(before);
  });

  it('who may use it: someone who can make a form in that folder; a description of a sensible length', async () => {
    await h.addMember(owner, 'Vi Viewer', 'vi@acme.test', 'VIEWER');
    viewer = (await h.login('vi@acme.test')).token;
    await draft(viewer).expect(403);
    await draft(designer, 'form').expect(400);
    await draft(designer, 'x'.repeat(2001)).expect(400);
    await h.api().post('/ai/form-drafts').set(h.bearer(designer)).send({ description: DESCRIPTION, folderId: 'not-a-folder' }).expect((r) => expect([403, 404]).toContain(r.status));
  });

  it('a monthly allowance by plan; each use is in the audit log', async () => {
    const left = 50 - (await h.api().get('/ai/status').set(h.bearer(owner))).body.used;
    for (let i = 0; i < left; i++) await draft(designer).expect(200);
    expect((await draft(designer).expect(429)).body.message).toBe("This month's drafts from a description are used up. Start from a template or a blank form instead.");
    const entries = (await h.api().get('/audit?limit=200').set(h.bearer(owner)).expect(200)).body.entries.filter((e: { action: string }) => e.action === 'form.ai_drafted');
    expect(entries.length).toBeGreaterThanOrEqual(50);
    expect(entries[0].after).toMatchObject({ description: DESCRIPTION, questions: 5 });
  });

  it('an installation without an AI service does not offer it', async () => {
    const plain = await startApp();
    try {
      await plain.signUp('Zed', 'zed@other.test', 'Other');
      const z = (await plain.login('zed@other.test')).token;
      expect((await plain.api().get('/ai/status').set(plain.bearer(z)).expect(200)).body).toMatchObject({ available: false });
    } finally {
      await plain.close();
    }
  });
});
