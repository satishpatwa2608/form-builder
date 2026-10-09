import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, type HydratedDocument } from 'mongoose';

/** A workflow in the organisation's library, for several forms to use (see the engine's shared-workflow.ts). */
@Schema({ timestamps: true, collection: 'shared_workflows' })
export class SharedWorkflowRow {
  @Prop({ required: true, unique: true }) id: string;
  @Prop({ required: true }) orgId: string;
  @Prop({ required: true }) name: string;
  @Prop({ type: String, default: '' }) description: string;
  @Prop({ type: MongooseSchema.Types.Mixed, required: true }) workflow: Record<string, unknown>;
  @Prop({ type: MongooseSchema.Types.Mixed, default: [] }) automations: unknown[];
  /** The answers it reads from whichever form uses it. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: [] }) fields: unknown[];
  @Prop({ required: true }) updatedBy: string;
  updatedAt: Date;
}
export type SharedWorkflowDocument = HydratedDocument<SharedWorkflowRow>;
export const SharedWorkflowSchema = SchemaFactory.createForClass(SharedWorkflowRow);
SharedWorkflowSchema.index({ orgId: 1, name: 1 });
