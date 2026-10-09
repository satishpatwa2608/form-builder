import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

/**
 * What lets a requester into the portal: first a link sent to their email
 * (used once), then the session that link is exchanged for. Only the hash of
 * either is kept.
 */
@Schema({ collection: 'portal_passes', timestamps: true })
export class PortalPass {
  @Prop({ required: true, unique: true }) tokenHash: string;
  @Prop({ required: true }) orgId: string;
  /** Lower-case. */
  @Prop({ required: true }) email: string;
  @Prop({ required: true, enum: ['LINK', 'SESSION'] }) kind: 'LINK' | 'SESSION';
  @Prop({ required: true }) expiresAt: Date;
  createdAt?: Date;
}
export type PortalPassDocument = HydratedDocument<PortalPass>;
export const PortalPassSchema = SchemaFactory.createForClass(PortalPass);
// Gone from the database soon after it stops working.
PortalPassSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });
PortalPassSchema.index({ orgId: 1, email: 1, kind: 1, createdAt: -1 });
