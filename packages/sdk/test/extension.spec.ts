import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createExtension, sign, SIGNATURE_HEADER, verify } from '../src';

const SECRET = 'a-secret-issued-by-form-builder';
const build = (options: { orgId?: string } = {}) =>
  createExtension({ name: 'Acme', secret: SECRET, ...options })
    .step({ key: 'credit-check', label: 'Check credit', outputs: ['score'] }, (ctx) => ({ summary: `Score for ${String(ctx.values.customer)}`, data: { score: 710 } }))
    .step({ key: 'note', label: 'Note' }, () => 'noted')
    .step({ key: 'broken', label: 'Broken' }, () => {
      throw new Error('The credit bureau is closed');
    })
    .list({ key: 'branches', label: 'Branches', params: ['city'] }, ({ params }) => [{ value: 'B1', label: `Main (${String(params.city ?? 'any')})`, phone: '100' }])
    .check({ key: 'no-duplicates', label: 'No duplicate invoices' }, ({ values }) => (values.invoice === 'INV-1' ? { errors: { invoice: 'Already claimed' } } : undefined));

const post = (ext: ReturnType<typeof build>, path: string, body: unknown, secret = SECRET, at = Date.now()) => {
  const text = JSON.stringify(body);
  return ext.handle({ method: 'POST', path, headers: { [SIGNATURE_HEADER]: sign(secret, { method: 'POST', path, body: text }, at) }, body: text });
};

describe('Signing', () => {
  const parts = { method: 'POST', path: '/fb/steps/x', body: '{"a":1}' };
  it('accepts what was signed, and nothing else', () => {
    const now = 1_800_000_000_000;
    const header = sign(SECRET, parts, now);
    expect(verify(SECRET, header, parts, now)).toBe(true);
    expect(verify(SECRET, header, { ...parts, body: '{"a":2}' }, now)).toBe(false);
    expect(verify(SECRET, header, { ...parts, path: '/fb/steps/y' }, now)).toBe(false);
    expect(verify(SECRET, header, { ...parts, method: 'GET' }, now)).toBe(false);
    expect(verify('another-secret', header, parts, now)).toBe(false);
    expect(verify(SECRET, undefined, parts, now)).toBe(false);
    expect(verify(SECRET, 'v1=abc', parts, now)).toBe(false);
    expect(verify('', header, parts, now)).toBe(false);
  });
  it('refuses a request replayed after five minutes', () => {
    const now = 1_800_000_000_000;
    const header = sign(SECRET, parts, now);
    expect(verify(SECRET, header, parts, now + 299_000)).toBe(true);
    expect(verify(SECRET, header, parts, now + 301_000)).toBe(false);
    expect(verify(SECRET, header, parts, now - 301_000)).toBe(false);
  });
});

