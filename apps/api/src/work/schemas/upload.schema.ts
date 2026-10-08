/* Ported from Sangam form-master.schema.ts: upload records and rate-limit counters. */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ timestamps: true, collection: 'form_uploads' })
export class FormUpload {
  @Prop({ required: true, type: String })
  uuid: string;

  @Prop({ required: true, type: String })
  orgId: string;

  @Prop({ required: true, type: String })
  formCode: string;

  @Prop({ required: true, type: String })
  fieldName: string;

  @Prop({ required: true, type: String })
  key: string;

  @Prop({ required: true, type: String })
  name: string;

  @Prop({ type: Number, default: 0 })
  size: number;

  /** Declared by the browser, then confirmed from the bytes on verify. */
  @Prop({ type: String, default: '' })
  contentType: string;

  /** The field's accept list at presign time - the real type must satisfy it. */
  @Prop({ type: [String], default: [] })
  accept: string[];

  @Prop({ type: String, enum: ['PENDING', 'VERIFIED', 'REJECTED', 'ATTACHED'], default: 'PENDING' })
  status: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'ATTACHED';

  /** Which scanner cleared the file (`none` when no scanner is configured). */
  @Prop({ type: String, default: '' })
  scannedBy: string;

  /** Unattached uploads expire; an S3 lifecycle rule on the `pending/` prefix removes their objects. */
  @Prop({ type: Date, required: true })
  expiresAt: Date;
}
export type FormUploadDocument = HydratedDocument<FormUpload>;
export const FormUploadSchema = SchemaFactory.createForClass(FormUpload);
FormUploadSchema.index({ uuid: 1 }, { unique: true });
FormUploadSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, partialFilterExpression: { status: { $ne: 'ATTACHED' } } });

/** Throttler counters shared by every API instance (EC2 + Hostinger). */
@Schema({ collection: 'form_rate_limits' })
export class FormRateLimit {
  @Prop({ required: true, type: String })
  key: string;

  @Prop({ type: Number, default: 0 })
  totalHits: number;

  @Prop({ type: Date, required: true })
  expiresAt: Date;

  @Prop({ type: Date, default: null })
  blockExpiresAt: Date | null;

  /** TTL anchor: the later of expiresAt / blockExpiresAt. */
  @Prop({ type: Date, required: true })
  purgeAt: Date;
}
export type FormRateLimitDocument = HydratedDocument<FormRateLimit>;
export const FormRateLimitSchema = SchemaFactory.createForClass(FormRateLimit);
FormRateLimitSchema.index({ key: 1 }, { unique: true });
FormRateLimitSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
