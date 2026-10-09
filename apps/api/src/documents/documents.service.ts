import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { findStatus, isRtl, localize, workflowOf, type FormDefinition, type FormValues } from '@fb/engine';
import type { Model } from 'mongoose';
import type { AuthContext } from '../auth/auth-context';
import { newId } from '../common/crypto';
import { OBJECT_STORE, type ObjectStore } from '../common/object-store';
import { checkSubmissionShape } from '../forms/payload-guard';
import { FormsService } from '../forms/forms.service';
import { JobQueue } from '../jobs/job-queue.service';
import { Organization, type OrganizationDocument } from '../orgs/org.schemas';
import { FORM_SUBMITTED_EVENT } from '../work/constants';
import { FormSubmission, type FormSubmissionDocument } from '../work/schemas/form-submission.schema';
import { FormDefinitionService } from '../work/services/form-definition.service';
import type { FormSubmittedEvent } from '../work/services/form-submission.service';
import { DocumentBatch, type DocumentBatchDocument } from './document-batch.schema';
import { documentRows, renderDocument } from './submission-pdf';

/** How many documents one batch may ask for. */
export const MAX_BATCH = 1000;
const JOB_RECORD = 'document.record';
const JOB_BATCH_ITEM = 'document.batch-item';
const BATCH_ATTEMPTS = 3;

/**
 * Documents of record: a PDF of a response, made by the server. A form that
 * asks to keep one has it made in the background as each response arrives;
 * otherwise it is made the first time someone asks for it. Either way it is
 * stored once, at a place that follows from the response, so making it again
 * (a retried job, two people asking at once) never leaves two.
 */
