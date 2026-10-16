import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { FormDefinition } from '@fb/engine';
import { AuditService } from '../../audit/audit.service';
import { OBJECT_STORE, type ObjectStore } from '../../common/object-store';
import { ACTION_KEY } from '../../connectors/connectors.service';
import { JobQueue } from '../../jobs/job-queue.service';
import { orgLog } from '../../logs/org-log';
import { Organization, type OrganizationDocument } from '../../orgs/org.schemas';
import { SignatureRequest, type SignatureRequestDocument } from '../../signatures/signature.schema';
import { FormFlowRun, FormFlowRunDocument, FormRecordEvent, FormRecordEventDocument } from '../schemas/form-record.schema';
import { FormSubmission, FormSubmissionDocument } from '../schemas/form-submission.schema';
import { Notification, NotificationDocument } from '../schemas/notification.schema';
import { FormUpload, FormUploadDocument } from '../schemas/upload.schema';
import { FormDefinitionService } from './form-definition.service';

const DAY = 86_400_000;
const BATCH = 500;
/** The steps that hand a response to the organisation's own system. */
const SENDS_OUT = ['HANDLER', 'WEBHOOK', 'FLOW'] as const;

/** Whether a form hands its responses to the organisation's own system (a connector write, a webhook, a flow tool). */
export function sendsOut(def: Pick<FormDefinition, 'automations'>): boolean {
  return (def.automations ?? []).some((a) => a.enabled && a.actions.some((s) => s.type === 'WEBHOOK' || s.type === 'FLOW' || (s.type === 'HANDLER' && ACTION_KEY.test(s.key))));
}

/**
 * Keeping data only as long as needed: a closed record (or, for a form without a workflow, a response) is deleted
 * once the organisation's retention has passed, with its files, its PDF, its timeline and its signed copies. Open
 * work is never deleted. A record whose form hands it to the organisation's own system is deleted only after that
 * succeeded, so nothing is lost that was meant to be kept there. A record an admin holds is kept. Each night's
 * deletions are counted in the audit trail, which keeps a year (it holds no answers).
 */
@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @InjectModel(Organization.name) private readonly orgs: Model<OrganizationDocument>,
    @InjectModel(FormSubmission.name) private readonly records: Model<FormSubmissionDocument>,
    @InjectModel(FormRecordEvent.name) private readonly events: Model<FormRecordEventDocument>,
    @InjectModel(FormFlowRun.name) private readonly runs: Model<FormFlowRunDocument>,
    @InjectModel(Notification.name) private readonly notifications: Model<NotificationDocument>,
    @InjectModel(FormUpload.name) private readonly uploads: Model<FormUploadDocument>,
    @InjectModel(SignatureRequest.name) private readonly signatures: Model<SignatureRequestDocument>,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    private readonly definitions: FormDefinitionService,
    private readonly audit: AuditService,
    private readonly jobs: JobQueue,
  ) {}

  onModuleInit() {
    // The process that runs background work does this too, once an hour (it finds nothing most hours).
    if (!this.jobs.runsJobs || process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.run().catch((e: Error) => this.logger.error(`retention failed: ${e.message}`)), 3_600_000);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** What an admin is told: how long, which forms keep their answers only here, and what goes at the next run. */
  async overview(orgId: string) {
    const org = await this.orgs.findOne({ id: orgId }).select('retention').lean();
    const days = org?.retention ? org.retention.days : 7;
    const latest = await this.definitions.latestByCode(orgId);
    const keptHereOnly = [...latest.values()].filter((d) => d.status === 'PUBLISHED' && !sendsOut(d)).map((d) => d.name);
    const due = days === null ? 0 : (await this.due(orgId, days, new Date())).length;
    return { days, keptHereOnly, due };
  }

  /** Records past retention that may go now: closed (or sent, without a workflow) long enough, not held, and copied out if they are meant to be. */
  private async due(orgId: string, days: number, now: Date, limit = BATCH) {
    const cutoff = new Date(now.getTime() - days * DAY);
    const rows = await this.records
      .find({ orgId, held: { $ne: true }, $or: [{ resolvedAt: { $lte: cutoff } }, { resolvedAt: null, createdAt: { $lte: cutoff } }] })
      .select('uuid formId resolvedAt files document')
      .limit(limit)
      .lean();
    const out: typeof rows = [];
    for (const r of rows) {
      const def = await this.definitions.findVersion(orgId, r.formId);
      // Open work (a form with a workflow, not resolved) is never deleted.
      if (!r.resolvedAt && def?.workflow?.enabled) continue;
      if (def && sendsOut(def)) {
        const copied = await this.events.exists({ orgId, recordId: r.uuid, type: 'AUTOMATION', 'data.ok': true, 'data.action': { $in: SENDS_OUT } });
        if (!copied) continue;
      }
      out.push(r);
    }
    return out;
  }

  /** Deletes what is due in every organisation. Returns how many records went. */
  async run(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let total = 0;
    try {
      const orgs = await this.orgs.find({}).select('id retention').comment('across-orgs: the nightly retention looks at every organisation').lean();
      for (const org of orgs) {
        const days = org.retention ? org.retention.days : 7;
        if (days === null || days === undefined) continue;
        let deleted = 0;
        for (;;) {
          const batch = await this.due(org.id, days, now);
          if (!batch.length) break;
          for (const r of batch) await this.remove(org.id, r);
          deleted += batch.length;
          if (batch.length < BATCH) break;
        }
        if (deleted) {
          total += deleted;
          await this.audit.record({ orgId: org.id, actorId: 'system:retention' }, { action: 'records.deleted_by_retention', targetType: 'organization', targetId: org.id, after: { records: deleted, days } });
          orgLog.info(org.id, 'audit', `${deleted} record(s) deleted: closed more than ${days} days ago`, { days });
        }
      }
    } finally {
      this.running = false;
    }
    return total;
  }

  private async remove(orgId: string, r: { uuid: string; files?: { uploadId: string; key?: string }[]; document?: { key: string } | null }) {
    const signed = await this.signatures.find({ orgId, recordId: r.uuid }).select('signedKey').lean();
    // Stored files first: a record left without them is better than files left without a record.
    const keys = [...(r.files ?? []).map((f) => f.key), r.document?.key, ...signed.map((s) => s.signedKey)].filter((k): k is string => !!k);
    for (const key of keys) await this.store.remove(key).catch(() => undefined);
    await Promise.all([
      this.uploads.deleteMany({ orgId, uuid: { $in: (r.files ?? []).map((f) => f.uploadId) } }),
      this.events.deleteMany({ orgId, recordId: r.uuid }),
      this.runs.deleteMany({ orgId, recordId: r.uuid }),
      this.notifications.deleteMany({ orgId, recordId: r.uuid }),
      this.signatures.deleteMany({ orgId, recordId: r.uuid }),
    ]);
    await this.records.deleteOne({ orgId, uuid: r.uuid });
  }
}
