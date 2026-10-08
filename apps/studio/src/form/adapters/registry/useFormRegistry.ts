import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FormDefinition } from '../../types';
import { api } from '../../../lib/api';
import { formRegistry, type FormDoc } from './form-registry';

export const formRegistryKeys = {
  doc: (id: string) => ['forms', 'doc', id] as const,
  family: (id: string) => ['forms', 'family', id] as const,
};

export function useFormDoc(id: string | undefined) {
  return useQuery({ queryKey: formRegistryKeys.doc(id ?? ''), queryFn: () => formRegistry.get(id!), enabled: !!id, retry: false });
}

export function useFormFamily(id: string | undefined) {
  return useQuery({ queryKey: formRegistryKeys.family(id ?? ''), queryFn: () => formRegistry.family(id!), enabled: !!id });
}

export function usePublishedForm(code: string | undefined) {
  return useQuery({ queryKey: ['forms', 'published', code ?? ''], queryFn: () => formRegistry.publishedByCode(code!), enabled: !!code });
}

/** Every change affects the forms list, this form and its versions: refresh them all. */
function useRegistryMutation<TArg, TResult>(fn: (arg: TArg) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: ['forms'] }) });
}

const definitionOf = (p: Promise<FormDoc>) => p.then((d) => d.definition);
export const useSaveFormDraft = () => useRegistryMutation((def: FormDefinition) => definitionOf(formRegistry.save(def)));
export const usePublishForm = () => useRegistryMutation((id: string) => definitionOf(formRegistry.publish(id)));
export const useCreateNewVersion = () => useRegistryMutation((id: string) => definitionOf(formRegistry.createNewVersion(id)));
export const useArchiveForm = () => useRegistryMutation((id: string) => definitionOf(formRegistry.archive(id)));

/** The live version of every form that tracks work items (for the Inbox, Dashboard, New work item, Webhooks). */
export function useFormDefinitions() {
  return useQuery({ queryKey: ['forms', 'work-forms'], queryFn: () => api<FormDefinition[]>('/work-forms'), staleTime: 60_000 });
}
