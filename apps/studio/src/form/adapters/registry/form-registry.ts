import type { FormDefinition } from '../../types';
import { api } from '../../../lib/api';
import type { Permission } from '../../../lib/types';
import { toFormError } from '../backend';

/**
 * Where the builder reads and saves definitions: the Forms API. Creating a
 * form happens on the Forms page (it needs a folder); the builder edits one.
 * Lifecycle: DRAFT --publish--> PUBLISHED --archive / superseded--> ARCHIVED.
 */
export interface FormDoc {
  definition: FormDefinition;
  folderId: string;
  /** What the caller may do with this form (from its folder). */
  permissions: Permission[];
}

const path = (id: string) => `/forms/${encodeURIComponent(id)}`;

/** Server field errors become the engine's error type, which the builder knows how to show. */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toFormError(e);
  }
}

export const formRegistry = {
  get: (id: string) => api<FormDoc>(path(id)),
  save: (def: FormDefinition) => call(() => api<FormDoc>(path(def.id), { method: 'PUT', body: def })),
  publish: (id: string) => call(() => api<FormDoc>(`${path(id)}/publish`, { method: 'POST' })),
  createNewVersion: (id: string) => call(() => api<FormDoc>(`${path(id)}/new-version`, { method: 'POST' })),
  archive: (id: string) => call(() => api<FormDoc>(`${path(id)}/archive`, { method: 'POST' })),
  remove: (id: string) => call(() => api(path(id), { method: 'DELETE' })),
  /** The live (published) version of a form by its code, or null. */
  async publishedByCode(code: string): Promise<FormDefinition | null> {
    const summary = (await api<{ id: string; code: string; publishedVersion: number | null }[]>('/forms')).find((f) => f.code === code);
    if (!summary?.publishedVersion) return null;
    const live = (await api<{ id: string; status: string }[]>(`${path(summary.id)}/versions`)).find((v) => v.status === 'PUBLISHED');
    return live ? (await api<FormDoc>(path(live.id))).definition : null;
  },
  /** Every other version of the form (their workflow status keys must keep their meaning). */
  async family(id: string): Promise<FormDefinition[]> {
    const versions = await api<{ id: string; status: string }[]>(`${path(id)}/versions`);
    return Promise.all(versions.filter((v) => v.id !== id).map(async (v) => (await api<FormDoc>(path(v.id))).definition));
  },
};