describe('An extension', () => {
  it('declares what it offers', async () => {
    const ext = build();
    const res = await ext.handle({ method: 'GET', path: '/fb/manifest', headers: { [SIGNATURE_HEADER]: sign(SECRET, { method: 'GET', path: '/fb/manifest', body: '' }) }, body: '' });
    expect(res).toEqual({
      status: 200,
      body: {
        contract: 1,
        name: 'Acme',
        steps: [{ key: 'credit-check', label: 'Check credit', outputs: ['score'] }, { key: 'note', label: 'Note' }, { key: 'broken', label: 'Broken' }],
        lists: [{ key: 'branches', label: 'Branches', params: ['city'] }],
        checks: [{ key: 'no-duplicates', label: 'No duplicate invoices' }],
      },
    });
  });

  it('runs a step, a list and a check', async () => {
    const ext = build();
    expect(await post(ext, '/fb/steps/credit-check', { orgId: 'o1', values: { customer: 'Ravi' } })).toEqual({ status: 200, body: { summary: 'Score for Ravi', data: { score: 710 } } });
    expect(await post(ext, '/fb/steps/note', { orgId: 'o1' })).toEqual({ status: 200, body: { summary: 'noted' } });
    expect(await post(ext, '/fb/lists/branches', { orgId: 'o1', params: { city: 'Pune' } })).toEqual({ status: 200, body: { rows: [{ value: 'B1', label: 'Main (Pune)', phone: '100' }] } });
    expect(await post(ext, '/fb/checks/no-duplicates', { orgId: 'o1', values: { invoice: 'INV-1' } })).toEqual({ status: 200, body: { errors: { invoice: 'Already claimed' }, message: '' } });
    expect(await post(ext, '/fb/checks/no-duplicates', { orgId: 'o1', values: { invoice: 'INV-2' } })).toEqual({ status: 200, body: { errors: {}, message: '' } });
  });

  it('refuses anything not signed with its secret, before looking at it', async () => {
    const ext = build();
    expect((await post(ext, '/fb/steps/credit-check', {}, 'guess')).status).toBe(401);
    expect((await ext.handle({ method: 'POST', path: '/fb/steps/credit-check', headers: {}, body: '{}' })).status).toBe(401);
    expect((await ext.handle({ method: 'GET', path: '/fb/manifest', headers: {}, body: '' })).status).toBe(401);
    expect((await post(ext, '/fb/steps/credit-check', {}, SECRET, Date.now() - 3_600_000)).status).toBe(401);
    // Only the health check needs no signature, and it tells nothing.
    expect(await ext.handle({ method: 'GET', path: '/fb/health', headers: {}, body: '' })).toEqual({ status: 200, body: { ok: true } });
  });

  it('a step that throws fails with its own message; unknown things are not found', async () => {
    const ext = build();
    expect(await post(ext, '/fb/steps/broken', { orgId: 'o1' })).toEqual({ status: 500, body: { error: 'The credit bureau is closed' } });
    expect((await post(ext, '/fb/steps/nope', {})).status).toBe(404);
    expect((await post(ext, '/fb/lists/nope', {})).status).toBe(404);
    expect((await post(ext, '/fb/checks/nope', {})).status).toBe(404);
    expect((await post(ext, '/fb/other', {})).status).toBe(404);
  });

  it('can be tied to one organisation', async () => {
    const ext = build({ orgId: 'o1' });
    expect((await post(ext, '/fb/steps/note', { orgId: 'o1' })).status).toBe(200);
    expect((await post(ext, '/fb/steps/note', { orgId: 'o2' })).status).toBe(403);
    expect((await post(ext, '/fb/steps/note', {})).status).toBe(403);
  });

  it('catches mistakes in what is declared when it starts, not when a form uses it', () => {
    const ext = createExtension({ name: 'Acme', secret: SECRET });
    expect(() => ext.step({ key: 'Credit Check', label: 'x' }, () => {})).toThrow(/lower-case letters, digits or "-"/);
    expect(() => ext.step({ key: 'a', label: ' ' }, () => {})).toThrow(/needs a label/);
    ext.step({ key: 'a', label: 'A' }, () => {});
    expect(() => ext.step({ key: 'a', label: 'Again' }, () => {})).toThrow(/declared twice/);
    expect(() => ext.step({ key: 'b', label: 'B', outputs: ['not ok'] }, () => {})).toThrow(/plain name/);
    expect(() => ext.list({ key: 'l', label: 'L', params: ['a-b'] }, () => [])).toThrow(/plain name/);
    expect(() => createExtension({ name: '' })).toThrow(/name/);
    expect(() => createExtension({ name: 'No secret', secret: '' }).listen(0)).toThrow(/FB_EXTENSION_SECRET/);
  });

  it('serves over HTTP', async () => {
    const server = await build().listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const body = JSON.stringify({ orgId: 'o1', params: {} });
      const ok = await fetch(`${base}/fb/lists/branches`, { method: 'POST', headers: { [SIGNATURE_HEADER]: sign(SECRET, { method: 'POST', path: '/fb/lists/branches', body }) }, body });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ rows: [{ value: 'B1', label: 'Main (any)', phone: '100' }] });
      expect((await fetch(`${base}/fb/lists/branches`, { method: 'POST', body })).status).toBe(401);
      expect((await fetch(`${base}/fb/health`)).status).toBe(200);
      const big = await fetch(`${base}/fb/lists/branches`, { method: 'POST', body: 'x'.repeat(1_100_000) }).then((r) => r.status, () => 413);
      expect(big).toBe(413);
    } finally {
      server.close();
    }
  });
});
