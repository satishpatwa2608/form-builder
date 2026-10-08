import type { FormDefinition, FormValues, SubmissionResult, SystemContext } from '../../types';
import { api } from '../../../lib/api';

export interface SubmissionRequest {
  definition: FormDefinition;
  /** What the form would send, built by the engine (hidden fields dropped, mapping applied). */
  payload: FormValues;
  /** Raw values by field name - the server re-validates these itself. */
  values: FormValues;
  systemContext: SystemContext;
}

/**
 * Where a submission goes. The runtime only knows this interface: the mock
 * echoes the payload (preview, playground, tests); the HTTP adapter posts to
 * the generic submit API, uploading any files first.
 */
export interface SubmissionAdapter {
  submit(request: SubmissionRequest): Promise<SubmissionResult>;
}

interface MockOptions {
  delayMs?: number;
  /** Simulate a backend rejection. */
  fail?: string;
}

/**
 * Files can't be shown as JSON. The mock echoes their metadata instead;
 * the HTTP adapter uploads them and sends upload ids.
 */
export function describeFiles(payload: FormValues): FormValues {
  const describe = (v: unknown): unknown =>
    typeof File !== 'undefined' && v instanceof File ? { name: v.name, size: v.size, type: v.type } : v;
  return Object.fromEntries(
    Object.entries(payload).map(([k, v]) => [k, Array.isArray(v) ? v.map(describe) : describe(v)]),
  );
}

export function createMockSubmissionAdapter({ delayMs = 300, fail }: MockOptions = {}): SubmissionAdapter {
  return {
    async submit({ payload }) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (fail) return { ok: false, payload: describeFiles(payload), error: fail };
      return { ok: true, submissionId: crypto.randomUUID(), payload: describeFiles(payload) };
    },
  };
}

/**
 * The studio only previews forms, so submissions go to the mock (it echoes the
 * payload). Real submissions and uploads arrive with the runtime (Phase 1b).
 */
export const defaultSubmissionAdapter: SubmissionAdapter = createMockSubmissionAdapter();

/** Browser -> private storage (pre-signed link) -> server checks the real type -> upload id. */
export async function uploadFile(definition: FormDefinition, fieldName: string, file: File): Promise<{ uploadId: string }> {
  const org = encodeURIComponent(definition.orgId);
  const ticket = await api<{ uploadId: string; url: string; headers: Record<string, string> }>(`/public/forms/${encodeURIComponent(definition.code)}/uploads?org=${org}`, {
    method: 'POST',
    body: { fieldName, fileName: file.name, contentType: file.type, size: file.size },
  });
  const put = await fetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: file });
  if (!put.ok) throw new Error(`Upload of ${file.name} failed`);
  await api(`/public/uploads/${ticket.uploadId}/verify?org=${org}`, { method: 'POST' });
  return { uploadId: ticket.uploadId };
}
