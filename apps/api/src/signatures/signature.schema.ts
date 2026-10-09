import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, type HydratedDocument } from 'mongoose';

export type SignerStatus = 'WAITING' | 'SENT' | 'SIGNED' | 'DECLINED';

/** One person asked to sign. Who they are is known by the private link they were sent. */
export interface Signer {
  email: string;
  /** SHA-256 of their link's token: the token itself is only ever in their email. */
  tokenHash: string;
  /** WAITING = not their turn yet (signing in order). */
  status: SignerStatus;
  sentAt: Date | null;
  remindedAt: Date | null;
  /** What they gave when signing, and the circumstances, for the audit page. */
  name: string;
  signature: string;
  signedAt: Date | null;
  ip: string;
  userAgent: string;
  declineReason: string;
}

/**
 * A request for one or more people to sign the PDF of a response, made by a
 * workflow's "Send for signature" step. The flow that made it waits until
 * everyone has signed, someone declines, or time runs out.
 */
@Schema({ timestamps: true, collection: 'signature_requests', minimize: false })
export class SignatureRequest {
  @Prop({ required: true, unique: true }) id: string;
  @Prop({ required: true }) orgId: string;
  @Prop({ required: true, index: true }) recordId: string;
  /** The flow run to carry on when this ends, and the step it stopped at. */
  @Prop({ required: true }) runId: string;
  @Prop({ required: true }) stepKey: string;
  @Prop({ required: true }) title: string;
  @Prop({ type: String, default: '' }) message: string;
  @Prop({ type: String, default: 'IN_ORDER' }) order: 'IN_ORDER' | 'PARALLEL';
  @Prop({ required: true, default: 'WAITING' }) status: 'WAITING' | 'SIGNED' | 'DECLINED' | 'EXPIRED';
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] }) signers: Signer[];
  @Prop({ required: true }) expiresAt: Date;
  /** How many rounds of reminders have gone out, and how many may: one every three days, never without end. */
  @Prop({ type: Number, default: 0 }) reminders: number;
  @Prop({ type: Number, default: 0 }) maxReminders: number;
  /** SHA-256 of the PDF that was put in front of the signers. */
  @Prop({ type: String, default: '' }) documentHash: string;
  /** Where the signed PDF is kept, once everyone has signed. */
  @Prop({ type: String, default: '' }) signedKey: string;
  @Prop({ type: Date, default: null }) finishedAt: Date | null;
  createdAt: Date;
}
export type SignatureRequestDocument = HydratedDocument<SignatureRequest>;
export const SignatureRequestSchema = SchemaFactory.createForClass(SignatureRequest);
SignatureRequestSchema.index({ 'signers.tokenHash': 1 });
