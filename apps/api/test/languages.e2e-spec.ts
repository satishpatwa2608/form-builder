import { readPdf as pdfParse } from './read-pdf';
import { startApp, type Harness } from './harness';

const form = {
  name: 'Visitor pass',
  code: 'VISITOR',
  businessId: '',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  languages: { default: 'en', others: ['hi', 'ar'] },
  fields: [
    { id: 'a', type: 'TEXT', name: 'visitor', label: 'Visitor name', required: true },
    { id: 'b', type: 'EMAIL', name: 'email', label: 'Email' },
    { id: 'c', type: 'RADIO', name: 'purpose', label: 'Purpose', dataSource: { type: 'STATIC', options: [{ label: 'Meeting', value: 'MEET' }, { label: 'Delivery', value: 'DELIVER' }] } },
  ],
  translations: {
    hi: { 'form.name': 'आगंतुक पास', 'field.visitor.label': 'आगंतुक का नाम', 'field.purpose.label': 'उद्देश्य', 'field.purpose.option.MEET': 'बैठक' },
    ar: { 'field.visitor.label': 'اسم الزائر' },
  },
};

describe('Forms in several languages (e2e)', () => {
  let h: Harness;
  let owner: string;
  let orgId: string;
  let id: string;

  beforeAll(async () => {
    h = await startApp();
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    const folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Front desk' }).expect(201)).body[0].id;
    id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: form }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
  });
  afterAll(() => h?.close());

  const submit = (values: object, language?: string) => h.api().post(`/public/forms/VISITOR/submissions?org=${orgId}`).send({ values, ...(language ? { language } : {}) });
  const stored = async () => (await h.api().get(`/forms/${id}/submissions`).set(h.bearer(owner)).expect(200)).body.rows as { uuid: string; language: string; payload: Record<string, unknown> }[];

  it('the published form carries its languages and translations to whoever opens it', async () => {
    const pub = (await h.api().get(`/public/forms/VISITOR?org=${orgId}`).expect(200)).body;
    const def = pub.definition ?? pub;
    expect(def.languages).toEqual({ default: 'en', others: ['hi', 'ar'] });
    expect(def.translations.hi['field.visitor.label']).toBe('आगंतुक का नाम');
  });

  it('the server answers mistakes in the language the form is being filled in', async () => {
    const problems = async (language?: string) => Object.fromEntries(((await submit({ email: 'nope', purpose: 'WRONG' }, language).expect(422)).body.errors as { field: string; message: string }[]).map((e) => [e.field, e.message]));
    expect(await problems()).toEqual({ visitor: 'Visitor name is required', email: 'Enter a valid email address', purpose: 'Select a valid option' });
    expect(await problems('hi')).toEqual({ visitor: 'आगंतुक का नाम आवश्यक है', email: 'एक मान्य ईमेल पता दर्ज करें', purpose: 'एक मान्य विकल्प चुनें' });
    expect(await problems('ar')).toEqual({ visitor: 'اسم الزائر مطلوب', email: 'أدخل عنوان بريد إلكتروني صالحًا', purpose: 'اختر خيارًا صالحًا' });
    // A regional form of a language it has; a language it does not have; and nonsense.
    expect((await problems('hi-IN')).visitor).toBe('आगंतुक का नाम आवश्यक है');
    expect((await problems('fr')).visitor).toBe('Visitor name is required');
    expect((await submit({}, '<script>'.repeat(50)).expect(422)).body.errors[0].message).toBe('Visitor name is required');
  });

  it('answers are stored the same whatever the language; the language itself is remembered', async () => {
    await submit({ visitor: 'आशा राव', purpose: 'MEET' }, 'hi').expect(201);
    await submit({ visitor: 'Ravi', purpose: 'MEET' }).expect(201);
    await submit({ visitor: 'Zed', purpose: 'MEET' }, 'fr').expect(201);
    const rows = await stored();
    expect(rows.map((r) => [r.payload.visitor, r.payload.purpose, r.language]).sort()).toEqual([['Ravi', 'MEET', 'en'], ['Zed', 'MEET', 'en'], ['आशा राव', 'MEET', 'hi']].sort());
  });

  it('the PDF of a response is in the language it was answered in', async () => {
    const rows = await stored();
    const pdf = async (uuid: string) => {
      const res = await h.api().get(`/forms/${id}/submissions/${uuid}/document`).set(h.bearer(owner)).buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); }).expect(200);
      return (await pdfParse(res.body as Buffer)).text.replace(/\s+/g, ' ');
    };
    const english = await pdf(rows.find((r) => r.payload.visitor === 'Ravi')!.uuid);
    expect(english).toContain('Visitor pass');
    expect(english).toContain('Meeting');
    const hindi = await pdf(rows.find((r) => r.language === 'hi')!.uuid);
    // Hindi text cannot be read back out of a PDF reliably; what can be checked is that the English wording is gone.
    expect(hindi).not.toContain('Visitor pass');
    expect(hindi).not.toContain('Visitor name');
    expect(hindi).not.toContain('Meeting');
  });

  it('a language code that is not one is refused when the form is saved', async () => {
    const folder = (await h.api().get('/folders').set(h.bearer(owner)).expect(200)).body[0].id;
    const bad = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: { ...form, code: 'BAD', languages: { default: 'en', others: ['Hindi please'] } } }).expect(400)).body;
    expect(JSON.stringify(bad)).toContain('Use a language code such as en, hi or ar');
  });
});
