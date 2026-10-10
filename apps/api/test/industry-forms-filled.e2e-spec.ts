import { join } from 'node:path';
import type { FormDefinition, FormField } from '@fb/engine';
import { fillForm } from './fill-form';
import { startApp, type Harness } from './harness';

interface Template {
  key: string;
  name: string;
  definition: { access: string; fields: unknown[] } & Record<string, unknown>;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { INDUSTRY_TEMPLATES } = require(join(__dirname, '../../studio/src/templates/industry')) as { INDUSTRY_TEMPLATES: Template[] };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TEMPLATE_FRAGMENTS, TEMPLATE_WORKFLOWS } = require(join(__dirname, '../../studio/src/templates/industry/kit')) as { TEMPLATE_FRAGMENTS: { id: string; name: string; description: string; fields: unknown[] }[]; TEMPLATE_WORKFLOWS: ({ id: string } & Record<string, unknown>)[] };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** Every industry form, filled in from start to finish and sent, as a person would: nothing but the form itself to go on. */
describe('Industry templates: filled in and submitted (e2e)', () => {
  let h: Harness;
  let owner: string;
  let orgId: string;
  let folder: string;
  const library = new Map<string, string>();
  type Field = { props?: { fragment?: { id: string } } };

  beforeAll(async () => {
    h = await startApp();
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Industry' }).expect(201)).body[0].id;
    for (const f of TEMPLATE_FRAGMENTS) library.set(f.id, (await h.api().post('/fragments').set(h.bearer(owner)).send({ name: f.name, description: f.description, fields: f.fields }).expect(201)).body.id);
    // And the workflow three of them share.
    for (const { id, ...w } of TEMPLATE_WORKFLOWS) library.set(id, (await h.api().post('/workflows').set(h.bearer(owner)).send(w).expect(201)).body.id);
  });
  afterAll(async () => h?.close());

  it.each(INDUSTRY_TEMPLATES.map((t) => [t.key, t] as const))('%s: can be completed and sent, and becomes a record with a reference', async (key, t) => {
    const code = key.toUpperCase().replace(/-/g, '_');
    const fields = (t.definition.fields as Field[]).map((f) => (f.props?.fragment ? { ...f, props: { ...f.props, fragment: { ...f.props.fragment, id: library.get(f.props.fragment.id)! } } } : f));
    const made = await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: { businessId: '', ...t.definition, ...(t.definition.workflowRef ? { workflowRef: { ...(t.definition.workflowRef as { id: string }), id: library.get((t.definition.workflowRef as { id: string }).id)! } } : {}), fields, name: t.name, code } }).expect(201);
    await h.api().post(`/forms/${made.body.definition.id}/publish`).set(h.bearer(owner)).expect(200);
    const who = t.definition.access === 'AUTHENTICATED' ? h.bearer(owner) : {};
    const served = (await h.api().get(`/public/forms/${code}?org=${orgId}`).set(who).expect(200)).body;
    const def = (served.definition ?? served) as FormDefinition;

    const upload = async (field: FormField) => {
      const ticket = (await h.api().post(`/public/forms/${code}/uploads?org=${orgId}`).set(who).send({ fieldName: field.name, fileName: `${field.name}.png`, contentType: 'image/png', size: PNG.length }).expect(201)).body;
      const put = await fetch(h.localUrl(ticket.url), { method: 'PUT', headers: ticket.headers, body: PNG });
      expect(put.ok).toBe(true);
      await h.api().post(`/public/uploads/${ticket.uploadId}/verify?org=${orgId}`).set(who).expect(200);
      return { uploadId: ticket.uploadId as string };
    };
    const { values, problems } = await fillForm(def, upload);
    // Whatever the form would still object to is a fault in the form: a rule nobody can satisfy.
    expect(problems).toEqual({});

    const sent = await h.api().post(`/public/forms/${code}/submissions?org=${orgId}`).set(who).send({ values });
    expect([sent.status, sent.status === 201 ? undefined : JSON.stringify(sent.body.errors ?? sent.body.message)]).toEqual([201, undefined]);
    expect(sent.body.ref).toMatch(/^[A-Z]{2,5}-\d+$/);
    // It is in the Inbox, in its first status.
    const records = (await h.api().get(`/forms/${made.body.definition.id}/submissions`).set(h.bearer(owner)).expect(200)).body;
    const rows = (records.items ?? records.rows ?? records.submissions ?? records) as { ref?: string }[];
    expect(JSON.stringify(rows)).toContain(sent.body.ref);
  });
});
