import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { OrgLog } from '../src/logs/log.schema';
import { logLine, maskEmail, OrgLogService, safeContext } from '../src/logs/org-log.service';
import { Organization } from '../src/orgs/org.schemas';
import { startApp, type Harness } from './harness';

const form = (code: string, actions: object[]) => ({
  name: `${code} form`,
  code,
  businessId: '',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [
    { id: 'a', type: 'TEXT', name: 'name', label: 'Name', required: true },
    { id: 'b', type: 'EMAIL', name: 'email', label: 'Email', required: true },
  ],
  workflow: { enabled: true, refPrefix: code.slice(0, 3), statuses: [{ key: 'NEW', label: 'New', category: 'OPEN' }, { key: 'DONE', label: 'Done', category: 'DONE' }], assignment: { type: 'NONE' } },
  automations: [{ id: 'a1', name: 'After', enabled: true, when: 'SUBMITTED', actions }],
});

describe("An organisation's own log (e2e)", () => {
  let h: Harness;
  let owner: string;
  let viewer: string;
  let orgId: string;
  let other: string;
  let logs: OrgLogService;
  type Line = { id: string; at: string; level: string; area: string; message: string; context: Record<string, unknown> };
  const read = async (query = '', token = owner) => (await h.api().get(`/org/logs${query}`).set(h.bearer(token)).expect(200)).body as { lines: Line[]; next: string | null };
  const waitFor = async (query: string, test: (lines: Line[]) => boolean, what: string) => {
    for (let i = 0; i < 100; i++) {
      const { lines } = await read(query);
      if (test(lines)) return lines;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const submit = (code: string, values: object) => h.api().post(`/public/forms/${code}/submissions?org=${orgId}`).send({ values });

  beforeAll(async () => {
    h = await startApp();
    logs = h.app.get(OrgLogService);
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    await h.addMember(owner, 'Viv', 'viv@acme.test', 'VIEWER');
    viewer = (await h.login('viv@acme.test')).token;
    await h.signUp('Zed', 'zed@other.test', 'Other');
    other = (await h.login('zed@other.test')).token;
    const folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Ops' }).expect(201)).body[0].id;
    for (const def of [
      form('GOOD', [{ id: 'mail', type: 'EMAIL', to: [{ kind: 'FIELD', field: 'email' }], subject: 'Thanks', body: 'Hello {{name}}' }]),
      form('BAD', [{ id: 'hook', type: 'WEBHOOK', url: 'https://not-allowed.example/x?token=SECRETTOKEN' }]),
    ]) {
      const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: def }).expect(201)).body.definition.id;
      await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
    }
  });
  afterAll(async () => h?.close());

  it('what happened is written as it happens: a response, its workflow, its email, each at its level', async () => {
    const sub = (await submit('GOOD', { name: 'Ravi Kumar', email: 'ravi@customer.test' }).expect(201)).body;
    const lines = await waitFor('?limit=200', (l) => l.some((x) => x.area === 'mail' && x.message === 'Email sent') && l.some((x) => x.area === 'workflow'), 'the lines of one response');
    const received = lines.find((l) => l.message === 'Response received')!;
    expect(received).toMatchObject({ level: 'INFO', area: 'submissions', context: { form: 'GOOD', ref: sub.ref, record: sub.submissionId, channel: 'WEB' } });
    expect(lines.find((l) => l.area === 'workflow')).toMatchObject({ level: 'INFO', context: { form: 'GOOD', record: sub.submissionId, step: 'mail', kind: 'EMAIL' } });
    // Enough of an address to recognise it, and no more; and never what was answered.
    expect(lines.find((l) => l.area === 'mail')!.context).toMatchObject({ to: 'r***@customer.test', through: 'Form Builder' });
    expect(JSON.stringify(lines)).not.toMatch(/Ravi Kumar|ravi@customer\.test/);
    // What people changed is in the same log: publishing a form, and signing in under its own area.
    expect(lines.some((l) => l.area === 'audit' && l.message === 'form.published')).toBe(true);
    expect(lines.some((l) => l.area === 'sign-in' && l.message === 'auth.login')).toBe(true);
  });

  it('a step that fails is an error, said in plain words, with nothing secret from the step', async () => {
    const sub = (await submit('BAD', { name: 'Meera', email: 'meera@customer.test' }).expect(201)).body;
    const errors = await waitFor('?level=ERROR', (l) => l.some((x) => x.context.record === sub.submissionId), 'the error');
    expect(errors.every((l) => l.level === 'ERROR')).toBe(true);
    // The step that failed, and after it the line saying the automation stopped there.
    const line = errors.find((l) => l.context.record === sub.submissionId && l.context.step === 'hook')!;
    expect(line).toMatchObject({ area: 'workflow', context: { form: 'BAD', step: 'hook', kind: 'WEBHOOK' } });
    expect(line.message).toContain('After:');
    expect(JSON.stringify(errors)).not.toContain('SECRETTOKEN');
  });

  it('debug lines are written only while an area is set to debug, and that switches itself off', async () => {
    await submit('GOOD', { name: 'x' }).expect(422);
    await new Promise((r) => setTimeout(r, 150));
    expect((await read('?area=submissions')).lines.filter((l) => l.level === 'DEBUG')).toEqual([]);

    const before = (await h.api().get('/org/logs/settings').set(h.bearer(owner)).expect(200)).body;
    expect(before.areas.find((a: { area: string }) => a.area === 'submissions')).toEqual({ area: 'submissions', label: 'Responses coming in', level: 'INFO', recording: 'INFO' });
    expect(before).toMatchObject({ keepDays: 14, debugUntil: null });
    const set = (await h.api().put('/org/logs/settings').set(h.bearer(owner)).send({ levels: { submissions: 'DEBUG', connectors: 'ERROR' }, debugHours: 2, keepDays: 7 }).expect(200)).body;
    expect(set.areas.find((a: { area: string }) => a.area === 'submissions')).toMatchObject({ level: 'DEBUG', recording: 'DEBUG' });
    expect(set.areas.find((a: { area: string }) => a.area === 'connectors')).toMatchObject({ level: 'ERROR', recording: 'ERROR' });
    expect(set.keepDays).toBe(7);
    expect(new Date(set.debugUntil).getTime() - Date.now()).toBeGreaterThan(1.9 * 3_600_000);
    expect(new Date(set.debugUntil).getTime() - Date.now()).toBeLessThan(2.1 * 3_600_000);

    await submit('GOOD', { name: 'x' }).expect(422);
    const debug = await waitFor('?area=submissions', (l) => l.some((x) => x.level === 'DEBUG'), 'the debug line');
    // Which question was at fault, not what was typed.
    expect(debug.find((l) => l.level === 'DEBUG')).toMatchObject({ message: 'Response sent back with mistakes', context: { form: 'GOOD', mistakes: 1, fields: 'email' } });

    // The time runs out: the setting still says debug, the area records at info again.
    await h.app.get<Model<Organization>>(getModelToken(Organization.name)).updateOne({ id: orgId }, { $set: { 'logging.debugUntil': new Date(Date.now() - 1000) } });
    const later = (await h.api().get('/org/logs/settings').set(h.bearer(owner)).expect(200)).body;
    expect(later.areas.find((a: { area: string }) => a.area === 'submissions')).toMatchObject({ level: 'DEBUG', recording: 'INFO' });
    expect(later.debugUntil).toBeNull();
    const count = (await read('?area=submissions&level=DEBUG')).lines.filter((l) => l.level === 'DEBUG').length;
    await submit('GOOD', { name: 'x' }).expect(422);
    await new Promise((r) => setTimeout(r, 150));
    expect((await read('?area=submissions&level=DEBUG')).lines.filter((l) => l.level === 'DEBUG')).toHaveLength(count);
  });

  it('is filtered by level, area and words, read in pages, followed from a point in time, and downloaded as a log file', async () => {
    expect((await read('?level=WARN')).lines.every((l) => l.level === 'WARN' || l.level === 'ERROR')).toBe(true);
    expect((await read('?area=mail')).lines.every((l) => l.area === 'mail')).toBe(true);
    expect((await read('?q=Response%20received')).lines.every((l) => l.message === 'Response received')).toBe(true);
    expect((await read('?q=GOOD')).lines.every((l) => l.context.form === 'GOOD')).toBe(true);
    // Words are words: what would be a pattern finds nothing and breaks nothing.
    expect((await read('?q=.*')).lines).toEqual([]);

    const first = await read('?limit=3');
    expect(first.lines).toHaveLength(3);
    const older = await read(`?limit=3&before=${first.next}`);
    expect(new Date(older.lines[0]!.at).getTime()).toBeLessThan(new Date(first.lines[2]!.at).getTime() + 1);
    const newest = first.lines[0]!.at;
    logs.info(orgId, 'portal', 'A line written after the page was read', { n: 1 });
    await waitFor(`?after=${newest}`, (l) => l.some((x) => x.message === 'A line written after the page was read'), 'the followed line');

    const file = await h.api().get('/org/logs/download?area=submissions').set(h.bearer(owner)).expect(200);
    expect(file.headers['content-type']).toContain('text/plain');
    expect(file.headers['content-disposition']).toMatch(/attachment; filename="form-builder-\d{4}-\d{2}-\d{2}\.log"/);
    const rows = file.text.trim().split('\n');
    expect(rows[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z (DEBUG|INFO |WARN |ERROR) \[submissions\] /);
    // Oldest first, as a file reads.
    expect(rows.map((r) => r.slice(0, 24))).toEqual([...rows.map((r) => r.slice(0, 24))].sort());
  });

  it('each organisation reads only its own; a viewer cannot read it, and only an admin changes what is recorded', async () => {
    const theirs = await read('', other);
    expect(theirs.lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(theirs)).not.toMatch(/GOOD|BAD|After:/);
    await h.api().get('/org/logs').expect(401);
    await h.api().get('/org/logs').set(h.bearer(viewer)).expect(403);
    await h.api().get('/org/logs/download').set(h.bearer(viewer)).expect(403);
    await h.api().put('/org/logs/settings').set(h.bearer(viewer)).send({ keepDays: 1 }).expect(403);
    expect((await h.api().put('/org/logs/settings').set(h.bearer(owner)).send({ levels: { nonsense: 'DEBUG' } }).expect(400)).body.message).toContain('no part of the product');
    await h.api().put('/org/logs/settings').set(h.bearer(owner)).send({ levels: { mail: 'LOUD' } }).expect(400);
    // Changing what is listened to is itself in the audit trail.
    const audit = (await h.api().get('/audit?action=org.logging_updated').set(h.bearer(owner)).expect(200)).body.entries;
    expect(audit[0].after).toMatchObject({ submissions: 'DEBUG', connectors: 'ERROR', keepDays: 7 });
  });

  it('lines carry no secrets, are kept for the days chosen, and a flood is cut off with one line saying so', async () => {
    expect(safeContext({ form: 'A', password: 'x', apiToken: 'y', Authorization: 'z', nested: { a: 1 }, note: 'line\nbreak', n: 3, ok: true, empty: '' })).toEqual({ form: 'A', password: '[redacted]', apiToken: '[redacted]', Authorization: '[redacted]', note: 'line break', n: 3, ok: true });
    expect(maskEmail('ravi.kumar@customer.test')).toBe('r***@customer.test');
    expect(logLine({ at: new Date('2026-10-09T10:00:00.000Z'), level: 'WARN', area: 'mail', message: 'Email not sent', context: { to: 'r***@x.test', reason: 'two words' } })).toBe('2026-10-09T10:00:00.000Z WARN  [mail] Email not sent to=r***@x.test reason="two words"');

    const lines = h.app.get<Model<OrgLog>>(getModelToken(OrgLog.name));
    const newest = await lines.findOne({ orgId }).sort({ at: -1 }).lean();
    const days = (newest!.expiresAt.getTime() - newest!.at.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(7);

    const before = await lines.countDocuments({ orgId, area: 'gateway' });
    for (let i = 0; i < 700; i++) logs.info(orgId, 'gateway', `flood ${i}`);
    for (let i = 0; i < 100 && !(await lines.exists({ orgId, message: /More than 600 lines/ })); i++) await new Promise((r) => setTimeout(r, 30));
    await new Promise((r) => setTimeout(r, 200));
    expect(await lines.countDocuments({ orgId, area: 'gateway' }) - before).toBeLessThanOrEqual(600);
    expect(await lines.countDocuments({ orgId, message: /More than 600 lines/ })).toBe(1);
  });
});
