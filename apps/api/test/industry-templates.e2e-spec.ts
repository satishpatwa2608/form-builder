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

/** The long forms offered by industry (apps/studio/src/templates/industry), taken through the server as a customer would. */
describe('Industry templates: created, published and served (e2e)', () => {
  let h: Harness;
  let owner: string;
  let orgId: string;
  let folder: string;

  beforeAll(async () => {
    h = await startApp();
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Industry' }).expect(201)).body[0].id;
  });
  afterAll(async () => h?.close());

  it.each(INDUSTRY_TEMPLATES.map((t) => [t.key, t] as const))('%s: becomes a draft, is published as it comes, and is served to the people it is for', async (key, t) => {
    const code = key.toUpperCase().replace(/-/g, '_');
    const made = await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: { businessId: '', ...t.definition, name: t.name, code } });
    expect([made.status, made.body.message]).toEqual([201, undefined]);
    const published = await h.api().post(`/forms/${made.body.definition.id}/publish`).set(h.bearer(owner));
    expect([published.status, published.body.message ?? published.body.issues]).toEqual([200, undefined]);

    const served = await h.api().get(`/public/forms/${code}?org=${orgId}`).set(t.definition.access === 'AUTHENTICATED' ? h.bearer(owner) : {});
    expect(served.status).toBe(200);
    const def = served.body.definition ?? served.body;
    expect(def.layout).toEqual(t.definition.layout);
    expect(def.fields.length).toBe(t.definition.fields.length);
    // What happens after sending is the organisation's business, not the public's.
    expect(def.workflow).toBeUndefined();
    expect(def.automations).toBeUndefined();
  });
});
