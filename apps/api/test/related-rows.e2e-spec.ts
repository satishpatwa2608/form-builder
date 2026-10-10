import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { startApp, type Harness } from './harness';

/**
 * "A customer has many orders": rows of one table that belong to a row of another, on the same system or a
 * different one, brought along with a look-up so it can fill a form and its repeating section in one go.
 */
describe('Connectors: related rows (e2e)', () => {
  let h: Harness;
  let customerDb: MongoMemoryServer;
  let owner: string;
  let designer: string;
  let crm: { id: string; ref: string };
  let billing: { id: string; ref: string };

  const expose = (id: string, entities: object[], expected = 200) => h.api().put(`/connectors/${id}/entities`).set(h.bearer(owner)).send({ entities }).expect(expected);
  const query = async (key: string, params: object) => (await h.api().post('/connectors/query').set(h.bearer(designer)).send({ key, params }).expect(200)).body as Record<string, unknown>[];
  const customers = (related: object[]) => ({ key: 'customers', label: 'Customers', fields: ['no', 'name', 'city'], keyField: 'no', operations: ['list'], related });
  const orders = { key: 'orders', label: 'Orders', fields: ['customer_no', 'item', 'qty'], operations: ['list'] };

  beforeAll(async () => {
    process.env.CONNECTOR_ALLOW_PRIVATE_NETWORK = 'true';
    customerDb = await MongoMemoryServer.create();
    const uri = customerDb.getUri();
    const c = await MongoClient.connect(uri);
    await c.db('crm').collection('customers').insertMany([
      { no: 'C1', name: 'Asha Textiles', city: 'Pune', credit: 5000 },
      { no: 'C2', name: 'Ravi Motors', city: 'Pune', credit: 100 },
      { no: 'C3', name: 'No orders yet', city: 'Delhi', credit: 0 },
      ...[4, 5, 6, 7].map((n) => ({ no: `C${n}`, name: `Customer ${n}`, city: 'Pune', credit: 0 })),
      { no: '', name: 'Without a number', city: 'Goa', credit: 0 },
    ]);
    await c.db('crm').collection('orders').insertMany([
      { customer_no: 'C1', item: 'Cotton', qty: 40, margin: 0.3 },
      { customer_no: 'C1', item: 'Silk', qty: 5, margin: 0.5 },
      { customer_no: 'C2', item: 'Tyres', qty: 8, margin: 0.1 },
      { customer_no: '', item: 'Belongs to nobody', qty: 1, margin: 0 },
    ]);
    await c.db('billing').collection('invoices').insertMany([{ customer: 'C1', number: 'INV-7', amount: 1200 }, { customer: 'C2', number: 'INV-8', amount: 300 }]);
    await c.close();

    h = await startApp();
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    await h.addMember(owner, 'Dev', 'dev@acme.test', 'DESIGNER');
    designer = (await h.login('dev@acme.test')).token;
    const make = async (name: string, database: string) => (await h.api().post('/connectors').set(h.bearer(owner)).send({ type: 'mongodb', name, settings: { database }, secrets: { uri } }).expect(201)).body as { id: string; ref: string };
    crm = await make('CRM', 'crm');
    billing = await make('Billing', 'billing');
    await expose(billing.id, [{ key: 'invoices', label: 'Invoices', fields: ['customer', 'number', 'amount'], operations: ['list'] }]);
  });
  afterAll(async () => {
    delete process.env.CONNECTOR_ALLOW_PRIVATE_NETWORK;
    await h?.close();
    await customerDb?.stop();
  });

  it('a relation must use exposed fields on both sides, a table forms may list, and a name of its own', async () => {
    const ordersKey = `/connectors/${crm.ref}/orders`;
    const said = async (related: object[], other: object = orders) => String((await expose(crm.id, [customers(related), other], 400)).body.message);
    expect(await said([{ name: 'orders', source: ordersKey, field: 'margin', equals: 'no' }])).toContain('"margin" must be one of the exposed fields of Orders');
    expect(await said([{ name: 'orders', source: ordersKey, field: 'customer_no', equals: 'credit' }])).toContain('"credit" must be one of the exposed fields of Customers');
    expect(await said([{ name: 'city', source: ordersKey, field: 'customer_no', equals: 'no' }])).toContain('"city" is already a name on Customers');
    expect(await said([{ name: 'orders', source: ordersKey, field: 'customer_no', equals: 'no' }], { ...orders, operations: ['insert'] })).toContain('must come from a table that forms may list');
    expect(await said([{ name: 'gone', source: `/connectors/${crm.ref}/nothing`, field: 'x', equals: 'no' }])).toContain('must come from a table that forms may list');
  });

  it('a look-up that finds a customer brings their orders, and their invoices from another system', async () => {
    await expose(crm.id, [
      customers([
        { name: 'orders', source: `/connectors/${crm.ref}/orders`, field: 'customer_no', equals: 'no' },
        { name: 'invoices', source: `/connectors/${billing.ref}/invoices`, field: 'customer', equals: 'no' },
      ]),
      orders,
    ]);
    const [found, ...rest] = await query(`/connectors/${crm.ref}/customers`, { no: 'C1' });
    expect(rest).toEqual([]);
    // Only what each table exposes: no credit limit, no margin.
    expect(found).toEqual({
      no: 'C1',
      name: 'Asha Textiles',
      city: 'Pune',
      orders: [{ customer_no: 'C1', item: 'Cotton', qty: 40 }, { customer_no: 'C1', item: 'Silk', qty: 5 }],
      invoices: [{ customer: 'C1', number: 'INV-7', amount: 1200 }],
    });
    // Each of a few rows brings its own.
    const two = await query(`/connectors/${crm.ref}/customers`, { city: 'Delhi' });
    expect(two).toEqual([{ no: 'C3', name: 'No orders yet', city: 'Delhi', orders: [], invoices: [] }]);
  });

  it('a long list (a dropdown\'s options) brings nothing along, and an empty value matches nothing', async () => {
    const many = await query(`/connectors/${crm.ref}/customers`, { city: 'Pune' });
    expect(many).toHaveLength(6);
    expect(many.every((row) => !('orders' in row) && !('invoices' in row))).toBe(true);
    // A row with nothing to match on gets an empty list, not every row whose field is empty too.
    expect(await query(`/connectors/${crm.ref}/customers`, { city: 'Goa' })).toEqual([{ no: '', name: 'Without a number', city: 'Goa', orders: [], invoices: [] }]);
  });

  it('the builder is told which lists come along and what their rows hold', async () => {
    const sources = (await h.api().get('/connectors/sources').set(h.bearer(designer)).expect(200)).body as { key: string; related?: { name: string; fields: string[] }[] }[];
    expect(sources.find((x) => x.key === `/connectors/${crm.ref}/customers`)!.related).toEqual([
      { name: 'orders', fields: ['customer_no', 'item', 'qty'] },
      { name: 'invoices', fields: ['customer', 'number', 'amount'] },
    ]);
    expect(sources.find((x) => x.key === `/connectors/${crm.ref}/orders`)).not.toHaveProperty('related');
  });

  it('when the other table stops being exposed, the look-up still works and the list is empty', async () => {
    await expose(billing.id, []);
    const [found] = await query(`/connectors/${crm.ref}/customers`, { no: 'C2' });
    expect(found).toMatchObject({ no: 'C2', orders: [{ customer_no: 'C2', item: 'Tyres', qty: 8 }], invoices: [] });
  });
});
