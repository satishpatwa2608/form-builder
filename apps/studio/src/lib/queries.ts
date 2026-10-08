import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { AuditEntry, Folder, FormSummary, FormVersionRow, Grant, Invitation, Member } from './types';

export const useMembers = (enabled = true) => useQuery({ queryKey: ['members'], queryFn: () => api<Member[]>('/members'), enabled });
export const useInvitations = (enabled = true) => useQuery({ queryKey: ['invitations'], queryFn: () => api<Invitation[]>('/invitations'), enabled });
export const useFolders = () => useQuery({ queryKey: ['folders'], queryFn: () => api<Folder[]>('/folders') });
export const useGrants = (folderId: string | undefined, enabled: boolean) =>
  useQuery({ queryKey: ['grants', folderId], queryFn: () => api<Grant[]>(`/grants?scopeType=folder&scopeId=${folderId}`), enabled: enabled && !!folderId });
export const useFolderPermissions = (folderId: string | undefined) =>
  useQuery({ queryKey: ['folder-permissions', folderId], queryFn: () => api<{ permissions: string[] }>(`/folders/${folderId}/permissions`), enabled: !!folderId });
export const useAudit = (action: string, before?: string) =>
  useQuery({
    queryKey: ['audit', action, before],
    queryFn: () => api<{ entries: AuditEntry[]; next: string | null }>(`/audit?limit=50${action ? `&action=${encodeURIComponent(action)}` : ''}${before ? `&before=${encodeURIComponent(before)}` : ''}`),
  });

/** A mutation that refreshes the given query keys on success. */
export function useAction<TArgs, TResult = unknown>(fn: (args: TArgs) => Promise<TResult>, invalidate: string[][]) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => Promise.all(invalidate.map((queryKey) => qc.invalidateQueries({ queryKey }))) });
}

export const useForms = () => useQuery({ queryKey: ['forms'], queryFn: () => api<FormSummary[]>('/forms') });
export const useFormVersions = (id: string | undefined) =>
  useQuery({ queryKey: ['form-versions', id], queryFn: () => api<FormVersionRow[]>(`/forms/${id}/versions`), enabled: !!id });
