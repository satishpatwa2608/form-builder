import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { legacyModules } from '../../access/roles';
import type { AccessTokenPayload } from '../../auth/auth.guard';
import { Session, User, type SessionDocument, type UserDocument } from '../../auth/auth.schemas';
import { Membership, Organization, type MembershipDocument, type OrganizationDocument } from '../../orgs/org.schemas';

/** The signed-in caller, when a public endpoint is called with a valid token (Sangam's shape, kept for the ported code). */
export interface OptionalUser {
  uuid: string;
  orgId: string;
  email?: string;
  name?: string;
  employeeId?: string;
  modules?: string[];
}

/**
 * Who and which org a *public* request is for. Public endpoints are open to
 * anonymous callers, so the org comes from the form link (/f/:org/:code) and
 * a bearer token is checked only if one is sent - against a live session and
 * membership, like AuthGuard.
 */
@Injectable()
export class FormContextService {
  private readonly orgCache = new Map<string, { at: number }>();

  constructor(
    private readonly jwt: JwtService,
    @InjectModel(Organization.name) private readonly orgs: Model<OrganizationDocument>,
    @InjectModel(Session.name) private readonly sessions: Model<SessionDocument>,
    @InjectModel(Membership.name) private readonly memberships: Model<MembershipDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
  ) {}

  async resolveOrgId(orgKey: string | undefined): Promise<string> {
    const key = (orgKey ?? '').trim();
    if (!/^[A-Za-z0-9-]{1,64}$/.test(key)) throw new NotFoundException('Form not found');
    const cached = this.orgCache.get(key);
    if (cached && Date.now() - cached.at < 5 * 60_000) return key;
    if (!(await this.orgs.exists({ id: key }))) throw new NotFoundException('Form not found');
    this.orgCache.set(key, { at: Date.now() });
    return key;
  }

  /** Users have no phone number in this product yet. */
  async userPhone(_user: OptionalUser): Promise<string | undefined> {
    return undefined;
  }

  /** The caller if a valid bearer token is present; undefined if none. An invalid token is an error, not "anonymous". */
  async optionalUser(authorization: string | undefined): Promise<OptionalUser | undefined> {
    if (!authorization?.startsWith('Bearer ')) return undefined;
    try {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(authorization.slice(7), { algorithms: ['HS256'] });
      const session = await this.sessions.findOne({ id: payload.sid, userId: payload.sub, revokedAt: null, expiresAt: { $gt: new Date() } }).lean();
      if (!session) throw new Error('session ended');
      const membership = await this.memberships.findOne({ orgId: session.orgId, userId: session.userId, status: 'ACTIVE' }).lean();
      if (!membership) throw new Error('not a member');
      const user = await this.users.findOne({ id: session.userId }).select('email name').lean();
      return { uuid: session.userId, orgId: session.orgId, email: user?.email, name: user?.name, modules: legacyModules(membership.role) };
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
