import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminApi, unwrap, USE_API } from './backend';

/** An email written once for the organisation and used wherever one is sent. */
export interface SavedEmail {
  id: string;
  name: string;
  subject: string;
  body: string;
}
let local: SavedEmail[] = [];
/** Tests: the library as the API would return it. */
export const seedLocalEmails = (emails: SavedEmail[]) => {
  local = emails;
};
const KEY = ['form-platform', 'email-templates'] as const;

export function useSavedEmails() {
  return useQuery({ queryKey: KEY, queryFn: async () => (USE_API ? unwrap<SavedEmail[]>(await adminApi.get('/email-templates')) : local), staleTime: 60_000, retry: false });
}

export function useSaveEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: Omit<SavedEmail, 'id'> & { id?: string }) => {
      if (!USE_API) {
        const saved = { id: id ?? `mail_${local.length + 1}`, ...body };
        local = [...local.filter((m) => m.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name));
        return saved;
      }
      return unwrap<SavedEmail>(id ? await adminApi.put(`/email-templates/${encodeURIComponent(id)}`, body) : await adminApi.post('/email-templates', body));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!USE_API) {
        local = local.filter((m) => m.id !== id);
        return;
      }
      await adminApi.delete(`/email-templates/${encodeURIComponent(id)}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
