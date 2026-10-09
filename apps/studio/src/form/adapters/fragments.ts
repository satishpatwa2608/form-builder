import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FormField } from '../types';
import type { Fragment } from '../engine';
import { adminApi, toFormError, unwrap, USE_API } from './backend';

/** A form that has a section copied from a fragment (its draft or its live version). */
export interface FragmentUseRow {
  formId: string;
  code: string;
  name: string;
  version: number;
  status: string;
}

/** A fragment in the organisation's library, with the forms that use it. */
export interface LibraryFragment extends Fragment {
  usedBy: FragmentUseRow[];
}

/** What is sent to save one; without an id it is new. */
export interface FragmentInput {
  id?: string;
  name: string;
  description?: string;
  fields: FormField[];
}

/** Without the API (tests, local storage only) the library lives in memory. */
let local: LibraryFragment[] = [];
export const seedLocalFragments = (fragments: LibraryFragment[]) => {
  local = fragments;
};

const KEY = ['form-platform', 'fragments'] as const;

async function save({ id, ...body }: FragmentInput): Promise<LibraryFragment> {
  if (!USE_API) {
    const saved: LibraryFragment = { ...body, id: id ?? `frag_${local.length + 1}`, usedBy: local.find((f) => f.id === id)?.usedBy ?? [] };
    local = [...local.filter((f) => f.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name));
    return saved;
  }
  try {
    return unwrap<LibraryFragment>(id ? await adminApi.put(`/fragments/${encodeURIComponent(id)}`, body) : await adminApi.post('/fragments', body));
  } catch (e) {
    throw toFormError(e);
  }
}

/** The fragment library. Every member can read it; a form's designer places fragments from it. */
export function useFragments(enabled = true) {
  return useQuery({ queryKey: KEY, queryFn: async () => (USE_API ? unwrap<LibraryFragment[]>(await adminApi.get('/fragments')) : local), enabled, staleTime: 30_000 });
}

export function useSaveFragment() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: save, onSuccess: () => qc.invalidateQueries({ queryKey: KEY }) });
}

export function useDeleteFragment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      if (USE_API) await adminApi.delete(`/fragments/${encodeURIComponent(id)}`);
      else local = local.filter((f) => f.id !== id);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
