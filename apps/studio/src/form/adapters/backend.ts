import { api, ApiError } from '../../lib/api';
import { FormDefinitionError } from '../engine';

/**
 * The ported form adapters were written against an axios client with a
 * `{ success, data }` envelope. This facade gives them the same shape over
 * the studio's API client (in-memory access token, silent refresh), so the
 * adapter code reads as it did in Sangam. Unit tests use the local adapters.
 */
export const USE_API = import.meta.env.MODE !== 'test';

type Params = Record<string, string | number | boolean | undefined>;
const query = (params?: Params) => {
  const entries = Object.entries(params ?? {}).filter(([, v]) => v !== undefined) as [string, string | number | boolean][];
  return entries.length ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)]))}` : '';
};
const call = async <T>(method: string, url: string, body?: unknown, params?: Params) => ({ data: { data: await api<T>(`${url}${query(params)}`, { method, body }) } });

export const adminApi = {
  get: (url: string, config?: { params?: Params }) => call('GET', url, undefined, config?.params),
  post: (url: string, body?: unknown) => call('POST', url, body),
  put: (url: string, body?: unknown) => call('PUT', url, body),
  patch: (url: string, body?: unknown) => call('PATCH', url, body),
  delete: (url: string) => call('DELETE', url),
};

/** `{ data: { data } }` -> data. */
export const unwrap = <T>(res: { data: { data?: unknown } }): T => res.data.data as T;

export interface ApiFieldError {
  field: string;
  message: string;
}

export function fieldErrorsOf(error: unknown): ApiFieldError[] | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const list = Object.entries(error.fields).map(([field, message]) => ({ field, message }));
  return list.length ? list : undefined;
}

export function messageOf(error: unknown, fallback = 'Something went wrong'): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** API errors -> the engine's error type, so the builder shows field problems the same way everywhere. */
export function toFormError(error: unknown): Error {
  const errors = fieldErrorsOf(error);
  if (errors?.length) return new FormDefinitionError(errors.map((e) => ({ path: e.field, message: e.message })));
  return new Error(messageOf(error));
}
