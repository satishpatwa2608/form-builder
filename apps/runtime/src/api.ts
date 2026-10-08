/**
 * The runtime talks only to the public form API. If the visitor is signed in
 * to the studio (same site), the refresh cookie gives a short-lived token so
 * sign-in-only forms and "fill from my profile" work; otherwise it's anonymous.
 */
export const API_URL = ((import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4100').replace(/\/+$/, '');

let token: string | null = null;

export async function trySession(): Promise<{ id: string; name: string; email: string; orgId: string } | null> {
  try {
    const res = await fetch(`${API_URL}/auth/refresh`, { method: 'POST', credentials: 'include' });
    if (!res.ok) return null;
    token = ((await res.json()) as { accessToken: string }).accessToken;
    const me = await fetch(`${API_URL}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (!me.ok) return null;
    const body = (await me.json()) as { user: { id: string; name: string; email: string }; org: { id: string } };
    return { ...body.user, orgId: body.org.id };
  } catch {
    return null;
  }
}

export class PublicApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly errors?: { field: string; message: string }[],
  ) {
    super(message);
  }
}

export async function publicApi<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/public${path}`, {
      method: init.method ?? 'GET',
      headers: { ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new PublicApiError(0, "Can't reach the server. Check your connection and try again.");
  }
  const body = (await res.json().catch(() => ({}))) as { message?: string; errors?: { field: string; message: string }[] };
  if (!res.ok) throw new PublicApiError(res.status, body.message || (res.status === 429 ? 'Too many attempts. Wait a minute and try again.' : 'Something went wrong'), body.errors);
  return body as T;
}
