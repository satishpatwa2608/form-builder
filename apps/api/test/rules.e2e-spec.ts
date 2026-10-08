import { startApp, type Harness } from './harness';

const sizes = ['S', 'M', 'L'].map((v) => ({ label: v, value: v }));

/** An expense claim whose totals, limits and options are decided by form rules. */
const claim = (rules: unknown[]) => ({
  name: 'Expense claim',
  code: 'EXPENSE',
  businessId: '',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [
    { id: 'f1', type: 'NUMBER', name: 'quantity', label: 'Quantity', required: true },
    { id: 'f2', type: 'NUMBER', name: 'unitPrice', label: 'Unit price', required: true },
    { id: 'f3', type: 'NUMBER', name: 'tax', label: 'Tax' },
    { id: 'f4', type: 'NUMBER', name: 'total', label: 'Total', validation: { max: 100000 } },
    { id: 'f5', type: 'TEXTAREA', name: 'justification', label: 'Justification' },
    { id: 'f6', type: 'DATE', name: 'spentOn', label: 'Spent on' },
    { id: 'f7', type: 'CHECKBOX', name: 'kids', label: 'Kids range' },
    { id: 'f8', type: 'DROPDOWN', name: 'size', label: 'Size', dataSource: { type: 'STATIC', options: sizes } },
  ],
  rules,
  workflow: {
    enabled: true,
    refPrefix: 'EXP',
    statuses: [
      { key: 'NEW', label: 'New', category: 'OPEN' },
      { key: 'PAID', label: 'Paid', category: 'DONE' },
    ],
    assignment: { type: 'NONE' },
    priority: { default: 'LOW', rules: [{ if: { field: 'total', operator: 'greaterThan', value: 5000 }, priority: 'HIGH' }] },
    actions: [{ key: 'pay', label: 'Pay', from: ['NEW'], to: 'PAID' }],
  },
});

const rules = [
  { id: 'tax', then: [{ type: 'SET_VALUE', target: 'tax', value: 'round(quantity * unitPrice * 0.18, 2)' }] },
  { id: 'total', then: [{ type: 'SET_VALUE', target: 'total', value: 'quantity * unitPrice + tax' }] },
  { id: 'why', when: { expr: 'total > 5000' }, then: [{ type: 'REQUIRE', target: 'justification' }] },
  { id: 'date', when: { expr: 'spentOn > today()' }, then: [{ type: 'ERROR', target: 'spentOn', message: 'Cannot be in the future' }] },
  { id: 'kids', when: { field: 'kids', operator: 'equals', value: true }, then: [{ type: 'SET_OPTIONS', target: 'size', values: ['S'] }] },
];

