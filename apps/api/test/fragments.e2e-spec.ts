import { startApp, type Harness } from './harness';

const address = {
  name: 'Address',
  description: 'Postal address',
  fields: [
    { id: 'line1', type: 'TEXT', name: 'line1', label: 'Address line', required: true },
    { id: 'city', type: 'TEXT', name: 'city', label: 'City', required: true },
    { id: 'pin', type: 'TEXT', name: 'pin', label: 'PIN code', requiredWhen: { field: 'city', operator: 'isNotEmpty' } },
  ],
};

const form = (code: string, fields: object[]) => ({ name: code, code, businessId: '', access: 'PUBLIC', submission: { method: 'POST', endpointId: 'default-submit' }, fields });
const section = (id: string, fragmentId: string, prefix?: string) => ({ id, type: 'SECTION', name: id, label: prefix ? `${prefix} address` : 'Address', props: { fragment: { id: fragmentId, ...(prefix ? { prefix } : {}) } } });
const name = { id: 'who', type: 'TEXT', name: 'customer', label: 'Customer', required: true };

describe('Fragments (e2e)', () => {
  let h: Harness;
  let owner: string;
  let designer: string;
  let orgId: string;
  let folder: string;
  let fragId: string;

  beforeAll(async () => {
    h = await startApp();
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Sales' }).expect(201)).body[0].id;
    await h.addMember(owner, 'Dev', 'dev@acme.test', 'DESIGNER');
    designer = (await h.login('dev@acme.test')).token;
  });
  afterAll(() => h?.close());

  const draft = async (definition: object, token = owner) => (await h.api().post('/forms').set(h.bearer(token)).send({ folderId: folder, definition }).expect(201)).body.definition.id as string;
  const publish = (id: string) => h.api().post(`/forms/${id}/publish`).set(h.bearer(owner));
  const submit = (code: string, values: object) => h.api().post(`/public/forms/${code}/submissions?org=${orgId}`).send({ values });
  const names = (def: { fields: { name: string }[] }) => def.fields.map((f) => f.name);
  const republish = async (code: string) => {
    const current = (await h.api().get('/forms').set(h.bearer(owner)).expect(200)).body.find((f: { code: string }) => f.code === code).id;
    const next = (await h.api().post(`/forms/${current}/new-version`).set(h.bearer(owner)).expect(200)).body.definition.id;
    return (await publish(next).expect(200)).body.definition;
  };

  it('an admin keeps a section in the library; a designer can use it but not change it', async () => {
    await h.api().post('/fragments').set(h.bearer(designer)).send(address).expect(403);
    const made = (await h.api().post('/fragments').set(h.bearer(owner)).send(address).expect(201)).body;
    fragId = made.id;
    expect(made).toMatchObject({ name: 'Address', description: 'Postal address', usedBy: [] });
    expect(names(made)).toEqual(['line1', 'city', 'pin']);
    expect((await h.api().get('/fragments').set(h.bearer(designer)).expect(200)).body.map((f: { name: string }) => f.name)).toEqual(['Address']);
    await h.api().put(`/fragments/${fragId}`).set(h.bearer(designer)).send(address).expect(403);
    await h.api().delete(`/fragments/${fragId}`).set(h.bearer(designer)).expect(403);
  });

  it('a fragment is checked like a form, and must stand on its own', async () => {
    const problems = async (body: object) => (await h.api().post('/fragments').set(h.bearer(owner)).send(body).expect(400)).body.errors.map((e: { message: string }) => e.message);
    expect(await problems({ ...address, name: '' })).toEqual(['Give the fragment a name']);
    expect(await problems({ ...address, fields: [] })).toContain('Add at least one field for people to fill in');
    expect(await problems({ ...address, fields: [{ id: 'a', type: 'TEXT', name: '1bad', label: 'x' }] })).toEqual(['Field name must be letters, digits or _, not starting with a digit']);
    expect(await problems({ ...address, fields: [...address.fields, { id: 'x', type: 'TEXT', name: 'gst', label: 'GST', requiredWhen: { field: 'country', operator: 'equals', value: 'IN' } }] })).toContain(
      '"GST" depends on "country", which is not part of the fragment',
    );
    expect(await problems({ ...address, fields: [...address.fields, section('inner', 'whatever')] })).toContain('"Address" is itself a fragment; a fragment cannot hold another');
  });

  it('three forms use it; one of them twice, told apart by a prefix', async () => {
    for (const code of ['ORDER', 'QUOTE']) {
      const id = await draft(form(code, [name, section('addr', fragId)]), designer);
      const published = (await publish(id).expect(200)).body.definition;
      // The section is filled from the library when the form is published, whatever the draft held.
      expect(names(published)).toEqual(['customer', 'addr', 'line1', 'city', 'pin']);
    }
    const twice = await draft(form('INVOICE', [name, section('bill', fragId), section('ship', fragId)]));
    expect((await publish(twice).expect(400)).body.errors[0].message).toBe('"Address" is used more than once on this form. Give each one a different prefix so their answers are kept apart.');
    await h.api().put(`/forms/${twice}`).set(h.bearer(owner)).send(form('INVOICE', [name, section('bill', fragId, 'billing'), section('ship', fragId, 'shipping')])).expect(200);
    const published = (await publish(twice).expect(200)).body.definition;
    expect(names(published)).toEqual(['customer', 'bill', 'billing_line1', 'billing_city', 'billing_pin', 'ship', 'shipping_line1', 'shipping_city', 'shipping_pin']);
    expect(published.fields.find((f: { name: string }) => f.name === 'shipping_pin').requiredWhen).toEqual({ field: 'shipping_city', operator: 'isNotEmpty' });

    // The fields behave as the form's own: required, and kept apart in the answers.
    const short = await submit('INVOICE', { customer: 'Ravi', billing_line1: '1 MG Road', billing_city: 'Pune', billing_pin: '411001' }).expect(422);
    expect(short.body.errors.map((e: { field: string }) => e.field).sort()).toEqual(['shipping_city', 'shipping_line1']);
    const ok = await submit('INVOICE', { customer: 'Ravi', billing_line1: '1 MG Road', billing_city: 'Pune', billing_pin: '411001', shipping_line1: '9 Dock Rd', shipping_city: 'Kochi', shipping_pin: '682001' }).expect(201);
    expect(ok.body.payload).toMatchObject({ billing_city: 'Pune', shipping_city: 'Kochi' });

    const listed = (await h.api().get('/fragments').set(h.bearer(owner)).expect(200)).body[0];
    expect(listed.usedBy.map((u: { code: string }) => u.code).sort()).toEqual(['INVOICE', 'ORDER', 'QUOTE']);
  });

  it('changed once in the library, every form shows the change after it is published again, and not before', async () => {
    const changed = { ...address, fields: [...address.fields, { id: 'country', type: 'TEXT', name: 'country', label: 'Country', required: true }] };
    await h.api().put(`/fragments/${fragId}`).set(h.bearer(owner)).send(changed).expect(200);

    // Live forms are untouched: the old fields still make a complete answer.
    await submit('ORDER', { customer: 'A', line1: 'x', city: 'Pune', pin: '1' }).expect(201);

    for (const code of ['ORDER', 'QUOTE']) expect(names(await republish(code))).toEqual(['customer', 'addr', 'line1', 'city', 'pin', 'country']);
    expect(names(await republish('INVOICE'))).toEqual(['customer', 'bill', 'billing_line1', 'billing_city', 'billing_pin', 'billing_country', 'ship', 'shipping_line1', 'shipping_city', 'shipping_pin', 'shipping_country']);

    const missing = await submit('ORDER', { customer: 'B', line1: 'x', city: 'Pune', pin: '1' }).expect(422);
    expect(missing.body.errors).toEqual([{ field: 'country', message: 'Country is required' }]);
    await submit('ORDER', { customer: 'B', line1: 'x', city: 'Pune', pin: '1', country: 'India' }).expect(201);
  });

  it('a fragment in use cannot be deleted; a section whose fragment has gone says what to do', async () => {
    const refused = await h.api().delete(`/fragments/${fragId}`).set(h.bearer(owner)).expect(409);
    expect(refused.body.message).toBe('"Address" is used by INVOICE, ORDER, QUOTE. Detach it there first.');

    const spare = (await h.api().post('/fragments').set(h.bearer(owner)).send({ ...address, name: 'Spare' }).expect(201)).body.id;
    await h.api().delete(`/fragments/${spare}`).set(h.bearer(owner)).expect(200);
    const orphan = await draft(form('ORPHAN', [name, { ...section('addr', spare), label: 'Delivery address' }]));
    expect((await publish(orphan).expect(400)).body.errors[0].message).toBe('The fragment "Delivery address" is no longer in the library. Detach the section to keep its fields, or remove it.');
    // Detached, it is a section of the form's own.
    await h.api().put(`/forms/${orphan}`).set(h.bearer(owner)).send(form('ORPHAN', [name, { id: 'addr', type: 'SECTION', name: 'addr', label: 'Delivery address' }, { id: 'l', type: 'TEXT', name: 'line1', label: 'Line', parentId: 'addr' }])).expect(200);
    await publish(orphan).expect(200);
  });

  it('another organisation has its own library; a form sent to it keeps its fields as its own', async () => {
    await h.signUp('Zed', 'zed@other.test', 'Other');
    const stranger = (await h.login('zed@other.test')).token;
    expect((await h.api().get('/fragments').set(h.bearer(stranger)).expect(200)).body).toEqual([]);
    await h.api().put(`/fragments/${fragId}`).set(h.bearer(stranger)).send(address).expect(404);
    await h.api().delete(`/fragments/${fragId}`).set(h.bearer(stranger)).expect(404);

    const theirFolder = (await h.api().post('/folders').set(h.bearer(stranger)).send({ name: 'F' }).expect(201)).body[0].id;
    const current = (await h.api().get('/forms').set(h.bearer(owner)).expect(200)).body.find((f: { code: string }) => f.code === 'ORDER').id;
    const pkg = (await h.api().get(`/forms/${current}/export`).set(h.bearer(owner)).expect(200)).body;
    await h.api().post('/forms/import').set(h.bearer(stranger)).send({ folderId: theirFolder, package: pkg }).expect(201);
    const imported = (await h.api().get('/forms').set(h.bearer(stranger)).expect(200)).body.find((f: { code: string }) => f.code === 'ORDER').id;
    const def = (await h.api().get(`/forms/${imported}`).set(h.bearer(stranger)).expect(200)).body.definition;
    expect(names(def)).toEqual(['customer', 'addr', 'line1', 'city', 'pin', 'country']);
    expect(def.fields.find((f: { name: string }) => f.name === 'addr').props?.fragment).toBeUndefined();
    await h.api().post(`/forms/${imported}/publish`).set(h.bearer(stranger)).expect(200);
  });
});
