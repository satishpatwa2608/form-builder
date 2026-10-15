import { writeFileSync } from 'node:fs';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { FormSubmission } from '../src/work/schemas/form-submission.schema';
import { startApp, type Harness } from './harness';

const HOUR = 3_600_000;

const form = (code: string) => ({
  name: `Form ${code}`,
  code,
  businessId: '',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [{ id: 'n', type: 'TEXT', name: 'name', label: 'Name', required: true }],
  workflow: {
    enabled: true,
    refPrefix: code.slice(0, 3),
    statuses: [{ key: 'NEW', label: 'New', category: 'OPEN' }, { key: 'WIP', label: 'Working', category: 'IN_PROGRESS' }, { key: 'DONE', label: 'Done', category: 'DONE' }],
    assignment: { type: 'NONE' },
  },
});

/** The dashboard over a known set of records: each number worked out by hand from what is seeded. */
describe('Dashboard numbers (e2e)', () => {
  let h: Harness;
  let owner: string;
  let me: string;
  let pat: string;
  let patToken: string;

  beforeAll(async () => {
    h = await startApp();
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    me = (await h.api().get('/auth/me').set(h.bearer(owner))).body.user.id;
    const orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    pat = await h.addMember(owner, 'Pat', 'pat@acme.test', 'RECORDS_WORKER');
    patToken = (await h.login('pat@acme.test')).token;
    const folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'F' }).expect(201)).body[0].id;
    for (const code of ['ALPHA', 'BETA']) {
      const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: form(code) }).expect(201)).body.definition.id;
      await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
    }
    const records = h.app.get<Model<FormSubmission>>(getModelToken(FormSubmission.name));
    const now = Date.now();
    const at = (hoursAgo: number) => new Date(now - hoursAgo * HOUR);
    const make = async (code: string, set: Record<string, unknown>) => {
      const id = (await h.api().post(`/public/forms/${code}/submissions?org=${orgId}`).send({ values: { name: 'x' } }).expect(201)).body.submissionId;
      await records.collection.updateOne({ uuid: id }, { $set: set });
    };
    // Open, mine (Asha's):
    await make('ALPHA', { assigneeId: me, priority: 'HIGH', dueAt: at(2), createdAt: at(10) }); // overdue
    await make('ALPHA', { assigneeId: me, priority: 'HIGH', resolutionDueAt: new Date(now + HOUR), createdAt: at(5) }); // due today (unless near midnight)
    await make('BETA', { assigneeId: me, priority: 'LOW', responseDueAt: at(1), respondedAt: null, createdAt: at(3) }); // overdue (no response)
    await make('BETA', { assigneeId: me, priority: 'LOW', responseDueAt: at(1), respondedAt: at(0.5), createdAt: at(3), status: 'WIP' }); // answered in time: not overdue
    // Open, Pat's and nobody's:
    await make('ALPHA', { assigneeId: pat, priority: 'CRITICAL', escalationStep: 2, resolutionDueAt: at(1), createdAt: at(40) }); // overdue, escalated
    await make('ALPHA', { assigneeId: '', priority: 'MEDIUM', createdAt: at(30) }); // unassigned
    await make('BETA', { assigneeId: '', priority: 'MEDIUM', createdAt: at(24 * 40) }); // unassigned, made before the period
    // Resolved:
    await make('ALPHA', { assigneeId: me, status: 'DONE', resolvedAt: at(1), createdAt: at(9), resolutionDueAt: at(-5), resolutionBreachedAt: null }); // today, on time
    await make('BETA', { assigneeId: pat, status: 'DONE', resolvedAt: at(24 * 3), createdAt: at(24 * 3 + 6), resolutionDueAt: at(24 * 3 + 2), resolutionBreachedAt: at(24 * 3 + 2), reopenCount: 1 }); // late, reopened
    await make('BETA', { assigneeId: pat, status: 'DONE', resolvedAt: at(24 * 50), createdAt: at(24 * 51) }); // before the period
  });
  afterAll(() => h?.close());

  it('what each person and the team have, overdue, due, escalated, and how the period went', async () => {
    const d = (await h.api().get('/work-dashboard?days=30').set(h.bearer(owner)).expect(200)).body;
    if (process.env.DASHBOARD_SNAPSHOT) writeFileSync(process.env.DASHBOARD_SNAPSHOT, JSON.stringify(d, null, 1));
    const nearMidnight = new Date(Date.now() + HOUR).getDate() !== new Date().getDate();
    expect(d.me).toMatchObject({ open: 4, overdue: 2, resolvedToday: new Date(Date.now() - HOUR).getDate() === new Date().getDate() ? 1 : 0 });
    if (!nearMidnight) expect(d.me.dueToday).toBe(1);
    expect(d.team).toMatchObject({ open: 7, unassigned: 2, overdue: 3, escalated: 1 });
    expect(d.team.byForm).toEqual([{ formCode: 'ALPHA', open: 4 }, { formCode: 'BETA', open: 3 }]);
    expect(Object.fromEntries(d.team.byPriority.map((p: { priority: string; open: number }) => [p.priority, p.open]))).toEqual({ HIGH: 2, LOW: 2, CRITICAL: 1, MEDIUM: 2 });
    expect(Object.fromEntries(d.team.byAssignee.map((a: { name: string; open: number; overdue: number }) => [a.name, [a.open, a.overdue]]))).toEqual({ Asha: [4, 1], Pat: [1, 1], Unassigned: [2, 0] });
    expect(d.performance).toMatchObject({ created: 8, resolved: 2, slaCompliance: 50, reopenRate: 50 });
    expect(d.performance.avgResolutionHours).toBe(7);
    expect(d.performance.trend).toHaveLength(30);
    expect(d.performance.trend.reduce((n: number, t: { raised: number }) => n + t.raised, 0)).toBe(8);
    expect(d.performance.trend.reduce((n: number, t: { resolved: number }) => n + t.resolved, 0)).toBe(2);
  });

  it('a form and a team narrow it; a worker sees what is theirs to see', async () => {
    const alpha = (await h.api().get('/work-dashboard?days=30&formCode=ALPHA').set(h.bearer(owner)).expect(200)).body;
    expect(alpha.team).toMatchObject({ open: 4, unassigned: 1, overdue: 2, escalated: 1 });
    const pats = (await h.api().get('/work-dashboard?days=30').set(h.bearer(patToken)).expect(200)).body;
    expect(pats.me).toMatchObject({ open: 1, overdue: 1 });
  });
});
