import type { FormDefinition, FormValues } from '@fb/engine';
import type { SubmissionAdapter } from '@form/adapters/submission/submission-adapter';
import type { DataSourceAdapter } from '@form/adapters/data-source/data-source-adapter';
import { describeFiles } from '@form/adapters/submission/submission-adapter';
import { proofsFor, type CodeConfirmer } from '@form/adapters/codes/code-confirmer';
import { PublicApiError, publicApi } from './api';

/** Browser -> private storage (pre-signed link) -> server checks the real type -> upload id. */
async function uploadFile(def: FormDefinition, fieldName: string, file: File): Promise<{ uploadId: string }> {
  const org = encodeURIComponent(def.orgId);
  const ticket = await publicApi<{ uploadId: string; url: string; headers: Record<string, string> }>(`/forms/${encodeURIComponent(def.code)}/uploads?org=${org}`, {
    method: 'POST',
    body: { fieldName, fileName: file.name, contentType: file.type, size: file.size },
  });
  const put = await fetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: file });
  if (!put.ok) throw new PublicApiError(put.status, `Upload of ${file.name} failed`);
  await publicApi(`/uploads/${ticket.uploadId}/verify?org=${org}`, { method: 'POST' });
  return { uploadId: ticket.uploadId };
}

/** Real submissions: files first (the submission refers to verified uploads), one idempotency key per attempt. */
export const httpSubmissionAdapter: SubmissionAdapter = {
  async submit({ definition, payload, values, systemContext }) {
    try {
      const body: FormValues = { ...values };
      for (const f of definition.fields.filter((x) => x.type === 'FILE')) {
        const files = Array.isArray(values[f.name]) ? (values[f.name] as unknown[]) : [];
        body[f.name] = await Promise.all(files.filter((x): x is File => x instanceof File).map((file) => uploadFile(definition, f.name, file)));
      }
      const send = { values: body, idempotencyKey: crypto.randomUUID(), channel: systemContext.sourceChannel, urlParams: systemContext.urlParams, timeZone: systemContext.timeZone, language: systemContext.language, proofs: proofsFor(definition, values) };
      const at = (what: string) => `/forms/${encodeURIComponent(definition.code)}/${what}?org=${encodeURIComponent(definition.orgId)}`;
      type Done = { submissionId: string; ref?: string; payload: FormValues };
      let data: Done;
      if (definition.payment?.enabled) {
        // The answers are checked and held by the server; the person pays on the payment service's page and comes back to /pay/….
        const started = await publicApi<{ payment?: { url: string }; submitted?: Done }>(at('payments'), { method: 'POST', body: send });
        if (started.payment) {
          window.location.assign(started.payment.url);
          // The page is leaving: nothing more to show here.
          return await new Promise<never>(() => undefined);
        }
        data = started.submitted!;
      } else data = await publicApi<Done>(at('submissions'), { method: 'POST', body: send });
      return { ok: true, submissionId: data.submissionId, ref: data.ref || undefined, payload: data.payload };
    } catch (e) {
      const err = e as PublicApiError;
      return { ok: false, payload: describeFiles(payload), error: err.message || 'Submission failed. Please try again.', fieldErrors: err.errors };
    }
  },
};

/** Public forms read options only through the sources their published form binds (the API checks it). */
export function publicDataSourceAdapter(def: FormDefinition): DataSourceAdapter {
  return {
    async fetchRows(api, params) {
      return publicApi<Record<string, unknown>[]>(`/data-sources/query?org=${encodeURIComponent(def.orgId)}`, {
        method: 'POST',
        body: { formCode: def.code, key: api.url.split('?')[0], params },
      });
    },
  };
}

/** Codes that confirm an email address or phone number are sent and checked by the server. */
export const httpCodeConfirmer: CodeConfirmer = {
  async send(def, field, value) {
    await publicApi(`/forms/${encodeURIComponent(def.code)}/codes?org=${encodeURIComponent(def.orgId)}`, { method: 'POST', body: { field, value } });
  },
  async check(def, field, value, code) {
    const { proof } = await publicApi<{ proof: string }>(`/forms/${encodeURIComponent(def.code)}/codes/check?org=${encodeURIComponent(def.orgId)}`, { method: 'POST', body: { field, value, code } });
    return proof;
  },
};
