import { join } from 'node:path';
import { startApp, type Harness } from './harness';

// The forms belong to the builder; they are loaded by path so that this project's type check stays within its own files.
interface Template {
  key: string;
  name: string;
  definition: { access: string; fields: unknown[] } & Record<string, unknown>;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { INDUSTRY_TEMPLATES } = require(join(__dirname, '../../studio/src/templates/industry')) as { INDUSTRY_TEMPLATES: Template[] };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TEMPLATE_FRAGMENTS, TEMPLATE_WORKFLOWS } = require(join(__dirname, '../../studio/src/templates/industry/kit')) as { TEMPLATE_FRAGMENTS: { id: string; name: string; description: string; fields: unknown[] }[]; TEMPLATE_WORKFLOWS: ({ id: string } & Record<string, unknown>)[] };

/** The long forms offered by industry (apps/studio/src/templates/industry), taken through the server as a customer would. */
describe('Industry templates: created, published and served (e2e)', () => {
  let h: Harness;
  let owner: string;
  let orgId: string;
  let folder: string;
  const library = new Map<string, string>();
  const shared = (def: Record<string, unknown>) => (def.workflowRef ? { workflowRef: { ...(def.workflowRef as { id: string }), id: library.get((def.workflowRef as { id: string }).id)! } } : {});
  type Field = { name: string; props?: { fragment?: { id: string; prefix?: string } } };
  const linked = (fields: unknown[]) => (fields as Field[]).map((f) => (f.props?.fragment ? { ...f, props: { ...f.props, fragment: { ...f.props.fragment, id: library.get(f.props.fragment.id)! } } } : f));

  beforeAll(async () => {
    h = await startApp();
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Industry' }).expect(201)).body[0].id;
    // The fragments the forms share go into the library first, as "New form" does.
    for (const f of TEMPLATE_FRAGMENTS) library.set(f.id, (await h.api().post('/fragments').set(h.bearer(owner)).send({ name: f.name, description: f.description, fields: f.fields }).expect(201)).body.id);
    // And the workflow three of them share.
    for (const { id, ...w } of TEMPLATE_WORKFLOWS) library.set(id, (await h.api().post('/workflows').set(h.bearer(owner)).send(w).expect(201)).body.id);
  });
  afterAll(async () => h?.close());

  it.each(INDUSTRY_TEMPLATES.map((t) => [t.key, t] as const))('%s: becomes a draft, is published as it comes, and is served to the people it is for', async (key, t) => {
    const code = key.toUpperCase().replace(/-/g, '_');
    const made = await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: { businessId: '', ...t.definition, ...shared(t.definition), fields: linked(t.definition.fields), name: t.name, code } });
    expect([made.status, made.body.message]).toEqual([201, undefined]);
    const published = await h.api().post(`/forms/${made.body.definition.id}/publish`).set(h.bearer(owner));
    expect([published.status, published.status === 200 ? undefined : JSON.stringify(published.body.errors ?? published.body.issues ?? published.body.message)]).toEqual([200, undefined]);

    const served = await h.api().get(`/public/forms/${code}?org=${orgId}`).set(t.definition.access === 'AUTHENTICATED' ? h.bearer(owner) : {});
    expect(served.status).toBe(200);
    const def = served.body.definition ?? served.body;
    expect(def.layout).toEqual(t.definition.layout);
    expect(def.fields.length).toBe(t.definition.fields.length);
    // Publishing refreshes each fragment section from the library: what is served is field for field what the form was written with.
    expect((def.fields as Field[]).map((f) => f.name)).toEqual((t.definition.fields as Field[]).map((f) => f.name));
    // What happens after sending is the organisation's business, not the public's.
    expect(def.workflow).toBeUndefined();
    expect(def.automations).toBeUndefined();
  });
});
