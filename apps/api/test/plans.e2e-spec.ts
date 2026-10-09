import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { PlansService } from '../src/plans/plans.service';
import { UsageMonth } from '../src/plans/usage.schema';
import { startApp, type Harness } from './harness';

const form = (code: string) => ({
  name: `Form ${code}`,
  code,
  businessId: '',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [{ id: 'f1', type: 'TEXT', name: 'name', label: 'Name', required: true }],
});

describe('Plans: limits, quotas, usage and form analytics (e2e)', () => {
  let h: Harness;
  let owner: string;
  let orgId: string;
  let folder: string;

  beforeAll(async () => {
    h = await startApp({ DEFAULT_PLAN: 'FREE' });
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Forms' }).expect(201)).body[0].id;
  });
  afterAll(() => h?.close());

  it('the Free plan caps forms, seats, connectors and gateways with a clear 402', async () => {
    for (const code of ['A', 'B', 'C']) await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: form(code) }).expect(201);
    const over = await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: form('D') }).expect(402);
    expect(over.body.message).toContain('allows 3 forms');

    // Owner + one invitation = 2 seats; re-inviting the same person is not another seat.
    await h.api().post('/invitations').set(h.bearer(owner)).send({ email: 'dev@acme.test', role: 'DESIGNER' }).expect(201);
    await h.api().post('/invitations').set(h.bearer(owner)).send({ email: 'dev@acme.test', role: 'DESIGNER' }).expect(201);
    await h.api().post('/invitations').set(h.bearer(owner)).send({ email: 'eve@acme.test', role: 'DESIGNER' }).expect(402);

    expect((await h.api().post('/gateways').set(h.bearer(owner)).send({ name: 'LAN' }).expect(402)).body.message).toContain("doesn't include gateways");
    await h.api().post('/connectors').set(h.bearer(owner)).send({ type: 'rest', name: 'API', settings: { baseUrl: 'https://api.example.com', auth: 'none', resources: '[]' } }).expect(402);

    const usage = (await h.api().get('/org/usage').set(h.bearer(owner)).expect(200)).body;
    expect(usage).toMatchObject({ plan: 'FREE', limits: { forms: 3, members: 2 }, usage: { forms: 3, members: 2, connectors: 0, gateways: 0, submissionsThisMonth: 0 } });

    // Upgrading (billing / operator) lifts the limits.
    await h.app.get(PlansService).setPlan(orgId, 'TEAM');
    await h.api().post('/gateways').set(h.bearer(owner)).send({ name: 'LAN' }).expect(201);
    await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: form('D') }).expect(201);
  });

  it('counts views, starts and submissions per form, and stops accepting at the monthly quota', async () => {
    const id = (await h.api().get('/forms').set(h.bearer(owner)).expect(200)).body.find((f: { code: string }) => f.code === 'A').id;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
    const events = (type: string) => h.api().post(`/public/forms/A/events?org=${orgId}`).send({ type });
    await events('view').expect(204);
    await events('view').expect(204);
    await events('start').expect(204);
    await h.api().post(`/public/forms/B/events?org=${orgId}`).send({ type: 'view' }).expect(404); // not published
    await h.api().post(`/public/forms/A/submissions?org=${orgId}`).send({ values: { name: 'Ravi' }, idempotencyKey: 'k1' }).expect(201);

    const stats = (await h.api().get(`/forms/${id}/stats?days=7`).set(h.bearer(owner)).expect(200)).body;
    expect(stats.series).toHaveLength(7);
    expect(stats.totals).toEqual({ views: 2, starts: 1, submissions: 1 });
    expect(stats).toMatchObject({ startRate: 50, completionRate: 100 });
    expect((await h.api().get('/org/usage').set(h.bearer(owner))).body.usage.submissionsThisMonth).toBe(1);

    // Per question: each visit says once what was answered, where a mistake showed, and where the person stopped.
    const visit = (body: object) => h.api().post(`/public/forms/A/events?org=${orgId}`).send({ type: 'fields', ...body }).expect(204);
    await visit({ answered: ['name'], mistakes: [] }); // went on to submit
    await visit({ answered: ['name', 'name'], mistakes: ['name'], leftAt: 'name' }); // gave up; a name said twice counts once
    await visit({ answered: ['nope', 7, { $gt: '' }], mistakes: 'name', leftAt: 'constructor' }); // nothing the form has: nothing counted
    const fields = (await h.api().get(`/forms/${id}/field-stats?days=7`).set(h.bearer(owner)).expect(200)).body;
    expect(fields).toMatchObject({ days: 7, starts: 1, submissions: 1 });
    expect(fields.fields).toEqual([{ name: 'name', label: expect.any(String), answered: 2, mistakes: 1, leftAt: 1 }]);
    // Only someone who may see the form sees its counts; a form with no live version has no questions to count.
    await h.api().get(`/forms/${id}/field-stats`).expect(401);
    const draft = (await h.api().get('/forms').set(h.bearer(owner)).expect(200)).body.find((f: { code: string }) => f.code === 'B').id;
    expect((await h.api().get(`/forms/${draft}/field-stats`).set(h.bearer(owner)).expect(200)).body.fields).toEqual([]);

    // At the quota the respondent gets a neutral message.
    await h.app.get<Model<UsageMonth>>(getModelToken(UsageMonth.name)).updateOne({ orgId }, { $set: { submissions: 2_000 } });
    const refused = await h.api().post(`/public/forms/A/submissions?org=${orgId}`).send({ values: { name: 'Ravi' }, idempotencyKey: 'k2' }).expect(429);
    expect(refused.body.message).toContain("isn't accepting responses");
  });
});
