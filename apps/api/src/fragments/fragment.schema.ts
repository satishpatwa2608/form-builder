import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, type HydratedDocument } from 'mongoose';

/** A section of fields in the organisation's library, for several forms to use (see the engine's fragments.ts). */
@Schema({ timestamps: true, collection: 'fragments' })
export class FragmentRow {
  @Prop({ required: true, unique: true }) id: string;
  @Prop({ required: true }) orgId: string;
  @Prop({ required: true }) name: string;
  @Prop({ type: String, default: '' }) description: string;
  @Prop({ type: MongooseSchema.Types.Mixed, default: [] }) fields: unknown[];
  @Prop({ required: true }) updatedBy: string;
  updatedAt: Date;
}
export type FragmentDocument = HydratedDocument<FragmentRow>;
export const FragmentSchema = SchemaFactory.createForClass(FragmentRow);
FragmentSchema.index({ orgId: 1, name: 1 });
