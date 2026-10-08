import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, type HydratedDocument } from 'mongoose';

/**
 * "Save and continue later" on a public form. Found only by a random token
 * (stored hashed) that the respondent keeps; gone after DRAFT_TTL_DAYS or
 * once submitted.
 */
@Schema({ collection: 'form_drafts', timestamps: true, minimize: false })
export class FormDraft {
  @Prop({ required: true, unique: true }) tokenHash: string;
  @Prop({ required: true }) orgId: string;
  @Prop({ required: true }) code: string;
  /** Set for sign-in-only forms: only that person can resume. */
  @Prop({ type: String, default: '' }) userId: string;
  @Prop({ type: MongooseSchema.Types.Mixed, required: true }) values: Record<string, unknown>;
  @Prop({ required: true }) expiresAt: Date;
  updatedAt: Date;
}
export type FormDraftDocument = HydratedDocument<FormDraft>;
export const FormDraftSchema = SchemaFactory.createForClass(FormDraft);
FormDraftSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
