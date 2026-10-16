import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { RetentionService } from '../src/work/services/retention.service';
import { startApp, type Harness } from './harness';

const DAY = 86_400_000;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const form = (code: string, workflow: boolean, sendsOut = false) => ({
  name: `Form ${code}`,
  code,
  businessId: '',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [{ id: 'n', type: 'TEXT', name: 'name', label: 'Name', required: true }],
  ...(workflow
    ? { workflow: { enabled: true, refPrefix: code.slice(0, 3), statuses: [{ key: 'NEW', label: 'New', category: 'OPEN' }, { key: 'DONE', label: 'Done', category: 'DONE' }], assignment: { type: 'NONE' } } }
    : {}),
  ...(sendsOut ? { automations: [{ id: 'out', name: 'To our CRM', enabled: true, when: 'SUBMITTED', actions: [{ id: 'w', type: 'WEBHOOK', url: 'https://crm.example.com/in' }] }] } : {}),
});

describe('Keeping data only as long as needed (e2e)', () => {
  let h: Harness;
  let dir: string;
  let owner: string;
  let worker: string;
  let orgId: string;
  let other: string;
  let otherOrg: string;
  let records: Model<{ uuid: string }>;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fb-retention-'));
    h = await startApp({ LOCAL_STORAGE_DIR: dir });
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    await h.addMember(owner, 'Wes', 'wes@acme.test', 'RECORDS_WORKER');
    worker = (await h.login('wes@acme.test')).token;
    await h.signUp('Zed', 'zed@other.test', 'Other');
    other = (await h.login('zed@other.test')).token;
    otherOrg = (await h.api().get('/auth/me').set(h.bearer(other))).body.org.id;
    records = h.app.get(getModelToken('FormSubmission'));
    const events = h.app.get<Model<unknown>>(getModelToken('FormRecordEvent'));

    const publish = async (token: string, def: Record<string, unknown>) => {
      const folder = (await h.api().post('/folders').set(h.bearer(token)).send({ name: `F ${def.code}` }).expect(201)).body[0].id;
      const id = (await h.api().post('/forms').set(h.bearer(token)).send({ folderId: folder, definition: def }).expect(201)).body.definition.id;
      await h.api().post(`/forms/${id}/publish`).set(h.bearer(token)).expect(200);
    };
    await publish(owner, form('WORK', true));
    await publish(owner, form('PLAIN', false));
    await publish(owner, form('SENT', true, true));
    await publish(other, form('THEIRS', true));
    const make = async (code: string, org: string, set: Record<string, unknown>) => {
      const id = (await h.api().post(`/public/forms/${code}/submissions?org=${org}`).send({ values: { name: 'x' } }).expect(201)).body.submissionId as string;
      await records.collection.updateOne({ uuid: id }, { $set: set });
      return id;
    };
    const ago = (days: number) => new Date(Date.now() - days * DAY);
    ids.closedLongAgo = await make('WORK', orgId, { status: 'DONE', createdAt: ago(20), resolvedAt: ago(8) });
    ids.closedLately = await make('WORK', orgId, { status: 'DONE', createdAt: ago(20), resolvedAt: ago(3) });
    ids.stillOpen = await make('WORK', orgId, { createdAt: ago(60) });
    ids.held = await make('WORK', orgId, { status: 'DONE', createdAt: ago(20), resolvedAt: ago(8) });
    ids.plainOld = await make('PLAIN', orgId, { createdAt: ago(8) });
    ids.plainNew = await make('PLAIN', orgId, { createdAt: ago(2) });
    ids.copied = await make('SENT', orgId, { status: 'DONE', createdAt: ago(20), resolvedAt: ago(8) });
    ids.notCopied = await make('SENT', orgId, { status: 'DONE', createdAt: ago(20), resolvedAt: ago(8) });
    ids.theirs = await make('THEIRS', otherOrg, { status: 'DONE', createdAt: ago(20), resolvedAt: ago(8) });
    // The CRM took this one (the webhook step succeeded); the other's did not.
    await events.collection.insertOne({ uuid: 'copied-ok', orgId, recordId: ids.copied, type: 'AUTOMATION', by: '', message: 'To our CRM: posted', data: { ok: true, action: 'WEBHOOK', runId: 'r1' }, createdAt: new Date() });
    // A file staff added to the record that goes.
    const ticket = (await h.api().post(`/records/${ids.closedLongAgo}/files`).set(h.bearer(owner)).send({ fileName: 'photo.png', contentType: 'image/png', size: PNG.length }).expect(201)).body;
    await h.api().put(h.localUrl(ticket.url).replace(h.base, '')).set('Content-Type', 'image/png').send(PNG).expect(200);
    await h.api().post(`/records/${ids.closedLongAgo}/files/${ticket.uploadId}/attach`).set(h.bearer(owner)).expect(200);
    // The other organisation keeps everything.
    await h.api().patch('/org').set(h.bearer(other)).send({ retention: { days: null } }).expect(200);
  });
  afterAll(async () => {
    await h?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const exists = async (id: string) => !!(await records.exists({ uuid: id }));

  it('seven days by default; an admin sees which forms keep their answers only here, and what goes next', async () => {
    expect((await h.api().get('/org').set(h.bearer(owner)).expect(200)).body.retention).toEqual({ days: 7 });
    const o = (await h.api().get('/retention').set(h.bearer(owner)).expect(200)).body;
    expect(o).toMatchObject({ days: 7, due: 4 });
    expect(o.keptHereOnly.sort()).toEqual(['Form PLAIN', 'Form WORK']);
    await h.api().get('/retention').set(h.bearer(worker)).expect(403);
  });

  it('a record can be kept past it by a Forms admin, and that is on its timeline', async () => {
    await h.api().post(`/records/${ids.held}/hold`).set(h.bearer(worker)).send({ held: true }).expect(403);
    const after = (await h.api().post(`/records/${ids.held}/hold`).set(h.bearer(owner)).send({ held: true }).expect(200)).body;
    expect(after.record.held).toBe(true);
    expect(after.events.at(-1)).toMatchObject({ type: 'HOLD', message: 'Kept: not deleted by the retention until let go' });
  });

  it('the nightly run deletes what is closed past it, with its files; never open work, held, uncopied, recent, or another organisation\'s', async () => {
    const files = () => readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.png')).length;
    expect(files()).toBe(1);
    expect(await h.app.get(RetentionService).run()).toBe(3);
    expect({
      closedLongAgo: await exists(ids.closedLongAgo),
      closedLately: await exists(ids.closedLately),
      stillOpen: await exists(ids.stillOpen),
      held: await exists(ids.held),
      plainOld: await exists(ids.plainOld),
      plainNew: await exists(ids.plainNew),
      copied: await exists(ids.copied),
      notCopied: await exists(ids.notCopied),
      theirs: await exists(ids.theirs),
    }).toEqual({ closedLongAgo: false, closedLately: true, stillOpen: true, held: true, plainOld: false, plainNew: true, copied: false, notCopied: true, theirs: true });
    // Its file is gone from the store, and its timeline with it.
    expect(files()).toBe(0);
    expect(await h.app.get<Model<unknown>>(getModelToken('FormRecordEvent')).exists({ recordId: ids.closedLongAgo })).toBeNull();
    await h.api().get(`/records/${ids.closedLongAgo}`).set(h.bearer(owner)).expect(404);
    // Counted in the audit trail, without any answer.
    const entry = (await h.api().get('/audit?limit=20').set(h.bearer(owner)).expect(200)).body.entries.find((e: { action: string }) => e.action === 'records.deleted_by_retention');
    expect(entry).toMatchObject({ after: { records: 3, days: 7 } });
    // Nothing more to do the second time.
    expect(await h.app.get(RetentionService).run()).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it('an admin chooses how long; only the lengths offered; only an admin', async () => {
    await h.api().patch('/org').set(h.bearer(owner)).send({ retention: { days: 5 } }).expect(400);
    await h.api().patch('/org').set(h.bearer(worker)).send({ retention: { days: 30 } }).expect(403);
    expect((await h.api().patch('/org').set(h.bearer(owner)).send({ retention: { days: 30 } }).expect(200)).body.retention).toEqual({ days: 30 });
    expect((await h.api().get('/retention').set(h.bearer(owner)).expect(200)).body).toMatchObject({ days: 30, due: 0 });
  });
});
