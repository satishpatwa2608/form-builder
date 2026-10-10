import { FormAutomationService } from '../src/work/services/form-automation.service';
import { startApp, type Harness } from './harness';

/**
 * Two things a team that works a queue needs (AEM's "out of office", and tasks that several people must
 * answer or that act when nobody does): someone away hands their new work to a colleague, and an approval
 * can need everyone and can do something when its time runs out.
 */
describe('Work: away, and approvals that need everyone or run out of time (e2e)', () => {
  let h: Harness;
  let owner: string;
  let ownerId: string;
  let orgId: string;
  let folder: string;
  let nia: string;
  let sam: string;
  let niaToken: string;
  let samToken: string;

  const form = (code: string, extra: { assignTo?: string; approval?: object } = {}) => ({
    name: `Request ${code}`,
    code,
    businessId: '',
    access: 'PUBLIC',
    submission: { method: 'POST', endpointId: 'default-submit' },
    fields: [{ id: 'w', type: 'TEXT', name: 'what', label: 'What' }],
    workflow: {
      enabled: true,
      refPrefix: code.slice(0, 3),
      statuses: [
        { key: 'NEW', label: 'New', category: 'OPEN' },
        { key: 'REFUSED', label: 'Refused', category: 'OPEN' },
        { key: 'DONE', label: 'Done', category: 'DONE' },
      ],
      assignment: extra.assignTo ? { type: 'USER', userId: extra.assignTo } : { type: 'NONE' },
      actions: [{ key: 'close', label: 'Close', from: ['NEW', 'REFUSED'], to: 'DONE', ...(extra.approval ? { approval: { onReject: 'REFUSED', ...extra.approval } } : {}) }],
    },
  });
  const publish = async (definition: object) => {
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition }).expect(201)).body.definition.id as string;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
  };
  const send = async (code: string) => (await h.api().post(`/public/forms/${code}/submissions?org=${orgId}`).send({ values: { what: 'A thing' } }).expect(201)).body.submissionId as string;
  const record = async (id: string) => (await h.api().get(`/records/${id}`).set(h.bearer(owner)).expect(200)).body as { record: { assigneeId: string; status: string }; events: { type: string; message: string; data?: Record<string, unknown> }[]; approvals: { runId: string; status: string; approvers: string[]; decision: string | null }[] };
  const away = (token: string, body: object, expected = 200) => h.api().patch('/away').set(h.bearer(token)).send(body).expect(expected);
  /** Asks for the close, and returns the approval now waiting. */
  const askToClose = async (id: string) => {
    const asked = (await h.api().post(`/records/${id}/actions/close`).set(h.bearer(owner)).send({}).expect(200)).body as Awaited<ReturnType<typeof record>>;
    return asked.approvals.find((a) => a.status === 'WAITING')!;
  };
  const decide = (token: string, id: string, runId: string, decision: 'APPROVED' | 'REJECTED', expected = 200) => h.api().post(`/records/${id}/approvals/${runId}`).set(h.bearer(token)).send({ decision }).expect(expected);
  const hoursOn = (n: number) => new Date(Date.now() + n * 3600_000);

  beforeAll(async () => {
    h = await startApp();
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    const me = (await h.api().get('/auth/me').set(h.bearer(owner))).body;
    orgId = me.org.id;
    ownerId = me.user.id;
    folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Ops' }).expect(201)).body[0].id;
    nia = await h.addMember(owner, 'Nia', 'nia@acme.test', 'RECORDS_WORKER');
    sam = await h.addMember(owner, 'Sam', 'sam@acme.test', 'RECORDS_WORKER');
    niaToken = (await h.login('nia@acme.test')).token;
    samToken = (await h.login('sam@acme.test')).token;
    await publish(form('TONIA', { assignTo: nia }));
  });
  afterAll(async () => h?.close());

  describe('away', () => {
    afterEach(async () => {
      await away(niaToken, { off: true });
      await away(samToken, { off: true });
    });

    it('new work meant for someone away goes to the person they named, and comes back to them when they return', async () => {
      expect((await record(await send('TONIA'))).record.assigneeId).toBe(nia);
      const set = (await away(niaToken, { toUserId: sam })).body;
      expect(set).toMatchObject({ set: true, now: true, until: null, toUserId: sam });
      expect((await h.api().get('/away').set(h.bearer(niaToken)).expect(200)).body).toMatchObject({ now: true, toUserId: sam });
      expect((await record(await send('TONIA'))).record.assigneeId).toBe(sam);
      await away(niaToken, { off: true });
      expect((await record(await send('TONIA'))).record.assigneeId).toBe(nia);
    });

    it('what they already hold stays with them; giving them something by hand goes to the stand-in, and the timeline says so', async () => {
      const held = await send('TONIA');
      await away(niaToken, { toUserId: sam });
      expect((await record(held)).record.assigneeId).toBe(nia);

      await publish(form('NOONE'));
      const id = await send('NOONE');
      await h.api().post(`/records/${id}/assign`).set(h.bearer(owner)).send({ userId: nia, note: 'Please look at this first' }).expect(200);
      const after = await record(id);
      expect(after.record.assigneeId).toBe(sam);
      const event = after.events.find((e) => e.type === 'ASSIGNED')!;
      expect(event).toMatchObject({ message: 'Please look at this first', data: { to: sam, insteadOf: nia } });
    });

    it('away from a day still to come changes nothing yet; an end that has passed is over', async () => {
      const later = (await away(niaToken, { from: hoursOn(48).toISOString(), until: hoursOn(96).toISOString(), toUserId: sam })).body;
      expect(later).toMatchObject({ set: true, now: false });
      expect((await record(await send('TONIA'))).record.assigneeId).toBe(nia);
      await away(niaToken, { from: hoursOn(-48).toISOString(), until: hoursOn(-1).toISOString(), toUserId: sam }, 400);
    });

    it('two people away for each other, or away with nobody named, leave the work where it was meant to go', async () => {
      await away(niaToken, { toUserId: sam });
      await away(samToken, { toUserId: nia });
      expect((await record(await send('TONIA'))).record.assigneeId).toBe(nia);
      await away(samToken, { off: true });
      await away(niaToken, {});
      expect((await record(await send('TONIA'))).record.assigneeId).toBe(nia);
    });

    it('nobody stands in for themselves, the stand-in must be a member, and only an administrator sets it for someone else', async () => {
      expect(JSON.stringify((await away(niaToken, { toUserId: nia }, 400)).body)).toContain('stand in for themselves');
      expect(JSON.stringify((await away(niaToken, { toUserId: 'not-a-member' }, 400)).body)).toContain('active member');
      await h.api().patch(`/members/${sam}/away`).set(h.bearer(niaToken)).send({ toUserId: nia }).expect(403);
      await h.api().patch(`/members/${nia}/away`).set(h.bearer(owner)).send({ toUserId: sam }).expect(200);
      const listed = (await h.api().get('/members').set(h.bearer(owner)).expect(200)).body as { userId: string; away: { now: boolean; toUserId: string } }[];
      expect(listed.find((m) => m.userId === nia)!.away).toMatchObject({ now: true, toUserId: sam });
    });

    it('an approval meant for someone away is asked of their stand-in', async () => {
      await publish(form('AWAYAP', { approval: { to: [{ kind: 'USER', userId: nia }] } }));
      await away(niaToken, { toUserId: sam });
      const id = await send('AWAYAP');
      expect((await askToClose(id)).approvers).toEqual([sam]);
    });
  });

  describe('a team\'s queue, and a manager\'s people', () => {
    let queued: string;
    let zoe: string;
    let zoeToken: string;
    const mine = async (token: string, query = '') => ((await h.api().get(`/records?${query}`).set(h.bearer(token)).expect(200)).body.rows as { uuid: string }[]).map((r) => r.uuid);

    beforeAll(async () => {
      zoe = await h.addMember(owner, 'Zoe', 'zoe@acme.test', 'RECORDS_WORKER');
      zoeToken = (await h.login('zoe@acme.test')).token;
      await h.api().patch(`/members/${sam}`).set(h.bearer(owner)).send({ department: 'Claims' }).expect(200);
      // The team: Nia by name, and everyone in Claims (Sam). Zoe is in neither.
      await publish({ ...form('QUEUE'), recordAccess: { mode: 'TEAM', userIds: [nia], departments: ['Claims'] } });
      queued = await send('QUEUE');
    });

    it('work nobody has taken is seen by the team, by name or by department, and by no one else', async () => {
      expect(await mine(niaToken, 'assignee=unassigned')).toContain(queued);
      expect(await mine(samToken, 'assignee=unassigned')).toContain(queued);
      expect(await mine(zoeToken, 'assignee=unassigned')).not.toContain(queued);
      await h.api().get(`/records/${queued}`).set(h.bearer(zoeToken)).expect(404);
      expect((await h.api().get(`/records/${queued}`).set(h.bearer(samToken)).expect(200)).body.canTake).toBe(true);
    });

    it('"Take it": the first to press has it; the next is told who took it; an outsider cannot', async () => {
      await h.api().post(`/records/${queued}/take`).set(h.bearer(zoeToken)).expect(404);
      const taken = (await h.api().post(`/records/${queued}/take`).set(h.bearer(samToken)).expect(200)).body;
      expect(taken.record.assigneeId).toBe(sam);
      expect(taken.canTake).toBe(false);
      // It has left the queue, so the rest of the team no longer sees it.
      await h.api().post(`/records/${queued}/take`).set(h.bearer(niaToken)).expect(404);
      expect(await mine(niaToken, 'assignee=unassigned')).not.toContain(queued);
      expect((await record(queued)).events.find((e) => e.type === 'ASSIGNED')!.data).toMatchObject({ to: sam, took: true });
    });

    it('two pressing at the same moment: exactly one gets it', async () => {
      const id = await send('QUEUE');
      const both = await Promise.all([h.api().post(`/records/${id}/take`).set(h.bearer(niaToken)), h.api().post(`/records/${id}/take`).set(h.bearer(samToken))]);
      expect(both.map((r) => r.status).sort()).toEqual([200, expect.any(Number)]);
      expect(both.filter((r) => r.status === 200)).toHaveLength(1);
      const loser = both.find((r) => r.status !== 200)!;
      expect([404, 409]).toContain(loser.status);
      expect([nia, sam]).toContain((await record(id)).record.assigneeId);
    });

    it('a manager sees what their people hold, can open it and give it to someone else; others still cannot', async () => {
      await h.api().patch(`/members/${sam}`).set(h.bearer(owner)).send({ managerId: zoe }).expect(200);
      expect(await mine(zoeToken, 'assignee=reports')).toContain(queued);
      await h.api().get(`/records/${queued}`).set(h.bearer(zoeToken)).expect(200);
      expect(await mine(niaToken, 'assignee=reports')).toEqual([]);
      await h.api().post(`/records/${queued}/assign`).set(h.bearer(zoeToken)).send({ userId: nia, note: 'Sam is on leave tomorrow' }).expect(200);
      expect((await record(queued)).record.assigneeId).toBe(nia);
      await h.api().patch(`/members/${sam}`).set(h.bearer(owner)).send({ managerId: '' }).expect(200);
    });
  });

  describe('approvals', () => {
    beforeAll(async () => {
      const both = [{ kind: 'USER', userId: nia }, { kind: 'USER', userId: sam }];
      await publish(form('ALLAP', { approval: { to: both, need: 'ALL' } }));
      await publish(form('ANYAP', { approval: { to: both } }));
      await publish(form('LATEREJ', { approval: { to: both, dueInHours: 4, whenLate: 'REJECT' } }));
      await publish(form('LATEMGR', { approval: { to: both, need: 'ALL', dueInHours: 4, whenLate: 'MANAGER' } }));
      await publish(form('LATEREM', { approval: { to: both, dueInHours: 4 } }));
      await h.api().patch(`/members/${nia}`).set(h.bearer(owner)).send({ managerId: ownerId }).expect(200);
    });

    it('everyone must approve: the first approval is noted and the record waits; the last one makes the move', async () => {
      const id = await send('ALLAP');
      const run = await askToClose(id);
      await decide(niaToken, id, run.runId, 'APPROVED');
      const waiting = await record(id);
      expect(waiting.record.status).toBe('NEW');
      expect(waiting.events.some((e) => e.data?.phase === 'approved-by-one')).toBe(true);
      // It is no longer waiting on the one who has answered.
      expect((await h.api().get('/records?waiting=me').set(h.bearer(niaToken)).expect(200)).body.total).toBe(0);
      expect((await h.api().get('/records?waiting=me').set(h.bearer(samToken)).expect(200)).body.total).toBeGreaterThanOrEqual(1);
      await decide(samToken, id, run.runId, 'APPROVED');
      expect((await record(id)).record.status).toBe('DONE');
    });

    it('everyone must approve: one rejection refuses it at once', async () => {
      const id = await send('ALLAP');
      const run = await askToClose(id);
      await decide(niaToken, id, run.runId, 'APPROVED');
      await decide(samToken, id, run.runId, 'REJECTED');
      expect((await record(id)).record.status).toBe('REFUSED');
    });

    it('left as it was, the first answer still decides', async () => {
      const id = await send('ANYAP');
      const run = await askToClose(id);
      await decide(samToken, id, run.runId, 'APPROVED');
      expect((await record(id)).record.status).toBe('DONE');
      // Already settled: a second answer is refused.
      await decide(niaToken, id, run.runId, 'APPROVED', 409);
    });

    it('time runs out: refused when the form says so, and only once', async () => {
      const id = await send('LATEREJ');
      await askToClose(id);
      const sweeper = h.app.get(FormAutomationService);
      await sweeper.sweep(hoursOn(1));
      expect((await record(id)).record.status).toBe('NEW');
      await sweeper.sweep(hoursOn(5));
      const after = await record(id);
      expect(after.record.status).toBe('REFUSED');
      expect(after.events.filter((e) => e.data?.phase === 'late')).toHaveLength(1);
      await sweeper.sweep(hoursOn(6));
      expect((await record(id)).events.filter((e) => e.data?.phase === 'late')).toHaveLength(1);
    });

    it('time runs out: whoever has not answered gives way to their manager; someone with no manager keeps it', async () => {
      const id = await send('LATEMGR');
      const run = await askToClose(id);
      await h.app.get(FormAutomationService).sweep(hoursOn(5));
      const after = await record(id);
      expect(after.record.status).toBe('NEW');
      expect([...after.approvals.find((a) => a.runId === run.runId)!.approvers].sort()).toEqual([ownerId, sam].sort());
      // It is no longer hers to answer.
      await decide(niaToken, id, run.runId, 'APPROVED', 403);
      await decide(samToken, id, run.runId, 'APPROVED');
      await decide(owner, id, run.runId, 'APPROVED');
      expect((await record(id)).record.status).toBe('DONE');
    });

    it('time runs out: otherwise the people still to answer are reminded', async () => {
      const id = await send('LATEREM');
      await askToClose(id);
      const before = (await h.api().get('/notifications').set(h.bearer(niaToken)).expect(200)).body.unread as number;
      await h.app.get(FormAutomationService).sweep(hoursOn(5));
      const after = await record(id);
      expect(after.record.status).toBe('NEW');
      expect(after.events.find((e) => e.data?.phase === 'late')!.data).toMatchObject({ did: 'REMIND', approvers: [nia, sam] });
      expect((await h.api().get('/notifications').set(h.bearer(niaToken)).expect(200)).body.unread).toBe(before + 1);
    });
  });
});
