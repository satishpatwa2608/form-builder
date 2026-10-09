import { BadRequestException, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { setOrgLogWriter } from './org-log';
import { Organization, type OrganizationDocument } from '../orgs/org.schemas';
import { isLogArea, LOG_AREAS, LOG_LEVELS, OrgLog, type LogArea, type LogLevel, type OrgLogDocument } from './log.schema';

const RANK: Record<LogLevel, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const DEFAULT_LEVEL: LogLevel = 'INFO';
const DEFAULT_KEEP_DAYS = 14;
const MAX_KEEP_DAYS = 30;
/** Debug is for finding a fault, not for leaving on: it switches itself back after this long at most. */
const MAX_DEBUG_HOURS = 24;
/** Lines one organisation may write in a minute. Beyond it lines are dropped, and one line says so. */
const LINES_PER_MINUTE = 600;
const SECRET = /pass(word)?|secret|token|hash|credential|api_?key|private_?key|recovery|authori[sz]ation|cookie|signature|\bsig\b/i;

export type LogContext = Record<string, unknown>;

export interface LogSettings {
  /** The level of each area that differs from the usual (INFO). */
  levels: Partial<Record<LogArea, LogLevel>>;
  /** Until when DEBUG levels are honoured; after it they count as INFO again. */
  debugUntil: Date | null;
  keepDays: number;
}

export interface LogQuery {
  level?: LogLevel;
  area?: string;
  q?: string;
  before?: string;
  after?: string;
  limit?: number;
}
export interface LogLineView {
  id: string;
  at: Date;
  level: LogLevel;
  area: string;
  message: string;
  context: Record<string, string | number | boolean>;
}

/** A value as it may appear in a log line: short, on one line, never an object. */
function plain(v: unknown): string | number | boolean | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.replace(/[\r\n\t]+/g, ' ').slice(0, 200);
  if (v instanceof Date) return v.toISOString();
  return undefined;
}

/** The facts beside a message, with anything that could be a secret taken out by name. */
export function safeContext(context: LogContext = {}): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(context).slice(0, 16)) {
    const key = k.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40);
    const value = plain(v);
    if (!key || value === undefined || value === '') continue;
    out[key] = SECRET.test(key) ? '[redacted]' : value;
  }
  return out;
}

/** An address shown enough to recognise and no more: r***@customer.test */
export const maskEmail = (email: string) => email.replace(/^(.)[^@]*(@.+)$/, '$1***$2');

/** One line as text, the way a log file reads: time, level, area, message, facts. */
export function logLine(l: Pick<OrgLog, 'at' | 'level' | 'area' | 'message' | 'context'>): string {
  const facts = Object.entries(l.context ?? {})
    .map(([k, v]) => `${k}=${typeof v === 'string' && /[\s="]/.test(v) ? JSON.stringify(v) : v}`)
    .join(' ');
  return `${new Date(l.at).toISOString()} ${l.level.padEnd(5)} [${l.area}] ${l.message}${facts ? ` ${facts}` : ''}`;
}

/**
 * Each organisation's own log of what the product did for it. Writing a line
 * never fails the work it describes and never waits for it: a line that
 * cannot be written is lost, and the work goes on.
 */
@Injectable()
export class OrgLogService implements OnModuleDestroy {
  private readonly logger = new Logger('OrgLog');
  private readonly settingsCache = new Map<string, { at: number; settings: LogSettings }>();
  private readonly minute = new Map<string, { at: number; n: number }>();

  constructor(
    @InjectModel(OrgLog.name) private readonly lines: Model<OrgLogDocument>,
    @InjectModel(Organization.name) private readonly orgs: Model<OrganizationDocument>,
  ) {
    // From here on any part of the product can write a line (org-log.ts).
    setOrgLogWriter((orgId, level, area, message, context) => this.write(orgId, level, area, message, context));
  }

  onModuleDestroy() {
    setOrgLogWriter(undefined);
  }

