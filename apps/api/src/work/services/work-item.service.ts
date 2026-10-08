import { Injectable } from '@nestjs/common';
import type { FormValues } from '@fb/engine';
import { FormSubmissionService } from './form-submission.service';

export interface CreateWorkItem {
  orgId: string;
  /** The form that defines the item's fields and process (usually a sign-in-only internal form). */
  formCode: string;
  /** Answers by field name, validated exactly like a submission. */
  values: FormValues;
  /** Who it's raised for / by, if a person is involved (prefill, submitter). */
  createdBy?: { uuid: string; name?: string; email?: string; employeeId?: string };
  /** Retries with the same key create the item once. */
  idempotencyKey?: string;
}

/**
 * How other modules raise work items, e.g. a failed quality check raising a
 * "Quality deviation" item. Import FormPlatformModule and inject this. The
 * item goes through the same pipeline as a submission (validation,
 * reference, assignment, automations), with source MODULE.
 */
@Injectable()
export class WorkItemService {
  constructor(private readonly submissions: FormSubmissionService) {}

  async create(input: CreateWorkItem): Promise<{ id: string; ref: string }> {
    const user = input.createdBy ? { ...input.createdBy, orgId: input.orgId } : undefined;
    const res = await this.submissions.submit(
      input.orgId,
      input.formCode,
      { values: input.values, idempotencyKey: input.idempotencyKey, channel: 'APP' },
      user,
      undefined,
      { source: 'MODULE', trusted: true },
    );
    const data = res as { submissionId: string; ref?: string };
    return { id: data.submissionId, ref: data.ref ?? '' };
  }
}
