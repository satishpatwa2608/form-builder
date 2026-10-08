import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { newId as uuidv4 } from '../common/crypto';
import { APP_CONFIG, type AppConfig } from '../config';
import { Job, JobDocument } from './job.schema';

export interface JobHandlerOptions {
  /** Starts before the job is given up on. Default 3. */
  maxAttempts?: number;
}

export interface EnqueueOptions {
  orgId?: string;
  /** Queued at most once for this key, however often it is asked for. */
  dedupeKey?: string;
  runAt?: Date;
}

/** What a handler is told about the job it is running. */
export interface JobContext {
  id: string;
  /** 1 on the first try. */
  attempt: number;
}

type Handler = (payload: any, job: JobContext) => Promise<void>;

const LOCK_MS = 5 * 60_000;
const POLL_MS = 1_000;
const CONCURRENCY = 5;
const KEEP_DONE_MS = 7 * 86_400_000;
const KEEP_FAILED_MS = 30 * 86_400_000;

/** 30s, 1m, 2m, 4m ... capped at an hour. */
export const retryDelayMs = (attempt: number) => Math.min(30_000 * 2 ** (attempt - 1), 3_600_000);

/**
 * A job queue kept in MongoDB. The API process stores jobs; whichever process
 * runs them (the worker in production, the API itself in development and
 * tests - see JOBS_ROLE) claims each one with a conditional write, so several
 * workers never run the same job at once. A job is retried with a growing
 * delay when its handler throws or its worker dies, and kept as FAILED once
 * it has used up its attempts.
 *
 * Delivery is at-least-once: a handler may be started again after a crash, so
 * handlers must be safe to repeat.
 */
@Injectable()
export class JobQueue implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobQueue.name);
  private readonly handlers = new Map<string, { run: Handler; maxAttempts: number }>();
  private timer?: NodeJS.Timeout;
  private draining?: Promise<number>;
  private kicked = false;
  private closed = false;

  constructor(
    @InjectModel(Job.name) private readonly jobs: Model<JobDocument>,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Whether this process runs jobs, or only stores them for a worker. */
  get runsJobs(): boolean {
    return this.config.JOBS_ROLE !== 'enqueue';
  }

  async onModuleInit() {
    // The dedupe key relies on its unique index, so nothing may be queued before the indexes exist.
    await this.jobs.init();
    // Tests run jobs as they are queued (see enqueue) and call drain() for retries.
    if (!this.runsJobs || this.config.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.drain().catch((e) => this.logger.error(`job poll failed: ${(e as Error).message}`)), POLL_MS);
    this.timer.unref?.();
  }

  async onModuleDestroy() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.draining?.catch(() => undefined);
  }

  register(type: string, run: Handler, options: JobHandlerOptions = {}) {
    this.handlers.set(type, { run, maxAttempts: options.maxAttempts ?? 3 });
  }

  /** Stores a job. Returns false when one with the same dedupeKey was already queued. */
  async enqueue(type: string, payload: Record<string, unknown>, options: EnqueueOptions = {}): Promise<boolean> {
    try {
      await this.jobs.create({
        uuid: uuidv4(),
        type,
        orgId: options.orgId ?? '',
        payload,
        status: 'PENDING',
        maxAttempts: this.handlers.get(type)?.maxAttempts ?? 3,
        runAt: options.runAt ?? new Date(),
        ...(options.dedupeKey ? { dedupeKey: options.dedupeKey } : {}),
      });
    } catch (e) {
      if ((e as { code?: number }).code === 11000 && options.dedupeKey) return false;
      throw e;
    }
    // Run it straight away when this process is a runner, instead of waiting for the next poll.
    if (this.runsJobs && !this.kicked && !this.closed) {
      this.kicked = true;
      setImmediate(() => {
        this.kicked = false;
        void this.drain().catch((err) => this.logger.error(`job run failed: ${(err as Error).message}`));
      });
    }
    return true;
  }

  /**
   * Runs every job that is due at `now`, including ones queued while it runs.
   * Returns how many were started. One drain at a time per process.
   */
  drain(now?: Date): Promise<number> {
    if (this.draining) return this.draining.then(async (n) => n + (await this.drain(now)));
    const run = (async () => {
      let started = 0;
      const lane = async () => {
        for (;;) {
          if (this.closed) return;
          const job = await this.claim(now ?? new Date());
          if (!job) return;
          started++;
          await this.execute(job);
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, lane));
      return started;
    })();
    this.draining = run.finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  /** The oldest due job this process has a handler for, marked as ours. */
  private async claim(now: Date): Promise<Job | null> {
    return this.jobs
      .findOneAndUpdate(
        {
          type: { $in: [...this.handlers.keys()] },
          $or: [
            { status: 'PENDING', runAt: { $lte: now } },
            // Its worker stopped without finishing: take it over.
            { status: 'RUNNING', lockedUntil: { $lte: now } },
          ],
        },
        { $set: { status: 'RUNNING', lockedUntil: new Date(now.getTime() + LOCK_MS) }, $inc: { attempts: 1 } },
        { sort: { runAt: 1 }, new: true },
      )
      .lean();
  }

  private async execute(job: Job) {
    const handler = this.handlers.get(job.type)!;
    const finished = (set: Record<string, unknown>) =>
      this.jobs.updateOne({ uuid: job.uuid, status: 'RUNNING' }, { $set: set, $unset: { lockedUntil: 1 } });
    const giveUp = (error: string) => {
      this.logger.error(`job ${job.type} ${job.uuid} failed for good after ${job.attempts} attempts: ${error}`);
      return finished({ status: 'FAILED', lastError: error, expireAt: new Date(Date.now() + KEEP_FAILED_MS) });
    };
    // Taken over from a dead worker once too often.
    if (job.attempts > job.maxAttempts) return giveUp(job.lastError || 'its worker stopped before finishing');
    try {
      await handler.run(job.payload, { id: job.uuid, attempt: job.attempts });
      await finished({ status: 'DONE', lastError: '', expireAt: new Date(Date.now() + KEEP_DONE_MS) });
    } catch (e) {
      const error = ((e as Error).message ?? 'failed').slice(0, 500);
      if (job.attempts >= job.maxAttempts) return giveUp(error);
      this.logger.warn(`job ${job.type} ${job.uuid} attempt ${job.attempts} failed, will retry: ${error}`);
      await finished({ status: 'PENDING', lastError: error, runAt: new Date(Date.now() + retryDelayMs(job.attempts)) });
    }
  }

  /** Counts by status, for the health page and tests. */
  async counts(orgId?: string): Promise<Record<string, number>> {
    const rows = await this.jobs.aggregate<{ _id: string; n: number }>([
      { $match: orgId ? { orgId } : {} },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]);
    return Object.fromEntries(rows.map((r) => [r._id, r.n]));
  }
}
