import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPdf as pdfParse } from './read-pdf';
import { spawnSync } from 'node:child_process';
import { newSealIdentity } from '../src/documents/pdf-seal';
import { OBJECT_STORE, type ObjectStore } from '../src/common/object-store';
import { JobQueue } from '../src/jobs/job-queue.service';
import { DocumentsService } from '../src/documents/documents.service';
import { startApp, type Harness } from './harness';

const levels = [{ label: 'Minor', value: 'LOW' }, { label: 'Serious', value: 'HIGH' }];
const form = (code: string, extra: object = {}, label = 'Customer') => ({
  name: `${code} form`,
  code,
  businessId: '',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [
    { id: 'a', type: 'TEXT', name: 'customer', label, required: true },
    { id: 'b', type: 'RADIO', name: 'severity', label: 'Severity', dataSource: { type: 'STATIC', options: levels } },
    { id: 'r', type: 'REPEAT', name: 'items', label: 'Items' },
    { id: 'i', type: 'TEXT', name: 'item', label: 'Item', parentId: 'r' },
    { id: 'q', type: 'NUMBER', name: 'qty', label: 'Qty', parentId: 'r' },
  ],
  workflow: { enabled: true, refPrefix: code.slice(0, 3), statuses: [{ key: 'NEW', label: 'Newly arrived', category: 'OPEN' }, { key: 'CLOSED', label: 'Closed', category: 'DONE' }], assignment: { type: 'NONE' } },
  ...extra,
});

