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

describe('Repeating sections are checked by the server (e2e)', () => {
  let h: Harness;
  let owner: string;
  let orgId: string;
  let formId: string;

  const kinds = [{ label: 'Goods', value: 'GOODS' }, { label: 'Service', value: 'SERVICE' }];
  const order = {
    name: 'Order',
    code: 'ORDER',
    businessId: '',
    access: 'PUBLIC',
    submission: { method: 'POST', endpointId: 'default-submit' },
    fields: [
      { id: 'c', type: 'TEXT', name: 'customer', label: 'Customer', required: true },
      { id: 'r', type: 'REPEAT', name: 'lines', label: 'Lines', validation: { min: 1, max: 3 }, props: { totals: ['lineTotal'] } },
      { id: 'i', type: 'TEXT', name: 'item', label: 'Item', required: true, parentId: 'r' },
      { id: 'k', type: 'DROPDOWN', name: 'kind', label: 'Kind', parentId: 'r', dataSource: { type: 'STATIC', options: kinds } },
      { id: 'q', type: 'NUMBER', name: 'qty', label: 'Qty', parentId: 'r', validation: { min: 1 } },
      { id: 'p', type: 'NUMBER', name: 'price', label: 'Price', parentId: 'r' },
      { id: 'l', type: 'NUMBER', name: 'lineTotal', label: 'Line total', parentId: 'r' },
      { id: 's', type: 'TEXT', name: 'serial', label: 'Serial', parentId: 'r' },
      { id: 't', type: 'NUMBER', name: 'total', label: 'Total' },
    ],
    rules: [
      { id: 'line', then: [{ type: 'SET_VALUE', target: 'lineTotal', value: 'qty * price' }] },
      { id: 'tot', then: [{ type: 'SET_VALUE', target: 'total', value: 'sum(lineTotal)' }] },
      { id: 'serial', when: { expr: 'kind == "GOODS"' }, then: [{ type: 'SHOW', target: 'serial' }, { type: 'REQUIRE', target: 'serial' }] },
    ],
    workflow: {
      enabled: true,
      refPrefix: 'ORD',
      statuses: [{ key: 'NEW', label: 'New', category: 'OPEN' }, { key: 'DONE', label: 'Done', category: 'DONE' }],
      assignment: { type: 'NONE' },
      priority: { default: 'LOW', rules: [{ if: { field: 'total', operator: 'greaterThan', value: 1000 }, priority: 'HIGH' }] },
      actions: [{ key: 'finish', label: 'Finish', from: ['NEW'], to: 'DONE' }],
    },
    automations: [
      { id: 'a1', name: 'Confirm', enabled: true, when: 'SUBMITTED', actions: [{ id: 's1', type: 'EMAIL', to: [{ kind: 'EMAIL', email: 'sales@acme.test' }], subject: 'Order {{$record.ref}}', body: 'Lines: {{lines}}. Total {{total}}.' }] },
    ],
  };

  beforeAll(async () => {
    h = await startApp();
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    const folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Sales' }).expect(201)).body[0].id;
    formId = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: order }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${formId}/publish`).set(h.bearer(owner)).expect(200);
  });
  afterAll(() => h?.close());

  const submit = (values: object) => h.api().post(`/public/forms/ORDER/submissions?org=${orgId}`).send({ values });
  const fieldErrors = (body: { errors?: { field: string; message: string }[] }) => Object.fromEntries((body.errors ?? []).map((e) => [e.field, e.message]));
  const pen = { item: 'Pen', kind: 'GOODS', qty: 3, price: 10, serial: 'S1' };
  const setup = { item: 'Setup', kind: 'SERVICE', qty: 1, price: 2500 };

  it('recomputes every row and the total, and uses them for priority and the email', async () => {
    const res = await submit({ customer: 'Acme', lines: [{ ...pen, lineTotal: 1 }, { ...setup, lineTotal: 1, serial: 'not shown' }], total: 5 }).expect(201);
    expect(res.body.payload).toEqual({
      customer: 'Acme',
      lines: [{ ...pen, lineTotal: 30 }, { ...setup, lineTotal: 2500 }],
      total: 2530,
    });
    const { rows } = (await h.api().get(`/forms/${formId}/submissions`).set(h.bearer(owner)).expect(200)).body;
    expect(rows[0]).toMatchObject({ priority: 'HIGH', payload: { total: 2530 } });
    for (let i = 0; i < 60 && !h.outbox.some((m) => m.to === 'sales@acme.test'); i++) await new Promise((r) => setTimeout(r, 50));
    const mail = h.outbox.find((m) => m.to === 'sales@acme.test')!;
    expect(mail.text).toContain('item: Pen; kind: GOODS; qty: 3; price: 10; lineTotal: 30; serial: S1 | item: Setup');
    expect(mail.text).toContain('Total 2530.');
  });

  it('reports a mistake in a row at section.row.field', async () => {
    const res = await submit({ customer: 'Acme', lines: [{ item: '', kind: 'GOODS', qty: 0, price: 1 }, { item: 'x', kind: 'OTHER', qty: 1, price: 1 }] }).expect(422);
    expect(fieldErrors(res.body)).toEqual({
      'lines.0.item': 'Item is required',
      'lines.0.qty': 'Must be at least 1',
      'lines.0.serial': 'Serial is required',
      'lines.1.kind': 'Select a valid option',
    });
  });

  it('checks the number of rows', async () => {
    expect(fieldErrors((await submit({ customer: 'Acme', lines: [] }).expect(422)).body)).toEqual({ lines: 'Add at least 1 rows' });
    expect(fieldErrors((await submit({ customer: 'Acme' }).expect(422)).body)).toEqual({ lines: 'Add at least 1 rows' });
    expect(fieldErrors((await submit({ customer: 'Acme', lines: [setup, setup, setup, setup] }).expect(422)).body)).toEqual({ lines: 'No more than 3 rows' });
    const flood = Array.from({ length: 201 }, () => ({ item: 'x' }));
    expect(fieldErrors((await submit({ customer: 'Acme', lines: flood }).expect(422)).body)).toEqual({ lines: 'No more than 200 rows' });
  });

  it('refuses rows of the wrong shape', async () => {
    const shape = async (lines: unknown) => fieldErrors((await submit({ customer: 'Acme', lines }).expect(422)).body);
    expect(await shape('one line')).toEqual({ lines: 'Must be a list of rows' });
    expect(await shape([['x']])).toEqual({ 'lines.0': 'Must be a row of answers' });
    expect(await shape([{ ...setup, qty: '1' }])).toEqual({ 'lines.0.qty': 'Must be a number' });
    expect(await shape([{ ...setup, customer: 'x' }])).toEqual({ 'lines.0.customer': 'Unknown field' });
    expect(await shape([{ ...setup, $where: 'x' }])).toEqual({ 'lines.0': 'Invalid field name' });
    expect(await shape([{ ...setup, item: '<script>alert(1)</script>' }])).toEqual({ 'lines.0.item': 'HTML tags are not allowed' });
    // A field of the section sent at the top level is not one of the form's answers.
    expect(fieldErrors((await submit({ customer: 'Acme', lines: [setup], qty: 5 }).expect(422)).body)).toEqual({ qty: 'Unknown field' });
  });

  it('will not publish a section holding what cannot repeat', async () => {
    const broken = { ...order, code: 'ORDER_BAD', fields: [...order.fields, { id: 'f', type: 'FILE', name: 'photo', label: 'Photo', parentId: 'r' }] };
    const folder = (await h.api().get('/folders').set(h.bearer(owner)).expect(200)).body[0].id;
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: broken }).expect(201)).body.definition.id;
    const refused = await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(400);
    expect(refused.body.errors.map((e: { message: string }) => e.message)).toContain('A FILE field cannot go inside the repeating section "lines"');
  });
});

describe('hCaptcha is verified by the server (e2e)', () => {
  let h: Harness;
  let owner: string;
  let orgId: string;
  let folder: string;
  const calls: { url: string; body: Record<string, string> }[] = [];
  let verdict: Record<string, unknown> = { success: true };
  const realFetch = globalThis.fetch;

  const guarded = (code: string, captcha: Record<string, unknown>) => ({
    name: 'Contact',
    code,
    businessId: '',
    access: 'PUBLIC',
    submission: { method: 'POST', endpointId: 'default-submit' },
    captcha: { enabled: true, provider: 'HCAPTCHA', siteKey: 'site-key-1', mode: 'CHECKBOX', ...captcha },
    fields: [
      { id: 'a', type: 'TEXT', name: 'who', label: 'Who', required: true },
      { id: 'c', type: 'CAPTCHA', name: 'captchaToken' },
    ],
  });

  beforeAll(async () => {
    h = await startApp();
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes('siteverify')) return realFetch(input, init);
      calls.push({ url, body: Object.fromEntries(new URLSearchParams(String(init?.body))) });
      return new Response(JSON.stringify(verdict), { status: 200 });
    }) as typeof fetch;
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Web' }).expect(201)).body[0].id;
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: guarded('CONTACT', {}) }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    delete process.env.FORM_HCAPTCHA_SECRET;
    await h?.close();
  });

  const submit = (captchaToken?: string) => h.api().post(`/public/forms/CONTACT/submissions?org=${orgId}`).send({ values: { who: 'Asha', captchaToken } });

  it('refuses rather than waves through when its secret is not set', async () => {
    delete process.env.FORM_HCAPTCHA_SECRET;
    await submit('token-1').expect(503);
    expect(calls).toHaveLength(0);
  });

  it('asks hCaptcha, naming the form\'s own site key, and stores the answer without the token', async () => {
    process.env.FORM_HCAPTCHA_SECRET = 'shh';
    verdict = { success: true };
    const res = await submit('token-2').expect(201);
    expect(calls.at(-1)).toMatchObject({ url: 'https://api.hcaptcha.com/siteverify', body: { secret: 'shh', response: 'token-2', sitekey: 'site-key-1' } });
    expect(res.body.payload).toEqual({ who: 'Asha' });
  });

  it('rejects a token hCaptcha does not accept, a missing one, and a mock one', async () => {
    process.env.FORM_HCAPTCHA_SECRET = 'shh';
    verdict = { success: false, 'error-codes': ['invalid-input-response'] };
    const bad = await submit('forged').expect(422);
    expect(bad.body.errors).toEqual([{ field: 'captchaToken', message: 'Verification failed - please try again' }]);
    const before = calls.length;
    await submit().expect(422);
    await submit('mock-captcha-123').expect(400);
    expect(calls).toHaveLength(before);
  });

  it('score-based checking is offered with reCAPTCHA only', async () => {
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: guarded('CONTACT_V3', { mode: 'V3' }) }).expect(201)).body.definition.id;
    const refused = await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(400);
    expect(refused.body.errors.map((e: { message: string }) => e.message)).toContain('Score-based checking is only offered by reCAPTCHA');
  });
});
