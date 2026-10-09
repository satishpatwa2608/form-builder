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
  /** The API process holding its connection right now ('' when none does). Calls from other processes are passed to it. */
  @Prop({ type: String, default: '' }) instanceId: string;
  @Prop({ type: Date, default: null }) revokedAt: Date | null;
  @Prop({ required: true }) createdBy: string;
}
export type GatewayDocument = HydratedDocument<Gateway>;
export const GatewaySchema = SchemaFactory.createForClass(Gateway);

/**
 * A call to a gateway made on a process that does not hold its connection
 * (another API server, or the worker). The process that does hold it picks
 * the call up, runs it and writes the answer back. Short-lived: removed when
 * answered, and by the database itself after a few minutes otherwise.
 */
// minimize off: an empty object in a request (no filters) must arrive as one, not be dropped on the way.
@Schema({ collection: 'gateway_calls', minimize: false })
export class GatewayCall {
  @Prop({ required: true, unique: true }) id: string;
  @Prop({ required: true }) orgId: string;
  @Prop({ required: true, index: true }) gatewayId: string;
  @Prop({ type: Object, required: true }) request: Record<string, unknown>;
  @Prop({ required: true, default: 'PENDING' }) status: 'PENDING' | 'RUNNING' | 'DONE';
  @Prop({ type: Object, default: null }) response: Record<string, unknown> | null;
  @Prop({ type: Date, default: () => new Date(), expires: 300 }) createdAt: Date;
}
export type GatewayCallDocument = HydratedDocument<GatewayCall>;
export const GatewayCallSchema = SchemaFactory.createForClass(GatewayCall);
