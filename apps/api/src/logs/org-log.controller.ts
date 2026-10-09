import { Body, Controller, Get, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Auth, type AuthContext } from '../auth/auth-context';
import { RequirePermission } from '../auth/auth.guard';
import { ZodBody } from '../common/zod-body';
import { actorOf, AuditService } from '../audit/audit.service';
import { LOG_LEVELS } from './log.schema';
import { OrgLogService } from './org-log.service';

const query = z.object({
  level: z.enum(LOG_LEVELS).optional(),
  area: z.string().max(40).optional(),
  q: z.string().max(100).optional(),
  before: z.string().datetime().optional(),
  after: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});
const settingsBody = z.object({
  levels: z.record(z.string().max(40), z.string().max(10)).optional(),
  debugHours: z.number().min(1).max(24).optional(),
  keepDays: z.number().min(1).max(30).optional(),
});

/** An organisation's own log: read by whoever may read its audit trail, set up by whoever manages the organisation. */
@Controller('org/logs')
export class OrgLogController {
  constructor(
    private readonly logs: OrgLogService,
    private readonly audit: AuditService,
  ) {}

  /** Newest first; pass `next` back as `before` for older lines, or the newest line's time as `after` to follow. */
  @Get()
  @RequirePermission('audit.read')
  list(@Auth() auth: AuthContext, @Query(new ZodBody(query)) q: z.infer<typeof query>) {
    return this.logs.list(auth.orgId, q);
  }

  @Get('download')
  @RequirePermission('audit.read')
  async download(@Auth() auth: AuthContext, @Query(new ZodBody(query)) q: z.infer<typeof query>, @Res() res: Response) {
    const text = await this.logs.download(auth.orgId, q);
    res.status(200).set({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="form-builder-${new Date().toISOString().slice(0, 10)}.log"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' }).send(text);
  }

  @Get('settings')
  @RequirePermission('audit.read')
  settings(@Auth() auth: AuthContext) {
    return this.logs.settings(auth.orgId);
  }

  @Put('settings')
  @RequirePermission('org.manage')
  async update(@Auth() auth: AuthContext, @Body(new ZodBody(settingsBody)) body: z.infer<typeof settingsBody>) {
    const { settings, saved } = await this.logs.update(auth.orgId, body);
    // Who changed what is listened to is itself part of the audit trail.
    await this.audit.record(actorOf(auth), { action: 'org.logging_updated', targetType: 'organization', targetId: auth.orgId, after: saved });
    return settings;
  }
}
