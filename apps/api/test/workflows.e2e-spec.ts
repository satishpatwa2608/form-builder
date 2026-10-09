import { startApp, type Harness } from './harness';

const levels = [{ label: 'Minor', value: 'LOW' }, { label: 'Serious', value: 'HIGH' }];

/** A complaint process that reads three answers from whichever form uses it. */
const handling = {
  name: 'Complaint handling',
  description: 'New, investigation, closed; serious ones are high priority.',
  workflow: {
    enabled: true,
    statuses: [
      { key: 'NEW', label: 'New', category: 'OPEN' },
      { key: 'INVESTIGATION', label: 'Investigation', category: 'IN_PROGRESS' },
      { key: 'CLOSED', label: 'Closed', category: 'DONE' },
    ],
    assignment: { type: 'NONE' },
    priority: { default: 'MEDIUM', rules: [{ if: { field: 'severity', operator: 'equals', value: 'HIGH' }, priority: 'HIGH' }] },
    actions: [
      { key: 'accept', label: 'Accept', from: ['NEW'], to: 'INVESTIGATION' },
      { key: 'close', label: 'Close', from: ['INVESTIGATION'], to: 'CLOSED' },
    ],
    contactEmailField: 'email',
  },
  automations: [
    { id: 'a1', name: 'Acknowledge', enabled: true, when: 'SUBMITTED', actions: [{ id: 's1', type: 'EMAIL', to: [{ kind: 'FIELD', field: 'email' }], subject: 'We got {{$record.ref}}', body: 'Dear {{customer}}, thank you.' }] },
  ],
  fields: [
    { name: 'severity', label: 'Severity', type: 'RADIO', options: levels },
    { name: 'email', label: "Requester's email", type: 'EMAIL' },
    { name: 'customer', label: "Requester's name", type: 'TEXT' },
  ],
};

const form = (code: string, fields: object[], workflowRef?: object) => ({
  name: code,
  code,
  businessId: '',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields,
  ...(workflowRef ? { workflowRef } : {}),
});

