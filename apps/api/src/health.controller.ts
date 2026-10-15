import { Controller, Get, Headers, HttpStatus, Inject, NotFoundException, Res } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Response } from 'express';
import type { Connection } from 'mongoose';
import { timingSafeEqual } from 'node:crypto';
import { CONNECTOR_TYPES } from '@fb/connectors';
import { Public } from './auth/auth.guard';
import { renderMetrics } from './common/metrics';
import { APP_CONFIG, type AppConfig } from './config';
import { GatewaysService } from './gateways/gateways.service';
import { JobQueue } from './jobs/job-queue.service';
import { JOB_STATUSES } from './jobs/job.schema';

const HOUR = 3_600_000;

/**
 * GET /health looks before it answers: the database, the queue and the gateways. It answers 503 only when the
 * database cannot be reached (the one thing a restart may fix); a slow queue or failed work is reported, for a
 * person or an alert to act on. Counts only: nothing of any organisation's.
 *
 * GET /metrics is the same and more as numbers a monitor reads (Prometheus text), behind METRICS_TOKEN.
 */
@Controller()
export class HealthController {
  constructor(
    @InjectConnection() private readonly db: Connection,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly jobs: JobQueue,
    private readonly gateways: GatewaysService,
  ) {}

  @Public()
  @Get('health')
  async health(@Res({ passthrough: true }) res: Response) {
    const database = await this.db
      .db!.admin()
      .ping()
      .then(() => 'ok' as const, () => 'down' as const)
      .catch(() => 'down' as const);
    if (database === 'down') {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: 'down', service: 'api', checks: { database } };
    }
    const [oldestWaitingJobSeconds, failedJobsLastHour, gatewaysConnected] = await Promise.all([this.jobs.oldestWaitingSeconds(), this.jobs.failedSince(HOUR), this.gateways.connectedCount()]);
    return { status: 'ok', service: 'api', connectors: CONNECTOR_TYPES, checks: { database, oldestWaitingJobSeconds, failedJobsLastHour, gatewaysConnected } };
  }

  @Public()
  @Get('metrics')
  async metrics(@Headers('authorization') authorization: string | undefined, @Res({ passthrough: true }) res: Response) {
    const expected = this.config.METRICS_TOKEN ? Buffer.from(`Bearer ${this.config.METRICS_TOKEN}`) : null;
    const given = Buffer.from(authorization ?? '');
    // Without the token (or with none set) there is no such page.
    if (!expected || given.length !== expected.length || !timingSafeEqual(given, expected)) throw new NotFoundException();
    const [counts, oldest, failed, gateways] = await Promise.all([this.jobs.counts(), this.jobs.oldestWaitingSeconds(), this.jobs.failedSince(HOUR), this.gateways.connectedCount()]);
    res.type('text/plain; version=0.0.4');
    return renderMetrics([
      { name: 'fb_jobs', help: 'Background jobs kept, by state', values: JOB_STATUSES.map((state) => ({ labels: { state }, value: counts[state] ?? 0 })) },
      { name: 'fb_jobs_oldest_waiting_seconds', help: 'How long the oldest due job has waited', values: [{ labels: {}, value: oldest }] },
      { name: 'fb_jobs_failed_last_hour', help: 'Jobs that gave up in the last hour', values: [{ labels: {}, value: failed }] },
      { name: 'fb_gateways_connected', help: 'Gateways connected and heard from lately', values: [{ labels: {}, value: gateways }] },
    ]);
  }
}
