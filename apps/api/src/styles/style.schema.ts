import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, type HydratedDocument } from 'mongoose';

/** A reusable look (colours, borders, spacing) forms and fields refer to by key. Ported from Sangam's style master. */
@Schema({ timestamps: true, collection: 'styles' })
export class Style {
  @Prop({ required: true }) orgId: string;
  /** What definitions reference (`styleId`). */
  @Prop({ required: true }) key: string;
  @Prop({ required: true }) name: string;
  @Prop({ type: String, default: '' }) description: string;
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} }) props: Record<string, unknown>;
}
export type StyleDocument = HydratedDocument<Style>;
export const StyleSchema = SchemaFactory.createForClass(Style);
StyleSchema.index({ orgId: 1, key: 1 }, { unique: true });