  private static read(raw: unknown): LogSettings {
    const r = (raw ?? {}) as { levels?: Record<string, unknown>; debugUntil?: Date | string | null; keepDays?: number };
    const levels: Partial<Record<LogArea, LogLevel>> = {};
    for (const [area, level] of Object.entries(r.levels ?? {})) if (isLogArea(area) && LOG_LEVELS.includes(level as LogLevel) && level !== DEFAULT_LEVEL) levels[area] = level as LogLevel;
    const until = r.debugUntil ? new Date(r.debugUntil) : null;
    return { levels, debugUntil: until && !Number.isNaN(until.getTime()) ? until : null, keepDays: Math.min(MAX_KEEP_DAYS, Math.max(1, Math.round(r.keepDays ?? DEFAULT_KEEP_DAYS))) };
  }

  private async settingsOf(orgId: string): Promise<LogSettings> {
    const hit = this.settingsCache.get(orgId);
    if (hit && Date.now() - hit.at < 30_000) return hit.settings;
    const org = await this.orgs.findOne({ id: orgId }).select('logging').lean<{ logging?: unknown }>();
    const settings = OrgLogService.read(org?.logging);
    if (this.settingsCache.size > 2000) this.settingsCache.clear();
    this.settingsCache.set(orgId, { at: Date.now(), settings });
    return settings;
  }

  /** The level an area is recording at now. A DEBUG whose time has run out is INFO again. */
  static levelNow(settings: LogSettings, area: LogArea, now = Date.now()): LogLevel {
    const level = settings.levels[area] ?? DEFAULT_LEVEL;
    return level === 'DEBUG' && (!settings.debugUntil || settings.debugUntil.getTime() <= now) ? DEFAULT_LEVEL : level;
  }

  /** Writes a line if the area is listening at that level. Never throws, never needs awaiting. */
  write(orgId: string | undefined, level: LogLevel, area: LogArea, message: string, context?: LogContext): void {
    if (!orgId) return;
    void this.store(orgId, level, area, message, context).catch((e: Error) => this.logger.warn(`a log line was not written: ${e.name}`));
  }
  debug = (orgId: string | undefined, area: LogArea, message: string, context?: LogContext) => this.write(orgId, 'DEBUG', area, message, context);
  info = (orgId: string | undefined, area: LogArea, message: string, context?: LogContext) => this.write(orgId, 'INFO', area, message, context);
  warn = (orgId: string | undefined, area: LogArea, message: string, context?: LogContext) => this.write(orgId, 'WARN', area, message, context);
  error = (orgId: string | undefined, area: LogArea, message: string, context?: LogContext) => this.write(orgId, 'ERROR', area, message, context);

  private async store(orgId: string, level: LogLevel, area: LogArea, message: string, context?: LogContext) {
    const settings = await this.settingsOf(orgId);
    if (RANK[level] < RANK[OrgLogService.levelNow(settings, area)]) return;
    const now = Date.now();
    const bucket = this.minute.get(orgId);
    const count = bucket && now - bucket.at < 60_000 ? bucket : { at: now, n: 0 };
    count.n++;
    if (this.minute.size > 5000) this.minute.clear();
    this.minute.set(orgId, count);
    if (count.n > LINES_PER_MINUTE) {
      // One line to say lines are being left out, then silence until the minute is over.
      if (count.n !== LINES_PER_MINUTE + 1) return;
      level = 'WARN';
      message = `More than ${LINES_PER_MINUTE} lines in a minute: the rest of this minute's lines are left out`;
      context = { area };
      area = 'audit';
    }
    await this.lines.create({ orgId, at: new Date(now), level, rank: RANK[level], area, message: message.replace(/[\r\n\t]+/g, ' ').slice(0, 500), context: safeContext(context), expiresAt: new Date(now + settings.keepDays * 86_400_000) });
  }

  // ---------------------------------------------------------------- reading