describe('Documents of record (e2e)', () => {
  let h: Harness;
  let owner: string;
  let designer: string;
  let viewer: string;
  let orgId: string;
  let folder: string;
  let dir: string;
  let store: ObjectStore;
  let queue: JobQueue;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fb-docs-'));
    h = await startApp({ LOCAL_STORAGE_DIR: dir });
    store = h.app.get<ObjectStore>(OBJECT_STORE);
    queue = h.app.get(JobQueue);
    await h.signUp('Asha', 'asha@acme.test', 'Acme Trading');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Service' }).expect(201)).body[0].id;
    await h.addMember(owner, 'Dev', 'dev@acme.test', 'DESIGNER');
    await h.addMember(owner, 'Vik', 'vik@acme.test', 'VIEWER');
    designer = (await h.login('dev@acme.test')).token;
    viewer = (await h.login('vik@acme.test')).token;
    await h.api().put('/org/branding').set(h.bearer(owner)).send({ primaryColor: '#0f766e' }).expect(200);
  });
  afterAll(async () => {
    await h?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const publish = async (definition: object) => {
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition }).expect(201)).body.definition.id as string;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
    return id;
  };
  const submit = async (code: string, values: object) => (await h.api().post(`/public/forms/${code}/submissions?org=${orgId}`).send({ values }).expect(201)).body as { submissionId: string; ref: string };
  // If the reader ever cannot read a PDF, say what it was given (small ones in full), so the failure can be looked into
  // from the log alone: the reader throws something that is not an Error and carries no message.
  const pdfOf = (res: { body: Buffer }) =>
    pdfParse(res.body).then(
      (p) => ({ pages: p.numpages, text: p.text.replace(/\s+/g, ' ') }),
      (e: unknown) => {
        const body = Buffer.isBuffer(res.body) ? res.body : Buffer.from(JSON.stringify(res.body ?? null));
        throw new Error(
          `The PDF could not be read (${(e as { name?: string })?.name ?? typeof e}: ${(e as { message?: string })?.message ?? String(e)}). ` +
            `It is ${body.length} bytes, starts ${JSON.stringify(body.subarray(0, 8).toString('latin1'))}, ends ${JSON.stringify(body.subarray(-8).toString('latin1'))}` +
            (body.length <= 16_000 ? `; in full (base64): ${body.toString('base64')}` : ''),
        );
      },
    );
  const download = (formId: string, sid: string, token = owner) => h.api().get(`/forms/${formId}/submissions/${sid}/document`).set(h.bearer(token)).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
  const stored = (code: string) => { try { return readdirSync(join(dir, 'documents', orgId, code)); } catch { return []; } };
  const waitFor = async (check: () => boolean | Promise<boolean>, what: string) => {
    for (let i = 0; i < 200; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  it('a form that keeps a PDF has one made and stored as each response arrives, with no browser', async () => {
    const id = await publish(form('KEEP', { document: { keep: true, footer: 'Acme confidential' } }));
    const sub = await submit('KEEP', { customer: 'Asha Textiles', severity: 'HIGH', items: [{ item: 'Pen', qty: 2 }, { item: 'Ink', qty: 1 }] });
    await waitFor(() => stored('KEEP').length === 1, 'the stored document');
    expect(stored('KEEP')).toEqual([expect.stringMatching(new RegExp(`^${sub.submissionId}-[0-9a-f]{8}\\.pdf$`))]);

    const res = await download(id, sub.submissionId).expect(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(`inline; filename="${sub.ref}.pdf"`);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const { text, pages } = await pdfOf(res);
    expect(pages).toBe(1);
    // Branded, with the record's own reference and status in words, the option's label, and the rows as a table.
    for (const part of ['Acme Trading', 'KEEP form', `Reference ${sub.ref}`, 'Status Newly arrived', 'Asha Textiles', 'Serious', 'Items', 'Pen', 'Ink', 'Acme confidential']) expect(text).toContain(part);
    expect(text).not.toContain('HIGH');
  });

  it('without that setting nothing is made until someone asks; then it is made once and kept', async () => {
    const id = await publish(form('LAZY'));
    const sub = await submit('LAZY', { customer: 'Ravi' });
    await new Promise((r) => setTimeout(r, 150));
    expect(stored('LAZY')).toEqual([]);
    const first = await download(id, sub.submissionId).expect(200);
    expect(stored('LAZY')).toEqual([expect.stringMatching(new RegExp(`^${sub.submissionId}-[0-9a-f]{8}\\.pdf$`))]);
    // Asked again, the same stored document comes back, byte for byte.
    await new Promise((r) => setTimeout(r, 1100));
    const second = await download(id, sub.submissionId).expect(200);
    expect(Buffer.compare(first.body, second.body)).toBe(0);
    expect(stored('LAZY')).toHaveLength(1);
  });

  it('says what was answered at the time: a later change to the form does not rewrite an old response', async () => {
    const id = await publish(form('VERS'));
    const old = await submit('VERS', { customer: 'Before' });
    const next = (await h.api().post(`/forms/${id}/new-version`).set(h.bearer(owner)).expect(200)).body.definition.id;
    await h.api().put(`/forms/${next}`).set(h.bearer(owner)).send(form('VERS', {}, 'Company name')).expect(200);
    await h.api().post(`/forms/${next}/publish`).set(h.bearer(owner)).expect(200);
    const fresh = await submit('VERS', { customer: 'After' });
    const before = (await pdfOf(await download(next, old.submissionId).expect(200))).text;
    const after = (await pdfOf(await download(next, fresh.submissionId).expect(200))).text;
    expect(before).toMatch(/Customer\s*Before/);
    expect(before).not.toContain('Company name');
    expect(after).toMatch(/Company name\s*After/);
  });

  it('only people who may read a form\'s responses get its documents, and only that form\'s', async () => {
    const id = await publish(form('PRIV'));
    const other = await publish(form('OTHER'));
    const sub = await submit('PRIV', { customer: 'Secret Ltd' });
    await download(id, sub.submissionId, designer).expect(200);
    await download(id, sub.submissionId, viewer).expect(404);
    await h.api().get(`/forms/${id}/submissions/${sub.submissionId}/document`).expect(401);
    // Not through another form's address, and not a response that does not exist.
    await download(other, sub.submissionId).expect(404);
    await download(id, '00000000-0000-4000-8000-000000000000').expect(404);
    await h.signUp('Zed', 'zed@other.test', 'Other');
    const stranger = (await h.login('zed@other.test')).token;
    await download(id, sub.submissionId, stranger).expect(404);
  });

  it('if storage fails the job is tried again and ends with exactly one document', async () => {
    const id = await publish(form('RETRY', { document: { keep: true } }));
    const real = store.put.bind(store);
    let failures = 2;
    const put = jest.spyOn(store, 'put').mockImplementation(async (key, data, type) => {
      if (key.includes('/RETRY/') && failures-- > 0) throw new Error('storage unavailable');
      return real(key, data, type);
    });
    try {
      const sub = await submit('RETRY', { customer: 'Unlucky' });
      await new Promise((r) => setTimeout(r, 200));
      expect(stored('RETRY')).toEqual([]);
      // The queue retries later; run it as if that time had come, twice over.
      await queue.drain(new Date(Date.now() + 3_600_000));
      await queue.drain(new Date(Date.now() + 7_200_000));
      expect(stored('RETRY')).toEqual([expect.stringMatching(new RegExp(`^${sub.submissionId}-[0-9a-f]{8}\\.pdf$`))]);
      expect(put.mock.calls.filter(([key]) => key.includes('/RETRY/'))).toHaveLength(3);
      expect((await pdfOf(await download(id, sub.submissionId).expect(200))).text).toContain('Unlucky');
      // A response is never refused or lost because its document could not be made.
      expect((await h.api().get(`/forms/${id}/submissions`).set(h.bearer(owner)).expect(200)).body.rows).toHaveLength(1);
    } finally {
      put.mockRestore();
    }
  });

  it('a workflow email can carry the PDF: the same stored document, to every recipient', async () => {
    const withMail = form('MAILED', {
      fields: [...form('MAILED').fields, { id: 'e', type: 'EMAIL', name: 'email', label: 'Email' }],
      automations: [
        {
          id: 'a1',
          name: 'Send a copy',
          enabled: true,
          when: 'SUBMITTED',
          actions: [
            { id: 's1', type: 'EMAIL', to: [{ kind: 'FIELD', field: 'email' }, { kind: 'EMAIL', email: 'records@acme.test' }], subject: 'Your copy of {{$record.ref}}', body: 'Attached.', attachDocument: true },
            { id: 's2', type: 'EMAIL', to: [{ kind: 'EMAIL', email: 'plain@acme.test' }], subject: 'No file', body: 'Just words.' },
          ],
        },
      ],
    });
    const id = await publish(withMail);
    const sub = await submit('MAILED', { customer: 'Meera', email: 'meera@customer.test' });
    await waitFor(() => h.outbox.some((m) => m.to === 'plain@acme.test'), 'the emails');
    const copies = h.outbox.filter((m) => m.subject === `Your copy of ${sub.ref}`);
    expect(copies.map((m) => m.to).sort()).toEqual(['meera@customer.test', 'records@acme.test']);
    for (const mail of copies) {
      expect(mail.attachments).toHaveLength(1);
      expect(mail.attachments![0]).toMatchObject({ fileName: `${sub.ref}.pdf`, contentType: 'application/pdf' });
      expect((await pdfParse(mail.attachments![0]!.content)).text).toContain('Meera');
    }
    // What was mailed is what is kept and what Responses gives.
    const kept = await download(id, sub.submissionId).expect(200);
    expect(Buffer.compare(kept.body, copies[0]!.attachments![0]!.content)).toBe(0);
    expect(h.outbox.find((m) => m.to === 'plain@acme.test')!.attachments).toBeUndefined();
    const events = (await h.api().get(`/records/${sub.submissionId}`).set(h.bearer(owner)).expect(200)).body.events as { message: string }[];
    expect(events.some((e) => e.message.includes('emailed 2 recipients with the PDF'))).toBe(true);
  });

  describe('the generation API', () => {
    let id: string;
    const generate = (body: object, token = designer) => h.api().post(`/forms/${id}/document`).set(h.bearer(token)).send(body).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    beforeAll(async () => {
      id = await publish(form('GEN', { document: { title: 'Service certificate' } }));
    });

    it('answers in, the form\'s PDF out, nothing stored', async () => {
      const res = await generate({ values: { customer: 'Meera', severity: 'LOW' }, reference: 'CERT/2026/7' }).expect(200);
      expect(res.headers['content-disposition']).toBe('inline; filename="GEN-CERT_2026_7.pdf"');
      const { text } = await pdfOf(res);
      for (const part of ['Service certificate', 'Reference CERT/2026/7', 'Meera', 'Minor']) expect(text).toContain(part);
      expect(stored('GEN')).toEqual([]);
    });

    it('refuses answers that do not fit the form, and people who do not design it', async () => {
      expect((await h.api().post(`/forms/${id}/document`).set(h.bearer(designer)).send({ values: 'nope' }).expect(400)).body.message).toBe('Give the answers as an object: field name to value');
      await h.api().post(`/forms/${id}/document`).set(h.bearer(designer)).send({ values: { customer: { $ne: null } } }).expect(400);
      await h.api().post(`/forms/${id}/document`).set(h.bearer(viewer)).send({ values: { customer: 'x' } }).expect(403);
      await h.api().post(`/forms/${id}/document`).send({ values: { customer: 'x' } }).expect(401);
    });

    it('many at once are queued, checked before anything is made, and each can be fetched when done', async () => {
      const items = Array.from({ length: 12 }, (_, i) => ({ customer: `Customer ${i + 1}`, severity: i % 2 ? 'HIGH' : 'LOW' }));
      expect((await h.api().post(`/forms/${id}/documents/batch`).set(h.bearer(designer)).send({ items: [] }).expect(400)).body.message).toBe('Give the answers for at least one document');
      expect((await h.api().post(`/forms/${id}/documents/batch`).set(h.bearer(designer)).send({ items: [...items, 'bad'] }).expect(400)).body.message).toMatch(/^Item 13: /);
      expect((await h.api().post(`/forms/${id}/documents/batch`).set(h.bearer(designer)).send({ items: Array.from({ length: 1001 }, () => ({ customer: 'x' })) }).expect(400)).body.message).toBe('A batch makes at most 1000 documents');
      await h.api().post(`/forms/${id}/documents/batch`).set(h.bearer(viewer)).send({ items }).expect(403);

      const batch = (await h.api().post(`/forms/${id}/documents/batch`).set(h.bearer(designer)).send({ items }).expect(201)).body;
      expect(batch).toMatchObject({ total: 12, formCode: 'GEN' });
      await waitFor(async () => (await h.api().get(`/documents/batches/${batch.id}`).set(h.bearer(designer))).body.status === 'DONE', 'the batch');
      expect((await h.api().get(`/documents/batches/${batch.id}`).set(h.bearer(designer)).expect(200)).body).toMatchObject({ total: 12, done: 12, failed: 0, status: 'DONE' });
      const last = await h.api().get(`/documents/batches/${batch.id}/12`).set(h.bearer(designer)).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); }).expect(200);
      expect((await pdfOf(last)).text).toContain('Customer 12');
      expect((await pdfOf(last)).text).toContain('Reference 12 of 12');
      await h.api().get(`/documents/batches/${batch.id}/13`).set(h.bearer(designer)).expect(404);
      await h.api().get(`/documents/batches/${batch.id}/0`).set(h.bearer(designer)).expect(404);
      await h.api().get(`/documents/batches/${batch.id}`).set(h.bearer(viewer)).expect(403);
      expect(readdirSync(join(dir, 'documents', orgId, 'batches', batch.id))).toHaveLength(12);
    });
  });

  it("an organisation's own fillable PDF: kept in its library, and each response is written into it", async () => {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 300]);
    page.drawText('Acme claim form 7B', { x: 20, y: 270, size: 14 });
    doc.getForm().createTextField('Customer').addToPage(page, { x: 20, y: 220, width: 200, height: 20 });
    doc.getForm().createTextField('How bad').addToPage(page, { x: 20, y: 180, width: 200, height: 20 });
    const own = Buffer.from(await doc.save());
    const upload = (token: string, body: Buffer, type = 'application/pdf') => h.api().post('/pdf-templates?name=Claim%20form%207B.pdf').set(h.bearer(token)).set('Content-Type', type).send(body);

    // Only someone who may change forms adds one; what is not a fillable PDF is refused, each for its own reason.
    await upload(viewer, own).expect(403);
    expect((await upload(owner, Buffer.from('hello, not a pdf')).expect(400)).body.message).toBe('That file is not a PDF');
    const flat = await PDFDocument.create();
    flat.addPage();
    expect((await upload(owner, Buffer.from(await flat.save())).expect(400)).body.message).toContain('has no boxes to fill in');

    const added = (await upload(designer, own).expect(201)).body;
    expect(added).toMatchObject({ name: 'Claim form 7B', boxes: [{ name: 'Customer', kind: 'text' }, { name: 'How bad', kind: 'text' }] });
    expect((await h.api().get('/pdf-templates').set(h.bearer(viewer)).expect(200)).body.map((t: { name: string }) => t.name)).toEqual(['Claim form 7B']);

    // "Customer" matches the question of that name by itself; "How bad" is pointed at Severity by the designer.
    const id = await publish(form('OWNPDF', { document: { ownPdf: { id: added.id, name: added.name, map: { 'How bad': 'severity' } } } }));
    const sub = await submit('OWNPDF', { customer: 'Asha Textiles', severity: 'HIGH' });
    const pdf = await pdfOf(await download(id, sub.submissionId).expect(200));
    expect(pdf.text).toContain('Acme claim form 7B');
    expect(pdf.text).toContain('Asha Textiles');
    expect(pdf.text).toContain('Serious');
    // It is their page, not ours: none of the product's own layout is on it.
    expect(pdf.text).not.toContain('Newly arrived');

    // Another organisation cannot use, see or remove it.
    await h.signUp('Zed', 'zed@pdf-other.test', 'Other Co');
    const other = (await h.login('zed@pdf-other.test')).token;
    expect((await h.api().get('/pdf-templates').set(h.bearer(other)).expect(200)).body).toEqual([]);
    await h.api().delete(`/pdf-templates/${added.id}`).set(h.bearer(other)).expect(404);

    // Taken out of the library: a response still gets a document, in the product's own layout.
    await h.api().delete(`/pdf-templates/${added.id}`).set(h.bearer(owner)).expect(204);
    const later = await submit('OWNPDF', { customer: 'Ravi Traders', severity: 'LOW' });
    const usual = await pdfOf(await download(id, later.submissionId).expect(200));
    expect(usual.text).toContain('Ravi Traders');
    expect(usual.text).not.toContain('Acme claim form 7B');
  });

  describe('sealed PDFs', () => {
    const hasPdfsig = spawnSync('pdfsig', ['-v'], { stdio: 'ignore' }).status === 0;
    /** What poppler's own signature checker says about a PDF, when it is installed (CI insists on it). */
    const checked = (pdf: Buffer, name: string) => {
      if (!hasPdfsig && !process.env.REQUIRE_PDFSIG) return undefined;
      const file = join(dir, `${name}.pdf`);
      writeFileSync(file, pdf);
      const out = spawnSync('pdfsig', [file], { encoding: 'utf8' });
      return `${out.stdout}${out.stderr}`;
    };
    const raw = async (res: { body: Buffer }) => res.body;

    it('a form whose PDFs are sealed gives a certified PDF, sealed with a certificate made for the organisation', async () => {
      const id = await publish(form('SEALED', { document: { keep: true, seal: true } }));
      const sub = await submit('SEALED', { customer: 'Asha Textiles', severity: 'HIGH' });
      const res = await download(id, sub.submissionId).expect(200);
      const pdf = await raw(res);
      // The same document to read.
      expect((await pdfOf(res)).text).toContain('Asha Textiles');
      const text = pdf.toString('latin1');
      expect(text).toMatch(/\/Perms\s*<<\s*\/DocMDP \d+ 0 R/);
      expect(text).toContain('/TransformMethod /DocMDP');
      const said = checked(pdf, 'sealed-response');
      if (said !== undefined) {
        expect(said).toContain('Signature Validation: Signature is Valid.');
        expect(said).toContain('Signer Certificate Common Name: Acme Trading');
      }
      // Asked for again, it is the very same file: sealed once, when it was made.
      expect((await raw(await download(id, sub.submissionId).expect(200))).equals(pdf)).toBe(true);
      // A form that does not ask for it is as before.
      const plainId = await publish(form('UNSEALED', { document: { keep: true } }));
      const plain = await submit('UNSEALED', { customer: 'Ravi Traders', severity: 'LOW' });
      expect((await raw(await download(plainId, plain.submissionId).expect(200))).toString('latin1')).not.toContain('/DocMDP');
    });

    it('asked for several times at once (the job, a download, an email), there is still one document: the first made', async () => {
      const id = await publish(form('SEALED_RACE', { document: { seal: true } }));
      const sub = await submit('SEALED_RACE', { customer: 'Mira Mills', severity: 'LOW' });
      const docs = h.app.get(DocumentsService);
      const made = await Promise.all(Array.from({ length: 5 }, () => docs.forRecord(orgId, sub.submissionId)));
      for (const m of made.slice(1)) expect(m.pdf.equals(made[0]!.pdf)).toBe(true);
      expect((await raw(await download(id, sub.submissionId).expect(200))).equals(made[0]!.pdf)).toBe(true);
      // The copies that lost were thrown away: one file for this response.
      const files = readdirSync(join(dir, 'documents', orgId, 'SEALED_RACE')).filter((f) => f.startsWith(sub.submissionId));
      expect(files).toHaveLength(1);
    });

    it('admins see whose certificate seals their PDFs, can add their own, and can go back; nobody is shown a key', async () => {
      await h.api().get('/org/seal').set(h.bearer(designer)).expect(403);
      const first = (await h.api().get('/org/seal').set(h.bearer(owner)).expect(200)).body;
      expect(first).toMatchObject({ subject: 'Acme Trading', issuer: 'Acme Trading', selfIssued: true, own: false });
      expect(JSON.stringify(first)).not.toContain('PRIVATE KEY');

      // Their own certificate, as the PEM text a certificate authority sends.
      const theirs = await newSealIdentity('Acme Trading Legal Dept');
      const file = Buffer.from(`${theirs.certificates[0]}${theirs.privateKey}`).toString('base64');
      await h.api().put('/org/seal').set(h.bearer(designer)).send({ file }).expect(403);
      const set = (await h.api().put('/org/seal').set(h.bearer(owner)).send({ file }).expect(200)).body;
      expect(set).toMatchObject({ subject: 'Acme Trading Legal Dept', own: true });
      expect(JSON.stringify(set)).not.toContain('PRIVATE KEY');

      // From now on that is what seals.
      const id = await publish(form('SEALED_OWN', { document: { keep: true, seal: true } }));
      const sub = await submit('SEALED_OWN', { customer: 'Meera Nair', severity: 'LOW' });
      const said = checked(await raw(await download(id, sub.submissionId).expect(200)), 'sealed-own');
      if (said !== undefined) {
        expect(said).toContain('Signature Validation: Signature is Valid.');
        expect(said).toContain('Signer Certificate Common Name: Acme Trading Legal Dept');
      }

      // A file that is not a certificate, or a certificate without its key, is refused in words.
      expect((await h.api().put('/org/seal').set(h.bearer(owner)).send({ file: Buffer.from('hello').toString('base64') }).expect(400)).body.message).toContain('not a certificate file we can read');
      expect((await h.api().put('/org/seal').set(h.bearer(owner)).send({ file: Buffer.from(theirs.certificates[0]!).toString('base64') }).expect(400)).body.message).toContain('must hold both the certificate and its private key');
      // Still theirs after the refusals; then back to the one made for them.
      expect((await h.api().get('/org/seal').set(h.bearer(owner)).expect(200)).body.subject).toBe('Acme Trading Legal Dept');
      expect((await h.api().delete('/org/seal').set(h.bearer(owner)).expect(200)).body).toMatchObject({ subject: 'Acme Trading', own: false, fingerprint: first.fingerprint });
    });

    it('another organisation has a certificate of its own', async () => {
      await h.signUp('Zara', 'zara@seal-other.test', 'Zenith Ltd');
      const other = (await h.login('zara@seal-other.test')).token;
      const theirs = (await h.api().get('/org/seal').set(h.bearer(other)).expect(200)).body;
      const ours = (await h.api().get('/org/seal').set(h.bearer(owner)).expect(200)).body;
      expect(theirs.subject).toBe('Zenith Ltd');
      expect(theirs.fingerprint).not.toBe(ours.fingerprint);
    });
  });
});
