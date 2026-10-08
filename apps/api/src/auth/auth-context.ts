import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { OrgRole } from '../access/roles';

/** Who is calling, set by AuthGuard from the access token + a live session and membership check. */
export interface AuthContext {
  userId: string;
  orgId: string;
  sessionId: string;
  role: OrgRole;
  /** A second factor was verified for this session. */
  mfa: boolean;
  ip: string;
  userAgent: string;
}

export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => ctx.switchToHttp().getRequest().auth);
