import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { newId } from '../common/crypto';
import { AuditEntry, type AuditEntryDocument } from './audit.schema';

export interface AuditActor {
  orgId: string;
  actorId: string;
  ip?: string;
  userAgent?: string;
}

/** The audit actor for a signed-in request. */
export const actorOf = (auth: { orgId: string; userId: string; ip: string; userAgent: string }): AuditActor => ({
  orgId: auth.orgId,
  actorId: auth.userId,
  ip: auth.ip,
  userAgent: auth.userAgent,
});

export interface AuditEvent {
  action: string;
  targetType?: string;
  targetId?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

/**
 * Keys that must never reach the log, whatever a caller passes. Deliberately
 * not "code" or "key": a form's code and a style's key are identifiers, and
 * redacting them made the log useless (two-factor codes are never logged).
 */
const SECRET_KEYS = /pass(word)?|secret|token|hash|credential|api_?key|private_?key|recovery/i;
export const redact = (v: Record<string, unknown> | null | undefined) =>
  v ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEYS.test(k) ? '[redacted]' : x])) : null;

@Injectable()
export class AuditService {
  constructor(@InjectModel(AuditEntry.name) private readonly entries: Model<AuditEntryDocument>) {}

  async record(actor: AuditActor, event: AuditEvent): Promise<void> {
    await this.entries.create({
      id: newId(),
      orgId: actor.orgId,
      actorId: actor.actorId,
      ip: actor.ip ?? '',
      userAgent: actor.userAgent ?? '',
      action: event.action,
      targetType: event.targetType ?? '',
      targetId: event.targetId ?? '',
      before: redact(event.before),
      after: redact(event.after),
    });
  }

  async list(orgId: string, query: { action?: string; actorId?: string; before?: string; limit?: number }) {
    const filter: Record<string, unknown> = { orgId };
    if (query.action) filter.action = query.action;
    if (query.actorId) filter.actorId = query.actorId;
    if (query.before) filter.at = { $lt: new Date(query.before) };
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const rows = await this.entries.find(filter).sort({ at: -1 }).limit(limit).select('-_id -__v').lean();
    return { entries: rows, next: rows.length === limit ? rows[rows.length - 1]!.at.toISOString() : null };
  }
}
