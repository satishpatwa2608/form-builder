import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, type Binary } from 'mongodb';
import { withFileFacets } from '../src/connectors/connectors.service';
import { startApp, type Harness } from './harness';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** A file a respondent uploads is written into a field of the customer's own system, with its name and kind beside it. */
describe('Connectors: an uploaded file into a field (e2e)', () => {
  let h: Harness;
  let customerDb: MongoMemoryServer;
  let uri: string;
  let owner: string;
  let orgId: string;
  let dir: string;
  let ref: string;

  const stored = async (who: string) => {
    const c = await MongoClient.connect(uri);
    try {
      for (let i = 0; i < 60; i++) {
        const row = await c.db('hr').collection('claims').findOne({ claimant: who });
        if (row) return row as Record<string, unknown>;
        await new Promise((r) => setTimeout(r, 50));
      }
      return null;
    } finally {
      await c.close();
    }
  };
  const upload = async (fileName: string) => {
    const ticket = (await h.api().post(`/public/forms/CLAIM/uploads?org=${orgId}`).send({ fieldName: 'receipt', fileName, contentType: 'image/png', size: PNG.length }).expect(201)).body;
    await h.api().put(h.localUrl(ticket.url).replace(h.base, '')).set('Content-Type', 'image/png').send(PNG).expect(200);
    await h.api().post(`/public/uploads/${ticket.uploadId}/verify?org=${orgId}`).expect(200);
    return ticket.uploadId as string;
  };

  beforeAll(async () => {
    process.env.CONNECTOR_ALLOW_PRIVATE_NETWORK = 'true';
    dir = mkdtempSync(join(tmpdir(), 'fb-column-'));
    customerDb = await MongoMemoryServer.create();
    uri = customerDb.getUri();
    const c = await MongoClient.connect(uri);
    await c.db('hr').collection('claims').insertOne({ claimant: 'seed', receipt: null, receipt_name: '', receipt_type: '', amount: 0 });
    await c.close();
    h = await startApp({ LOCAL_STORAGE_DIR: dir });
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    const made = (await h.api().post('/connectors').set(h.bearer(owner)).send({ type: 'mongodb', name: 'HR', settings: { database: 'hr' }, secrets: { uri }, writable: true }).expect(201)).body;
    ref = made.ref;
    await h.api().put(`/connectors/${made.id}/entities`).set(h.bearer(owner)).send({ entities: [{ key: 'claims', label: 'Claims', fields: ['claimant', 'amount', 'receipt', 'receipt_name', 'receipt_type'], operations: ['insert', 'list'] }] }).expect(200);
    const step = (await h.api().get('/custom-workflows').set(h.bearer(owner)).expect(200)).body.find((a: { label: string }) => a.label === 'HR: insert Claims');
    const folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Claims' }).expect(201)).body[0].id;
    const definition = {
      name: 'Expense claim',
      code: 'CLAIM',
      businessId: '',
      access: 'PUBLIC',
      submission: { method: 'POST', endpointId: 'default-submit' },
      fields: [
        { id: 'c', type: 'TEXT', name: 'claimant', label: 'Your name', required: true },
        { id: 'a', type: 'NUMBER', name: 'amount', label: 'Amount' },
        { id: 'r', type: 'FILE', name: 'receipt', label: 'Receipt' },
      ],
      // Nothing chosen by hand: "receipt", "receipt_name" and "receipt_type" are matched by name.
      automations: [{ id: 'a1', name: 'Save', enabled: true, when: 'SUBMITTED', actions: [{ id: 's1', type: 'HANDLER', key: step.key }] }],
    };
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
  });
  afterAll(async () => {
    delete process.env.CONNECTOR_ALLOW_PRIVATE_NETWORK;
    await h?.close();
    await customerDb?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a file answer offers the file, its name and its kind to be matched', () => {
    expect(withFileFacets({ who: 'Ravi', photo: [{ uploadId: 'u1', name: 'me.png', contentType: 'image/png' }, { uploadId: 'u2', name: 'other.png' }], tags: ['a'], none: [] })).toEqual({
      who: 'Ravi',
      photo: [{ uploadId: 'u1', name: 'me.png', contentType: 'image/png' }, { uploadId: 'u2', name: 'other.png' }],
      photo__name: 'me.png',
      photo__type: 'image/png',
      tags: ['a'],
      none: [],
    });
  });

  it('the file itself is written into the field, byte for byte, with its name and kind in the fields beside it', async () => {
    const uploadId = await upload('taxi receipt.png');
    await h.api().post(`/public/forms/CLAIM/submissions?org=${orgId}`).send({ values: { claimant: 'Ravi Kumar', amount: 420, receipt: [{ uploadId }] } }).expect(201);
    const row = await stored('Ravi Kumar');
    // The name is the tidy one the file was stored under (no spaces, nothing that could be a path).
    expect(row).toMatchObject({ claimant: 'Ravi Kumar', amount: 420, receipt_name: 'taxi_receipt.png', receipt_type: 'image/png' });
    // Bytes, as the database holds them, and exactly the ones uploaded.
    expect(Buffer.from((row!.receipt as Binary).buffer).equals(PNG)).toBe(true);
  });

  it('a response without a file writes the rest and leaves the file field alone', async () => {
    await h.api().post(`/public/forms/CLAIM/submissions?org=${orgId}`).send({ values: { claimant: 'Meera Nair', amount: 10 } }).expect(201);
    const row = await stored('Meera Nair');
    expect(row).toMatchObject({ claimant: 'Meera Nair', amount: 10 });
    expect(row!.receipt ?? null).toBeNull();
  });

  it('reading the table back shows that a file is there and how big, never its bytes', async () => {
    const rows = (await h.api().post('/connectors/query').set(h.bearer(owner)).send({ key: `/connectors/${ref}/claims`, params: { claimant: 'Ravi Kumar' } }).expect(200)).body as Record<string, unknown>[];
    expect(rows).toEqual([{ claimant: 'Ravi Kumar', amount: 420, receipt: `(file, ${PNG.length} bytes)`, receipt_name: 'taxi_receipt.png', receipt_type: 'image/png' }]);
  });
});
