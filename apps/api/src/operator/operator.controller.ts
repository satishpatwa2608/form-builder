import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { Auth, type AuthContext } from '../auth/auth-context';
import { idParam } from '../common/id-param';
import { ZodBody } from '../common/zod-body';
import { PLAN_IDS } from '../plans/plans';
import { OperatorService } from './operator.service';

const email = z.string().trim().toLowerCase().email().max(254);
const createBody = z.object({ name: z.string().trim().min(2).max(80), plan: z.enum(PLAN_IDS), ownerEmail: email });
const planBody = z.object({ plan: z.enum(PLAN_IDS) });
const inviteBody = z.object({ email });

/**
 * The operator's console: the customers of this installation. Every route answers "not found" to anyone
 * who is not one of OPERATOR_EMAILS, whatever their role in their own organisation.
 */
@Controller('operator/customers')
export class OperatorController {
  constructor(private readonly operator: OperatorService) {}

  @Get()
  list(@Auth() auth: AuthContext) {
    return this.operator.list(auth);
  }

  @Post()
  create(@Auth() auth: AuthContext, @Body(new ZodBody(createBody)) body: z.infer<typeof createBody>) {
    return this.operator.create(auth, body);
  }

  @Patch(':id')
  setPlan(@Auth() auth: AuthContext, @Param('id') id: string, @Body(new ZodBody(planBody)) body: z.infer<typeof planBody>) {
    return this.operator.setPlan(auth, idParam(id), body.plan);
  }

  @Post(':id/owner-invitations')
  @HttpCode(200)
  inviteOwner(@Auth() auth: AuthContext, @Param('id') id: string, @Body(new ZodBody(inviteBody)) body: z.infer<typeof inviteBody>) {
    return this.operator.inviteOwner(auth, idParam(id), body.email);
  }
}
