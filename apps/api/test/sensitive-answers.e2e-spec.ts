import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { FormSubmission } from '../src/work/schemas/form-submission.schema';
import { startApp, type Harness } from './harness';

/**
 * Questions marked "Sensitive": what the database holds is ciphertext, and everything that reads a response
 * through the product (the record, the list, the PDF, emails, exports) still sees the answer as it was given.
 */
describe('Sensitive answers are stored encrypted (e2e)', () => {
  let h: Harness;
  let owner: string;
  let orgId: string;
  let formId: string;
  let raw: Model<FormSubmission>;

  const definition = {
    name: 'Account opening',
    code: 'ACCOUNT',
    businessId: '',
    access: 'PUBLIC',
    submission: { method: 'POST', endpointId: 'default-submit' },
    fields: [
      { id: 'n', type: 'TEXT', name: 'fullName', label: 'Full name', required: true },
      { id: 'i', type: 'TEXT', name: 'idNumber', label: 'ID number', sensitive: true },
      { id: 'e', type: 'EMAIL', name: 'email', label: 'Email' },
      { id: 'r', type: 'REPEAT', name: 'accounts', label: 'Accounts' },
      { id: 'rb', type: 'TEXT', name: 'bank', label: 'Bank', parentId: 'r' },
      { id: 'rn', type: 'TEXT', name: 'number', label: 'Account number', parentId: 'r', sensitive: true },
    ],
    workflow: { enabled: true, refPrefix: 'ACC', statuses: [{ key: 'NEW', label: 'New', category: 'OPEN' }, { key: 'DONE', label: 'Done', category: 'DONE' }] },
    automations: [{ id: 'a', name: 'Confirm', enabled: true, when: 'SUBMITTED', actions: [{ id: 'm', type: 'EMAIL', to: [{ kind: 'FIELD', field: 'email' }], subject: 'Received', body: 'ID on file: {{idNumber}}' }] }],
  };
  const values = { fullName: 'Asha Rao', idNumber: 'ABCDE1234F', email: 'asha@customer.test', accounts: [{ bank: 'First Bank', number: '0011223344' }] };
  const send = async (v: object) => (await h.api().post(`/public/forms/ACCOUNT/submissions?org=${orgId}`).send({ values: v }).expect(201)).body.submissionId as string;
  /** What is really in the database, read past the product (the native driver, so nothing opens it on the way). */
  const stored = async (uuid: string) => (await raw.collection.findOne({ uuid }))!;

  beforeAll(async () => {
    h = await startApp();
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    const folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Ops' }).expect(201)).body[0].id;
    formId = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${formId}/publish`).set(h.bearer(owner)).expect(200);
    raw = h.app.get(getModelToken(FormSubmission.name));
  });
  afterAll(async () => h?.close());

  it('the database holds ciphertext for the sensitive answers, and plain text for the rest', async () => {
    const id = await send(values);
    const doc = await stored(id);
    const text = JSON.stringify(doc.payload);
    expect(text).not.toContain('ABCDE1234F');
    expect(text).not.toContain('0011223344');
    // A repeating section with a sensitive question in its rows is sealed whole.
    expect(text).not.toContain('First Bank');
    expect(doc.payload.fullName).toBe('Asha Rao');
    expect(doc.payload.idNumber).toEqual({ __sealed: expect.stringMatching(/^v1\./) });
    expect([...doc.sealedFields].sort()).toEqual(['accounts', 'idNumber']);
    // The same answer sealed twice is not the same ciphertext, so equal answers cannot be matched up.
    const again = await stored(await send(values));
    expect(again.payload.idNumber.__sealed).not.toBe(doc.payload.idNumber.__sealed);
  });

  it('the record, the list and what the submitter is told all carry the answer as it was given', async () => {
    const res = (await h.api().post(`/public/forms/ACCOUNT/submissions?org=${orgId}`).send({ values }).expect(201)).body;
    const detail = (await h.api().get(`/records/${res.submissionId}`).set(h.bearer(owner)).expect(200)).body;
    expect(detail.record.payload).toMatchObject({ idNumber: 'ABCDE1234F', accounts: [{ bank: 'First Bank', number: '0011223344' }] });
    const list = (await h.api().get('/records?formCode=ACCOUNT').set(h.bearer(owner)).expect(200)).body;
    expect(list.rows.find((r: { uuid: string }) => r.uuid === res.submissionId).payload.idNumber).toBe('ABCDE1234F');
    const subs = (await h.api().get(`/forms/${formId}/submissions`).set(h.bearer(owner)).expect(200)).body;
    expect(JSON.stringify(subs)).toContain('ABCDE1234F');
    expect(JSON.stringify(subs)).not.toContain('__sealed');
  });

  it('an email written from the answers, and the PDF of the response, read it too', async () => {
    h.outbox.length = 0;
    const id = await send({ ...values, email: 'mail@customer.test' });
    for (let i = 0; i < 200 && !h.outbox.some((m) => m.to === 'mail@customer.test'); i++) await new Promise((r) => setTimeout(r, 25));
    expect(h.outbox.find((m) => m.to === 'mail@customer.test')!.text).toContain('ID on file: ABCDE1234F');
    const pdf = await h.api().get(`/forms/${formId}/submissions/${id}/document`).set(h.bearer(owner)).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    const { readPdf: pdfParse } = await import('./read-pdf');
    expect((await pdfParse(pdf.body as Buffer)).text).toContain('ABCDE1234F');
  });

  it('a sensitive question left unanswered stores nothing for it', async () => {
    const doc = await stored(await send({ fullName: 'No ID' }));
    expect(doc.payload.fullName).toBe('No ID');
    expect(doc.payload.idNumber).toBeUndefined();
    expect(doc.sealedFields).not.toContain('idNumber');
  });

  it('a draft saved for later is sealed the same way, and comes back as it was typed', async () => {
    const saved = (await h.api().post(`/public/forms/ACCOUNT/drafts?org=${orgId}`).send({ values: { fullName: 'Half done', idNumber: 'ZZZZZ9999Z', accounts: [{ bank: 'Second Bank', number: '998877' }] } }).expect(201)).body;
    const drafts = raw.db.collection('form_drafts');
    const kept = JSON.stringify(await drafts.find({ orgId }).toArray());
    expect(kept).toContain('Half done');
    expect(kept).not.toContain('ZZZZZ9999Z');
    expect(kept).not.toContain('998877');
    const back = (await h.api().post(`/public/forms/ACCOUNT/drafts/load?org=${orgId}`).send({ token: saved.token }).expect(200)).body;
    expect(back.values).toEqual({ fullName: 'Half done', idNumber: 'ZZZZZ9999Z', accounts: [{ bank: 'Second Bank', number: '998877' }] });
  });

  it('filtering on a sensitive answer finds nothing (the database cannot see it), and says nothing wrong', async () => {
    const found = (await h.api().get(`/records?formCode=ACCOUNT&q=ABCDE1234F`).set(h.bearer(owner)).expect(200)).body;
    expect(found.total).toBe(0);
    const byName = (await h.api().get(`/records?formCode=ACCOUNT&q=Asha`).set(h.bearer(owner)).expect(200)).body;
    expect(byName.total).toBeGreaterThan(0);
  });
});
