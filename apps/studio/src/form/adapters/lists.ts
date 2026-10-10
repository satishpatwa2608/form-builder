import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminApi, unwrap, USE_API } from './backend';

/** One choice in a list. `value` is what a response stores; it is given once and kept. */
export interface ListItem {
  value?: string;
  label: string;
  /** For a list that depends on another: the value there this item belongs to. */
  parent?: string;
  retired?: boolean;
}
/** Master data: a list of choices kept once for the organisation and read by dropdowns on many forms. */
export interface SharedList {
  id: string;
  key: string;
  name: string;
  description: string;
  /** The key of the list whose choice narrows this one, or ''. */
  dependsOn: string;
  items: ListItem[];
  usedBy: { formId: string; name: string }[];
}
export interface ListInput {
  id?: string;
  name: string;
  description?: string;
  dependsOn?: string;
  items: ListItem[];
}

let local: SharedList[] = [];
/** Tests: the library as the API would return it. */
export const seedLocalLists = (lists: SharedList[]) => {
  local = lists;
};
const KEY = ['form-platform', 'lists'] as const;
const valueOf = (label: string) => label.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');

export function useLists() {
  return useQuery({ queryKey: KEY, queryFn: async () => (USE_API ? unwrap<SharedList[]>(await adminApi.get('/lists')) : local), staleTime: 30_000 });
}

export function useSaveList() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: ListInput) => {
      if (!USE_API) {
        const old = local.find((l) => l.id === id);
        const saved: SharedList = { id: id ?? `list_${local.length + 1}`, key: old?.key ?? body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: body.name, description: body.description ?? '', dependsOn: body.dependsOn ?? '', items: body.items.map((i) => ({ ...i, value: i.value || valueOf(i.label) })), usedBy: old?.usedBy ?? [] };
        local = [...local.filter((l) => l.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name));
        return saved;
      }
      return unwrap<SharedList>(id ? await adminApi.put(`/lists/${encodeURIComponent(id)}`, body) : await adminApi.post('/lists', body));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['form-platform'] }),
  });
}

export function useDeleteList() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!USE_API) {
        local = local.filter((l) => l.id !== id);
        return;
      }
      await adminApi.delete(`/lists/${encodeURIComponent(id)}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['form-platform'] }),
  });
}
