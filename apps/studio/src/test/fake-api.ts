import { vi } from 'vitest';

type Handler = (body: unknown, init: RequestInit) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>;

/** A fake fetch: `routes['POST /auth/login'] = () => ({ status: 200, body })`. Records every call. */
export function fakeApi(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; body: unknown; auth?: string }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname + new URL(url).search;
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body, auth: (init.headers as Record<string, string> | undefined)?.Authorization });
    const handler = routes[`${method} ${path}`] ?? routes[`${method} ${path.split('?')[0]}`];
    const res = handler ? await handler(body, init) : { status: 404, body: { message: `No fake for ${method} ${path}` } };
    const status = res.status ?? 200;
    return new Response(res.body === undefined ? null : JSON.stringify(res.body), { status, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

export const ME = {
  user: { id: 'u1', name: 'Asha Rao', email: 'asha@acme.test', twoFactorEnabled: false },
  org: { id: 'o1', name: 'Acme', role: 'OWNER', permissions: ['org.manage', 'members.view', 'members.manage', 'roles.grant', 'audit.read', 'folder.manage', 'form.view'], require2fa: false },
  session: { mfa: false },
  orgs: [{ id: 'o1', name: 'Acme', role: 'OWNER' }],
};