describe('Shared workflows (e2e)', () => {
  let h: Harness;
  let owner: string;
  let designer: string;
  let orgId: string;
  let folder: string;
  let wfId: string;

  beforeAll(async () => {
    h = await startApp();
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Service' }).expect(201)).body[0].id;
    await h.addMember(owner, 'Dev', 'dev@acme.test', 'DESIGNER');
    designer = (await h.login('dev@acme.test')).token;
  });
  afterAll(() => h?.close());

  const draft = async (definition: object, token = owner) => (await h.api().post('/forms').set(h.bearer(token)).send({ folderId: folder, definition }).expect(201)).body.definition.id as string;
  const publish = (id: string) => h.api().post(`/forms/${id}/publish`).set(h.bearer(owner));
  const submit = (code: string, values: object) => h.api().post(`/public/forms/${code}/submissions?org=${orgId}`).send({ values });
  const waitForMail = async (to: string) => {
    for (let i = 0; i < 60 && !h.outbox.some((m) => m.to === to); i++) await new Promise((r) => setTimeout(r, 50));
    return h.outbox.find((m) => m.to === to)!;
  };

  it('an admin adds a workflow to the library; a designer can pick from it but not change it', async () => {
    await h.api().post('/workflows').set(h.bearer(designer)).send(handling).expect(403);
    const made = (await h.api().post('/workflows').set(h.bearer(owner)).send(handling).expect(201)).body;
    wfId = made.id;
    expect(made).toMatchObject({ name: 'Complaint handling', usedBy: [], fields: handling.fields });
    const seen = (await h.api().get('/workflows').set(h.bearer(designer)).expect(200)).body;
    expect(seen.map((w: { name: string }) => w.name)).toEqual(['Complaint handling']);
    await h.api().put(`/workflows/${wfId}`).set(h.bearer(designer)).send(handling).expect(403);
    await h.api().delete(`/workflows/${wfId}`).set(h.bearer(designer)).expect(403);
  });

  it('a workflow is checked like a form\'s own, and must list every answer it reads', async () => {
    const problems = async (body: object) => (await h.api().post('/workflows').set(h.bearer(owner)).send(body).expect(400)).body.errors.map((e: { message: string }) => e.message);
    expect(await problems({ ...handling, name: ' ' })).toEqual(['Give the workflow a name']);
    expect(await problems({ ...handling, workflow: { ...handling.workflow, statuses: [{ key: 'NEW', label: 'New', category: 'OPEN' }] } })).toContain('Add at least one "done" status so records can be closed');
    expect(await problems({ ...handling, fields: handling.fields.filter((f) => f.name !== 'customer') })).toEqual(['The workflow uses "customer", which is not in the list of answers it needs']);
    expect(await problems({ ...handling, fields: [...handling.fields, { name: '1st', label: 'x', type: 'TEXT' }] })).toEqual(['"1st" is not a usable field name: letters, digits or _, not starting with a digit']);
    expect(await problems({ ...handling, workflow: undefined })).toEqual(['There is no workflow to save']);
  });

  it('two forms use it: one whose fields have the same names needs nothing; the other says which field is which', async () => {
    const sameNames = await draft(
      form('COMPLAINT', [
        { id: 'a', type: 'TEXT', name: 'customer', label: 'Your name', required: true },
        { id: 'b', type: 'EMAIL', name: 'email', label: 'Email', required: true },
        { id: 'c', type: 'RADIO', name: 'severity', label: 'Severity', dataSource: { type: 'STATIC', options: levels } },
      ], { id: wfId }),
      designer,
    );
    await publish(sameNames).expect(200);

    const otherNames = [
      { id: 'a', type: 'TEXT', name: 'fullName', label: 'Full name', required: true },
      { id: 'b', type: 'EMAIL', name: 'contactEmail', label: 'Contact email', required: true },
      { id: 'c', type: 'RADIO', name: 'urgency', label: 'Urgency', dataSource: { type: 'STATIC', options: levels } },
    ];
    const unmapped = await draft(form('RETURN', otherNames, { id: wfId }));
    const refused = await publish(unmapped).expect(400);
    expect(refused.body.errors.map((e: { message: string }) => e.message)).toEqual([
      '"Complaint handling" needs "Severity". Choose which of this form\'s fields that is.',
      '"Complaint handling" needs "Requester\'s email". Choose which of this form\'s fields that is.',
      '"Complaint handling" needs "Requester\'s name". Choose which of this form\'s fields that is.',
    ]);
    await h.api().put(`/forms/${unmapped}`).set(h.bearer(owner)).send(form('RETURN', otherNames, { id: wfId, map: { severity: 'urgency', email: 'contactEmail', customer: 'fullName' }, refPrefix: 'RET' })).expect(200);
    const published = (await publish(unmapped).expect(200)).body.definition;
    // The published version carries its own copy, in this form's terms.
    expect(published.workflow.priority.rules[0].if).toEqual({ field: 'urgency', operator: 'equals', value: 'HIGH' });
    expect(published.workflow.contactEmailField).toBe('contactEmail');
    expect(published.automations[0].actions[0]).toMatchObject({ to: [{ kind: 'FIELD', field: 'contactEmail' }], body: 'Dear {{fullName}}, thank you.' });

    // Both forms run the same process.
    const a = (await submit('COMPLAINT', { customer: 'Ravi', email: 'ravi@customer.test', severity: 'HIGH' }).expect(201)).body;
    const b = (await submit('RETURN', { fullName: 'Meera', contactEmail: 'meera@customer.test', urgency: 'LOW' }).expect(201)).body;
    expect(b.ref).toBe('RET-000001');
    expect((await waitForMail('ravi@customer.test')).text).toContain('Dear Ravi, thank you.');
    expect((await waitForMail('meera@customer.test')).text).toContain('Dear Meera, thank you.');
    const record = async (id: string) => (await h.api().get(`/records/${id}`).set(h.bearer(owner)).expect(200)).body;
    expect((await record(a.submissionId)).record).toMatchObject({ status: 'NEW', priority: 'HIGH' });
    expect((await record(b.submissionId)).record).toMatchObject({ status: 'NEW', priority: 'MEDIUM' });
    expect((await record(b.submissionId)).actions.map((x: { key: string }) => x.key)).toEqual(['accept']);

    const listed = (await h.api().get('/workflows').set(h.bearer(owner)).expect(200)).body[0];
    expect(listed.usedBy.map((u: { code: string }) => u.code).sort()).toEqual(['COMPLAINT', 'RETURN']);
  });

  it('changing the workflow reaches a form only when that form is next published', async () => {
    const changed = { ...handling, workflow: { ...handling.workflow, priority: { default: 'LOW', rules: handling.workflow.priority.rules } } };
    await h.api().put(`/workflows/${wfId}`).set(h.bearer(owner)).send(changed).expect(200);
    const priorityOf = async (code: string, values: object) => {
      const res = (await submit(code, values).expect(201)).body;
      return (await h.api().get(`/records/${res.submissionId}`).set(h.bearer(owner)).expect(200)).body.record.priority;
    };
    // Still the copy taken when it was published.
    expect(await priorityOf('COMPLAINT', { customer: 'A', email: 'a@customer.test', severity: 'LOW' })).toBe('MEDIUM');

    const current = (await h.api().get('/forms').set(h.bearer(owner)).expect(200)).body.find((f: { code: string }) => f.code === 'COMPLAINT').id;
    const next = (await h.api().post(`/forms/${current}/new-version`).set(h.bearer(owner)).expect(200)).body.definition.id;
    await publish(next).expect(200);
    expect(await priorityOf('COMPLAINT', { customer: 'B', email: 'b@customer.test', severity: 'LOW' })).toBe('LOW');
    // The other form has not been republished, so it has not changed.
    expect(await priorityOf('RETURN', { fullName: 'C', contactEmail: 'c@customer.test', urgency: 'LOW' })).toBe('MEDIUM');
  });

  it('a workflow in use cannot be deleted; once no form uses it, it can', async () => {
    const refused = await h.api().delete(`/workflows/${wfId}`).set(h.bearer(owner)).expect(409);
    expect(refused.body.message).toMatch(/^"Complaint handling" is used by COMPLAINT, RETURN\. Give those forms another workflow first\.$/);

    const spare = (await h.api().post('/workflows').set(h.bearer(owner)).send({ ...handling, name: 'Spare' }).expect(201)).body.id;
    const id = await draft(form('TEMP', [{ id: 'a', type: 'TEXT', name: 'customer', label: 'N' }, { id: 'b', type: 'EMAIL', name: 'email', label: 'E' }, { id: 'c', type: 'RADIO', name: 'severity', label: 'S', dataSource: { type: 'STATIC', options: levels } }], { id: spare }));
    await h.api().delete(`/workflows/${spare}`).set(h.bearer(owner)).expect(409);
    // A draft that still names a workflow which has gone is told so, in words.
    await h.api().delete(`/forms/${id}`).set(h.bearer(owner)).expect(200);
    await h.api().delete(`/workflows/${spare}`).set(h.bearer(owner)).expect(200);
    const orphan = await draft(form('ORPHAN', [{ id: 'a', type: 'TEXT', name: 'customer', label: 'N' }], { id: spare }));
    expect((await publish(orphan).expect(400)).body.errors[0].message).toBe('The shared workflow this form uses is no longer in the library. Choose another, or give the form its own.');
  });

  it('another organisation neither sees the library nor can use a workflow from it', async () => {
    await h.signUp('Zed', 'zed@other.test', 'Other');
    const stranger = (await h.login('zed@other.test')).token;
    expect((await h.api().get('/workflows').set(h.bearer(stranger)).expect(200)).body).toEqual([]);
    await h.api().put(`/workflows/${wfId}`).set(h.bearer(stranger)).send(handling).expect(404);
    await h.api().delete(`/workflows/${wfId}`).set(h.bearer(stranger)).expect(404);
    const theirFolder = (await h.api().post('/folders').set(h.bearer(stranger)).send({ name: 'F' }).expect(201)).body[0].id;
    const id = (await h.api().post('/forms').set(h.bearer(stranger)).send({ folderId: theirFolder, definition: form('THEIRS', [{ id: 'a', type: 'TEXT', name: 'customer', label: 'N' }], { id: wfId }) }).expect(201)).body.definition.id;
    expect((await h.api().post(`/forms/${id}/publish`).set(h.bearer(stranger)).expect(400)).body.errors[0].message).toContain('no longer in the library');

    // A form exported from the first organisation arrives with its workflow as its own.
    const current = (await h.api().get('/forms').set(h.bearer(owner)).expect(200)).body.find((f: { code: string }) => f.code === 'RETURN').id;
    const pkg = (await h.api().get(`/forms/${current}/export`).set(h.bearer(owner)).expect(200)).body;
    await h.api().post('/forms/import').set(h.bearer(stranger)).send({ folderId: theirFolder, package: pkg }).expect(201);
    const imported = (await h.api().get('/forms').set(h.bearer(stranger)).expect(200)).body.find((f: { code: string }) => f.code === 'RETURN').id;
    const def = (await h.api().get(`/forms/${imported}`).set(h.bearer(stranger)).expect(200)).body.definition;
    expect(def.workflowRef).toBeUndefined();
    expect(def.workflow.contactEmailField).toBe('contactEmail');
    await h.api().post(`/forms/${imported}/publish`).set(h.bearer(stranger)).expect(200);
  });
});
