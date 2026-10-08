import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, type HydratedDocument } from 'mongoose';
import { ORG_ROLES, type OrgRole } from '../access/roles';

@Schema({ _id: false })
export class OrgSecurity {
  /** Everyone must use a second factor to work in this org. */
  @Prop({ type: Boolean, default: false }) require2fa: boolean;
}

/** How public forms look for this org. */
@Schema({ _id: false })
export class OrgBranding {
  /** data:image/(png|jpeg|webp);base64,... - small, stored inline. */
  @Prop({ type: String, default: '' }) logo: string;
  @Prop({ type: String, default: '' }) primaryColor: string;
  /** Needs a plan with removeBranding; re-checked on every read, so a downgrade shows it again. */
  @Prop({ type: Boolean, default: false }) hidePoweredBy: boolean;
}

/** A customer's own host name for its forms (forms.acme.com), proven by a DNS TXT record. */
@Schema({ _id: false })
export class OrgDomain {
  @Prop({ required: true }) host: string;
  @Prop({ required: true }) token: string;
  @Prop({ type: Date, default: null }) verifiedAt: Date | null;
  @Prop({ type: Date, default: () => new Date() }) addedAt: Date;
}

/** Single sign-on through the customer's OpenID Connect provider (Entra ID, Okta, Google Workspace...). */
@Schema({ _id: false })
export class OrgSso {
  @Prop({ type: Boolean, default: false }) enabled: boolean;
  @Prop({ type: String, default: '' }) issuer: string;
  @Prop({ type: String, default: '' }) clientId: string;
  /** SecretBox-sealed. */
  @Prop({ type: String, default: '' }) clientSecret: string;
  /** Email domains this provider vouches for, each proven by a DNS TXT record (lower-case). Only these can sign in through it. */
  @Prop({ type: [String], default: [] }) domains: string[];
  /** Domains added but not yet proven: { domain, token }. */
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] }) pendingDomains: { domain: string; token: string }[];
  /** Create membership (and the user) on first sign-in. */
  @Prop({ type: Boolean, default: false }) autoProvision: boolean;
  @Prop({ type: String, default: 'VIEWER' }) defaultRole: string;
  /** People with these email domains must use SSO (password sign-in refused). */
  @Prop({ type: Boolean, default: false }) enforce: boolean;
  /** Set by a successful SSO sign-in; enforcing needs one, so a broken setup can't lock everyone out. */
  @Prop({ type: Date, default: null }) lastSuccessAt: Date | null;
}

@Schema({ timestamps: true, collection: 'organizations' })
export class Organization {
  @Prop({ required: true, unique: true }) id: string;
  @Prop({ required: true }) name: string;
  @Prop({ type: OrgSecurity, default: () => ({}) }) security: OrgSecurity;
  /** Set by billing or an operator; empty = DEFAULT_PLAN. */
  @Prop({ type: String, default: '' }) plan: string;
  @Prop({ type: Date, default: null }) planChangedAt: Date | null;
  @Prop({ type: OrgBranding, default: () => ({}) }) branding: OrgBranding;
  @Prop({ type: [OrgDomain], default: [] }) domains: OrgDomain[];
  @Prop({ type: OrgSso, default: () => ({}) }) sso: OrgSso;
}
export type OrganizationDocument = HydratedDocument<Organization>;
export const OrganizationSchema = SchemaFactory.createForClass(Organization);
OrganizationSchema.index({ 'domains.host': 1 });
OrganizationSchema.index({ 'sso.domains': 1 });

@Schema({ timestamps: true, collection: 'memberships' })
export class Membership {
  @Prop({ required: true, unique: true }) id: string;
  @Prop({ required: true }) orgId: string;
  @Prop({ required: true, index: true }) userId: string;
  @Prop({ required: true, enum: ORG_ROLES }) role: OrgRole;
  @Prop({ required: true, enum: ['ACTIVE', 'DISABLED', 'REMOVED'], default: 'ACTIVE' }) status: 'ACTIVE' | 'DISABLED' | 'REMOVED';
  /** Optional: form teams can be whole departments. */
  @Prop({ type: String, default: '' }) department: string;
  /** Optional: who "the assignee's manager" is for approvals and escalations. */
  @Prop({ type: String, default: '' }) managerId: string;
}
export type MembershipDocument = HydratedDocument<Membership>;
export const MembershipSchema = SchemaFactory.createForClass(Membership);
MembershipSchema.index({ orgId: 1, userId: 1 }, { unique: true });

@Schema({ timestamps: true, collection: 'invitations' })
export class Invitation {
  @Prop({ required: true, unique: true }) id: string;
  @Prop({ required: true, index: true }) orgId: string;
  @Prop({ required: true }) email: string;
  @Prop({ required: true, enum: ORG_ROLES }) role: OrgRole;
  @Prop({ required: true, unique: true }) tokenHash: string;
  @Prop({ required: true }) invitedBy: string;
  @Prop({ required: true }) expiresAt: Date;
  @Prop({ type: Date, default: null }) acceptedAt: Date | null;
  @Prop({ type: Date, default: null }) revokedAt: Date | null;
}
export type InvitationDocument = HydratedDocument<Invitation>;
export const InvitationSchema = SchemaFactory.createForClass(Invitation);
