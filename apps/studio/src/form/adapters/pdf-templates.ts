import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { USE_API } from './backend';

/** A fillable PDF of the organisation's own, kept so responses can be written into it. */
export interface OwnPdf {
  id: string;
  name: string;
  size: number;
  /** The boxes of the PDF an answer can go into. */
  boxes: { name: string; kind: 'text' | 'tick' | 'choice' }[];
}

let local: OwnPdf[] = [];
/** Tests: the library as the API would return it. */
export const seedLocalOwnPdfs = (pdfs: OwnPdf[]) => {
  local = pdfs;
};
const KEY = ['form-platform', 'pdf-templates'] as const;

export function useOwnPdfs() {
  return useQuery({ queryKey: KEY, queryFn: async () => (USE_API ? api<OwnPdf[]>('/pdf-templates') : local), staleTime: 30_000 });
}

/** Sends the PDF itself; the server keeps it once it has seen that it is a fillable PDF. */
export function useAddOwnPdf() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      if (!USE_API) {
        const made: OwnPdf = { id: `local-${local.length + 1}`, name: file.name.replace(/\.pdf$/i, ''), size: file.size, boxes: [] };
        local = [...local, made];
        return made;
      }
      return api<OwnPdf>(`/pdf-templates?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: new Blob([file], { type: 'application/pdf' }) });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}
