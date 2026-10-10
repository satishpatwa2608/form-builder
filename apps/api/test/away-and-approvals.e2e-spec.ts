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
    await publish(form('ANYAP2', { approval: { to: [{ kind: 'USER', userId: nia }, { kind: 'USER', userId: sam }] } }));
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
      // The history can name the person it was meant for, who has done nothing on this record.
      expect((after as unknown as { people: Record<string, { name: string }> }).people[nia]?.name).toBe('Nia');
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

  describe('sharing my list', () => {
    it('a colleague I share with sees and opens what I hold; nobody else does; I can stop sharing', async () => {
      const id = await send('TONIA');
      const list = async (token: string) => ((await h.api().get('/records?assignee=shared').set(h.bearer(token)).expect(200)).body.rows as { uuid: string }[]).map((r) => r.uuid);
      await h.api().get(`/records/${id}`).set(h.bearer(samToken)).expect(404);
      expect((await h.api().patch('/sharing').set(h.bearer(niaToken)).send({ userIds: [sam, nia] }).expect(200)).body).toEqual({ sharedWith: [sam] });
      expect((await h.api().get('/sharing').set(h.bearer(niaToken)).expect(200)).body).toEqual({ sharedWith: [sam] });
      expect(await list(samToken)).toContain(id);
      await h.api().get(`/records/${id}`).set(h.bearer(samToken)).expect(200);
      // Sharing goes one way: Nia does not see what Sam holds.
      expect(await list(niaToken)).toEqual([]);
      await h.api().patch('/sharing').set(h.bearer(niaToken)).send({ userIds: ['not-a-member'] }).expect(400);
      await h.api().patch('/sharing').set(h.bearer(niaToken)).send({ userIds: [] }).expect(200);
      await h.api().get(`/records/${id}`).set(h.bearer(samToken)).expect(404);
    });
  });

  describe('sending it back', () => {
    it('whoever was handed a record returns it in one press to the person who handed it over, once', async () => {
      const id = await send('TONIA');
      // Nobody handed it to Nia (the form's rule gave it to her): she has nobody to send it back to.
      expect((await h.api().get(`/records/${id}`).set(h.bearer(niaToken)).expect(200)).body.canSendBack).toBe(false);
      await h.api().post(`/records/${id}/send-back`).set(h.bearer(niaToken)).send({}).expect(400);

      await h.api().post(`/records/${id}/assign`).set(h.bearer(niaToken)).send({ userId: sam, note: 'Yours, I think' }).expect(200);
      expect((await h.api().get(`/records/${id}`).set(h.bearer(samToken)).expect(200)).body.canSendBack).toBe(true);
      // Only the one who holds it can send it back.
      await h.api().post(`/records/${id}/send-back`).set(h.bearer(owner)).send({}).expect(403);
      await h.api().post(`/records/${id}/send-back`).set(h.bearer(samToken)).send({ note: 'Not mine: it is a warranty case' }).expect(200);
      const after = await record(id);
      expect(after.record.assigneeId).toBe(nia);
      expect(after.events.filter((e) => e.type === 'ASSIGNED').at(-1)).toMatchObject({ message: 'Not mine: it is a warranty case', data: { from: sam, to: nia } });
      // It does not bounce: Nia is not offered a "send it back" of her own.
      expect((await h.api().get(`/records/${id}`).set(h.bearer(niaToken)).expect(200)).body.canSendBack).toBe(false);
    });
  });

  describe('asking a colleague', () => {
    it('the colleague sees the record and answers; it stays with its owner; then the colleague loses sight of it', async () => {
      const id = await send('TONIA');
      // Sam has nothing to do with it yet.
      await h.api().get(`/records/${id}`).set(h.bearer(samToken)).expect(404);
      const asked = (await h.api().post(`/records/${id}/ask`).set(h.bearer(niaToken)).send({ userId: sam, question: 'Is this covered by the warranty?' }).expect(200)).body;
      expect(asked.record.assigneeId).toBe(nia);
      expect(asked.record.asks).toEqual([expect.objectContaining({ by: nia, to: sam, question: 'Is this covered by the warranty?', answeredAt: null })]);
      // Asked twice while unanswered: no.
      await h.api().post(`/records/${id}/ask`).set(h.bearer(niaToken)).send({ userId: sam, question: 'Again?' }).expect(409);

      const seen = (await h.api().get(`/records/${id}`).set(h.bearer(samToken)).expect(200)).body;
      expect(seen.askedOfMe).toMatchObject({ question: 'Is this covered by the warranty?' });
      expect((await h.api().get('/records').set(h.bearer(samToken)).expect(200)).body.rows.map((r: { uuid: string }) => r.uuid)).toContain(id);
      // He can read and answer, and nothing else.
      await h.api().post(`/records/${id}/assign`).set(h.bearer(samToken)).send({ userId: sam }).expect(403);
      await h.api().post(`/records/${id}/actions/close`).set(h.bearer(samToken)).send({}).expect(403);
      await h.api().post(`/records/${id}/priority`).set(h.bearer(samToken)).send({ priority: 'HIGH' }).expect(403);

      const before = (await h.api().get('/notifications').set(h.bearer(niaToken)).expect(200)).body.unread as number;
      expect((await h.api().post(`/records/${id}/answer`).set(h.bearer(samToken)).send({ answer: 'Yes, until March.' }).expect(200)).body).toEqual({ gone: true });
      await h.api().get(`/records/${id}`).set(h.bearer(samToken)).expect(404);
      await h.api().post(`/records/${id}/answer`).set(h.bearer(samToken)).send({ answer: 'Twice' }).expect(404);
      const after = await record(id);
      expect(after.record.assigneeId).toBe(nia);
      expect(after.events.filter((e) => e.type === 'ASK').map((e) => [e.data?.phase, e.message])).toEqual([['asked', 'Is this covered by the warranty?'], ['answered', 'Yes, until March.']]);
      expect((await h.api().get('/notifications').set(h.bearer(niaToken)).expect(200)).body.unread).toBe(before + 1);
    });

    it('needs a question and a colleague who works records, other than oneself', async () => {
      const id = await send('TONIA');
      await h.api().post(`/records/${id}/ask`).set(h.bearer(niaToken)).send({ userId: sam, question: ' ' }).expect(400);
      await h.api().post(`/records/${id}/ask`).set(h.bearer(niaToken)).send({ userId: nia, question: 'Me?' }).expect(400);
      await h.api().post(`/records/${id}/ask`).set(h.bearer(niaToken)).send({ userId: 'nobody', question: 'Who?' }).expect(400);
      await h.api().post(`/records/${id}/answer`).set(h.bearer(niaToken)).send({ answer: 'Nothing asked' }).expect(400);
    });
  });

  describe('answering an approval from the email', () => {
    const keyFor = (email: string) => {
      const mail = [...h.outbox].reverse().find((m) => m.to === email && m.text.includes('/answer?key='));
      return mail ? /answer\?key=(fbap_[A-Za-z0-9_-]+)/.exec(mail.text)![1]! : undefined;
    };
    const waitForKey = async (email: string) => {
      for (let i = 0; i < 200; i++) {
        const key = keyFor(email);
        if (key) return key;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`no approval link was emailed to ${email}`);
    };
    const look = (key: string, expected = 200) => h.api().post('/public/approvals/look').send({ key }).expect(expected);
    const answer = (key: string, decision: string, expected = 200) => h.api().post('/public/approvals/decide').send({ key, decision, comment: 'From my phone' }).expect(expected);

    beforeAll(async () => {
      const both = [{ kind: 'USER', userId: nia }, { kind: 'USER', userId: sam }];
      await publish(form('MAILAP', { approval: { to: both, need: 'ALL', byEmail: true } }));
    });

    it('a form that has not asked for it sends no such link', async () => {
      h.outbox.length = 0;
      await askToClose(await send('ANYAP2'));
      await new Promise((r) => setTimeout(r, 300));
      expect(h.outbox.some((m) => m.text.includes('/answer?key='))).toBe(false);
    });

    it('each approver gets their own link; opening it decides nothing; the button does, once', async () => {
      h.outbox.length = 0;
      const id = await send('MAILAP');
      const run = await askToClose(id);
      const niaKey = await waitForKey('nia@acme.test');
      const samKey = await waitForKey('sam@acme.test');
      expect(niaKey).not.toBe(samKey);
      // Nothing about the keys reaches a screen.
      expect(JSON.stringify(await record(id))).not.toMatch(/fbap_|"keys"|hash/);

      expect((await look(niaKey)).body).toEqual({ title: run.runId ? expect.any(String) : '', instructions: '', form: 'Request MAILAP', reference: expect.stringMatching(/^MAI-/), askedOf: 'Nia', open: true, decision: null });
      expect((await record(id)).record.status).toBe('NEW');

      expect((await answer(niaKey, 'APPROVED')).body).toEqual({ done: true });
      // Everyone must approve: hers is noted, the record waits for Sam, and her link is spent.
      expect((await record(id)).record.status).toBe('NEW');
      await look(niaKey, 404);
      await answer(niaKey, 'APPROVED', 404);

      await answer(samKey, 'APPROVED');
      const after = await record(id);
      expect(after.record.status).toBe('DONE');
      expect(after.events.some((e) => e.type === 'APPROVAL' && e.message === 'From my phone')).toBe(true);
    });

    it('a made-up key, an answer that is neither, and a link whose time has passed are all refused', async () => {
      h.outbox.length = 0;
      const id = await send('MAILAP');
      await askToClose(id);
      const key = await waitForKey('sam@acme.test');
      await look('fbap_' + 'x'.repeat(40), 404);
      await look('not a key', 404);
      await answer(key, 'MAYBE', 400);
      // Someone who no longer works records cannot answer with an old email.
      await h.api().patch(`/members/${sam}`).set(h.bearer(owner)).send({ status: 'DISABLED' }).expect(200);
      await answer(key, 'APPROVED', 403);
      await h.api().patch(`/members/${sam}`).set(h.bearer(owner)).send({ status: 'ACTIVE' }).expect(200);
      samToken = (await h.login('sam@acme.test')).token;
      expect((await record(id)).record.status).toBe('NEW');
    });
  });

  describe('approvals asked at the same time', () => {
    const waitFor = async <T>(get: () => Promise<T | undefined | false>, what: string): Promise<T> => {
      for (let i = 0; i < 200; i++) {
        const v = await get();
        if (v) return v;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`timed out waiting for ${what}`);
    };
    const decision = (way: 'APPROVED' | 'REJECTED') => ({ field: '$steps.ask.decision', operator: 'equals', value: way });
    /** The approvals of a record that are waiting for someone, by title. */
    const waiting = async (id: string) => (await record(id)).approvals.filter((a) => a.status === 'WAITING' && a.approvers.length) as unknown as { runId: string; title: string; approvers: string[] }[];

    beforeAll(async () => {
      await publish({
        ...form('TOGETHER'),
        automations: [
          {
            id: 'a',
            name: 'Legal and finance',
            enabled: true,
            when: 'SUBMITTED',
            actions: [
              { id: 'ask', type: 'APPROVAL', to: [{ kind: 'USER', userId: nia }], title: 'Legal', together: [{ to: [{ kind: 'USER', userId: sam }], title: 'Finance' }] },
              { id: 'yes', type: 'SET_STATUS', status: 'DONE', if: decision('APPROVED') },
              { id: 'no', type: 'SET_STATUS', status: 'REFUSED', if: decision('REJECTED') },
            ],
          },
        ],
      });
    });

    it('each person is asked their own question at once; the flow goes on only when both have approved', async () => {
      const id = await send('TOGETHER');
      const asked = await waitFor(async () => ((await waiting(id)).length === 2 ? waiting(id) : undefined), 'both approvals to be asked');
      expect(asked.map((a) => [a.title, a.approvers]).sort()).toEqual([['Finance', [sam]], ['Legal', [nia]]]);
      // Each sees only their own, and cannot answer the other's.
      const legal = asked.find((a) => a.title === 'Legal')!;
      const finance = asked.find((a) => a.title === 'Finance')!;
      await decide(samToken, id, legal.runId, 'APPROVED', 403);

      await decide(niaToken, id, legal.runId, 'APPROVED');
      expect((await record(id)).record.status).toBe('NEW');
      expect((await waiting(id)).map((a) => a.title)).toEqual(['Finance']);
      await decide(samToken, id, finance.runId, 'APPROVED');
      await waitFor(async () => (await record(id)).record.status === 'DONE', 'the flow to carry on');
      expect((await record(id)).events.filter((e) => e.data?.phase === 'part')).toHaveLength(2);
    });

    it('one rejection settles it: the other is no longer asked, and the rejected branch runs', async () => {
      const id = await send('TOGETHER');
      const asked = await waitFor(async () => ((await waiting(id)).length === 2 ? waiting(id) : undefined), 'both approvals to be asked');
      const finance = asked.find((a) => a.title === 'Finance')!;
      const legal = asked.find((a) => a.title === 'Legal')!;
      await decide(samToken, id, finance.runId, 'REJECTED');
      await waitFor(async () => (await record(id)).record.status === 'REFUSED', 'the rejected branch');
      expect(await waiting(id)).toEqual([]);
      await decide(niaToken, id, legal.runId, 'APPROVED', 409);
    });

    it('both answering at the same moment carries the flow on once', async () => {
      const id = await send('TOGETHER');
      const asked = await waitFor(async () => ((await waiting(id)).length === 2 ? waiting(id) : undefined), 'both approvals to be asked');
      await Promise.all([decide(niaToken, id, asked.find((a) => a.title === 'Legal')!.runId, 'APPROVED'), decide(samToken, id, asked.find((a) => a.title === 'Finance')!.runId, 'APPROVED')]);
      await waitFor(async () => (await record(id)).record.status === 'DONE', 'the flow to carry on');
      await new Promise((r) => setTimeout(r, 200));
      const moves = (await record(id)).events.filter((e) => e.type === 'STATUS');
      expect(moves).toHaveLength(1);
    });

    it('a part with nobody to ask stops the step, and a form must say who and what for each', async () => {
      const bad = { ...form('TOGBAD'), automations: [{ id: 'a', name: 'A', enabled: true, when: 'SUBMITTED', actions: [{ id: 'ask', type: 'APPROVAL', to: [{ kind: 'USER', userId: nia }], title: 'Legal', together: [{ to: [], title: '' }] }] }] };
      const made = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: bad }).expect(201)).body.definition.id as string;
      expect(JSON.stringify((await h.api().post(`/forms/${made}/publish`).set(h.bearer(owner)).expect(400)).body)).toContain('each approval asked at the same time needs who approves and what they approve');
    });
  });

  describe('what is due, by date', () => {
    it('records are found by when they are due, for a calendar to show', async () => {
      await publish({ ...form('DUEFORM'), workflow: { ...(form('DUEFORM').workflow as object), sla: { resolutionHours: 48 } } });
      const id = await send('DUEFORM');
      const due = new Date(((await record(id)).record as unknown as { resolutionDueAt: string }).resolutionDueAt);
      const day = (offset: number) => new Date(due.getTime() + offset * 86_400_000).toISOString();
      const found = async (from: string, to: string) => ((await h.api().get(`/records?formCode=DUEFORM&dueFrom=${encodeURIComponent(from)}&dueTo=${encodeURIComponent(to)}&limit=300`).set(h.bearer(owner)).expect(200)).body.rows as { uuid: string }[]).map((r) => r.uuid);
      expect(await found(day(-1), day(1))).toEqual([id]);
      expect(await found(day(1), day(2))).toEqual([]);
      expect(await found(day(-3), day(-1))).toEqual([]);
      await h.api().get('/records?dueFrom=not-a-date').set(h.bearer(owner)).expect(400);
      // A list is still at most 50 at a time.
      expect((await h.api().get('/records?limit=300').set(h.bearer(owner)).expect(200)).body.limit).toBe(50);
    });
  });

  describe('several records at once', () => {
    const bulk = (token: string, body: object, expected = 200) => h.api().post('/records/bulk').set(h.bearer(token)).send(body).expect(expected);

    it('ticked records are taken, given to someone and re-prioritised together; each follows its own rules', async () => {
      const a = await send('QUEUE');
      const b = await send('QUEUE');
      const elsewhere = await send('NOONE');
      // Sam is in the QUEUE team; the third record is not his to see, and says so without stopping the others.
      const took = (await bulk(samToken, { ids: [a, b, elsewhere], op: 'take' })).body;
      expect(took.done).toBe(2);
      expect(took.failed).toEqual([{ id: elsewhere, ok: false, error: 'Record not found' }]);
      expect((await record(a)).record.assigneeId).toBe(sam);

      expect((await bulk(owner, { ids: [a, b], op: 'assign', userId: nia, note: 'Sam is out this afternoon' })).body).toEqual({ done: 2, failed: [] });
      const after = await record(b);
      expect(after.record.assigneeId).toBe(nia);
      expect(after.events.filter((e) => e.type === 'ASSIGNED').at(-1)!.message).toBe('Sam is out this afternoon');

      expect((await bulk(owner, { ids: [a, b], op: 'priority', priority: 'HIGH' })).body.done).toBe(2);
      expect(((await record(a)).record as unknown as { priority: string }).priority).toBe('HIGH');
    });

    it('approvals waiting on me are answered together; a record with nothing waiting says so', async () => {
      const one = await send('ANYAP2');
      const two = await send('ANYAP2');
      const none = await send('ANYAP2');
      await askToClose(one);
      await askToClose(two);
      const answered = (await bulk(niaToken, { ids: [one, two], op: 'decide', decision: 'APPROVED', comment: 'Both fine' })).body;
      expect(answered).toEqual({ done: 2, failed: [] });
      expect((await record(one)).record.status).toBe('DONE');
      expect((await record(two)).record.status).toBe('DONE');
      const nothing = (await bulk(owner, { ids: [none], op: 'decide', decision: 'APPROVED' })).body;
      expect(nothing.failed[0].error).toBe('Nothing here is waiting for your approval');
    });

    it('needs at least one record, no more than fifty, and something to do', async () => {
      await bulk(owner, { ids: [], op: 'take' }, 400);
      await bulk(owner, { ids: Array.from({ length: 51 }, (_, i) => `id-${i}`), op: 'take' }, 400);
      await bulk(owner, { ids: ['x'], op: 'delete' }, 400);
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
      const waitingOn = async (token: string) => ((await h.api().get('/records?waiting=me').set(h.bearer(token)).expect(200)).body.rows as { uuid: string }[]).map((r) => r.uuid);
      expect(await waitingOn(niaToken)).not.toContain(id);
      expect(await waitingOn(samToken)).toContain(id);
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
