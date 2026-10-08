import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { FormRateLimit, FormRateLimitDocument } from '../schemas/upload.schema';

/**
 * @nestjs/throttler storage backed by MongoDB so every API instance (EC2 and
 * Hostinger) counts against the same limits. Fixed window per key; counters
 * self-delete via a TTL index. (Redis is the usual store; this keeps the stack to MongoDB.)
 */
@Injectable()
export class MongoThrottlerStorage implements ThrottlerStorage {
  constructor(@InjectModel(FormRateLimit.name) private readonly model: Model<FormRateLimitDocument>) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number): Promise<ThrottlerStorageRecord> {
    const now = Date.now();

    // Count within the live window; if none, start a new one.
    let doc = await this.model
      .findOneAndUpdate({ key, expiresAt: { $gt: new Date(now) } }, { $inc: { totalHits: 1 } }, { new: true })
      .lean();
    if (!doc) {
      const expiresAt = new Date(now + ttl);
      doc = await this.model
        .findOneAndUpdate(
          { key },
          { $set: { totalHits: 1, expiresAt, blockExpiresAt: null, purgeAt: expiresAt } },
          { upsert: true, new: true },
        )
        .lean();
    }

    let blockExpiresAt = doc.blockExpiresAt ? new Date(doc.blockExpiresAt).getTime() : 0;
    if (doc.totalHits > limit && blockExpiresAt <= now) {
      blockExpiresAt = now + blockDuration;
      const purgeAt = new Date(Math.max(new Date(doc.expiresAt).getTime(), blockExpiresAt));
      await this.model.updateOne({ key }, { $set: { blockExpiresAt: new Date(blockExpiresAt), purgeAt } });
    }

    return {
      totalHits: doc.totalHits,
      timeToExpire: Math.max(0, Math.ceil((new Date(doc.expiresAt).getTime() - now) / 1000)),
      isBlocked: blockExpiresAt > now,
      timeToBlockExpire: Math.max(0, Math.ceil((blockExpiresAt - now) / 1000)),
    };
  }
}
