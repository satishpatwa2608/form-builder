import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

/** An in-app notification (the studio's bell). */
@Schema({ collection: 'notifications', timestamps: { createdAt: true, updatedAt: false } })
export class Notification {
  @Prop({ required: true, unique: true }) id: string;
  @Prop({ required: true }) orgId: string;
  @Prop({ required: true }) userId: string;
  @Prop({ required: true }) message: string;
  @Prop({ type: String, default: '' }) recordId: string;
  @Prop({ type: String, default: '' }) ref: string;
  @Prop({ type: String, default: '' }) formName: string;
  @Prop({ type: Date, default: null }) readAt: Date | null;
  createdAt: Date;
}
export type NotificationDocument = HydratedDocument<Notification>;
export const NotificationSchema = SchemaFactory.createForClass(Notification);
NotificationSchema.index({ orgId: 1, userId: 1, createdAt: -1 });
