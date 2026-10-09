import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, type HydratedDocument } from 'mongoose';

/**
 * One organisation's custom code: a service written against @fb/sdk, running
 * in its own container on our private network. An operator installs it (the
 * address is ours to decide, never the customer's); the organisation's admins
 * see what it offers.
 */
@Schema({ timestamps: true, collection: 'extensions' })
export class ExtensionRow {
  @Prop({ required: true, unique: true }) id: string;
  @Prop({ required: true }) orgId: string;
  /** Short handle used in the keys forms store: x-<ref>-<step>, /extensions/<ref>/<list>. */
  @Prop({ required: true }) ref: string;
  /** Where the container answers, e.g. http://acme-ext.internal:8080 (origin only). */
  @Prop({ required: true }) url: string;
  /** The signing secret, sealed with a data key of its own. */
  @Prop({ required: true }) sealedSecret: string;
  @Prop({ required: true }) wrappedKey: string;
  /** What it said it offers, the last time it was asked. */
  @Prop({ type: String, default: '' }) name: string;
  @Prop({ type: MongooseSchema.Types.Mixed, default: [] }) steps: unknown[];
  @Prop({ type: MongooseSchema.Types.Mixed, default: [] }) lists: unknown[];
  @Prop({ type: MongooseSchema.Types.Mixed, default: [] }) checks: unknown[];
  /** NEW until it has answered once. */
  @Prop({ type: String, default: 'NEW' }) status: 'NEW' | 'OK' | 'UNREACHABLE';
  @Prop({ type: Date, default: null }) lastSyncedAt: Date | null;
  @Prop({ type: String, default: '' }) lastError: string;
  @Prop({ type: Boolean, default: false }) isDeleted: boolean;
  createdAt: Date;
}
export type ExtensionDocument = HydratedDocument<ExtensionRow>;
export const ExtensionSchema = SchemaFactory.createForClass(ExtensionRow);
ExtensionSchema.index({ orgId: 1, ref: 1 }, { unique: true });
