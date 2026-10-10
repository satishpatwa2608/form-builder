import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import * as argon2 from 'argon2';
import type { Model } from 'mongoose';
import { permissionsOf } from '../access/roles';
import { actorOf, AuditService } from '../audit/audit.service';
import { APP_CONFIG, isOperator, type AppConfig } from '../config';
import { hashToken, newId, randomToken, SecretBox } from '../common/crypto';
import { MAILER, type Mailer } from '../common/mailer';
import type { RequestMeta } from '../common/request-meta';
import { newTotpSecret, otpauthUrl, verifyTotp } from '../common/totp';
import { Membership, Organization, type MembershipDocument, type OrganizationDocument } from '../orgs/org.schemas';
import { idleMinutesOf } from '../orgs/org.schemas';

/** The screen signs people out on time; the server allows this much longer before it refuses, so the two never race. */
const IDLE_GRACE_MINUTES = 2;
import type { AuthContext } from './auth-context';
import { AuthToken, Session, User, type AuthTokenDocument, type SessionDocument, type UserDocument } from './auth.schemas';

export const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 3600_000;
const VERIFY_TTL_MS = 24 * 3600_000;
const RESET_TTL_MS = 3600_000;
const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60_000;
const RECOVERY_CODES = 10;

const WRONG_LOGIN = 'Email or password is wrong';

export interface SignedIn {
  accessToken: string;
  expiresIn: number;
  /** Goes into the httpOnly cookie, never into the response body. */
  refreshToken: string;
}

