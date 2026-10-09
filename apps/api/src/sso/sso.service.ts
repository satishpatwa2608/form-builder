import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { safeFetch, type ConnectorContext } from '@fb/connectors';
import type { Model } from 'mongoose';
import { ORG_ROLES, type OrgRole } from '../access/roles';
import { actorOf, AuditService } from '../audit/audit.service';
import { User, type UserDocument } from '../auth/auth.schemas';
import type { AuthContext } from '../auth/auth-context';
import { AuthService, type SignedIn } from '../auth/auth.service';
import { APP_CONFIG, type AppConfig } from '../config';
import { hashToken, newId, randomToken, SecretBox } from '../common/crypto';
import type { RequestMeta } from '../common/request-meta';
import { Membership, Organization, type MembershipDocument, type OrganizationDocument } from '../orgs/org.schemas';
import { PlansService } from '../plans/plans.service';
import { DNS_TXT, type TxtResolver } from '../site/site.service';
import { SsoState, type SsoStateDocument } from './sso.schema';
import { personFrom, readCertificate, samlAddresses, samlFor } from './saml';

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}

export interface SsoInput {
  enabled?: boolean;
  protocol?: 'OIDC' | 'SAML';
  saml?: { entryPoint?: string; idpIssuer?: string; cert?: string };
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  domains?: string[];
  autoProvision?: boolean;
  defaultRole?: OrgRole;
  enforce?: boolean;
}

/** Shown to the person at the end of a failed attempt (never provider details). */
export class SsoError extends Error {}

const STATE_TTL_MS = 10 * 60_000;
const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const b64url = (b: Buffer) => b.toString('base64url');
export const SSO_TXT_PREFIX = '_formbuilder-sso';

/**
 * Single sign-on, by whichever of the two the organisation's provider speaks.
 *
 * SAML 2.0: we send the browser to the provider with a request; it posts back
 * a signed statement of who the person is. The library checks the signature
 * against the certificate the admin pasted, and that the statement is for
 * us, from that provider, in time, and answers the request this browser made.
 *
 * OpenID Connect sign-in (authorization code + PKCE, confidential client).
 * Identity comes from the provider's userinfo endpoint, called with the
 * access token we just got from its token endpoint over TLS - so no ID token
 * signature handling is needed. The provider is trusted only for the email
 * domains the org admin lists.
 */
