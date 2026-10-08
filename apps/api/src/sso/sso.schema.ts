import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

/** One sign-in attempt in flight (state + PKCE verifier), single use, ten minutes. */
@Schema({ collection: 'sso_states' })
export class SsoState {
  @Prop({ required: true, unique: true }) stateHash: string;
  @Prop({ required: true }) orgId: string;
  /** Hash of the cookie set on the browser that started the attempt. */
  @Prop({ required: true }) browserHash: string;
  /** SecretBox-sealed PKCE verifier. */
  @Prop({ required: true }) verifier: string;
  @Prop({ required: true }) expiresAt: Date;
}
export type SsoStateDocument = HydratedDocument<SsoState>;
export const SsoStateSchema = SchemaFactory.createForClass(SsoState);
SsoStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
