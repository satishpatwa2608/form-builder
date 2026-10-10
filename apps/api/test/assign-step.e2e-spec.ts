import { startApp, type Harness } from './harness';

/** An Assign step that works out the person as it runs (AEM's "dynamic participant"). */
describe('Workflow: who a step gives the record to (e2e)', () => {
  let h: Harness;
  let owner: string;
  let orgId: string;
  let folder: string;
  let nia: string;
  let sam: string;
  const waitFor = async <T>(get: () => Promise<T | undefined>, what: string): Promise<T> => {
    for (let i = 0; i < 200; i++) {
      const v = await get();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const form = (code: string, step: object) => ({
    name: `Request ${code}`,
    code,
    businessId: '',
    access: 'PUBLIC',
    submission: { method: 'POST', endpointId: 'default-submit' },
    fields: [
      { id: 'r', type: 'DROPDOWN', name: 'region', label: 'Region', dataSource: { type: 'STATIC', options: [{ label: 'North', value: 'NORTH' }, { label: 'South', value: 'SOUTH' }, { label: 'East', value: 'EAST' }] } },
      { id: 'e', type: 'EMAIL', name: 'ownerEmail', label: 'Account owner' },
    ],
    workflow: { enabled: true, refPrefix: code.slice(0, 3), statuses: [{ key: 'NEW', label: 'New', category: 'OPEN' }, { key: 'DONE', label: 'Done', category: 'DONE' }], assignment: { type: 'NONE' } },
    automations: [{ id: 'a1', name: 'Give it to someone', enabled: true, when: 'SUBMITTED', actions: [{ id: 'give', type: 'ASSIGN', userId: '', ...step }] }],
  });
  const publish = async (definition: object, expected = 200) => {
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition }).expect(201)).body.definition.id as string;
    return h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(expected);
  };
  /** Sends one response and says who ends up with it, once the step has run (or failed). */
  const sentTo = async (code: string, values: object) => {
    const { submissionId } = (await h.api().post(`/public/forms/${code}/submissions?org=${orgId}`).send({ values }).expect(201)).body as { submissionId: string };
    return waitFor(async () => {
      const detail = (await h.api().get(`/records/${submissionId}`).set(h.bearer(owner)).expect(200)).body as { record: { assigneeId: string }; events: { message: string }[] };
      const said = detail.events.map((e) => e.message).join(' | ');
      return /assigned|no one to give it to/.test(said) ? { to: detail.record.assigneeId, said } : undefined;
    }, 'the step to run');
  };

  beforeAll(async () => {
    h = await startApp();
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Ops' }).expect(201)).body[0].id;
    nia = await h.addMember(owner, 'Nia', 'nia@acme.test', 'RECORDS_WORKER');
    sam = await h.addMember(owner, 'Sam', 'sam@acme.test', 'RECORDS_WORKER');
  });
  afterAll(async () => h?.close());

  it('each way of choosing must be set up before the form goes live', async () => {
    const said = async (step: object) => JSON.stringify((await publish(form(`BAD${Math.random().toString(36).slice(2, 7).toUpperCase()}`, step), 400)).body);
    expect(await said({})).toContain('choose who to assign');
    expect(await said({ by: 'ANSWER', field: 'nothing' })).toContain('choose the answer that decides who gets it');
    expect(await said({ by: 'ANSWER', field: 'region' })).toContain('say who gets it for each answer');
    expect(await said({ by: 'TURN', userIds: [] })).toContain('choose the people who take it in turn');
    expect(await said({ by: 'EMAIL', from: ' ' })).toContain("say where the person's email comes from");
  });

  it('by an answer: each answer has its person, and any other answer goes to the one named for the rest', async () => {
    await publish(form('BYANS', { by: 'ANSWER', field: 'region', map: { NORTH: nia }, userId: sam }));
    expect((await sentTo('BYANS', { region: 'NORTH' })).to).toBe(nia);
    expect((await sentTo('BYANS', { region: 'SOUTH' })).to).toBe(sam);
    expect((await sentTo('BYANS', {})).to).toBe(sam);
  });

  it('in turn: the people named take one each, round and round', async () => {
    await publish(form('TURNS', { by: 'TURN', userIds: [nia, sam] }));
    const got = [];
    for (let i = 0; i < 4; i++) got.push((await sentTo('TURNS', { region: 'EAST' })).to);
    expect(got).toEqual([nia, sam, nia, sam]);
  });

  it('by an email: an answer (or what an earlier step returned) names the member; someone who is not one gets nothing, and the step says so', async () => {
    await publish(form('BYMAIL', { by: 'EMAIL', from: '{{ownerEmail}}' }));
    expect((await sentTo('BYMAIL', { ownerEmail: 'Sam@Acme.test' })).to).toBe(sam);
    const stranger = await sentTo('BYMAIL', { ownerEmail: 'someone@elsewhere.test' });
    expect(stranger.to).toBeFalsy();
    expect(stranger.said).toContain('there is no one to give it to');
    expect((await sentTo('BYMAIL', {})).said).toContain('there is no one to give it to');
  });

  it('a person chosen in advance still works as before', async () => {
    await publish(form('FIXED', { userId: nia }));
    expect((await sentTo('FIXED', { region: 'SOUTH' })).to).toBe(nia);
  });
});
