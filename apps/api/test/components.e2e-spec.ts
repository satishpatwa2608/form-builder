import { startApp, type Harness } from './harness';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const days = ['MON', 'TUE', 'WED'].map((v) => ({ label: v, value: v }));

const booking = {
  name: 'Booking',
  code: 'BOOKING',
  businessId: '',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [
    { id: 't', type: 'TABS', name: 'parts' },
    { id: 's1', type: 'SECTION', name: 'you', label: 'You', parentId: 't' },
    { id: 'f1', type: 'TEXT', name: 'who', label: 'Who', required: true, parentId: 's1' },
    { id: 'f2', type: 'SWITCH', name: 'urgent', label: 'Urgent', parentId: 's1' },
    { id: 's2', type: 'SECTION', name: 'trip', label: 'Trip', parentId: 't' },
    { id: 'f3', type: 'CHECKBOX_GROUP', name: 'days', label: 'Days', dataSource: { type: 'STATIC', options: days }, validation: { max: 2 }, parentId: 's2' },
    { id: 'f4', type: 'STEPPER', name: 'guests', label: 'Guests', validation: { min: 1, max: 4 }, parentId: 's2' },
    { id: 'f5', type: 'IMAGE', name: 'map', props: { src: 'https://cdn.example.com/map.png', alt: 'Map' } },
    { id: 'f6', type: 'CONSENT', name: 'terms', label: 'I accept', required: true, props: { text: 'The terms.' } },
    { id: 'f7', type: 'SIGNATURE', name: 'sign', label: 'Signature', required: true },
  ],
};

describe('Phase 5 fields are checked by the server (e2e)', () => {
  let h: Harness;
  let owner: string;
  let orgId: string;
  let folder: string;

  beforeAll(async () => {
    h = await startApp();
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Travel' }).expect(201)).body[0].id;
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: booking }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
  });
  afterAll(() => h?.close());

  const good = { who: 'Asha', urgent: true, days: ['MON', 'WED'], guests: 2, terms: true, sign: PNG };
  const submit = (values: object) => h.api().post(`/public/forms/BOOKING/submissions?org=${orgId}`).send({ values });
  const fieldErrors = (body: { errors?: { field: string; message: string }[] }) => Object.fromEntries((body.errors ?? []).map((e) => [e.field, e.message]));

  it('stores a good submission', async () => {
    expect((await submit(good).expect(201)).body.payload).toEqual(good);
  });

  it('rejects values of the wrong shape before anything else', async () => {
    const shape = async (values: object) => fieldErrors((await submit({ ...good, ...values }).expect(422)).body);
    expect(await shape({ urgent: 'yes' })).toEqual({ urgent: 'Must be true or false' });
    expect(await shape({ days: 'MON' })).toEqual({ days: 'Must be a list of options' });
    expect(await shape({ guests: '2' })).toEqual({ guests: 'Must be a number' });
    expect(await shape({ terms: 1 })).toEqual({ terms: 'Must be true or false' });
    // A picture, a tab strip and a section hold nothing: sending a value for one is refused.
    expect(await shape({ map: 'x' })).toEqual({ map: 'Unknown field' });
    expect(await shape({ parts: 'x' })).toEqual({ parts: 'Unknown field' });
  });

  it('only accepts a signature that is a small PNG', async () => {
    for (const sign of ['data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,PHNjcmlwdD4=', 'https://evil.test/x.png', `${PNG}" onerror="x`, `data:image/png;base64,${'A'.repeat(160_000)}`]) {
      expect(fieldErrors((await submit({ ...good, sign }).expect(422)).body)).toEqual({ sign: 'Must be a signature' });
    }
  });

  it('applies the same rules as the form', async () => {
    const rules = async (values: object) => fieldErrors((await submit({ ...good, ...values }).expect(422)).body);
    expect(await rules({ terms: false })).toEqual({ terms: 'Please accept to continue' });
    expect(await rules({ sign: '' })).toEqual({ sign: 'Please sign' });
    expect(await rules({ days: ['MON', 'TUE', 'WED'] })).toEqual({ days: 'Select at most 2' });
    expect(await rules({ days: ['SUN'] })).toEqual({ days: 'Select a valid option' });
    expect(await rules({ guests: 9 })).toEqual({ guests: 'Must be at most 4' });
    expect(await rules({ who: '' })).toEqual({ who: 'Who is required' });
  });

  it('will not publish tabs holding a loose field, or a picture from an unsafe address', async () => {
    const broken = {
      ...booking,
      code: 'BROKEN',
      fields: [
        ...booking.fields.filter((f) => f.id !== 'f5'),
        { id: 'x1', type: 'TEXT', name: 'loose', label: 'Loose', parentId: 't' },
        { id: 'x2', type: 'IMAGE', name: 'pic', props: { src: 'javascript:alert(1)', alt: 'x' } },
      ],
    };
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: broken }).expect(201)).body.definition.id;
    const refused = await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(400);
    expect(refused.body.errors.map((e: { message: string }) => e.message)).toEqual(
      expect.arrayContaining(['Only sections go directly inside "parts": put this field in one of them', 'The picture needs an https:// or site-relative (/…) address']),
    );
  });
});
