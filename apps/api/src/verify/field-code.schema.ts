import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

/** A one-time code sent to an email address or phone number typed into a form. Only hashes are kept; it deletes itself. */
@Schema({ collection: 'form_field_codes', timestamps: true })
export class FieldCode {
  @Prop({ required: true }) orgId: string;
  @Prop({ required: true }) formCode: string;
  @Prop({ required: true }) field: string;
  /** Of the address or number the code went to. */
  @Prop({ required: true, index: true }) valueHash: string;
  @Prop({ required: true }) codeHash: string;
  @Prop({ required: true, default: 0 }) attempts: number;
  @Prop({ required: true }) expiresAt: Date;
  createdAt?: Date;
}
export type FieldCodeDocument = HydratedDocument<FieldCode>;
export const FieldCodeSchema = SchemaFactory.createForClass(FieldCode);
// Kept for an hour after it was sent, so "how many were sent lately" can be counted; then gone.
FieldCodeSchema.index({ createdAt: 1 }, { expireAfterSeconds: 3600 });
