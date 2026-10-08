import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

@Schema({ timestamps: true, collection: 'users' })
export class User {
  @Prop({ required: true, unique: true }) id: string;
  /** Lower-cased. */
  @Prop({ required: true, unique: true }) email: string;
  @Prop({ required: true }) name: string;
  /** argon2id. */
  @Prop({ required: true }) passwordHash: string;
  @Prop({ type: Date, default: null }) emailVerifiedAt: Date | null;
  @Prop({ type: Number, default: 0 }) failedLogins: number;
  @Prop({ type: Date, default: null }) lockedUntil: Date | null;
  /** Sealed (SecretBox) TOTP secret while being set up / once enabled. */
  @Prop({ type: String, default: '' }) totpSecret: string;
  @Prop({ type: Date, default: null }) totpEnabledAt: Date | null;
  /** Last accepted TOTP step: the same code can't be used twice. */
  @Prop({ type: Number, default: 0 }) totpLastStep: number;
  /** SHA-256 of unused recovery codes. */
  @Prop({ type: [String], default: [] }) recoveryCodes: string[];
  @Prop({ type: Date, default: null }) passwordChangedAt: Date | null;
}
export type UserDocument = HydratedDocument<User>;
export const UserSchema = SchemaFactory.createForClass(User);

/** One signed-in device. The refresh token rotates on every use; a reused old token revokes the session. */
@Schema({ timestamps: true, collection: 'sessions' })
export class Session {
  @Prop({ required: true, unique: true }) id: string;
  @Prop({ required: true, index: true }) userId: string;
  /** The org this session is working in (switchable). */
  @Prop({ required: true }) orgId: string;
  @Prop({ required: true, unique: true }) refreshHash: string;
  /** Recent refresh hashes, to spot a stolen token being replayed. */
  @Prop({ type: [String], default: [] }) previousHashes: string[];
  /** A second factor was verified when this session signed in. */
  @Prop({ type: Boolean, default: false }) mfa: boolean;
  /** Set when the session came from an org's single sign-on: it is good for that org only. */
  @Prop({ type: String, default: '' }) ssoOrgId: string;
  @Prop({ required: true }) expiresAt: Date;
  @Prop({ type: Date, default: null }) revokedAt: Date | null;
  @Prop({ type: String, default: '' }) ip: string;
  @Prop({ type: String, default: '' }) userAgent: string;
}
export type SessionDocument = HydratedDocument<Session>;
export const SessionSchema = SchemaFactory.createForClass(Session);
SessionSchema.index({ previousHashes: 1 });

/** Single-use links sent by email: verify the address, reset the password. */
@Schema({ timestamps: true, collection: 'auth_tokens' })
export class AuthToken {
  @Prop({ required: true, unique: true }) id: string;
  @Prop({ required: true, index: true }) userId: string;
  @Prop({ required: true, enum: ['VERIFY_EMAIL', 'RESET_PASSWORD'] }) kind: 'VERIFY_EMAIL' | 'RESET_PASSWORD';
  @Prop({ required: true, unique: true }) tokenHash: string;
  @Prop({ required: true }) expiresAt: Date;
  @Prop({ type: Date, default: null }) usedAt: Date | null;
}
export type AuthTokenDocument = HydratedDocument<AuthToken>;
export const AuthTokenSchema = SchemaFactory.createForClass(AuthToken);
