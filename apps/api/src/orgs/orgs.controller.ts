import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { ORG_ROLES } from '../access/roles';
import { Auth, type AuthContext } from '../auth/auth-context';
import { password } from '../auth/auth.controller';
import { Public, RequirePermission } from '../auth/auth.guard';
import { Meta, type RequestMeta } from '../common/request-meta';
import { ZodBody } from '../common/zod-body';
import { idParam } from '../common/id-param';
import { OrgsService } from './orgs.service';

const orgName = z.string().trim().min(1).max(100);
const updateOrgBody = z.object({ name: orgName.optional(), security: z.object({ require2fa: z.boolean().optional(), requireReview: z.boolean().optional() }).optional(), portal: z.object({ enabled: z.boolean().optional(), title: z.string().trim().max(80).optional(), intro: z.string().trim().max(500).optional() }).optional() });
const createOrgBody = z.object({ name: orgName, plan: z.enum(['FREE', 'TEAM', 'BUSINESS', 'ENTERPRISE']).optional() });
const memberBody = z
  .object({
    role: z.enum(ORG_ROLES).optional(),
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
    department: z.string().trim().max(60).optional(),
    managerId: z.string().regex(/^[A-Za-z0-9-]{0,64}$/).optional(),
  })
  .refine((b) => b.role || b.status || b.department !== undefined || b.managerId !== undefined, 'Nothing to change');
const inviteBody = z.object({ email: z.string().trim().email().max(254), role: z.enum(ORG_ROLES) });
const acceptBody = z.object({ token: z.string().min(10).max(200), name: z.string().trim().min(1).max(100).optional(), password });

@Controller()
export class OrgsController {
  constructor(private readonly orgs: OrgsService) {}

  @Get('org')
  get(@Auth() auth: AuthContext) {
    return this.orgs.get(auth);
  }

  @Patch('org')
  @RequirePermission('org.manage')
  update(@Auth() auth: AuthContext, @Body(new ZodBody(updateOrgBody)) body: z.infer<typeof updateOrgBody>) {
    return this.orgs.update(auth, body);
  }

  @Post('orgs')
  create(@Auth() auth: AuthContext, @Body(new ZodBody(createOrgBody)) body: z.infer<typeof createOrgBody>) {
    return this.orgs.create(auth, body.name, body.plan);
  }

  @Get('members')
  @RequirePermission('members.view')
  members(@Auth() auth: AuthContext) {
    return this.orgs.members(auth);
  }

  @Patch('members/:userId')
  @RequirePermission('members.manage')
  updateMember(@Auth() auth: AuthContext, @Param('userId') id: string, @Body(new ZodBody(memberBody)) body: z.infer<typeof memberBody>) {
    return this.orgs.updateMember(auth, idParam(id), body);
  }

  @Delete('members/:userId')
  @RequirePermission('members.manage')
  removeMember(@Auth() auth: AuthContext, @Param('userId') id: string) {
    return this.orgs.removeMember(auth, idParam(id));
  }

  /** Static route before the :id ones. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('invitations/accept')
  @HttpCode(200)
  accept(@Body(new ZodBody(acceptBody)) body: z.infer<typeof acceptBody>, @Meta() meta: RequestMeta) {
    return this.orgs.accept(body, meta);
  }

  @Get('invitations')
  @RequirePermission('members.manage')
  invitations(@Auth() auth: AuthContext) {
    return this.orgs.listInvitations(auth);
  }

  @Post('invitations')
  @RequirePermission('members.manage')
  invite(@Auth() auth: AuthContext, @Body(new ZodBody(inviteBody)) body: z.infer<typeof inviteBody>) {
    return this.orgs.invite(auth, body);
  }

  @Delete('invitations/:id')
  @RequirePermission('members.manage')
  revoke(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.orgs.revokeInvitation(auth, idParam(id));
  }
}
