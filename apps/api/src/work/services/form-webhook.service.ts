import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { OnEvent } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { newId as uuidv4 } from '../../common/crypto';
import apiResponse from '../response';
import { WORK_EVENT } from '../constants';
import { FormWebhook, FormWebhookDocument } from '../schemas/form-record.schema';
import { FormSubmission, FormSubmissionDocument } from '../schemas/form-submission.schema';
import { postWebhook, webhookAllowed } from './webhook-client';
import { WORK_EVENT_NAMES, type WorkEvent } from './form-record.service';
import { FormDefinitionService } from './form-definition.service';
import { valuesFromPayload } from '@fb/engine';
import type { FormValues } from '@fb/engine';

type AuthUser = { uuid: string; orgId: string };

const CODE = /^[A-Z0-9_]{1,100}$/;

/**
 * Org-level webhook subscriptions to work item events (record.created,
 * status.changed, sla.breached, ...). Delivery is fire-and-forget after the
 * change is saved: the same allow-list, no-redirect, timeout and HMAC rules
 * as the webhook automation step. The last result is kept on the subscription.
 */
@Injectable()
export class FormWebhookService {
  private readonly logger = new Logger(FormWebhookService.name);

  constructor(
    @InjectModel(FormWebhook.name) private readonly hooks: Model<FormWebhookDocument>,
    @InjectModel(FormSubmission.name) private readonly records: Model<FormSubmissionDocument>,
    private readonly definitions: FormDefinitionService,
  ) {}

  private static view(h: FormWebhook) {
    const { secret, isDeleted, ...rest } = h as FormWebhook & { _id?: unknown; __v?: unknown };
    delete (rest as { _id?: unknown })._id;
    delete (rest as { __v?: unknown }).__v;
    return { ...rest, signed: !!secret, isDeleted };
  }

  async list(user: AuthUser) {
    const rows = await this.hooks.find({ orgId: user.orgId, isDeleted: false }).sort({ name: 1 }).lean();
    return apiResponse(true, 200, 'Webhooks fetched', { webhooks: rows.map((r) => FormWebhookService.view(r)), events: WORK_EVENT_NAMES });
  }

  /** Create or update. `secret` is write-only: omitted keeps the current one, '' removes it. */
  async upsert(user: AuthUser, id: string, body: Record<string, unknown>) {
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
    const url = typeof body.url === 'string' ? body.url.trim().slice(0, 500) : '';
    if (!name) throw new BadRequestException('Give the webhook a name');
    const allowed = webhookAllowed(url);
    if ('error' in allowed) throw new BadRequestException(allowed.error);
    const events = Array.isArray(body.events) ? body.events.filter((e): e is string => (WORK_EVENT_NAMES as readonly string[]).includes(e as string)) : [];
    const formCodes = Array.isArray(body.formCodes) ? body.formCodes.filter((c): c is string => typeof c === 'string' && CODE.test(c)).slice(0, 50) : [];
    const set: Record<string, unknown> = { name, url, events, formCodes, active: body.active !== false, includeData: body.includeData === true };
    if (typeof body.secret === 'string') set.secret = body.secret.slice(0, 200);
    const uuid = id === 'new' ? uuidv4() : id;
    if (id !== 'new' && !(await this.hooks.exists({ uuid, orgId: user.orgId, isDeleted: false }))) throw new NotFoundException('Webhook not found');
    await this.hooks.updateOne({ uuid, orgId: user.orgId }, { $set: set, $setOnInsert: { uuid, orgId: user.orgId } }, { upsert: true });
    return this.list(user);
  }

  async remove(user: AuthUser, id: string) {
    await this.hooks.updateOne({ uuid: id, orgId: user.orgId }, { $set: { isDeleted: true, active: false } });
    return this.list(user);
  }

  @OnEvent(WORK_EVENT, { async: true })
  async deliver(e: WorkEvent) {
    try {
      const subs = await this.hooks.find({ orgId: e.orgId, active: true, isDeleted: false, $or: [{ events: { $size: 0 } }, { events: e.name }] }).lean();
      if (!subs.length) return;
      const record = await this.records
        .findOne({ uuid: e.recordId, orgId: e.orgId })
        .select('uuid ref formId formCode formVersion status priority assigneeId source createdAt payload work')
        .lean();
      if (!record) return;
      // Answers by field name (not the storage keys), only for subscriptions that ask for them.
      const needsData = subs.some((s) => s.includeData);
      const definition = needsData ? await this.definitions.findVersion(e.orgId, record.formId) : null;
      const values = definition ? valuesFromPayload(definition, record.payload as FormValues) : record.payload;
      const payload = {
        event: e.name,
        occurredAt: new Date().toISOString(),
        record: {
          id: record.uuid,
          ref: record.ref,
          formCode: record.formCode,
          formVersion: record.formVersion,
          status: record.status,
          priority: record.priority,
          assigneeId: record.assigneeId,
          source: record.source,
        },
        by: e.by,
        message: e.message,
        data: e.data,
      };
      await Promise.all(
        subs
          .filter((s) => !s.formCodes.length || s.formCodes.includes(record.formCode))
          .map(async (s) => {
            try {
              const body = s.includeData ? { ...payload, values, work: record.work ?? {} } : payload;
              const res = await postWebhook(s.url, body, s.secret || process.env.FORM_WEBHOOK_SECRET);
              await this.hooks.updateOne({ uuid: s.uuid }, { $set: { lastDeliveryAt: new Date(), lastResult: `${e.name}: ${res.status}`, failures: 0 } });
            } catch (err) {
              const msg = ((err as Error).message ?? 'failed').slice(0, 200);
              this.logger.warn(`webhook ${s.name} (${e.name}) failed: ${msg}`);
              await this.hooks.updateOne({ uuid: s.uuid }, { $set: { lastDeliveryAt: new Date(), lastResult: `${e.name}: ${msg}` }, $inc: { failures: 1 } });
            }
          }),
      );
    } catch (err) {
      this.logger.error(`webhook delivery for ${e.recordId} failed: ${(err as Error).message}`);
    }
  }
}