@Injectable()
export class DocumentsService implements OnModuleInit {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly jobs: JobQueue,
    private readonly forms: FormsService,
    private readonly definitions: FormDefinitionService,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @InjectModel(FormSubmission.name) private readonly submissions: Model<FormSubmissionDocument>,
    @InjectModel(Organization.name) private readonly orgs: Model<OrganizationDocument>,
    @InjectModel(DocumentBatch.name) private readonly batches: Model<DocumentBatchDocument>,
  ) {}

  onModuleInit() {
    this.jobs.register(JOB_RECORD, (p: { orgId: string; submissionId: string }) => this.forRecord(p.orgId, p.submissionId, true).then(() => undefined), { maxAttempts: 5 });
    this.jobs.register(
      JOB_BATCH_ITEM,
      async (p: { orgId: string; batchId: string; index: number; values: FormValues }, job) => {
        try {
          await this.batchItem(p);
        } catch (e) {
          // On its last try a document that cannot be made is counted, so the batch can still be seen to end.
          if (job.attempt >= BATCH_ATTEMPTS) await this.batches.updateOne({ orgId: p.orgId, id: p.batchId }, { $inc: { failed: 1 } });
          throw e;
        }
      },
      { maxAttempts: BATCH_ATTEMPTS },
    );
  }

  /** A form that keeps a PDF of each response has it made as the response arrives, off the request. */
  @OnEvent(FORM_SUBMITTED_EVENT, { async: true })
  async onSubmitted(event: FormSubmittedEvent) {
    try {
      const def = await this.definitions.findPublished(event.orgId, event.formCode);
      if (!def?.document?.keep) return;
      await this.jobs.enqueue(JOB_RECORD, { orgId: event.orgId, submissionId: event.submissionId }, { orgId: event.orgId, dedupeKey: `document:${event.submissionId}` });
    } catch (e) {
      // The response is already stored; its document can still be made when someone asks.
      this.logger.error(`could not queue the document of ${event.submissionId}: ${(e as Error).message}`);
    }
  }

  private async branding(orgId: string) {
    const org = await this.orgs.findOne({ id: orgId }).select('name branding').lean();
    const b = (org as { branding?: { logo?: string; primaryColor?: string } } | null)?.branding;
    return { name: org?.name ?? '', logo: b?.logo || undefined, color: b?.primaryColor || undefined };
  }

  private async render(orgId: string, def: FormDefinition, values: FormValues, record: { ref?: string; submittedAt: Date; status?: string }): Promise<Buffer> {
    return renderDocument({
      org: await this.branding(orgId),
      form: { name: def.name, code: def.code, version: def.version },
      record,
      options: def.document,
      rows: documentRows(def, values, def.document),
      generatedAt: new Date(),
    });
  }

  /** Where a response's document is kept. One response, one place. */
  private static keyOf(orgId: string, code: string, submissionId: string) {
    return `documents/${orgId}/${code}/${submissionId}.pdf`;
  }

  /**
   * The document of one response: the stored one, or made and stored now.
   * `remake` makes it again over the old one (the job does, so a retry after
   * a half-finished attempt ends with one good document).
   */
  async forRecord(orgId: string, submissionId: string, remake = false): Promise<{ pdf: Buffer; fileName: string }> {
    const row = await this.submissions.findOne({ orgId, uuid: submissionId }).lean();
    if (!row) throw new NotFoundException('Response not found');
    const fileName = `${row.ref || row.formCode}-${row.ref ? '' : row.uuid.slice(0, 8)}`.replace(/-$/, '') + '.pdf';
    if (row.document?.key && !remake) {
      const stored = await this.store.get(row.document.key);
      if (stored) return { pdf: stored, fileName };
    }
    // The version it was submitted against: a later change to the form does not rewrite what was answered.
    const stored = await this.definitions.findVersion(orgId, row.formId);
    if (!stored) throw new NotFoundException('The form this response belongs to no longer exists');
    // In the language it was answered in. (Right-to-left scripts cannot be drawn yet: those stay in the form's own language.)
    const def = row.language && !isRtl(row.language) ? localize(stored, row.language) : stored;
    const status = row.ref ? (findStatus(workflowOf(def), row.status)?.label ?? row.status) : undefined;
    const pdf = await this.render(orgId, def, row.payload as FormValues, { ref: row.ref || undefined, submittedAt: (row as unknown as { createdAt: Date }).createdAt, status });
    const key = DocumentsService.keyOf(orgId, row.formCode, row.uuid);
    await this.store.put(key, pdf, 'application/pdf');
    await this.submissions.updateOne({ orgId, uuid: submissionId }, { $set: { document: { key, size: pdf.length, at: new Date() } } }, { timestamps: false });
    return { pdf, fileName };
  }

  /** For someone who may read a form's responses: the PDF of one of them. */
  async download(auth: AuthContext, formId: string, submissionId: string) {
    const code = await this.forms.assertCanReadSubmissions(auth, formId);
    const row = await this.submissions.findOne({ orgId: auth.orgId, uuid: submissionId }).select('formCode').lean();
    if (!row || row.formCode !== code) throw new NotFoundException('Response not found');
    return this.forRecord(auth.orgId, submissionId);
  }

  /** Answers that are safe to draw: the same shape check a submission gets. Unknown keys are dropped by the renderer. */
  private static checked(def: FormDefinition, values: unknown): FormValues {
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new BadRequestException('Give the answers as an object: field name to value');
    const problems = checkSubmissionShape(def, values);
    if (problems.length) throw new BadRequestException({ message: 'The answers do not fit this form', errors: problems });
    return values as FormValues;
  }

  /** The generation API: this form's document for answers supplied by the caller. Nothing is stored. */
  async generate(auth: AuthContext, formId: string, body: unknown): Promise<{ pdf: Buffer; fileName: string }> {
    const row = await this.forms.access(auth, formId, 'form.edit');
    const def = (await this.definitions.findVersion(auth.orgId, row.id))!;
    const input = (body && typeof body === 'object' ? body : {}) as { values?: unknown; reference?: unknown };
    const ref = typeof input.reference === 'string' ? input.reference.trim().slice(0, 60) : '';
    return { pdf: await this.render(auth.orgId, def, DocumentsService.checked(def, input.values), { ref: ref || undefined, submittedAt: new Date() }), fileName: `${def.code}${ref ? `-${ref.replace(/[^A-Za-z0-9_-]/g, '_')}` : ''}.pdf` };
  }

  // ── Batches ──────────────────────────────────────────────────────────────

  /** Queues one document per set of answers. Answers that do not fit the form are refused before anything is queued. */
  async startBatch(auth: AuthContext, formId: string, body: unknown) {
    const row = await this.forms.access(auth, formId, 'form.edit');
    const def = (await this.definitions.findVersion(auth.orgId, row.id))!;
    const items = (body as { items?: unknown })?.items;
    if (!Array.isArray(items) || !items.length) throw new BadRequestException('Give the answers for at least one document');
    if (items.length > MAX_BATCH) throw new BadRequestException(`A batch makes at most ${MAX_BATCH} documents`);
    const checked = items.map((values, i) => {
      try {
        return DocumentsService.checked(def, values);
      } catch (e) {
        throw new BadRequestException(`Item ${i + 1}: ${(e as Error).message}`);
      }
    });
    const id = newId();
    await this.batches.create({ id, orgId: auth.orgId, formId: row.id, formCode: row.code, total: checked.length, createdBy: auth.userId });
    // Queued fifty at a time, so the request that starts a large batch answers in about a second.
    const all = [...checked.entries()];
    for (let at = 0; at < all.length; at += 50) {
      await Promise.all(
        all.slice(at, at + 50).map(([index, values]) => this.jobs.enqueue(JOB_BATCH_ITEM, { orgId: auth.orgId, batchId: id, index, values }, { orgId: auth.orgId, dedupeKey: `document-batch:${id}:${index}` })),
      );
    }
    return this.batchStatus(auth, id);
  }

  private static batchKey(orgId: string, batchId: string, index: number) {
    return `documents/${orgId}/batches/${batchId}/${index + 1}.pdf`;
  }

  private async batchItem(p: { orgId: string; batchId: string; index: number; values: FormValues }) {
    const batch = await this.batches.findOne({ orgId: p.orgId, id: p.batchId }).lean();
    if (!batch) return;
    const key = DocumentsService.batchKey(p.orgId, p.batchId, p.index);
    // A retry of an item that was already stored must not count it twice.
    const existed = !!(await this.store.get(key));
    const def = await this.definitions.findVersion(p.orgId, batch.formId);
    if (!def) throw new Error('the form no longer exists');
    await this.store.put(key, await this.render(p.orgId, def, p.values, { ref: `${p.index + 1} of ${batch.total}`, submittedAt: batch.createdAt }), 'application/pdf');
    if (!existed) await this.batches.updateOne({ orgId: p.orgId, id: p.batchId }, { $inc: { done: 1 } });
  }

  async batchStatus(auth: AuthContext, id: string) {
    const batch = await this.batches.findOne({ orgId: auth.orgId, id }).lean();
    if (!batch) throw new NotFoundException('Batch not found');
    await this.forms.access(auth, batch.formId, 'form.edit');
    const finished = batch.done + batch.failed >= batch.total;
    return { id: batch.id, formCode: batch.formCode, total: batch.total, done: batch.done, failed: batch.failed, status: !finished ? 'WORKING' : batch.failed ? 'DONE_WITH_FAILURES' : 'DONE', createdAt: batch.createdAt };
  }

  async batchDocument(auth: AuthContext, id: string, number: number) {
    const batch = await this.batches.findOne({ orgId: auth.orgId, id }).lean();
    if (!batch || !Number.isInteger(number) || number < 1 || number > batch.total) throw new NotFoundException('Document not found');
    await this.forms.access(auth, batch.formId, 'form.edit');
    const pdf = await this.store.get(DocumentsService.batchKey(auth.orgId, id, number - 1));
    if (!pdf) throw new NotFoundException('That document has not been made yet');
    return { pdf, fileName: `${batch.formCode}-${number}.pdf` };
  }
}
