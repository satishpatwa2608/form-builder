import { useQuery } from '@tanstack/react-query';
import type { FormValues } from '../types';
import { adminApi, unwrap, USE_API } from './backend';

export interface SubmissionRow {
  uuid: string;
  formCode: string;
  formVersion: number;
  payload: FormValues;
  files: { fieldName: string; uploadId: string; name: string; size: number; contentType: string }[];
  submittedBy: string;
  channel: string;
  status: string;
  createdAt: string;
}

interface SubmissionPage {
  rows: SubmissionRow[];
  total: number;
  page: number;
  limit: number;
}

/** Submissions only exist server-side; the local adapters never store them. */
export const submissionsAvailable = USE_API;

const fetchPage = async (formId: string, page: number, limit: number) =>
  unwrap<SubmissionPage>(await adminApi.get(`/forms/${encodeURIComponent(formId)}/submissions`, { params: { page, limit } }));

export function useSubmissions(formId: string | undefined, page: number, limit = 20) {
  return useQuery({
    queryKey: ['form-platform', 'submissions', formId, page, limit],
    queryFn: () => fetchPage(formId!, page, limit),
    enabled: !!formId && submissionsAvailable,
  });
}

/** Everything for an export, 100 at a time (capped at 5,000 rows). */
export async function fetchAllSubmissions(formId: string): Promise<SubmissionRow[]> {
  const rows: SubmissionRow[] = [];
  for (let page = 1; page <= 50; page++) {
    const batch = await fetchPage(formId, page, 100);
    rows.push(...batch.rows);
    if (rows.length >= batch.total || !batch.rows.length) break;
  }
  return rows;
}

export async function fileLink(formId: string, submissionId: string, uploadId: string): Promise<string> {
  return unwrap<{ url: string }>(await adminApi.get(`/forms/${formId}/submissions/${submissionId}/files/${uploadId}`)).url;
}
