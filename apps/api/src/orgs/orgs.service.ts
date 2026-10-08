import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import * as argon2 from 'argon2';
import type { Model } from 'mongoose';
import { canAssignRole, type OrgRole } from '../access/roles';
import { actorOf, AuditService } from '../audit/audit.service';
import { User, Session, type UserDocument, type SessionDocument } from '../auth/auth.schemas';
import type { AuthContext } from '../auth/auth-context';
import { AuthService } from '../auth/auth.service';
import { APP_CONFIG, type AppConfig } from '../config';
import { hashToken, newId, randomToken } from '../common/crypto';
import { MAILER, type Mailer } from '../common/mailer';
import type { RequestMeta } from '../common/request-meta';
import { PlansService } from '../plans/plans.service';
import { Invitation, Membership, Organization, type InvitationDocument, type MembershipDocument, type OrganizationDocument } from './org.schemas';

const INVITE_TTL_MS = 7 * 24 * 3600_000;

@Injectable()
export class OrgsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly audit: AuditService,
    private readonly authService: AuthService,
    private readonly plans: PlansService,
    @InjectModel(Organization.name) private readonly orgs: Model<OrganizationDocument>,
    @InjectModel(Membership.name) private readonly memberships: Model<MembershipDocument>,
    @InjectModel(Invitation.name) private readonly invitations: Model<InvitationDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(Session.name) private readonly sessions: Model<SessionDocument>,
  ) {}

  // ---------------------------------------------------------------- organisation

  async get(auth: AuthContext) {
    const org = await this.orgs.findOne({ id: auth.orgId }).lean();
    return { id: org!.id, name: org!.name, security: { require2fa: !!org!.security?.require2fa } };
  }

  async update(auth: AuthContext, body: { name?: string; security?: { require2fa?: boolean } }) {
    const org = await this.orgs.findOne({ id: auth.orgId });
    const before = { name: org!.name, require2fa: !!org!.security?.require2fa };
    if (body.security?.require2fa === true && !auth.mfa) {
      // Otherwise the admin locks themselves out on the next request.
      throw new BadRequestException('Turn on two-factor sign-in for yourself first');
    }
    if (body.name !== undefined) org!.set({ name: body.name });
    if (body.security?.require2fa !== undefined) org!.set({ 'security.require2fa': body.security.require2fa });
    await org!.save();
    await this.audit.record(actorOf(auth), {
      action: 'org.updated',
      targetType: 'organization',
      targetId: auth.orgId,
      before,
      after: { name: org!.name, require2fa: !!org!.security?.require2fa },
    });
    return this.get(auth);
  }

  /** Another organisation for a signed-in user; they become its owner. */
  async create(auth: AuthContext, name: string) {
    const orgId = newId();
    await this.orgs.create({ id: orgId, name });
    await this.memberships.create({ id: newId(), orgId, userId: auth.userId, role: 'OWNER' });
    await this.audit.record({ ...actorOf(auth), orgId }, { action: 'org.created', targetType: 'organization', targetId: orgId, after: { name } });
    return { id: orgId, name };
  }

  // ---------------------------------------------------------------- members

  async members(auth: AuthContext) {
    const rows = await this.memberships.find({ orgId: auth.orgId, status: { $ne: 'REMOVED' } }).lean();
    const users = await this.users.find({ id: { $in: rows.map((r) => r.userId) } }).lean();
    return rows
      .map((m) => {
        const u = users.find((x) => x.id === m.userId);
        return { userId: m.userId, name: u?.name ?? '', email: u?.email ?? '', role: m.role, status: m.status, department: m.department ?? '', managerId: m.managerId ?? '', twoFactorEnabled: !!u?.totpEnabledAt };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private async activeOwners(orgId: string) {
    return this.memberships.countDocuments({ orgId, role: 'OWNER', status: 'ACTIVE' });
  }

  private async mustMember(orgId: string, userId: string) {
    const m = await this.memberships.findOne({ orgId, userId, status: { $ne: 'REMOVED' } });
    if (!m) throw new NotFoundException('Member not found');
    return m;
  }

  /** Change a member's role or disable/re-enable them, within the escalation rules. */
  async updateMember(auth: AuthContext, userId: string, body: { role?: OrgRole; status?: 'ACTIVE' | 'DISABLED'; department?: string; managerId?: string }) {
    const m = await this.mustMember(auth.orgId, userId);
    const before = { role: m.role, status: m.status, department: m.department, managerId: m.managerId };
    if (m.role === 'OWNER' && auth.role !== 'OWNER') throw new ForbiddenException('Only an owner can change another owner');
    if (body.managerId) {
      if (body.managerId === userId) throw new BadRequestException("Someone can't be their own manager");
      if (!(await this.memberships.exists({ orgId: auth.orgId, userId: body.managerId, status: 'ACTIVE' }))) throw new BadRequestException('The manager must be an active member');
    }
    if (body.role && !canAssignRole(auth.role, body.role)) throw new ForbiddenException(`You can't give the ${body.role} role`);
    const losesOwner = m.role === 'OWNER' && m.status === 'ACTIVE' && ((body.role && body.role !== 'OWNER') || body.status === 'DISABLED');
    if (losesOwner && (await this.activeOwners(auth.orgId)) <= 1) throw new ConflictException('The organisation needs at least one active owner');

    if (body.role) m.set({ role: body.role });
    if (body.status) m.set({ status: body.status });
    if (body.department !== undefined) m.set({ department: body.department });
    if (body.managerId !== undefined) m.set({ managerId: body.managerId });
    await m.save();
    if (body.status === 'DISABLED') await this.endSessions(auth.orgId, userId);
    await this.audit.record(actorOf(auth), { action: 'member.updated', targetType: 'user', targetId: userId, before, after: { role: m.role, status: m.status, department: m.department, managerId: m.managerId } });
    return this.members(auth);
  }

  async removeMember(auth: AuthContext, userId: string) {
    const m = await this.mustMember(auth.orgId, userId);
    if (m.role === 'OWNER' && auth.role !== 'OWNER') throw new ForbiddenException('Only an owner can remove another owner');
    if (m.role === 'OWNER' && m.status === 'ACTIVE' && (await this.activeOwners(auth.orgId)) <= 1) throw new ConflictException('The organisation needs at least one active owner');
    const before = { role: m.role, status: m.status };
    m.set({ status: 'REMOVED' });
    await m.save();
    await this.endSessions(auth.orgId, userId);
    await this.audit.record(actorOf(auth), { action: 'member.removed', targetType: 'user', targetId: userId, before });
    return this.members(auth);
  }

  /** Sessions working in this org end now (the guard also re-checks membership on every request). */
  private async endSessions(orgId: string, userId: string) {
    await this.sessions.updateMany({ orgId, userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
  }

  // ---------------------------------------------------------------- invitations

  async listInvitations(auth: AuthContext) {
    const rows = await this.invitations.find({ orgId: auth.orgId, acceptedAt: null, revokedAt: null, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).lean();
    return rows.map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt }));
  }

  async invite(auth: AuthContext, body: { email: string; role: OrgRole }) {
    const email = body.email.toLowerCase();
    if (!canAssignRole(auth.role, body.role)) throw new ForbiddenException(`You can't give the ${body.role} role`);
    const user = await this.users.findOne({ email }).lean();
    if (user && (await this.memberships.exists({ orgId: auth.orgId, userId: user.id, status: { $ne: 'REMOVED' } }))) {
      throw new ConflictException('That person is already a member');
    }
    // Re-inviting the same address doesn't take another seat.
    if (!(await this.invitations.exists({ orgId: auth.orgId, email, acceptedAt: null, revokedAt: null, expiresAt: { $gt: new Date() } }))) await this.plans.assertCanAdd(auth.orgId, 'members');
    // One open invitation per address: a new one replaces the old.
    await this.invitations.updateMany({ orgId: auth.orgId, email, acceptedAt: null, revokedAt: null }, { $set: { revokedAt: new Date() } });
    const token = randomToken();
    const id = newId();
    await this.invitations.create({ id, orgId: auth.orgId, email, role: body.role, tokenHash: hashToken(token), invitedBy: auth.userId, expiresAt: new Date(Date.now() + INVITE_TTL_MS) });
    const org = await this.orgs.findOne({ id: auth.orgId }).lean();
    await this.mailer.send({
      to: email,
      subject: `You're invited to ${org!.name} on Form Builder`,
      text: `You've been invited to join ${org!.name}. Accept here: ${this.config.APP_URL}/accept-invite?token=${token}\nThe link works for 7 days.`,
    });
    await this.audit.record(actorOf(auth), { action: 'member.invited', targetType: 'invitation', targetId: id, after: { email, role: body.role } });
    return this.listInvitations(auth);
  }

  async revokeInvitation(auth: AuthContext, id: string) {
    const res = await this.invitations.updateOne({ id, orgId: auth.orgId, acceptedAt: null, revokedAt: null }, { $set: { revokedAt: new Date() } });
    if (!res.matchedCount) throw new NotFoundException('Invitation not found');
    await this.audit.record(actorOf(auth), { action: 'invitation.revoked', targetType: 'invitation', targetId: id });
    return this.listInvitations(auth);
  }

  /**
   * The link proves the invitee controls the email. A new person sets their
   * name and password here (their email counts as confirmed); an existing
   * user confirms with their password.
   */
  async accept(body: { token: string; name?: string; password: string }, meta: RequestMeta) {
    const inv = await this.invitations.findOne({ tokenHash: hashToken(body.token), acceptedAt: null, revokedAt: null, expiresAt: { $gt: new Date() } });
    if (!inv) throw new BadRequestException('This invitation is not valid any more. Ask for a new one.');
    let user = await this.users.findOne({ email: inv.email });
    if (user) {
      if (!(await argon2.verify(user.passwordHash, body.password))) throw new UnauthorizedException('Password is not right');
    } else {
      if (!body.name) throw new BadRequestException({ message: 'Some fields are not valid', errors: [{ field: 'name', message: 'Enter your name' }] });
      user = await this.users.create({ id: newId(), email: inv.email, name: body.name, passwordHash: await this.authService.hashPassword(body.password), emailVerifiedAt: new Date() });
    }
    await this.memberships.updateOne(
      { orgId: inv.orgId, userId: user.id },
      { $set: { role: inv.role, status: 'ACTIVE' }, $setOnInsert: { id: newId(), orgId: inv.orgId, userId: user.id } },
      { upsert: true },
    );
    inv.set({ acceptedAt: new Date() });
    await inv.save();
    await this.audit.record({ orgId: inv.orgId, actorId: user.id, ...meta }, { action: 'invitation.accepted', targetType: 'invitation', targetId: inv.id, after: { role: inv.role } });
    return { message: 'You have joined. Sign in to continue.', orgId: inv.orgId };
  }
}
