import { ForbiddenException, Injectable, SetMetadata, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import type { Request } from 'express';
import type { Model } from 'mongoose';
import { isAllowed, legacyModules, type Permission } from '../access/roles';
import { clientIp } from '../common/request-meta';
import { Membership, Organization, type MembershipDocument, type OrganizationDocument } from '../orgs/org.schemas';
import type { AuthContext } from './auth-context';
import { Session, type SessionDocument } from './auth.schemas';

const PUBLIC = 'fb:public';
const WITHOUT_MFA = 'fb:without-mfa';
const PERMISSION = 'fb:permission';

/** No sign-in needed (sign-up, login, links from emails). */
export const Public = () => SetMetadata(PUBLIC, true);
/** Reachable while the org requires 2FA and this session has none yet (so the user can set it up). */
export const AllowWithoutMfa = () => SetMetadata(WITHOUT_MFA, true);
/** Org-wide permission the route needs. Resource-level checks use PermissionService in the service. */
export const RequirePermission = (permission: Permission) => SetMetadata(PERMISSION, permission);

export interface AccessTokenPayload {
  sub: string;
  sid: string;
}

/**
 * Global guard. Deny by default: every route needs a valid access token for a
 * live session whose user is an active member of the session's org, unless it
 * is marked @Public. The session and membership are checked on every request,
 * so revoking a session or removing a member takes effect immediately.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    @InjectModel(Session.name) private readonly sessions: Model<SessionDocument>,
    @InjectModel(Membership.name) private readonly memberships: Model<MembershipDocument>,
    @InjectModel(Organization.name) private readonly orgs: Model<OrganizationDocument>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta = <T>(key: string) => this.reflector.getAllAndOverride<T>(key, [context.getHandler(), context.getClass()]);
    if (meta<boolean>(PUBLIC)) return true;

    const req = context.switchToHttp().getRequest<Request & { auth?: AuthContext; user?: unknown }>();
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new UnauthorizedException('Sign in to continue');

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, { algorithms: ['HS256'] });
    } catch {
      throw new UnauthorizedException('Your session has expired');
    }
    const session = await this.sessions.findOne({ id: payload.sid, userId: payload.sub }).lean();
    if (!session || session.revokedAt || session.expiresAt < new Date()) throw new UnauthorizedException('Your session has ended');

    const membership = await this.memberships.findOne({ orgId: session.orgId, userId: session.userId, status: 'ACTIVE' }).lean();
    if (!membership) throw new ForbiddenException('You no longer have access to this organisation');

    if (!session.mfa && !meta<boolean>(WITHOUT_MFA)) {
      const org = await this.orgs.findOne({ id: session.orgId }).select('security').lean();
      if (org?.security?.require2fa) throw new ForbiddenException({ message: 'Your organisation requires two-factor sign-in', code: 'TWO_FACTOR_REQUIRED' });
    }

    const permission = meta<Permission>(PERMISSION);
    if (permission && !isAllowed(membership.role, [], permission)) throw new ForbiddenException("You don't have permission to do that");

    req.auth = {
      userId: session.userId,
      orgId: session.orgId,
      sessionId: session.id,
      role: membership.role,
      mfa: session.mfa,
      ip: clientIp(req.ip),
      userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
    };
    // The ported Sangam work code reads `req.user` in its own shape.
    req.user = { uuid: session.userId, orgId: session.orgId, modules: legacyModules(membership.role) };
    return true;
  }
}
