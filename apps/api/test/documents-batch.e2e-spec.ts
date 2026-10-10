import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp, type Harness } from './harness';

/**
 * The plan's measure for documents: 1,000 records become 1,000 documents
 * without slowing the API. The queue runs as it does in production here
 * (polling in the background, a few at a time), not inline.
 */
describe('A batch of 1,000 documents (e2e)', () => {
  let h: Harness;
  let owner: string;
  let orgId: string;
  let id: string;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fb-batch-'));
    h = await startApp({ LOCAL_STORAGE_DIR: dir, JOBS_POLL: 'true' });
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    const folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Bulk' }).expect(201)).body[0].id;
    const definition = {
      name: 'Statement',
      code: 'STATEMENT',
      businessId: '',
      access: 'PUBLIC',
      submission: { method: 'POST', endpointId: 'default-submit' },
      fields: [
        { id: 'a', type: 'TEXT', name: 'customer', label: 'Customer', required: true },
        { id: 'b', type: 'NUMBER', name: 'balance', label: 'Balance' },
        { id: 'c', type: 'TEXTAREA', name: 'note', label: 'Note' },
      ],
    };
    id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
  }, 60_000);
  afterAll(async () => {
    await h?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('makes every one of them, within a time budget, while the API keeps answering promptly', async () => {
    const items = Array.from({ length: 1000 }, (_, i) => ({ customer: `Customer ${i + 1}`, balance: i * 10, note: 'Thank you for your business. '.repeat(3) }));
    const started = Date.now();
    const batch = (await h.api().post(`/forms/${id}/documents/batch`).set(h.bearer(owner)).send({ items }).expect(201)).body;
    const accepted = Date.now() - started;
    expect(batch).toMatchObject({ total: 1000, status: 'WORKING' });

    // While the documents are being made, ordinary requests are timed.
    const slow: number[] = [];
    let status = batch;
    while (status.status === 'WORKING') {
      if (Date.now() - started > 150_000) throw new Error(`still at ${status.done} of 1000 after 150 seconds`);
      const t = Date.now();
      await h.api().get('/forms').set(h.bearer(owner)).expect(200);
      slow.push(Date.now() - t);
      status = (await h.api().get(`/documents/batches/${batch.id}`).set(h.bearer(owner)).expect(200)).body;
      await new Promise((r) => setTimeout(r, 250));
    }
    const took = Date.now() - started;

    expect(status).toMatchObject({ total: 1000, done: 1000, failed: 0, status: 'DONE' });
    expect(readdirSync(join(dir, 'documents', orgId, 'batches', batch.id))).toHaveLength(1000);
    slow.sort((a, b) => a - b);
    const p95 = slow[Math.floor(slow.length * 0.95)] ?? 0;
    console.log(`1,000 documents in ${(took / 1000).toFixed(1)}s (accepted in ${accepted} ms); API during it: median ${slow[Math.floor(slow.length / 2)]} ms, 95th percentile ${p95} ms over ${slow.length} requests`);
    // Budgets: the whole batch in two and a half minutes on a developer's machine, and the API never made to wait long.
    // The promise is one second, kept on a machine of the size the product runs on. A shared build machine has two
    // slow cores that this very test also uses, so there the limit is set wider (API_P95_BUDGET_MS in the CI file):
    // still tight enough to catch the API being blocked, which shows as several seconds, not a few milliseconds over.
    expect(took).toBeLessThan(150_000);
    expect(p95).toBeLessThan(Number(process.env.API_P95_BUDGET_MS) || 1000);
  }, 200_000);
});
