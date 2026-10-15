import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { startApp, type Harness } from './harness';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** A maintenance complaint: "Resolve" needs a photo of the repair, but only for leaks. */
const form = (requireFiles: Record<string, unknown>) => ({
  name: 'Maintenance complaint',
  code: 'MAINT',
  businessId: '',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [
    {
      id: 'f1',
      type: 'DROPDOWN',
      name: 'kind',
      label: 'What kind of problem?',
      required: true,
      dataSource: { type: 'STATIC', options: [{ label: 'Leak', value: 'LEAK' }, { label: 'Noise', value: 'NOISE' }] },
    },
  ],
  workflow: {
    enabled: true,
    refPrefix: 'MNT',
    statuses: [
      { key: 'NEW', label: 'New', category: 'OPEN' },
      { key: 'WIP', label: 'Being fixed', category: 'IN_PROGRESS' },
      { key: 'DONE', label: 'Fixed', category: 'DONE' },
    ],
    assignment: { type: 'NONE' },
    actions: [
      { key: 'start', label: 'Start', from: ['NEW'], to: 'WIP' },
      { key: 'resolve', label: 'Resolve', from: ['WIP'], to: 'DONE', requireFiles },
    ],
  },
});

describe('A file required before a record can move (e2e)', () => {
  let h: Harness;
  let dir: string;
  let owner: string;
  let orgId: string;
  let folder: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fb-evidence-'));
    h = await startApp({ LOCAL_STORAGE_DIR: dir });
    await h.signUp('Asha', 'asha@acme.test', 'Acme Homes');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Maintenance' }).expect(201)).body[0].id;
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: form({ picturesOnly: true, if: { field: 'kind', operator: 'equals', value: 'LEAK' } }) }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
  });
  afterAll(async () => {
    await h?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const complaint = async (kind: string) => (await h.api().post(`/public/forms/MAINT/submissions?org=${orgId}`).send({ values: { kind } }).expect(201)).body.submissionId as string;
  const act = (id: string, key: string) => h.api().post(`/records/${id}/actions/${key}`).set(h.bearer(owner)).send({});
  const addFile = async (id: string, fileName: string, contentType: string, bytes: Buffer) => {
    const ticket = (await h.api().post(`/records/${id}/files`).set(h.bearer(owner)).send({ fileName, contentType, size: bytes.length }).expect(201)).body;
    await h.api().put(h.localUrl(ticket.url).replace(h.base, '')).set('Content-Type', contentType).send(bytes).expect(200);
    await h.api().post(`/records/${id}/files/${ticket.uploadId}/attach`).set(h.bearer(owner)).expect(200);
  };
  const pdf = async () => {
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]);
    return Buffer.from(await doc.save());
  };

  it('a leak cannot be resolved until a picture of the repair is on the record; a PDF is not a picture', async () => {
    const id = await complaint('LEAK');
    await act(id, 'start').expect(200);
    const refused = await act(id, 'resolve').expect(400);
    expect(refused.body.errors).toEqual([{ field: 'files', message: 'Add a picture to the record before you Resolve' }]);
    await addFile(id, 'invoice.pdf', 'application/pdf', await pdf());
    await act(id, 'resolve').expect(400);
    await addFile(id, 'repair.png', 'image/png', PNG);
    expect((await act(id, 'resolve').expect(200)).body.record.status).toBe('DONE');
  });

  it('a picture added before the record reached its current status does not count', async () => {
    const id = await complaint('LEAK');
    await addFile(id, 'the-leak.png', 'image/png', PNG);
    await new Promise((r) => setTimeout(r, 5));
    await act(id, 'start').expect(200);
    await act(id, 'resolve').expect(400);
  });

  it('a complaint the condition does not cover moves without a file', async () => {
    const id = await complaint('NOISE');
    await act(id, 'start').expect(200);
    expect((await act(id, 'resolve').expect(200)).body.record.status).toBe('DONE');
  });

  it('asks for as many as it says, and counts what is there', async () => {
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: { ...form({ count: 2 }), code: 'MAINT_TWO' } }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
    const rec = (await h.api().post(`/public/forms/MAINT_TWO/submissions?org=${orgId}`).send({ values: { kind: 'NOISE' } }).expect(201)).body.submissionId as string;
    await act(rec, 'start').expect(200);
    await addFile(rec, 'note.pdf', 'application/pdf', await pdf());
    expect((await act(rec, 'resolve').expect(400)).body.errors[0].message).toBe('Add 2 files to the record before you Resolve (1 so far)');
    await addFile(rec, 'photo.png', 'image/png', PNG);
    await act(rec, 'resolve').expect(200);
  });

  it('a condition on an answer the form does not have is refused at publish', async () => {
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: { ...form({ if: { field: 'nope', operator: 'equals', value: 'x' } }), code: 'MAINT_BAD' } }).expect(201)).body.definition.id;
    const res = await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(400);
    expect(res.body.errors).toContainEqual({ field: 'workflow.actions.1', message: '"Resolve": the condition for asking for a file uses unknown field "nope"' });
  });
});
