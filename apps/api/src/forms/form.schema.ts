import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, type HydratedDocument } from 'mongoose';

export type FormStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

/**
 * One version of one form (ported from Sangam's form_versions). `definition`
 * is the engine's FormDefinition JSON; top-level fields are copies for
 * queries. Versions of a form share `code` within an org and live in one folder.
 */
@Schema({ timestamps: true, collection: 'forms', minimize: false })
export class Form {
  @Prop({ required: true, unique: true }) id: string;
  @Prop({ required: true }) orgId: string;
  @Prop({ required: true }) folderId: string;
  @Prop({ required: true }) code: string;
  @Prop({ required: true }) version: number;
  @Prop({ required: true, enum: ['DRAFT', 'PUBLISHED', 'ARCHIVED'] }) status: FormStatus;
  @Prop({ type: String, default: '' }) name: string;
  @Prop({ type: MongooseSchema.Types.Mixed, required: true }) definition: Record<string, unknown>;
  @Prop({ required: true }) createdBy: string;
  @Prop({ required: true }) updatedBy: string;
  @Prop({ type: Date, default: null }) publishedAt: Date | null;
  @Prop({ type: String, default: '' }) publishedBy: string;
  /** A draft set to publish itself at this time. */
  @Prop({ type: Date, default: null }) publishAt: Date | null;
  /** Who scheduled it: the publish runs with that person's rights at the time. */
  @Prop({ type: String, default: '' }) scheduledBy: string;
  /** Why the last scheduled publish did not happen. */
  @Prop({ type: String, default: '' }) scheduleError: string;
  @Prop({ type: Boolean, default: false }) isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}
export type FormDocument = HydratedDocument<Form>;
export const FormSchema = SchemaFactory.createForClass(Form);
// Deleted drafts don't block reusing a code.
FormSchema.index({ orgId: 1, code: 1, version: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } });
FormSchema.index({ orgId: 1, folderId: 1, isDeleted: 1 });
