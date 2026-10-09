import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, type HydratedDocument } from 'mongoose';
import { ORG_ROLES, type OrgRole } from '../access/roles';

@Schema({ _id: false })
export class OrgSecurity {
  /** Everyone must use a second factor to work in this org. */
  @Prop({ type: Boolean, default: false }) require2fa: boolean;
  /** A form is published only once someone other than its author has approved it. */
  @Prop({ type: Boolean, default: false }) requireReview: boolean;
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

/** What a SAML 2.0 identity provider gives the admin to paste in. */
@Schema({ _id: false })
export class OrgSaml {
  /** Where the browser is sent to sign in (the provider's single sign-on address). */
  @Prop({ type: String, default: '' }) entryPoint: string;
  /** The provider's own name for itself (entity ID); responses from anyone else are refused. */
  @Prop({ type: String, default: '' }) idpIssuer: string;
  /** The certificate the provider signs with (PEM). Public: it checks signatures, it cannot make them. */
  @Prop({ type: String, default: '' }) cert: string;
}

/** Single sign-on through the customer's identity provider (Entra ID, Okta, Google Workspace...), by OpenID Connect or SAML 2.0. */
@Schema({ _id: false })
export class OrgSso {
  @Prop({ type: Boolean, default: false }) enabled: boolean;
  /** Which of the two the organisation's provider speaks. */
  @Prop({ type: String, enum: ['OIDC', 'SAML'], default: 'OIDC' }) protocol: 'OIDC' | 'SAML';
  @Prop({ type: OrgSaml, default: () => ({}) }) saml: OrgSaml;
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

/** The requests portal: where the people this organisation serves find its forms and follow what they sent. */
@Schema({ _id: false })
export class OrgPortal {
  @Prop({ type: Boolean, default: false }) enabled: boolean;
  /** The page's heading ('' = "Requests"). */
  @Prop({ type: String, default: '' }) title: string;
  /** A few words under the heading. */
  @Prop({ type: String, default: '' }) intro: string;
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
  @Prop({ type: OrgPortal, default: () => ({}) }) portal: OrgPortal;
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
