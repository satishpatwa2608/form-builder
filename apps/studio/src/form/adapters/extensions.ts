import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminApi, unwrap, USE_API } from './backend';

/** Something an extension offers: a workflow step, a dropdown list or a check. */
export interface ExtensionOffer {
  key: string;
  label: string;
  description?: string;
  outputs?: string[];
  params?: string[];
}

/** The organisation's own code, running in its extension (see docs/extensions.md). */
export interface ExtensionInfo {
  id: string;
  ref: string;
  name: string;
  /** NEW until it has answered once. */
  status: 'NEW' | 'OK' | 'UNREACHABLE';
  lastSyncedAt: string | null;
  lastError: string;
  steps: ExtensionOffer[];
  lists: ExtensionOffer[];
  checks: ExtensionOffer[];
  fields?: ExtensionOffer[];
}

/** A check a form can run before a submission is accepted, as the form stores it. */
export interface SubmitCheck {
  key: string;
  label: string;
  description?: string;
}

/** A field the organisation's own code draws, as a form names it. */
export interface CustomFieldOffer {
  key: string;
  label: string;
  description?: string;
  height: number;
}

/** Without the API (tests, local storage only) there are no extensions unless a test seeds them. */
let local: { extensions: ExtensionInfo[]; checks: SubmitCheck[]; fields: CustomFieldOffer[] } = { extensions: [], checks: [], fields: [] };
export const seedLocalExtensions = (extensions: ExtensionInfo[], checks: SubmitCheck[] = [], fields: CustomFieldOffer[] = []) => {
  local = { extensions, checks, fields };
};

const KEY = ['form-platform', 'extensions'] as const;

/** For admins: what is installed for the organisation and what it offers. */
export function useExtensions() {
  return useQuery({ queryKey: KEY, queryFn: async () => (USE_API ? unwrap<ExtensionInfo[]>(await adminApi.get('/extensions')) : local.extensions) });
}

/** Reads again what an extension offers, after a new version of it has been deployed. */
export function useRefreshExtension() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (USE_API ? unwrap<ExtensionInfo>(await adminApi.post(`/extensions/${encodeURIComponent(id)}/refresh`)) : local.extensions.find((e) => e.id === id)!),
    onSettled: () => qc.invalidateQueries({ queryKey: ['form-platform'] }),
  });
}

/** For designers: the checks a form can switch on. */
export function useSubmitChecks() {
  return useQuery({
    queryKey: [...KEY, 'checks'],
    queryFn: async () => (USE_API ? unwrap<SubmitCheck[]>(await adminApi.get('/extensions/checks')) : local.checks),
    staleTime: 60_000,
    retry: false,
  });
}

/** For designers: the fields the organisation's own code draws. */
export function useCustomFields() {
  return useQuery({
    queryKey: [...KEY, 'fields'],
    queryFn: async () => (USE_API ? unwrap<CustomFieldOffer[]>(await adminApi.get('/extensions/fields')) : local.fields),
    staleTime: 60_000,
    retry: false,
  });
}
