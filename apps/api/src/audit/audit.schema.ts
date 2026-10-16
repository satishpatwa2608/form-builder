import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, type HydratedDocument } from 'mongoose';

/**
 * Append-only. The model refuses updates and deletes (hooks below); in
 * production the app's database user also gets insert/find rights only on
 * this collection.
 */
@Schema({ collection: 'audit_log', timestamps: { createdAt: 'at', updatedAt: false } })
export class AuditEntry {
  @Prop({ required: true, unique: true }) id: string;
  /** '' for events before an org is known (e.g. a failed sign-in). */
  @Prop({ type: String, default: '', index: true }) orgId: string;
  @Prop({ type: String, default: '' }) actorId: string;
  @Prop({ required: true }) action: string;
  @Prop({ type: String, default: '' }) targetType: string;
  @Prop({ type: String, default: '' }) targetId: string;
  /** Changed values, with secrets never included. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null }) before: Record<string, unknown> | null;
  @Prop({ type: MongooseSchema.Types.Mixed, default: null }) after: Record<string, unknown> | null;
  @Prop({ type: String, default: '' }) ip: string;
  @Prop({ type: String, default: '' }) userAgent: string;
  at: Date;
}
export type AuditEntryDocument = HydratedDocument<AuditEntry>;
export const AuditEntrySchema = SchemaFactory.createForClass(AuditEntry);
AuditEntrySchema.index({ orgId: 1, at: -1 });
// Who did what is kept for a year (it holds no answers), whatever happens to the records it speaks of.
AuditEntrySchema.index({ at: 1 }, { expireAfterSeconds: 365 * 86_400 });

const refuse = () => {
  throw new Error('The audit log is append-only');
};
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete', 'findOneAndReplace'] as const) {
  AuditEntrySchema.pre(op, refuse);
}
AuditEntrySchema.pre('save', function (next) {
  if (!this.isNew) return next(new Error('The audit log is append-only'));
  next();
});
