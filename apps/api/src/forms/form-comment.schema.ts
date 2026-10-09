import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

/** A remark on a draft, about the whole form or one of its fields, made while it is being prepared or reviewed. */
@Schema({ timestamps: true, collection: 'form_comments' })
export class FormComment {
  @Prop({ required: true, unique: true }) id: string;
  @Prop({ required: true }) orgId: string;
  /** The draft (one version of one form) it was made on. */
  @Prop({ required: true }) formId: string;
  /** The field it is about; empty for the form as a whole. */
  @Prop({ type: String, default: '' }) fieldId: string;
  /** What the field was called at the time, in case it is renamed or removed later. */
  @Prop({ type: String, default: '' }) fieldLabel: string;
  @Prop({ required: true }) text: string;
  @Prop({ required: true }) authorId: string;
  @Prop({ type: Date, default: null }) resolvedAt: Date | null;
  @Prop({ type: String, default: '' }) resolvedBy: string;
  createdAt: Date;
}
export type FormCommentDocument = HydratedDocument<FormComment>;
export const FormCommentSchema = SchemaFactory.createForClass(FormComment);
FormCommentSchema.index({ orgId: 1, formId: 1, createdAt: 1 });