describe('Form rules are enforced by the server (e2e)', () => {
  let h: Harness;
  let owner: string;
  let orgId: string;
  let folder: string;
  let formId: string;

  beforeAll(async () => {
    h = await startApp();
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Finance' }).expect(201)).body[0].id;
    formId = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: claim(rules) }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${formId}/publish`).set(h.bearer(owner)).expect(200);
  });
  afterAll(() => h?.close());

  const submit = (values: object) => h.api().post(`/public/forms/EXPENSE/submissions?org=${orgId}`).send({ values });
  const fieldErrors = (body: { errors?: { field: string; message: string }[] }) =>
    Object.fromEntries((body.errors ?? []).map((e) => [e.field, e.message]));

  it('keeps rules on the form and serves them to the public page', async () => {
    const form = (await h.api().get(`/public/forms/EXPENSE?org=${orgId}`).expect(200)).body;
    expect((form.definition ?? form).rules).toHaveLength(rules.length);
  });

  it('a draft may hold a broken rule, but it cannot be published', async () => {
    const broken = [
      { id: 'a', then: [{ type: 'SET_VALUE', target: 'total', value: 'launch(quantity)' }] },
      { id: 'b', then: [{ type: 'SET_VALUE', target: 'tax', value: 'tax + 1' }] },
      { id: 'c', then: [{ type: 'SHOW', target: 'missing' }] },
    ];
    const draft = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: { ...claim(broken), code: 'BROKEN' } }).expect(201)).body.definition;
    const refused = await h.api().post(`/forms/${draft.id}/publish`).set(h.bearer(owner)).expect(400);
    const messages = refused.body.errors.map((e: { message: string }) => e.message);
    expect(messages).toEqual(
      expect.arrayContaining(['Unknown function "launch"', 'Calculations loop: tax -> tax', 'Acts on unknown field "missing"']),
    );
    // Not even as a draft: something that is not a rule at all.
    await h.api().put(`/forms/${draft.id}`).set(h.bearer(owner)).send({ ...claim([{ id: 'x', then: [{ type: 'RUN_SCRIPT', target: 'total' }] }]), code: 'BROKEN' }).expect(400);
  });

  it('a tampered total is replaced with the computed one, everywhere it is used', async () => {
    const res = await submit({ quantity: 10, unitPrice: 1000, tax: 0, total: 1 }).expect(422);
    // 10 x 1000 + 18% = 11,800: over 5,000, so the justification the browser tried to dodge is required.
    expect(fieldErrors(res.body)).toEqual({ justification: 'Justification is required' });

    const ok = await submit({ quantity: 10, unitPrice: 1000, tax: 0, total: 1, justification: 'Team offsite' }).expect(201);
    expect(ok.body.payload).toMatchObject({ quantity: 10, unitPrice: 1000, tax: 1800, total: 11800 });

    const { rows } = (await h.api().get(`/forms/${formId}/submissions`).set(h.bearer(owner)).expect(200)).body;
    expect(rows[0].payload).toMatchObject({ tax: 1800, total: 11800 });
    // The workflow's priority rule read the computed total, not the 1 that was sent.
    expect(rows[0].priority).toBe('HIGH');
  });

  it('a calculated field left out of the request is still stored', async () => {
    const ok = await submit({ quantity: 2, unitPrice: 50 }).expect(201);
    expect(ok.body.payload).toEqual({ quantity: 2, unitPrice: 50, tax: 18, total: 118 });
  });

  it("the field's own limits apply to the computed value", async () => {
    const res = await submit({ quantity: 100, unitPrice: 1000, total: 5, justification: 'x' }).expect(422);
    expect(fieldErrors(res.body)).toEqual({ total: 'Must be at most 100000' });
  });

  it("today() is taken in the form's time zone when it has one, whatever the browser claims", async () => {
    // A zone 14 hours ahead of UTC and one 12 behind never share a date with each other.
    const ahead = 'Pacific/Kiritimati';
    const behind = 'Etc/GMT+12';
    const dateIn = (timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const send = (code: string, spentOn: string, timeZone?: string) =>
      h.api().post(`/public/forms/${code}/submissions?org=${orgId}`).send({ values: { quantity: 1, unitPrice: 1, spentOn }, timeZone });

    // No zone on the form: the person's own zone decides what "the future" is.
    await send('EXPENSE', dateIn(ahead), ahead).expect(201);
    await send('EXPENSE', dateIn(ahead), behind).expect(422);
    await send('EXPENSE', dateIn(ahead), 'Not/AZone').expect(422); // unknown zone: UTC

    const fixed = { ...claim(rules), code: 'EXPENSE_FIXED', timeZone: behind };
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: fixed }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
    await send('EXPENSE_FIXED', dateIn(ahead), ahead).expect(422); // claiming a zone further ahead no longer helps
    await send('EXPENSE_FIXED', dateIn(behind), ahead).expect(201);

    const bad = await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: { ...claim(rules), code: 'EXPENSE_BAD', timeZone: 'Mars/Olympus' } }).expect(201);
    const refused = await h.api().post(`/forms/${bad.body.definition.id}/publish`).set(h.bearer(owner)).expect(400);
    expect(refused.body.errors.map((e: { field: string }) => e.field)).toContain('timeZone');
  });

  it('rule errors and narrowed options are checked without a browser', async () => {
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const res = await submit({ quantity: 1, unitPrice: 1, spentOn: future, kids: true, size: 'L' }).expect(422);
    expect(fieldErrors(res.body)).toEqual({ spentOn: 'Cannot be in the future', size: 'Select a valid option' });
    await submit({ quantity: 1, unitPrice: 1, spentOn: '2026-01-05', kids: true, size: 'S' }).expect(201);
    await submit({ quantity: 1, unitPrice: 1, kids: false, size: 'L' }).expect(201);
  });
});