const recoveryCode = () => {
  const raw = randomToken().replace(/[^a-zA-Z0-9]/g, '').slice(0, 10).toLowerCase();
  return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
};

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly box: SecretBox;
  /** Verified against when the email is unknown, so both paths take the same time. */
  private dummyHash = '';

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(Session.name) private readonly sessions: Model<SessionDocument>,
    @InjectModel(AuthToken.name) private readonly tokens: Model<AuthTokenDocument>,
    @InjectModel(Organization.name) private readonly orgs: Model<OrganizationDocument>,
    @InjectModel(Membership.name) private readonly memberships: Model<MembershipDocument>,
  ) {
    this.box = new SecretBox(Buffer.from(config.SECRET_KEY, 'base64'));
  }

  async onModuleInit() {
    this.dummyHash = await argon2.hash(randomToken(), { type: argon2.argon2id });
  }

  /**
   * A security event about a user (not one org): recorded in every org they
   * actively belong to, so each org's admins see it; with no org, unattached.
   */
  private async userEvent(userId: string, meta: Partial<RequestMeta>, action: string) {
    const orgIds = [...new Set((await this.memberships.find({ userId, status: 'ACTIVE' }).lean()).map((m) => m.orgId))];
    for (const orgId of orgIds.length ? orgIds : ['']) {
      await this.audit.record({ orgId, actorId: userId, ip: meta.ip, userAgent: meta.userAgent }, { action, targetType: 'user', targetId: userId });
    }
  }

  hashPassword(password: string) {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  // ---------------------------------------------------------------- sign-up / email

  /**
   * Creates the user, their organisation and an OWNER membership, and sends a
   * verification link. The answer is the same whether or not the email is
   * already registered (no account discovery); an existing user gets a notice.
   */
  async signup(body: { name: string; email: string; password: string; orgName: string }, meta: RequestMeta) {
    const email = body.email.toLowerCase();
    // Closed: a new organisation is started only by the people who run the installation. Said plainly, since the
    // sign-up page says the same and it reveals nothing about who has an account.
    if (this.config.SIGNUP === 'closed' && !isOperator(this.config, email)) throw new ForbiddenException('New accounts are by invitation here. Ask whoever provides Form Builder to you.');
    const existing = await this.users.findOne({ email }).lean();
    if (existing) {
      await this.mailer.send({
        to: email,
        subject: 'Someone tried to sign up with your email',
        text: `Someone tried to create a Form Builder account with this address. If it was you, sign in instead: ${this.config.APP_URL}/login`,
      });
      return;
    }
    const userId = newId();
    const orgId = newId();
    await this.users.create({ id: userId, email, name: body.name, passwordHash: await this.hashPassword(body.password) });
    await this.orgs.create({ id: orgId, name: body.orgName });
    await this.memberships.create({ id: newId(), orgId, userId, role: 'OWNER' });
    await this.audit.record({ orgId, actorId: userId, ...meta }, { action: 'auth.signup', targetType: 'organization', targetId: orgId, after: { name: body.orgName } });
    await this.sendVerification(userId, email);
  }

  private async sendVerification(userId: string, email: string) {
    const token = randomToken();
    await this.tokens.create({ id: newId(), userId, kind: 'VERIFY_EMAIL', tokenHash: hashToken(token), expiresAt: new Date(Date.now() + VERIFY_TTL_MS) });
    await this.mailer.send({
      to: email,
      subject: 'Confirm your email',
      text: `Confirm your email to start using Form Builder: ${this.config.APP_URL}/verify-email?token=${token}\nThe link works for 24 hours.`,
    });
  }

  async resendVerification(emailRaw: string) {
    const user = await this.users.findOne({ email: emailRaw.toLowerCase() }).lean();
    if (user && !user.emailVerifiedAt) await this.sendVerification(user.id, user.email);
  }

  private async useToken(kind: AuthToken['kind'], token: string) {
    const row = await this.tokens.findOneAndUpdate(
      { kind, tokenHash: hashToken(token), usedAt: null, expiresAt: { $gt: new Date() } },
      { $set: { usedAt: new Date() } },
    );
    if (!row) throw new BadRequestException('This link is not valid any more. Ask for a new one.');
    return row;
  }

  async verifyEmail(token: string, meta: RequestMeta) {
    const row = await this.useToken('VERIFY_EMAIL', token);
    await this.users.updateOne({ id: row.userId }, { $set: { emailVerifiedAt: new Date() } });
    await this.userEvent(row.userId, meta, 'auth.email_verified');
  }

  // ---------------------------------------------------------------- login / sessions

  async login(body: { email: string; password: string; code?: string; orgId?: string }, meta: RequestMeta): Promise<SignedIn> {
    const user = await this.users.findOne({ email: body.email.toLowerCase() });
    if (!user) {
      await argon2.verify(this.dummyHash, body.password);
      throw new UnauthorizedException(WRONG_LOGIN);
    }
    const locked = !!user.lockedUntil && user.lockedUntil > new Date();
    const passwordOk = await argon2.verify(user.passwordHash, body.password);
    if (locked || !passwordOk) {
      if (!locked) {
        const failed = user.failedLogins + 1;
        user.set(failed >= MAX_FAILED_LOGINS ? { failedLogins: 0, lockedUntil: new Date(Date.now() + LOCK_MS) } : { failedLogins: failed });
        await user.save();
      }
      await this.userEvent(user.id, meta, locked ? 'auth.login_locked' : 'auth.login_failed');
      throw new UnauthorizedException(WRONG_LOGIN);
    }
    if (!user.emailVerifiedAt) throw new ForbiddenException({ message: 'Confirm your email first - we sent you a link', code: 'EMAIL_NOT_VERIFIED' });
    const domain = user.email.split('@')[1] ?? '';
    if (await this.orgs.exists({ 'sso.enabled': true, 'sso.enforce': true, 'sso.lastSuccessAt': { $ne: null }, 'sso.domains': domain })) {
      throw new ForbiddenException({ message: 'Your organisation requires single sign-on. Use "Sign in with SSO".', code: 'SSO_REQUIRED' });
    }

    let mfa = false;
    if (user.totpEnabledAt) {
      if (!body.code) throw new UnauthorizedException({ message: 'Enter the code from your authenticator app', code: 'TWO_FACTOR_REQUIRED' });
      if (!(await this.checkSecondFactor(user, body.code))) {
        await this.userEvent(user.id, meta, 'auth.2fa_failed');
        throw new UnauthorizedException({ message: 'That code is not right', code: 'TWO_FACTOR_INVALID' });
      }
      mfa = true;
    }

    const memberships = await this.memberships.find({ userId: user.id, status: 'ACTIVE' }).sort({ updatedAt: -1 }).lean();
    const membership = body.orgId ? memberships.find((m) => m.orgId === body.orgId) : memberships[0];
    if (!membership) throw new ForbiddenException('You are not a member of any organisation');

    user.set({ failedLogins: 0, lockedUntil: null });
    await user.save();
    const signed = await this.openSession(user.id, membership.orgId, mfa, meta);
    await this.audit.record({ orgId: membership.orgId, actorId: user.id, ...meta }, { action: 'auth.login', targetType: 'user', targetId: user.id, after: { mfa } });
    return signed;
  }

  /** A TOTP code (each 30 s step only once) or an unused recovery code (burned on use). */
  private async checkSecondFactor(user: UserDocument, code: string): Promise<boolean> {
    const clean = code.trim().toLowerCase();
    if (/^\d{6}$/.test(clean)) {
      const step = verifyTotp(this.box.open(user.totpSecret), clean);
      if (step === null || step <= user.totpLastStep) return false;
      user.set({ totpLastStep: step });
      await user.save();
      return true;
    }
    const hash = hashToken(clean);
    if (!user.recoveryCodes.includes(hash)) return false;
    user.set({ recoveryCodes: user.recoveryCodes.filter((h) => h !== hash) });
    await user.save();
    return true;
  }

  private async openSession(userId: string, orgId: string, mfa: boolean, meta: RequestMeta, ssoOrgId = ''): Promise<SignedIn> {
    const refreshToken = randomToken();
    const id = newId();
    await this.sessions.create({ id, userId, orgId, mfa, ssoOrgId, refreshHash: hashToken(refreshToken), expiresAt: new Date(Date.now() + REFRESH_TTL_MS), lastActiveAt: new Date(), ip: meta.ip, userAgent: meta.userAgent });
    return { accessToken: await this.accessToken(userId, id), expiresIn: ACCESS_TTL_SECONDS, refreshToken };
  }

  /**
   * A session from single sign-on. The identity provider did the
   * authentication (and its own MFA), so the session counts as two-factor.
   */
  async openSsoSession(userId: string, orgId: string, meta: RequestMeta): Promise<SignedIn> {
    const signed = await this.openSession(userId, orgId, true, meta, orgId);
    await this.audit.record({ orgId, actorId: userId, ...meta }, { action: 'auth.login', targetType: 'user', targetId: userId, after: { mfa: true, sso: true } });
    return signed;
  }

  private accessToken(userId: string, sessionId: string) {
    return this.jwt.signAsync({ sub: userId, sid: sessionId }, { expiresIn: ACCESS_TTL_SECONDS, algorithm: 'HS256' });
  }

  /**
   * Rotates the refresh token. A token that was already rotated away means it
   * was copied: the whole session is revoked and the event is audited.
   */
  async refresh(refreshToken: string | undefined, meta: RequestMeta): Promise<SignedIn> {
    if (!refreshToken) throw new UnauthorizedException('Sign in to continue');
    const hash = hashToken(refreshToken);
    const session = await this.sessions.findOne({ refreshHash: hash });
    if (!session) {
      const stolen = await this.sessions.findOne({ previousHashes: hash });
      if (stolen && !stolen.revokedAt) {
        stolen.set({ revokedAt: new Date() });
        await stolen.save();
        await this.audit.record({ orgId: stolen.orgId, actorId: stolen.userId, ...meta }, { action: 'auth.refresh_reused', targetType: 'session', targetId: stolen.id });
      }
      throw new UnauthorizedException('Your session has ended');
    }
    if (session.revokedAt || session.expiresAt < new Date()) throw new UnauthorizedException('Your session has ended');
    // Away for longer than the organisation allows: the session is over, even if the browser was left open.
    const idle = idleMinutesOf((await this.orgs.findOne({ id: session.orgId }).select('security').lean())?.security);
    if (idle > 0 && session.lastActiveAt && Date.now() - session.lastActiveAt.getTime() > (idle + IDLE_GRACE_MINUTES) * 60_000) {
      session.set({ revokedAt: new Date() });
      await session.save();
      await this.audit.record({ orgId: session.orgId, actorId: session.userId, ...meta }, { action: 'auth.idle_signout', targetType: 'session', targetId: session.id, after: { minutes: idle } });
      throw new UnauthorizedException({ message: `You were signed out after ${idle} minutes away`, code: 'IDLE' });
    }
    const next = randomToken();
    session.set({ lastActiveAt: new Date(), refreshHash: hashToken(next), previousHashes: [hash, ...session.previousHashes].slice(0, 20), ip: meta.ip, userAgent: meta.userAgent });
    await session.save();
    return { accessToken: await this.accessToken(session.userId, session.id), expiresIn: ACCESS_TTL_SECONDS, refreshToken: next };
  }

  async logout(auth: AuthContext) {
    await this.sessions.updateOne({ id: auth.sessionId }, { $set: { revokedAt: new Date() } });
    await this.audit.record(actorOf(auth), { action: 'auth.logout', targetType: 'session', targetId: auth.sessionId });
  }

  async switchOrg(auth: AuthContext, orgId: string) {
    const membership = await this.memberships.findOne({ orgId, userId: auth.userId, status: 'ACTIVE' }).lean();
    if (!membership) throw new ForbiddenException('You are not a member of that organisation');
    // An org's identity provider vouches for its own org only.
    const session = await this.sessions.findOne({ id: auth.sessionId }).select('ssoOrgId').lean();
    if (session?.ssoOrgId && session.ssoOrgId !== orgId) throw new ForbiddenException({ message: 'Sign out and sign in with your password (or that organisation\'s single sign-on) to open it', code: 'SSO_SESSION_SCOPED' });
    await this.sessions.updateOne({ id: auth.sessionId }, { $set: { orgId } });
    return { accessToken: await this.accessToken(auth.userId, auth.sessionId), expiresIn: ACCESS_TTL_SECONDS };
  }

  /** The signed-in user, their organisations, and what they can do in the current one. */
  async me(auth: AuthContext) {
    const user = await this.users.findOne({ id: auth.userId }).lean();
    const memberships = await this.memberships.find({ userId: auth.userId, status: 'ACTIVE' }).lean();
    const orgs = await this.orgs.find({ id: { $in: memberships.map((m) => m.orgId) } }).lean();
    const current = orgs.find((o) => o.id === auth.orgId);
    return {
      user: { id: user!.id, name: user!.name, email: user!.email, twoFactorEnabled: !!user!.totpEnabledAt },
      org: { id: auth.orgId, name: current?.name ?? '', role: auth.role, permissions: permissionsOf(auth.role), require2fa: !!current?.security?.require2fa, requireReview: !!current?.security?.requireReview, idleMinutes: idleMinutesOf(current?.security) },
      session: { mfa: auth.mfa },
      orgs: memberships.map((m) => ({ id: m.orgId, name: orgs.find((o) => o.id === m.orgId)?.name ?? '', role: m.role })),
      // Adding an organisation: anyone where sign-up is open, the operators where it is closed. Operators also choose its plan.
      operator: isOperator(this.config, user!.email),
      canCreateOrgs: this.config.SIGNUP === 'open' || isOperator(this.config, user!.email),
    };
  }

  // ---------------------------------------------------------------- two-factor

  async startTwoFactor(auth: AuthContext) {
    const user = await this.users.findOne({ id: auth.userId });
    if (user!.totpEnabledAt) throw new ConflictException('Two-factor sign-in is already on');
    const secret = newTotpSecret();
    user!.set({ totpSecret: this.box.seal(secret) });
    await user!.save();
    return { secret, otpauthUrl: otpauthUrl(secret, user!.email) };
  }

  async enableTwoFactor(auth: AuthContext, code: string) {
    const user = await this.users.findOne({ id: auth.userId });
    if (!user!.totpSecret || user!.totpEnabledAt) throw new BadRequestException('Start the set-up first');
    const step = verifyTotp(this.box.open(user!.totpSecret), code);
    if (step === null) throw new BadRequestException('That code is not right');
    const codes = Array.from({ length: RECOVERY_CODES }, recoveryCode);
    user!.set({ totpEnabledAt: new Date(), totpLastStep: step, recoveryCodes: codes.map(hashToken) });
    await user!.save();
    // This session just proved the second factor.
    await this.sessions.updateOne({ id: auth.sessionId }, { $set: { mfa: true } });
    await this.userEvent(auth.userId, auth, 'auth.2fa_enabled');
    return { recoveryCodes: codes };
  }

  async disableTwoFactor(auth: AuthContext, body: { password: string; code: string }) {
    const user = await this.users.findOne({ id: auth.userId });
    if (!user!.totpEnabledAt) throw new BadRequestException('Two-factor sign-in is not on');
    const orgIds = (await this.memberships.find({ userId: auth.userId, status: 'ACTIVE' }).lean()).map((m) => m.orgId);
    if (await this.orgs.exists({ id: { $in: orgIds }, 'security.require2fa': true })) {
      throw new ForbiddenException('One of your organisations requires two-factor sign-in');
    }
    if (!(await argon2.verify(user!.passwordHash, body.password)) || !(await this.checkSecondFactor(user!, body.code))) {
      throw new UnauthorizedException('Password or code is not right');
    }
    user!.set({ totpSecret: '', totpEnabledAt: null, totpLastStep: 0, recoveryCodes: [] });
    await user!.save();
    await this.userEvent(auth.userId, auth, 'auth.2fa_disabled');
  }

  // ---------------------------------------------------------------- passwords

  async changePassword(auth: AuthContext, body: { currentPassword: string; newPassword: string }) {
    const user = await this.users.findOne({ id: auth.userId });
    if (!(await argon2.verify(user!.passwordHash, body.currentPassword))) throw new UnauthorizedException('Current password is not right');
    user!.set({ passwordHash: await this.hashPassword(body.newPassword), passwordChangedAt: new Date() });
    await user!.save();
    // Sign out everywhere else.
    await this.sessions.updateMany({ userId: auth.userId, id: { $ne: auth.sessionId }, revokedAt: null }, { $set: { revokedAt: new Date() } });
    await this.userEvent(auth.userId, auth, 'auth.password_changed');
  }

  async forgotPassword(emailRaw: string) {
    const user = await this.users.findOne({ email: emailRaw.toLowerCase() }).lean();
    if (!user) return;
    const token = randomToken();
    await this.tokens.create({ id: newId(), userId: user.id, kind: 'RESET_PASSWORD', tokenHash: hashToken(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) });
    await this.mailer.send({
      to: user.email,
      subject: 'Reset your password',
      text: `Reset your Form Builder password: ${this.config.APP_URL}/reset-password?token=${token}\nThe link works for 1 hour. If you didn't ask for this, ignore this email.`,
    });
  }

  async resetPassword(body: { token: string; password: string }, meta: RequestMeta) {
    const row = await this.useToken('RESET_PASSWORD', body.token);
    await this.users.updateOne(
      { id: row.userId },
      { $set: { passwordHash: await this.hashPassword(body.password), passwordChangedAt: new Date(), failedLogins: 0, lockedUntil: null, emailVerifiedAt: new Date() } },
    );
    await this.sessions.updateMany({ userId: row.userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
    await this.userEvent(row.userId, meta, 'auth.password_reset');
  }
}
