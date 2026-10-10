import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPdf as pdfParse } from './read-pdf';
import { startApp, type Harness } from './harness';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** A response saved as files in the customer's own storage: its answers, and its PDF, under its reference. */
describe('Connectors that save a response as files (e2e)', () => {
  let h: Harness;
  let owner: string;
  let orgId: string;
  let dir: string;
  const puts: { path: string; type: string; body: Buffer }[] = [];
  const container: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (!String(req.url).includes('sig=goodsig')) return res.writeHead(403).end();
      if (req.method === 'PUT') puts.push({ path: decodeURIComponent(String(req.url).split('?')[0]!), type: String(req.headers['content-type']), body: Buffer.concat(chunks) });
      res.writeHead(req.method === 'PUT' ? 201 : 200).end();
    });
  });

  beforeAll(async () => {
    process.env.CONNECTOR_ALLOW_PRIVATE_NETWORK = 'true';
    dir = mkdtempSync(join(tmpdir(), 'fb-files-'));
    await new Promise<void>((r) => container.listen(0, '127.0.0.1', r));
    h = await startApp({ LOCAL_STORAGE_DIR: dir });
    await h.signUp('Asha', 'asha@acme.test', 'Acme Trading');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
  });
  afterAll(async () => {
    delete process.env.CONNECTOR_ALLOW_PRIVATE_NETWORK;
    await h?.close();
    container.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('each response lands in the container as JSON, PDF and the files the respondent uploaded, named by form and reference', async () => {
    const created = (
      await h
        .api()
        .post('/connectors')
        .set(h.bearer(owner))
        .send({ type: 'azure-blob', name: 'Archive', settings: { containerUrl: `http://127.0.0.1:${(container.address() as AddressInfo).port}/responses`, prefix: 'forms' }, secrets: { sasToken: 'sv=2022-11-02&sp=cwl&sig=goodsig%3D' }, writable: true })
        .expect(201)
    ).body;
    expect(JSON.stringify(created)).not.toContain('goodsig');
    expect((await h.api().post(`/connectors/${created.id}/test`).set(h.bearer(owner)).expect(200)).body).toMatchObject({ ok: true });
    await h.api().put(`/connectors/${created.id}/entities`).set(h.bearer(owner)).send({ entities: [{ key: 'files', label: 'Files', fields: ['name'], operations: ['upload'] }] }).expect(200);
    const step = (await h.api().get('/custom-workflows').set(h.bearer(owner)).expect(200)).body.find((a: { label: string }) => a.label === 'Archive: upload Files');
    // A file takes the whole response: there are no fields to match.
    expect(step.inputs).toBeUndefined();

    const folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Loans' }).expect(201)).body[0].id;
    const definition = {
      name: 'Loan request',
      code: 'LOAN',
      businessId: '',
      access: 'PUBLIC',
      submission: { method: 'POST', endpointId: 'default-submit' },
      fields: [
        { id: 'a', type: 'TEXT', name: 'applicant', label: 'Applicant', required: true },
        { id: 'b', type: 'FILE', name: 'proof', label: 'Proof of income', props: { accept: ['image/*'], maxSizeMB: 2 }, validation: { max: 3 } },
      ],
      workflow: { enabled: true, refPrefix: 'LN', statuses: [{ key: 'NEW', label: 'New', category: 'OPEN' }, { key: 'DONE', label: 'Done', category: 'DONE' }], assignment: { type: 'NONE' } },
      automations: [{ id: 'a1', name: 'Archive', enabled: true, when: 'SUBMITTED', actions: [{ id: 'save', type: 'HANDLER', key: step.key }] }],
    };
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
    // The respondent uploads a picture, the way the form page does it.
    const ticket = (await h.api().post(`/public/forms/LOAN/uploads?org=${orgId}`).send({ fieldName: 'proof', fileName: '../payslip (March).png', contentType: 'image/png', size: PNG.length }).expect(201)).body;
    await h.api().put(h.localUrl(ticket.url).replace(h.base, '')).set('Content-Type', 'image/png').send(PNG).expect(200);
    await h.api().post(`/public/uploads/${ticket.uploadId}/verify?org=${orgId}`).expect(200);
    const sub = (await h.api().post(`/public/forms/LOAN/submissions?org=${orgId}`).send({ values: { applicant: 'Ravi Kumar', proof: [{ uploadId: ticket.uploadId }] } }).expect(201)).body;

    for (let i = 0; i < 100 && puts.length < 3; i++) await new Promise((r) => setTimeout(r, 50));
    expect(puts.map((p) => [p.path, p.type])).toEqual([
      [`/responses/forms/LOAN/${sub.ref}.json`, 'application/json'],
      [`/responses/forms/LOAN/${sub.ref}.pdf`, 'application/pdf'],
      // In a folder of its own beside the response; the name it was uploaded with cannot move it anywhere else.
      [`/responses/forms/LOAN/${sub.ref}-files/${puts[2]?.path.split('-files/')[1]}`, 'image/png'],
    ]);
    expect(puts[2]!.path.split('-files/')[1]).toMatch(/^1-[A-Za-z0-9._ -]*payslip[A-Za-z0-9._ ()-]*\.png$/);
    expect(puts[2]!.path).not.toContain('..');
    expect(Buffer.compare(puts[2]!.body, PNG)).toBe(0);
    expect(JSON.parse(puts[0]!.body.toString())).toMatchObject({ applicant: 'Ravi Kumar' });
    // The same document of record staff download, not a stand-in.
    expect((await pdfParse(puts[1]!.body)).text).toContain('Ravi Kumar');
    const events = ((await h.api().get(`/records/${sub.submissionId}`).set(h.bearer(owner)).expect(200)).body.events as { message: string }[]).map((e) => e.message);
    expect(events).toEqual(expect.arrayContaining([expect.stringContaining('saved 3 files in Archive')]));
    expect(JSON.stringify(events)).not.toContain('goodsig');
  });
});
