import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

/** A gateway agent in a customer's network. Only hashes of its tokens are stored. */
@Schema({ timestamps: true, collection: 'gateways' })
export class Gateway {
  @Prop({ required: true, unique: true }) id: string;
  @Prop({ required: true, index: true }) orgId: string;
  @Prop({ required: true }) name: string;
  /** One-time registration token (hash), until the agent registers. */
  @Prop({ type: String, default: '' }) registrationHash: string;
  @Prop({ type: Date, default: null }) registrationExpiresAt: Date | null;
  /** The agent's long-lived secret (hash). */
  @Prop({ type: String, default: '', index: true }) secretHash: string;
  @Prop({ type: Date, default: null }) registeredAt: Date | null;
  @Prop({ type: Date, default: null }) lastSeenAt: Date | null;
  @Prop({ type: String, default: '' }) version: string;
  @Prop({ type: Date, default: null }) revokedAt: Date | null;
  @Prop({ required: true }) createdBy: string;
}
export type GatewayDocument = HydratedDocument<Gateway>;
export const GatewaySchema = SchemaFactory.createForClass(Gateway);
