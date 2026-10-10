import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, type HydratedDocument } from 'mongoose';

/** A payment that goes with one response to a form: asked for, paid (or not), and then the response it became. */
@Schema({ collection: 'form_payments', timestamps: true })
export class Payment {
  @Prop({ required: true, unique: true }) id: string;
  @Prop({ required: true, index: true }) orgId: string;
  @Prop({ required: true }) formCode: string;
  /** In the currency's smallest unit (paise, cents), which is how every payment service counts. */
  @Prop({ required: true }) amountMinor: number;
  @Prop({ required: true }) currency: string;
  @Prop({ required: true }) provider: string;
  /** The payment service's own name for it, to ask after and to reconcile by. */
  @Prop({ type: String, default: '' }) providerRef: string;
  /** PENDING: asked for. PAID: the money arrived but the response is not registered yet. SUBMITTED: both. */
  @Prop({ required: true, enum: ['PENDING', 'PAID', 'SUBMITTED', 'FAILED'], default: 'PENDING' }) status: 'PENDING' | 'PAID' | 'SUBMITTED' | 'FAILED';
  /** The answers, held while the person is away paying. Removed once the response is registered. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null }) held: Record<string, unknown> | null;
  /** The signed-in person it belongs to, for forms that need one. */
  @Prop({ type: String, default: '' }) userId: string;
  @Prop({ type: String, default: '' }) submissionId: string;
  @Prop({ type: String, default: '' }) ref: string;
  @Prop({ type: Date, default: null }) paidAt: Date | null;
  /** What the practice service was told to answer (the TEST provider only). */
  @Prop({ type: String, default: '' }) testOutcome: string;
  /** An unpaid request, and the answers held with it, are removed at this time. Cleared once paid. */
  @Prop({ type: Date, default: null }) purgeAt: Date | null;
  createdAt?: Date;
}
export type PaymentDocument = HydratedDocument<Payment>;
export const PaymentSchema = SchemaFactory.createForClass(Payment);
PaymentSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
