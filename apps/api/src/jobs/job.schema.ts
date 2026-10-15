import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export const JOB_STATUSES = ['PENDING', 'RUNNING', 'DONE', 'FAILED'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * One unit of background work (an automation run, a webhook delivery). Stored
 * before it is attempted, so it survives a restart, is retried when it fails
 * and can be picked up by any worker.
 */
@Schema({ collection: 'jobs', timestamps: true })
export class Job {
  @Prop({ required: true, type: String })
  uuid: string;

  @Prop({ required: true, type: String })
  type: string;

  @Prop({ type: String, default: '' })
  orgId: string;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  payload: Record<string, unknown>;

  @Prop({ required: true, type: String, enum: JOB_STATUSES, default: 'PENDING' })
  status: JobStatus;

  /** Times it has been started (a crash mid-run counts). */
  @Prop({ type: Number, default: 0 })
  attempts: number;

  @Prop({ type: Number, default: 3 })
  maxAttempts: number;

  /** Not before this moment: now for new work, later for a retry. */
  @Prop({ required: true, type: Date })
  runAt: Date;

  /** While RUNNING: when another worker may assume this one died and take over. */
  @Prop({ type: Date })
  lockedUntil?: Date;

  /** The request that queued it: its log lines carry the same ID. */
  @Prop({ type: String })
  requestId?: string;

  /** While RUNNING: which taking of the job this is. Only the worker that holds it may renew it or write the result. */
  @Prop({ type: String })
  lease?: string;

  @Prop({ type: String, default: '' })
  lastError: string;

  /** The same key is only ever queued once (e.g. one run per submission). */
  @Prop({ type: String })
  dedupeKey?: string;

  /** Finished jobs are removed by MongoDB at this time. */
  @Prop({ type: Date })
  expireAt?: Date;
}

export type JobDocument = HydratedDocument<Job>;
export const JobSchema = SchemaFactory.createForClass(Job);
JobSchema.index({ uuid: 1 }, { unique: true });
JobSchema.index({ status: 1, runAt: 1 });
JobSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } });
JobSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
