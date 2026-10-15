import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { FormSubmission } from '../src/work/schemas/form-submission.schema';
import { startApp, type Harness } from './harness';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const form = {
  name: 'Maintenance complaint',
  code: 'MAINT',
  businessId: '',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [
    { id: 'p', type: 'DROPDOWN', name: 'property', label: 'Which property?', required: true, dataSource: { type: 'STATIC', options: [{ label: 'Tower A', value: 'A' }, { label: 'Tower B', value: 'B' }] } },
    { id: 'k', type: 'RADIO', name: 'kind', label: 'What kind of problem?', required: true, dataSource: { type: 'STATIC', options: [{ label: 'Leak', value: 'LEAK' }, { label: 'Noise', value: 'NOISE' }] } },
    { id: 'd', type: 'TEXT', name: 'details', label: 'Details' },
  ],
  workflow: {
    enabled: true,
    refPrefix: 'MNT',
    statuses: [
      { key: 'NEW', label: 'New', category: 'OPEN' },
      { key: 'DONE', label: 'Fixed', category: 'DONE' },
    ],
    assignment: { type: 'NONE' },
  },
};

describe('Reports: side by side by property, team, assignee, priority or status (e2e)', () => {
  let h: Harness;
  let owner: string;
  let pat: string;
  let patToken: string;
  let eli: string;
  let orgId: string;
  let records: Model<FormSubmission>;

  beforeAll(async () => {
    h = await startApp();
    await h.signUp('Asha', 'asha@acme.test', 'Acme Homes');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    pat = await h.addMember(owner, 'Pat Plumber', 'pat@acme.test', 'RECORDS_WORKER');
    eli = await h.addMember(owner, 'Eli Electric', 'eli@acme.test', 'RECORDS_WORKER');
    await h.api().patch(`/members/${pat}`).set(h.bearer(owner)).send({ department: 'Plumbing' }).expect(200);
    await h.api().patch(`/members/${eli}`).set(h.bearer(owner)).send({ department: 'Electrical' }).expect(200);
    patToken = (await h.login('pat@acme.test')).token;
    const folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Maintenance' }).expect(201)).body[0].id;
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: form }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
    records = h.app.get(getModelToken(FormSubmission.name));

    // Six complaints, set to known times straight in the database.
    const now = Date.now();
    const make = async (property: string, kind: string, set: Record<string, unknown>) => {
      const rid = (await h.api().post(`/public/forms/MAINT/submissions?org=${orgId}`).send({ values: { property, kind, details: 'Secret flat 4B' } }).expect(201)).body.submissionId;
      await records.collection.updateOne({ uuid: rid }, { $set: set });
      return rid;
    };
    const done = (createdHoursAgo: number, tookHours: number) => ({ status: 'DONE', createdAt: new Date(now - createdHoursAgo * HOUR), resolvedAt: new Date(now - (createdHoursAgo - tookHours) * HOUR) });
    await make('A', 'LEAK', { assigneeId: pat, ...done(50, 2) });
    await make('A', 'LEAK', { assigneeId: pat, ...done(40, 4) });
    await make('A', 'NOISE', { assigneeId: eli, ...done(30, 10) });
    await make('B', 'LEAK', { assigneeId: eli, priority: 'HIGH', dueAt: new Date(now - HOUR) });
    await make('B', 'NOISE', { assigneeId: '', dueAt: new Date(now + DAY) });
    // Long ago: outside a 30-day report.
    await make('B', 'LEAK', { assigneeId: pat, status: 'DONE', createdAt: new Date(now - 60 * DAY), resolvedAt: new Date(now - 50 * DAY) });
  });
  afterAll(() => h?.close());

  const report = (query: string, token = owner) => h.api().get(`/work-reports?${query}`).set(h.bearer(token));
  const row = (rows: { label: string }[], label: string) => rows.find((r) => r.label === label);

  it('by a choice question of the form: opened, resolved, median time to resolve, open and overdue now', async () => {
    const r = (await report('formCode=MAINT&days=30&by=field:property').expect(200)).body;
    expect(r.choices.map((c: { value: string }) => c.value)).toEqual(['field:property', 'field:kind', 'team', 'assignee', 'priority', 'status']);
    expect(row(r.groups, 'Tower A')).toMatchObject({ key: 'A', opened: 3, resolved: 3, medianResolveHours: 4, openNow: 0, overdueNow: 0 });
    expect(row(r.groups, 'Tower B')).toMatchObject({ key: 'B', opened: 2, resolved: 0, medianResolveHours: null, openNow: 2, overdueNow: 1 });
    expect(r.total).toEqual({ opened: 5, resolved: 3, openNow: 2, overdueNow: 1, medianResolveHours: 4 });
    expect(r.partial).toBe(false);
    // Counts and labels only: never what anyone wrote.
    expect(JSON.stringify(r)).not.toContain('Secret flat');
  });

  it('by team (the assignee\'s department), by assignee, by priority', async () => {
    const team = (await report('formCode=MAINT&days=30&by=team').expect(200)).body;
    expect(team.teams).toEqual(['Electrical', 'Plumbing']);
    expect(row(team.groups, 'Plumbing')).toMatchObject({ opened: 2, resolved: 2, medianResolveHours: 3, openNow: 0 });
    expect(row(team.groups, 'Electrical')).toMatchObject({ opened: 2, resolved: 1, medianResolveHours: 10, openNow: 1, overdueNow: 1 });
    expect(row(team.groups, 'Not assigned')).toMatchObject({ opened: 1, openNow: 1, overdueNow: 0 });
    const who = (await report('formCode=MAINT&days=30&by=assignee').expect(200)).body;
    expect(row(who.groups, 'Pat Plumber')).toMatchObject({ opened: 2, resolved: 2 });
    expect(row(who.groups, 'Not assigned')).toMatchObject({ openNow: 1 });
    const priority = (await report('formCode=MAINT&days=30&by=priority').expect(200)).body;
    expect(row(priority.groups, 'High')).toMatchObject({ openNow: 1, overdueNow: 1 });
    // A longer period takes in the old one.
    expect((await report('formCode=MAINT&days=90&by=field:property').expect(200)).body.total).toMatchObject({ opened: 6, resolved: 4 });
  });

  it('a team filter on the report, the inbox and the dashboard', async () => {
    const r = (await report('formCode=MAINT&days=30&by=field:kind&team=Plumbing').expect(200)).body;
    expect(r.total).toMatchObject({ opened: 2, resolved: 2, openNow: 0 });
    expect(row(r.groups, 'Leak')).toMatchObject({ opened: 2 });
    expect((await h.api().get('/records?formCode=MAINT&team=Electrical').set(h.bearer(owner)).expect(200)).body.total).toBe(2);
    expect((await h.api().get('/work-dashboard?formCode=MAINT&team=Electrical').set(h.bearer(owner)).expect(200)).body.team).toMatchObject({ open: 1, overdue: 1 });
  });

  it('a worker\'s report counts only what that worker may see', async () => {
    const seen = (await h.api().get('/records?formCode=MAINT').set(h.bearer(patToken)).expect(200)).body.total;
    const r = (await report('formCode=MAINT&days=90&by=status', patToken).expect(200)).body;
    expect(r.total.opened).toBe(seen);
    expect(r.total.opened).toBeLessThan(6);
  });

  it('an unknown grouping falls back to the first; an unknown form is not found', async () => {
    expect((await report('formCode=MAINT&by=$where').expect(200)).body.by).toBe('field:property');
    await report('formCode=NOPE').expect(404);
    // Without a form: team, assignee, priority, status across every form.
    expect((await report('days=30').expect(200)).body.by).toBe('team');
  });
});
