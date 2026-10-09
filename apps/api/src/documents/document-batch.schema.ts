import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

/** A request to make many documents at once from supplied data; the worker makes them one job each. */
@Schema({ timestamps: true, collection: 'document_batches' })
export class DocumentBatch {
  @Prop({ required: true, unique: true }) id: string;
  @Prop({ required: true }) orgId: string;
  /** The form version whose layout and settings the documents follow. */
  @Prop({ required: true }) formId: string;
  @Prop({ required: true }) formCode: string;
  @Prop({ required: true }) total: number;
  @Prop({ type: Number, default: 0 }) done: number;
  @Prop({ type: Number, default: 0 }) failed: number;
  @Prop({ required: true }) createdBy: string;
  createdAt: Date;
}
export type DocumentBatchDocument = HydratedDocument<DocumentBatch>;
export const DocumentBatchSchema = SchemaFactory.createForClass(DocumentBatch);
DocumentBatchSchema.index({ orgId: 1, createdAt: -1 });