  async list(orgId: string, q: LogQuery): Promise<{ lines: LogLineView[]; next: string | null }> {
    const filter: Record<string, unknown> = { orgId };
    if (q.level && q.level !== 'DEBUG') filter.rank = { $gte: RANK[q.level] };
    if (q.area && isLogArea(q.area)) filter.area = q.area;
    const at: Record<string, Date> = {};
    if (q.before) at.$lt = new Date(q.before);
    if (q.after) at.$gt = new Date(q.after);
    if (Object.keys(at).length) filter.at = at;
    const text = (q.q ?? '').trim().slice(0, 100);
    // Plain text, found anywhere in the message or among the facts beside it; never a pattern.
    if (text) {
      const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [{ message: { $regex: escaped, $options: 'i' } }, { 'context.form': text }, { 'context.ref': text }, { 'context.connector': { $regex: `^${escaped}`, $options: 'i' } }];
    }
    const limit = Math.min(Math.max(q.limit ?? 200, 1), 1000);
    const rows = await this.lines.find(filter).sort({ at: -1, _id: -1 }).limit(limit).lean<(OrgLog & { _id: unknown })[]>();
    return { lines: rows.map((l) => ({ id: String(l._id), at: l.at, level: l.level, area: l.area, message: l.message, context: l.context ?? {} })), next: rows.length === limit ? rows[rows.length - 1]!.at.toISOString() : null };
  }

  /** The same lines as text, oldest first, as a log file reads. */
  async download(orgId: string, q: LogQuery): Promise<string> {
    const { lines } = await this.list(orgId, { ...q, limit: 1000 });
    return `${lines.reverse().map(logLine).join('\n')}\n`;
  }

  // ---------------------------------------------------------------- settings

  async settings(orgId: string) {
    this.settingsCache.delete(orgId);
    const s = await this.settingsOf(orgId);
    return {
      areas: (Object.keys(LOG_AREAS) as LogArea[]).map((area) => ({ area, label: LOG_AREAS[area], level: s.levels[area] ?? DEFAULT_LEVEL, recording: OrgLogService.levelNow(s, area) })),
      debugUntil: s.debugUntil && s.debugUntil.getTime() > Date.now() ? s.debugUntil : null,
      keepDays: s.keepDays,
      limits: { maxKeepDays: MAX_KEEP_DAYS, maxDebugHours: MAX_DEBUG_HOURS },
    };
  }

  /** Returns the new settings and, for the audit trail, what they were set to. */
  async update(orgId: string, body: { levels?: Record<string, string>; debugHours?: number; keepDays?: number }) {
    const current = await this.settingsOf(orgId);
    const levels: Partial<Record<LogArea, LogLevel>> = { ...current.levels };
    for (const [area, level] of Object.entries(body.levels ?? {})) {
      if (!isLogArea(area)) throw new BadRequestException(`There is no part of the product called "${area.slice(0, 40)}"`);
      if (!LOG_LEVELS.includes(level as LogLevel)) throw new BadRequestException('Choose Debug, Info, Warnings or Errors');
      if (level === DEFAULT_LEVEL) delete levels[area];
      else levels[area] = level as LogLevel;
    }
    const anyDebug = Object.values(levels).includes('DEBUG');
    const turnedOn = Object.entries(body.levels ?? {}).some(([area, level]) => level === 'DEBUG' && current.levels[area as LogArea] !== 'DEBUG');
    const hours = Math.min(MAX_DEBUG_HOURS, Math.max(1, Math.round(body.debugHours ?? 1)));
    // Debug runs for the time asked for from the moment it is switched on (or asked for again), and not past the limit.
    const debugUntil = !anyDebug ? null : turnedOn || body.debugHours !== undefined || !current.debugUntil || current.debugUntil.getTime() <= Date.now() ? new Date(Date.now() + hours * 3_600_000) : current.debugUntil;
    const keepDays = body.keepDays === undefined ? current.keepDays : Math.min(MAX_KEEP_DAYS, Math.max(1, Math.round(body.keepDays)));
    await this.orgs.updateOne({ id: orgId }, { $set: { logging: { levels, debugUntil, keepDays } } });
    this.settingsCache.delete(orgId);
    return { settings: await this.settings(orgId), saved: { ...levels, keepDays } as Record<string, unknown> };
  }
}
