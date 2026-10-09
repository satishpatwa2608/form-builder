import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SharedWorkflow } from '../engine';
import { adminApi, toFormError, unwrap, USE_API } from './backend';

/** A form that uses a library workflow (its draft or its live version). */
export interface WorkflowUse {
  formId: string;
  code: string;
  name: string;
  version: number;
  status: string;
}

/** A workflow in the organisation's library, with the forms that use it. */
export interface LibraryWorkflow extends SharedWorkflow {
  usedBy: WorkflowUse[];
}

/** What is sent to save one; without an id it is new. */
export type LibraryWorkflowInput = Omit<SharedWorkflow, 'id'> & { id?: string };

interface SharedWorkflowAdapter {
  list(): Promise<LibraryWorkflow[]>;
  save(input: LibraryWorkflowInput): Promise<LibraryWorkflow>;
  remove(id: string): Promise<void>;
}

/** Without the API (tests, local storage only) the library lives in memory. */
let local: LibraryWorkflow[] = [];
export const seedLocalWorkflows = (workflows: LibraryWorkflow[]) => {
  local = workflows;
};

const localAdapter: SharedWorkflowAdapter = {
  async list() {
    return local;
  },
  async save(input) {
    const saved: LibraryWorkflow = { ...input, id: input.id ?? `wf_${local.length + 1}`, usedBy: local.find((w) => w.id === input.id)?.usedBy ?? [] };
    local = [...local.filter((w) => w.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name));
    return saved;
  },
  async remove(id) {
    local = local.filter((w) => w.id !== id);
  },
};

const httpAdapter: SharedWorkflowAdapter = {
  async list() {
    return unwrap<LibraryWorkflow[]>(await adminApi.get('/workflows'));
  },
  async save({ id, ...body }) {
    try {
      return unwrap<LibraryWorkflow>(id ? await adminApi.put(`/workflows/${encodeURIComponent(id)}`, body) : await adminApi.post('/workflows', body));
    } catch (e) {
      throw toFormError(e);
    }
  },
  async remove(id) {
    await adminApi.delete(`/workflows/${encodeURIComponent(id)}`);
  },
};

const adapter = USE_API ? httpAdapter : localAdapter;
const KEY = ['form-platform', 'shared-workflows'] as const;

/** The workflow library. Every member can read it; a form's designer picks from it. */
export function useSharedWorkflows(enabled = true) {
  return useQuery({ queryKey: KEY, queryFn: () => adapter.list(), enabled, staleTime: 30_000 });
}

export function useSaveSharedWorkflow() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: LibraryWorkflowInput) => adapter.save(input), onSuccess: () => qc.invalidateQueries({ queryKey: KEY }) });
}

export function useDeleteSharedWorkflow() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => adapter.remove(id), onSuccess: () => qc.invalidateQueries({ queryKey: KEY }) });
}