@Injectable()
export class SsoService {
  private readonly box: SecretBox;
  private readonly discovery = new Map<string, { doc: Discovery; at: number }>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DNS_TXT) private readonly resolveTxt: TxtResolver,
    private readonly audit: AuditService,
    private readonly authService: AuthService,
    private readonly plans: PlansService,
    @InjectModel(Organization.name) private readonly orgs: Model<OrganizationDocument>,
    @InjectModel(Membership.name) private readonly memberships: Model<MembershipDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(SsoState.name) private readonly states: Model<SsoStateDocument>,
  ) {
    this.box = new SecretBox(Buffer.from(config.SECRET_KEY, 'base64'));
  }

  get callbackUrl() {
    return `${this.config.API_URL.replace(/\/+$/, '')}/auth/sso/callback`;
  }

  /** Development/test only: an issuer on http or a private address. */
  private get insecureAllowed() {
    return this.config.NODE_ENV !== 'production' && process.env.SSO_ALLOW_INSECURE_ISSUER === 'true';
  }

  private async fetchJson(url: string, init: RequestInit = {}) {
    const ctx = { connector: { allowedHosts: [] }, secrets: {}, allowPrivateNetwork: this.insecureAllowed, signal: AbortSignal.timeout(10_000) } as unknown as ConnectorContext;
    return safeFetch(ctx, url, init);
  }

  /** Provider calls during sign-in: any network failure is one plain message. */
  private async providerCall(url: string, init: RequestInit = {}) {
    return this.fetchJson(url, init).catch(() => {
      throw new SsoError('Your identity provider could not be reached. Please try again.');
    });
  }

  private async discover(issuer: string): Promise<Discovery> {
    const hit = this.discovery.get(issuer);
    if (hit && Date.now() - hit.at < 3600_000) return hit.doc;
    const res = await this.fetchJson(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`).catch(() => {
      throw new BadRequestException("Couldn't reach that issuer");
    });
    const doc = res.json as Partial<Discovery> | null;
    if (res.status !== 200 || !doc?.authorization_endpoint || !doc.token_endpoint || !doc.userinfo_endpoint) throw new BadRequestException("That issuer didn't return an OpenID configuration");
    const https = (u: string) => this.insecureAllowed || u.startsWith('https://');
    if (![doc.authorization_endpoint, doc.token_endpoint, doc.userinfo_endpoint].every(https)) throw new BadRequestException('The provider endpoints must use https');
    this.discovery.set(issuer, { doc: doc as Discovery, at: Date.now() });
    return doc as Discovery;
  }

  // ---------------------------------------------------------------- settings

  async settings(auth: AuthContext) {
    const org = await this.orgs.findOne({ id: auth.orgId }).select('sso').lean();
    const s = org?.sso;
    return {
      enabled: !!s?.enabled,
      protocol: s?.protocol === 'SAML' ? 'SAML' : 'OIDC',
      saml: {
        entryPoint: s?.saml?.entryPoint ?? '',
        idpIssuer: s?.saml?.idpIssuer ?? '',
        certSet: !!s?.saml?.cert,
        certExpiresAt: (s?.saml?.cert ? readCertificate(s.saml.cert)?.expiresAt : null) ?? null,
        // What the admin gives their provider in return.
        ...samlAddresses(this.config.API_URL, auth.orgId),
      },
      issuer: s?.issuer ?? '',
      clientId: s?.clientId ?? '',
      clientSecretSet: !!s?.clientSecret,
      domains: s?.domains ?? [],
      pendingDomains: (s?.pendingDomains ?? []).map((p) => ({ domain: p.domain, dns: { type: 'TXT', name: `${SSO_TXT_PREFIX}.${p.domain}`, value: p.token } })),
      autoProvision: !!s?.autoProvision,
      defaultRole: s?.defaultRole ?? 'VIEWER',
      enforce: !!s?.enforce,
      lastSuccessAt: s?.lastSuccessAt ?? null,
      callbackUrl: this.callbackUrl,
      available: (await this.plans.limitsOf(auth.orgId)).sso,
    };
  }

  async update(auth: AuthContext, body: SsoInput) {
    await this.plans.assertFeature(auth.orgId, 'sso');
    const org = await this.orgs.findOne({ id: auth.orgId });
    if (!org) throw new NotFoundException('Organisation not found');
    if (body.issuer !== undefined) {
      const issuer = body.issuer.trim().replace(/\/+$/, '');
      if (!/^https:\/\//.test(issuer) && !this.insecureAllowed) throw new BadRequestException({ message: 'Invalid issuer', errors: [{ field: 'issuer', message: 'Use the https issuer URL from your identity provider' }] });
      await this.discover(issuer);
      org.set('sso.issuer', issuer);
    }
    if (body.protocol !== undefined && body.protocol !== (org.sso.protocol ?? 'OIDC')) {
      // The other kind of provider has not been proven to work here: it starts switched off and not required.
      org.set('sso.protocol', body.protocol);
      org.set('sso.enabled', false);
      org.set('sso.enforce', false);
      org.set('sso.lastSuccessAt', null);
    }
    if (body.saml?.entryPoint !== undefined) {
      const entryPoint = body.saml.entryPoint.trim();
      let ok = false;
      try {
        ok = !entryPoint || new URL(entryPoint).protocol === 'https:' || this.insecureAllowed;
      } catch {
        ok = false;
      }
      if (!ok) throw new BadRequestException({ message: 'Invalid sign-in address', errors: [{ field: 'saml.entryPoint', message: "Use the https sign-in address from your identity provider" }] });
      org.set('sso.saml.entryPoint', entryPoint);
    }
    if (body.saml?.idpIssuer !== undefined) org.set('sso.saml.idpIssuer', body.saml.idpIssuer.trim());
    if (body.saml?.cert) {
      const cert = readCertificate(body.saml.cert);
      if (!cert) throw new BadRequestException({ message: 'Invalid certificate', errors: [{ field: 'saml.cert', message: "That is not a certificate. Paste the signing certificate from your identity provider, including its BEGIN and END lines." }] });
      if (cert.expiresAt.getTime() < Date.now()) throw new BadRequestException({ message: 'Invalid certificate', errors: [{ field: 'saml.cert', message: `That certificate ran out on ${cert.expiresAt.toISOString().slice(0, 10)}. Get the current one from your identity provider.` }] });
      org.set('sso.saml.cert', cert.pem);
    }
    if (body.clientId !== undefined) org.set('sso.clientId', body.clientId.trim());
    if (body.clientSecret) org.set('sso.clientSecret', this.box.seal(body.clientSecret));
    if (body.domains !== undefined) {
      const domains = [...new Set(body.domains.map((d) => d.trim().toLowerCase()).filter(Boolean))];
      const bad = domains.find((d) => !DOMAIN.test(d));
      if (bad) throw new BadRequestException({ message: 'Invalid domain', errors: [{ field: 'domains', message: `${bad} is not a domain` }] });
      // Listing a domain proves nothing: each new one waits for its DNS TXT record (verifyDomain).
      const verified = (org.sso.domains ?? []).filter((d) => domains.includes(d));
      const pending = domains.filter((d) => !verified.includes(d)).map((domain) => (org.sso.pendingDomains ?? []).find((p) => p.domain === domain) ?? { domain, token: `fb-sso=${randomToken()}` });
      org.set('sso.domains', verified);
      org.set('sso.pendingDomains', pending);
    }
    if (body.autoProvision !== undefined) org.set('sso.autoProvision', body.autoProvision);
    if (body.defaultRole !== undefined) {
      if (!ORG_ROLES.includes(body.defaultRole) || body.defaultRole === 'OWNER') throw new BadRequestException('Choose a role below owner');
      org.set('sso.defaultRole', body.defaultRole);
    }
    if (body.enabled !== undefined) {
      const saml = org.sso.protocol === 'SAML';
      if (body.enabled && saml && (!org.sso.saml?.entryPoint || !org.sso.saml.idpIssuer || !org.sso.saml.cert)) throw new BadRequestException("Fill in your provider's sign-in address, issuer and certificate first");
      if (body.enabled && !saml && (!org.sso.issuer || !org.sso.clientId || !org.sso.clientSecret)) throw new BadRequestException('Fill in the issuer, client ID and client secret first');
      if (body.enabled && !org.sso.domains.length) throw new BadRequestException('Verify at least one email domain first');
      org.set('sso.enabled', body.enabled);
    }
    if (body.enforce !== undefined) {
      if (body.enforce && (!org.sso.enabled || !org.sso.lastSuccessAt)) throw new BadRequestException('Sign in once with SSO successfully before requiring it, so a setup mistake cannot lock everyone out');
      org.set('sso.enforce', body.enforce);
    }
    if (!org.sso.enabled) org.set('sso.enforce', false);
    await org.save();
    await this.audit.record(actorOf(auth), {
      action: 'org.sso_updated',
      targetType: 'organization',
      targetId: auth.orgId,
      after: { enabled: org.sso.enabled, protocol: org.sso.protocol ?? 'OIDC', samlChanged: !!body.saml, issuer: org.sso.issuer, domains: org.sso.domains, autoProvision: org.sso.autoProvision, defaultRole: org.sso.defaultRole, enforce: org.sso.enforce, secretChanged: !!body.clientSecret },
    });
    return this.settings(auth);
  }

  /**
   * Prove the org owns an email domain (TXT record), so its provider may vouch
   * for addresses on it. A domain belongs to one org's SSO only.
   */
  async verifyDomain(auth: AuthContext, rawDomain: string) {
    await this.plans.assertFeature(auth.orgId, 'sso');
    const domain = rawDomain.trim().toLowerCase();
    const org = await this.orgs.findOne({ id: auth.orgId });
    const pending = org?.sso?.pendingDomains?.find((p) => p.domain === domain);
    if (!org || !pending) throw new NotFoundException('That domain is not waiting for verification');
    const records = await this.resolveTxt(`${SSO_TXT_PREFIX}.${domain}`).catch(() => [] as string[][]);
    if (!records.some((chunks) => chunks.join('') === pending.token)) throw new BadRequestException(`The TXT record wasn't found yet. Add ${SSO_TXT_PREFIX}.${domain} = ${pending.token}; DNS changes can take a while to appear.`);
    if (await this.orgs.exists({ id: { $ne: auth.orgId }, 'sso.domains': domain })) throw new ConflictException('Another organisation already uses this domain for single sign-on');
    org.set('sso.domains', [...new Set([...org.sso.domains, domain])]);
    org.set('sso.pendingDomains', org.sso.pendingDomains.filter((p) => p.domain !== domain));
    await org.save();
    await this.audit.record(actorOf(auth), { action: 'org.sso_domain_verified', targetType: 'organization', targetId: auth.orgId, after: { domain } });
    return this.settings(auth);
  }

  // ---------------------------------------------------------------- sign-in

  private async orgForEmail(email: string) {
    const domain = email.split('@')[1]?.toLowerCase() ?? '';
    if (!DOMAIN.test(domain)) return null;
    return this.orgs.findOne({ 'sso.enabled': true, 'sso.domains': domain }).lean();
  }

  /** Is password sign-in refused for this address? */
  async requiredFor(email: string): Promise<boolean> {
    const org = await this.orgForEmail(email);
    return !!org?.sso?.enforce && !!org.sso.lastSuccessAt;
  }

  /** Where to send the browser to sign in (the provider's authorize URL). */
  async start(email: string): Promise<{ url: string; browserKey: string; crossSite?: boolean }> {
    const org = await this.orgForEmail(email);
    if (!org) throw new SsoError('Single sign-on is not set up for that email domain');
    if (!(await this.plans.limitsOf(org.id)).sso) throw new SsoError('Single sign-on is not available for this organisation');
    if (org.sso.protocol === 'SAML') return this.samlStart(org);
    const d = await this.discover(org.sso.issuer);
    const state = randomToken();
    const verifier = b64url(randomBytes(32));
    // Tied to this browser by a cookie, so a callback link made by someone else can't sign the victim in (login CSRF).
    const browserKey = randomToken();
    await this.states.create({ stateHash: hashToken(state), browserHash: hashToken(browserKey), orgId: org.id, verifier: this.box.seal(verifier), expiresAt: new Date(Date.now() + STATE_TTL_MS) });
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: org.sso.clientId,
      redirect_uri: this.callbackUrl,
      scope: 'openid email profile',
      state,
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      login_hint: email,
    }).toString();
    return { url: url.toString(), browserKey };
  }

  // ---------------------------------------------------------------- SAML

  /** The provider's metadata asks for ours: who we are and where to post the answer. */
  async samlMetadata(orgId: string): Promise<string> {
    const org = /^[A-Za-z0-9-]{1,64}$/.test(orgId) ? await this.orgs.findOne({ id: orgId }).select('id sso').lean() : null;
    if (!org) throw new NotFoundException('Not found');
    // Nothing of the provider's is needed to describe ourselves; the placeholders are never used to check anything.
    return samlFor(this.config.API_URL, org.id, { entryPoint: 'https://unused.invalid/', idpIssuer: 'unused', cert: 'unused' }, '').generateServiceProviderMetadata(null, null);
  }

  private async samlStart(org: { id: string; sso: OrganizationDocument['sso'] }) {
    const state = randomToken();
    const browserKey = randomToken();
    // XML IDs may not start with a digit.
    const requestId = `_${randomBytes(20).toString('hex')}`;
    await this.states.create({ stateHash: hashToken(state), browserHash: hashToken(browserKey), orgId: org.id, requestId, expiresAt: new Date(Date.now() + STATE_TTL_MS) });
    const url = await samlFor(this.config.API_URL, org.id, org.sso.saml, requestId)
      .getAuthorizeUrlAsync(state, undefined, {})
      .catch(() => {
        throw new SsoError('Single sign-on is not set up correctly for this organisation. Ask an admin.');
      });
    // The provider answers with a form posted from its own site: the cookie must be allowed to come back with that.
    return { url, browserKey, crossSite: true };
  }

  /** The provider posted its answer: check it, read who it is, open a session. */
  async samlCallback(orgId: string, samlResponse: string, relayState: string, browserKey: string | undefined, meta: RequestMeta): Promise<SignedIn> {
    const st = relayState ? await this.states.findOneAndDelete({ stateHash: hashToken(relayState), orgId, requestId: { $ne: '' }, expiresAt: { $gt: new Date() } }).lean() : null;
    // No request of ours behind it: a response the provider sent unasked, or one for another attempt.
    if (!st) throw new SsoError('That sign-in has expired. Please start again from the sign-in page.');
    if (!browserKey || hashToken(browserKey) !== st.browserHash) throw new SsoError('Please start single sign-on again from this browser.');
    const org = await this.orgs.findOne({ id: st.orgId });
    if (!org?.sso?.enabled || org.sso.protocol !== 'SAML') throw new SsoError('Single sign-on is turned off for this organisation');
    if (!(await this.plans.limitsOf(org.id)).sso) throw new SsoError('Single sign-on is not available for this organisation');
    const checked = await samlFor(this.config.API_URL, org.id, org.sso.saml, st.requestId)
      .validatePostResponseAsync({ SAMLResponse: samlResponse })
      .catch(() => null);
    // Whatever was wrong (signature, audience, time, issuer, the request it answers), the person is told one thing.
    if (!checked?.profile || checked.loggedOut) throw new SsoError('Your identity provider did not accept the sign-in');
    // The library checks the signature, not who it says it is from. A key shared between a provider's customers
    // would otherwise let one of them sign in to another's organisation here.
    if (checked.profile.issuer !== org.sso.saml.idpIssuer) throw new SsoError('Your identity provider did not accept the sign-in');
    const person = personFrom(checked.profile);
    if (!person.email) throw new SsoError('Your identity provider did not share an email address');
    return this.finish(org, person.email, person.name, meta);
  }

  /** The provider sent the browser back: trade the code, read who it is, open a session. */
  async callback(code: string, state: string, browserKey: string | undefined, meta: RequestMeta): Promise<SignedIn> {
    const st = await this.states.findOneAndDelete({ stateHash: hashToken(state), requestId: { $in: ['', null] }, expiresAt: { $gt: new Date() } }).lean();
    if (!st) throw new SsoError('That sign-in link has expired. Please try again.');
    if (!browserKey || hashToken(browserKey) !== st.browserHash) throw new SsoError('Please start single sign-on again from this browser.');
    const org = await this.orgs.findOne({ id: st.orgId });
    if (!org?.sso?.enabled || org.sso.protocol === 'SAML') throw new SsoError('Single sign-on is turned off for this organisation');
    const d = await this.discover(org.sso.issuer);

    const token = await this.providerCall(d.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.callbackUrl,
        client_id: org.sso.clientId,
        client_secret: this.box.open(org.sso.clientSecret),
        code_verifier: this.box.open(st.verifier),
      }).toString(),
    });
    const accessToken = (token.json as { access_token?: string } | null)?.access_token;
    if (token.status !== 200 || !accessToken) throw new SsoError('Your identity provider did not accept the sign-in');
    const info = await this.providerCall(d.userinfo_endpoint, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
    const claims = (info.json ?? {}) as { email?: string; email_verified?: boolean; name?: string };
    const email = (claims.email ?? '').trim().toLowerCase();
    if (info.status !== 200 || !email || claims.email_verified === false) throw new SsoError('Your identity provider did not share a verified email address');
    return this.finish(org, email, claims.name, meta);
  }

  /**
   * The provider has vouched for an address: check it is one this organisation's provider may vouch for,
   * find or create the member, and open a session. The same for OpenID Connect and SAML.
   */
  async finish(org: OrganizationDocument, email: string, name: string | undefined, meta: RequestMeta): Promise<SignedIn> {
    const domain = email.split('@')[1] ?? '';
    const claims = { name };
    if (!org.sso.domains.includes(domain)) throw new SsoError(`${domain} addresses can't sign in to ${org.name} with single sign-on`);

    let user = await this.users.findOne({ email });
    let membership = user ? await this.memberships.findOne({ orgId: org.id, userId: user.id }) : null;
    if (membership?.status === 'DISABLED') throw new SsoError('Your access to this organisation is disabled');
    if (!membership || membership.status === 'REMOVED') {
      if (!org.sso.autoProvision) throw new SsoError(`You are not a member of ${org.name}. Ask an admin to invite you.`);
      await this.plans.assertCanAdd(org.id, 'members').catch(() => {
        throw new SsoError(`${org.name} has no free seats. Ask an admin.`);
      });
      if (!user) {
        // No password: this person signs in through the provider (a reset can set one later).
        user = await this.users.create({ id: newId(), email, name: (claims.name ?? email.split('@')[0]!).slice(0, 100), passwordHash: await argon2.hash(randomToken(), { type: argon2.argon2id }), emailVerifiedAt: new Date() });
      }
      if (membership) {
        membership.set({ status: 'ACTIVE', role: org.sso.defaultRole });
        await membership.save();
      } else {
        membership = await this.memberships.create({ id: newId(), orgId: org.id, userId: user.id, role: org.sso.defaultRole as OrgRole, status: 'ACTIVE' });
      }
      await this.audit.record({ orgId: org.id, actorId: user.id, ...meta }, { action: 'member.provisioned_by_sso', targetType: 'user', targetId: user.id, after: { role: org.sso.defaultRole } });
    }
    if (!user) throw new SsoError('Single sign-on failed. Please try again.');
    if (!user.emailVerifiedAt) {
      user.set({ emailVerifiedAt: new Date() });
      await user.save();
    }
    org.set('sso.lastSuccessAt', new Date());
    await org.save();
    return this.authService.openSsoSession(user.id, org.id, meta);
  }
}
