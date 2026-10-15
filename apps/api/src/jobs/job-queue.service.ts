import { AsyncLocalStorage } from 'node:async_hooks';
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
  /**
   * Aborted when this worker no longer holds the job (its lease was taken over, say after a long pause). What it
   * does from then on is not recorded; a handler with several steps checks it between them (see stillHeld).
   */
  signal: AbortSignal;
}

/** Thrown by stillHeld() when the job has gone to another worker. */
export class LeaseLostError extends Error {
  constructor(id: string) {
    super(`job ${id} was taken over by another worker`);
  }
}

const running = new AsyncLocalStorage<JobContext>();

/** The job this code is running in, if any. */
export const currentJob = (): JobContext | undefined => running.getStore();

/** Throws when the job this code runs in has gone to another worker, so it starts nothing more. */
export function stillHeld(): void {
  const job = running.getStore();
  if (job?.signal.aborted) throw new LeaseLostError(job.id);
}

type Handler = (payload: any, job: JobContext) => Promise<void>;

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
 *
 * Each taking of a job has its own lease. The worker renews it while the handler runs, so a job longer than the
 * lease is not taken by a second worker; and a worker that lost it (paused past the lease, say) cannot write
 * the job's result over the new holder's, and its handler is told through JobContext.signal.
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
    // Tests run jobs as they are queued (see enqueue) and call drain() for retries, unless told to poll.
    const poll = this.config.JOBS_POLL ? this.config.JOBS_POLL === 'true' : this.config.NODE_ENV !== 'test';
    if (!this.runsJobs || !poll) return;
    this.timer = setInterval(() => void this.drain().catch((e) => this.logger.error(`job poll failed: ${(e as Error).message}`)), POLL_MS);
    this.timer.unref?.();
  }

  async onModuleDestroy() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.draining?.catch(() => undefined);
  }

  private get leaseMs(): number {
    return this.config.JOBS_LEASE_MS;
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
        { $set: { status: 'RUNNING', lockedUntil: new Date(now.getTime() + this.leaseMs), lease: uuidv4() }, $inc: { attempts: 1 } },
        { sort: { runAt: 1 }, new: true },
      )
      .lean();
  }

  private async execute(job: Job) {
    const handler = this.handlers.get(job.type)!;
    const held = { uuid: job.uuid, status: 'RUNNING', lease: job.lease };
    const finished = async (set: Record<string, unknown>) => {
      const res = await this.jobs.updateOne(held, { $set: set, $unset: { lockedUntil: 1, lease: 1 } });
      if (!res.matchedCount) this.logger.warn(`job ${job.type} ${job.uuid}: another worker holds it now, so this one's result is not written`);
    };
    const giveUp = (error: string) => {
      this.logger.error(`job ${job.type} ${job.uuid} failed for good after ${job.attempts} attempts: ${error}`);
      return finished({ status: 'FAILED', lastError: error, expireAt: new Date(Date.now() + KEEP_FAILED_MS) });
    };
    // Taken over from a dead worker once too often.
    if (job.attempts > job.maxAttempts) return giveUp(job.lastError || 'its worker stopped before finishing');

    // Renew the lease while the handler runs; when it cannot be renewed, someone else has the job.
    const lost = new AbortController();
    const renew = async () => {
      const res = await this.jobs.updateOne(held, { $set: { lockedUntil: new Date(Date.now() + this.leaseMs) } }).catch(() => undefined);
      if (res && !res.matchedCount && !lost.signal.aborted) {
        this.logger.warn(`job ${job.type} ${job.uuid} was taken over by another worker; stopping it here`);
        lost.abort();
      }
    };
    const beat = setInterval(() => void renew(), Math.max(Math.floor(this.leaseMs / 3), 20));
    beat.unref?.();
    const context: JobContext = { id: job.uuid, attempt: job.attempts, signal: lost.signal };
    try {
      await running.run(context, () => handler.run(job.payload, context));
      clearInterval(beat);
      if (lost.signal.aborted) return;
      await finished({ status: 'DONE', lastError: '', expireAt: new Date(Date.now() + KEEP_DONE_MS) });
    } catch (e) {
      clearInterval(beat);
      // The new holder runs it; this attempt is neither a success nor a failure of the job.
      if (lost.signal.aborted) return;
      const error = ((e as Error).message ?? 'failed').slice(0, 500);
      if (job.attempts >= job.maxAttempts) return giveUp(error);
      this.logger.warn(`job ${job.type} ${job.uuid} attempt ${job.attempts} failed, will retry: ${error}`);
      await finished({ status: 'PENDING', lastError: error, runAt: new Date(Date.now() + retryDelayMs(job.attempts)) });
    }
  }

  /** A job that failed for good, started again from its first attempt. False when there is no such job of that organisation's. */
  async retry(uuid: string, orgId: string): Promise<boolean> {
    const res = await this.jobs.updateOne({ uuid, orgId, status: 'FAILED' }, { $set: { status: 'PENDING', attempts: 0, runAt: new Date() }, $unset: { expireAt: 1 } });
    if (!res.modifiedCount) return false;
    if (this.runsJobs && !this.closed) setImmediate(() => void this.drain().catch((err) => this.logger.error(`job run failed: ${(err as Error).message}`)));
    return true;
  }

  /** What failed for good lately, newest first. */
  async failed(orgId: string, since: Date, limit = 50) {
    return this.jobs.find({ orgId, status: 'FAILED', updatedAt: { $gte: since } }).sort({ updatedAt: -1 }).limit(limit).select('uuid type payload attempts lastError updatedAt').lean<(Job & { updatedAt: Date })[]>();
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
