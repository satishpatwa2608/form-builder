import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { startApp, type Harness } from './harness';

/**
 * A form that opens already filled from a record, read on the server: found by a link made for that record, or
 * by who is signed in. Only the mapped answers reach the browser, and those kept "as the record says" are read
 * from the record again when the form is sent.
 */
describe('Forms: opening filled from a record (e2e)', () => {
  let h: Harness;
  let customerDb: MongoMemoryServer;
  let owner: string;
  let designer: string;
  let viewer: string;
  let orgId: string;
  let folder: string;
  let ref: string;
  let connectorId: string;
  let renewalId: string;

  const renewal = (code: string, extra: object = {}) => ({
    name: `Renewal ${code}`,
    code,
    businessId: '',
    access: 'PUBLIC',
    submission: { method: 'POST', endpointId: 'default-submit' },
    fields: [
      { id: 'c', type: 'TEXT', name: 'customer', label: 'Customer' },
      { id: 'y', type: 'TEXT', name: 'city', label: 'City' },
      { id: 'l', type: 'NUMBER', name: 'limit', label: 'Credit limit asked for' },
      { id: 'r', type: 'REPEAT', name: 'lines', label: 'Open orders' },
      { id: 'i', type: 'TEXT', name: 'item', label: 'Item', parentId: 'r' },
      { id: 'q', type: 'NUMBER', name: 'qty', label: 'Quantity', parentId: 'r' },
    ],
    openWith: {
      source: `/connectors/${ref}/customers`,
      param: 'no',
      by: 'LINK',
      set: { customer: 'name', city: 'city' },
      rows: [{ into: 'lines', from: 'orders', set: { item: 'item', qty: 'qty' } }],
      lock: ['customer', 'lines'],
      ...extra,
    },
  });
  const make = async (definition: object, publishExpected = 200) => {
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition }).expect(201)).body.definition.id as string;
    const published = await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(publishExpected);
    return { id, said: JSON.stringify(published.body) };
  };
  const linkFor = async (id: string, value: string, token = designer, expected = 200) => (await h.api().post(`/forms/${id}/fill-links`).set(h.bearer(token)).send({ value }).expect(expected)).body as { token: string; expiresAt: string; message?: string };
  const opens = (code: string, fill?: string, bearer?: string) => {
    const req = h.api().get(`/public/forms/${code}/opens-with?org=${orgId}${fill ? `&fill=${encodeURIComponent(fill)}` : ''}`);
    return bearer ? req.set(h.bearer(bearer)) : req;
  };
  const submit = (code: string, values: object, fill?: string) => h.api().post(`/public/forms/${code}/submissions?org=${orgId}`).send({ values, ...(fill ? { fill } : {}) });

  beforeAll(async () => {
    process.env.CONNECTOR_ALLOW_PRIVATE_NETWORK = 'true';
    customerDb = await MongoMemoryServer.create();
    const uri = customerDb.getUri();
    const c = await MongoClient.connect(uri);
    await c.db('crm').collection('customers').insertMany([
      { no: 'C1', name: 'Asha Textiles', city: 'Pune', credit: 5000 },
      { no: 'C2', name: 'Ravi Motors', city: 'Delhi', credit: 100 },
    ]);
    await c.db('crm').collection('orders').insertMany([
      { customer_no: 'C1', item: 'Cotton', qty: 40 },
      { customer_no: 'C1', item: 'Silk', qty: 5 },
      { customer_no: 'C2', item: 'Tyres', qty: 8 },
    ]);
    await c.db('crm').collection('staff').insertMany([
      { email: 'dev@acme.test', desk: 'B-12', grade: 'Senior', salary: 90 },
      { email: 'viv@acme.test', desk: 'A-03', grade: 'Junior', salary: 40 },
    ]);
    await c.close();

    h = await startApp();
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    await h.addMember(owner, 'Dev', 'dev@acme.test', 'DESIGNER');
    await h.addMember(owner, 'Viv', 'viv@acme.test', 'VIEWER');
    designer = (await h.login('dev@acme.test')).token;
    viewer = (await h.login('viv@acme.test')).token;
    folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Renewals' }).expect(201)).body[0].id;
    const made = (await h.api().post('/connectors').set(h.bearer(owner)).send({ type: 'mongodb', name: 'CRM', settings: { database: 'crm' }, secrets: { uri } }).expect(201)).body;
    ref = made.ref;
    connectorId = made.id;
    await h
      .api()
      .put(`/connectors/${made.id}/entities`)
      .set(h.bearer(owner))
      .send({
        entities: [
          { key: 'customers', label: 'Customers', fields: ['no', 'name', 'city', 'credit'], keyField: 'no', operations: ['list'], related: [{ name: 'orders', source: `/connectors/${ref}/orders`, field: 'customer_no', equals: 'no' }] },
          { key: 'orders', label: 'Orders', fields: ['customer_no', 'item', 'qty'], operations: ['list'] },
          { key: 'staff', label: 'Staff', fields: ['email', 'desk', 'grade', 'salary'], operations: ['list'] },
        ],
      })
      .expect(200);
    renewalId = (await make(renewal('RENEWAL'))).id;
  });
  afterAll(async () => {
    delete process.env.CONNECTOR_ALLOW_PRIVATE_NETWORK;
    await h?.close();
    await customerDb?.stop();
  });

  it('the page is told only that there are answers to ask for, never where they come from', async () => {
    const shown = (await h.api().get(`/public/forms/RENEWAL?org=${orgId}`).expect(200)).body;
    expect(shown.openWith).toEqual({ by: 'LINK' });
    expect(JSON.stringify(shown)).not.toContain('/connectors/');
    // Nor can the source be read by the page as a look-up could be: it is bound to nothing the page may ask for.
    await h.api().post(`/public/data-sources/query?org=${orgId}`).send({ formCode: 'RENEWAL', key: `/connectors/${ref}/customers`, params: { no: 'C1' } }).expect(404);
  });

  it('without a link it opens empty; with a link made for a record, it opens with that record\'s answers and its rows', async () => {
    expect((await opens('RENEWAL').expect(200)).body).toEqual({ values: {}, found: false, locked: [] });
    // Making a link is for people who may read the form's responses.
    await linkFor(renewalId, 'C1', viewer, 404);
    const { token, expiresAt } = await linkFor(renewalId, 'C1');
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    const opened = (await opens('RENEWAL', token).expect(200)).body;
    // The mapped answers and nothing else of the record: no customer number, no credit limit.
    expect(opened).toEqual({
      found: true,
      locked: ['customer', 'lines'],
      values: { customer: 'Asha Textiles', city: 'Pune', lines: [{ item: 'Cotton', qty: 40 }, { item: 'Silk', qty: 5 }] },
    });
  });

  it('a link that was changed, belongs to another form, or is out of date opens nothing', async () => {
    const { token } = await linkFor(renewalId, 'C1');
    const [body, mark] = token.split('.');
    // Pointed at another customer, with the old signature.
    const other = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), v: 'C2' })).toString('base64url');
    expect((await opens('RENEWAL', `${other}.${mark}`).expect(200)).body.found).toBe(false);
    expect((await opens('RENEWAL', `${body}.${mark!.slice(0, -2)}xx`).expect(200)).body.found).toBe(false);
    expect((await opens('RENEWAL', 'nonsense').expect(200)).body.found).toBe(false);
    // A link made for one form does not open another that reads the same table.
    await make(renewal('RENEWAL_TWO'));
    expect((await opens('RENEWAL_TWO', token).expect(200)).body.found).toBe(false);
    // And it stops working when its time is up.
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 31 * 86_400_000);
    try {
      expect((await opens('RENEWAL', token).expect(200)).body.found).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it('what is kept "as the record says" is read from the record again when the form is sent', async () => {
    const { token } = await linkFor(renewalId, 'C1');
    // The browser sends something else for the locked answers, and its own for the one that may be changed.
    const sent = (await submit('RENEWAL', { customer: 'Somebody Else Ltd', city: 'Mumbai', limit: 9000, lines: [{ item: 'Gold', qty: 999 }] }, token).expect(201)).body;
    expect(sent.payload).toMatchObject({ customer: 'Asha Textiles', city: 'Mumbai', limit: 9000, lines: [{ item: 'Cotton', qty: 40 }, { item: 'Silk', qty: 5 }] });
    // Filled by hand, with no link, it is an ordinary form: nothing is locked because nothing was filled.
    const plain = (await submit('RENEWAL', { customer: 'Walk-in customer', city: 'Goa', limit: 10, lines: [] }).expect(201)).body;
    expect(plain.payload).toMatchObject({ customer: 'Walk-in customer', city: 'Goa' });
  });

  it('a form that opens only from a link can be neither opened nor sent without one', async () => {
    const only = await make(renewal('RENEWAL_ONLY', { only: true }));
    expect((await h.api().get(`/public/forms/RENEWAL_ONLY?org=${orgId}`).expect(200)).body.openWith).toEqual({ by: 'LINK', only: true });
    expect((await opens('RENEWAL_ONLY').expect(403)).body.message).toContain('opens from a link made for you');
    expect((await submit('RENEWAL_ONLY', { customer: 'Made up', city: 'X', limit: 1, lines: [] }).expect(403)).body.message).toContain('opens from a link made for you');
    const { token } = await linkFor(only.id, 'C2');
    expect((await opens('RENEWAL_ONLY', token).expect(200)).body.values).toMatchObject({ customer: 'Ravi Motors', lines: [{ item: 'Tyres', qty: 8 }] });
    expect((await submit('RENEWAL_ONLY', { customer: 'Made up', city: 'Delhi', limit: 1, lines: [] }, token).expect(201)).body.payload.customer).toBe('Ravi Motors');
    // A link for a record that is not there says so.
    const gone = await linkFor(only.id, 'C99');
    expect((await opens('RENEWAL_ONLY', gone.token).expect(404)).body.message).toContain('no longer there');
  });

  it('found by who is signed in: each person opens the form with their own record', async () => {
    const desk = {
      name: 'Desk move',
      code: 'DESK',
      businessId: '',
      access: 'AUTHENTICATED',
      submission: { method: 'POST', endpointId: 'default-submit' },
      fields: [
        { id: 'd', type: 'TEXT', name: 'desk', label: 'Your desk now' },
        { id: 'g', type: 'TEXT', name: 'grade', label: 'Grade' },
        { id: 'w', type: 'TEXT', name: 'wanted', label: 'Desk you would like' },
      ],
      openWith: { source: `/connectors/${ref}/staff`, param: 'email', by: 'USER_EMAIL', set: { desk: 'desk', grade: 'grade' }, lock: ['desk', 'grade'] },
    };
    await make(desk);
    expect((await opens('DESK', undefined, designer).expect(200)).body).toEqual({ found: true, locked: ['desk', 'grade'], values: { desk: 'B-12', grade: 'Senior' } });
    expect((await opens('DESK', undefined, viewer).expect(200)).body.values).toEqual({ desk: 'A-03', grade: 'Junior' });
    // Nobody can send it as someone else, or promote themselves on the way.
    const sent = (await h.api().post(`/public/forms/DESK/submissions?org=${orgId}`).set(h.bearer(viewer)).send({ values: { desk: 'B-12', grade: 'Director', wanted: 'C-01' } }).expect(201)).body;
    expect(sent.payload).toMatchObject({ desk: 'A-03', grade: 'Junior', wanted: 'C-01' });
    // Someone with no record opens it empty.
    expect((await opens('DESK', undefined, owner).expect(200)).body).toEqual({ values: {}, found: false, locked: [] });
  });

  it('a setting that cannot work is refused when the form is published', async () => {
    const bad = async (code: string, extra: object, access = 'PUBLIC') => (await make({ ...renewal(code, extra), access }, 400)).said;
    expect(await bad('OW_BAD1', { by: 'USER_EMAIL' })).toContain('needs a form that asks people to sign in');
    expect(await bad('OW_BAD2', { set: { nothing: 'name' }, lock: [] })).toContain('is not a question of this form');
    expect(await bad('OW_BAD3', { lock: ['limit'] })).toContain('the record does not fill it');
    expect(await bad('OW_BAD4', { param: '' })).toContain('choose the field the record is found by');
    expect(await bad('OW_BAD5', { rows: [{ into: 'lines', set: { item: 'item' } }] })).toContain("say which of the record's lists fills");
    expect(await bad('OW_BAD6', { by: 'EMPLOYEE_ID', only: true }, 'AUTHENTICATED')).toContain('goes with a link made for each record');
  });

  it('when the other system cannot be read, a form that can also be filled by hand still opens, and says so', async () => {
    const { token } = await linkFor(renewalId, 'C1');
    // The table is no longer exposed: the same as the system being out of reach, as far as the form can tell.
    await h.api().put(`/connectors/${connectorId}/entities`).set(h.bearer(owner)).send({ entities: [] }).expect(200);
    expect((await opens('RENEWAL', token).expect(200)).body).toEqual({ values: {}, found: false, locked: [], unavailable: true });
    // But what was to be kept as the record says cannot be checked, so the form is not taken with that link.
    await submit('RENEWAL', { customer: 'Made up', city: 'X', limit: 1, lines: [] }, token).expect(404);
  });
});
