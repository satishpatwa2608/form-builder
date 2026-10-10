/**
 * API client. The access token lives in memory only (never localStorage); the
 * refresh token is an httpOnly cookie the browser sends to /auth/refresh.
 * A 401 triggers one silent refresh (shared by concurrent calls) and a retry.
 */
export const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4100';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly fields: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let accessToken: string | null = null;
let refreshing: Promise<string | null> | null = null;
let onSignedOut: (() => void) | null = null;

export const setAccessToken = (token: string | null) => {
  accessToken = token;
};
export const onSessionEnded = (fn: () => void) => {
  onSignedOut = fn;
};

/** Public auth calls: a 401 there is an answer (wrong password), not an expired session. */
const NO_REFRESH = ['/auth/login', '/auth/refresh', '/auth/signup', '/auth/verify-email', '/auth/forgot-password', '/auth/reset-password', '/invitations/accept', '/auth/resend-verification'];

export function refreshSession(): Promise<string | null> {
  refreshing ??= fetch(`${API_URL}/auth/refresh`, { method: 'POST', credentials: 'include' })
    .then(async (res) => {
      if (!res.ok) return null;
      const body = (await res.json()) as { accessToken: string };
      accessToken = body.accessToken;
      return accessToken;
    })
    .catch(() => null)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

async function toError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => ({}))) as { message?: string | string[]; code?: string; errors?: { field: string; message: string }[] };
  const message = Array.isArray(body.message) ? body.message.join(', ') : body.message;
  const fields = Object.fromEntries((body.errors ?? []).map((e) => [e.field, e.message]));
  const fallback = res.status === 429 ? 'Too many attempts. Wait a minute and try again.' : res.status >= 500 ? 'Something went wrong on our side. Try again.' : 'That did not work';
  return new ApiError(res.status, message || fallback, body.code, fields);
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}, retry = true): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: init.method ?? 'GET',
      credentials: 'include',
      headers: {
        // A file goes as itself, under its own type; everything else is JSON.
        ...(init.body instanceof Blob ? { 'Content-Type': init.body.type || 'application/octet-stream' } : init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: init.body instanceof Blob ? init.body : init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection.");
  }
  if (res.status === 401 && retry && !NO_REFRESH.includes(path)) {
    if (await refreshSession()) return api<T>(path, init, false);
    accessToken = null;
    onSignedOut?.();
  }
  if (!res.ok) throw await toError(res);
  return (res.status === 204 ? null : await res.json()) as T;
}

/**
 * A file the API makes for the signed-in person (a PDF), as a blob. It is fetched with
 * the session like any other request: a plain link could not carry it.
 */
export async function apiFile(path: string, retry = true): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { credentials: 'include', headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection.");
  }
  if (res.status === 401 && retry && (await refreshSession())) return apiFile(path, false);
  if (!res.ok) throw await toError(res);
  return res.blob();
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : 'That did not work');
