import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { Auth, type AuthContext } from '../auth/auth-context';
import { Public } from '../auth/auth.guard';
import { idParam } from '../common/id-param';
import { ZodBody } from '../common/zod-body';
import { GatewaysService } from './gateways.service';

const createBody = z.object({ name: z.string().trim().min(1).max(80) });
const registerBody = z.object({ token: z.string().regex(/^fbreg_[A-Za-z0-9_-]{20,}$/) });

@Controller('gateways')
export class GatewaysController {
  constructor(private readonly gateways: GatewaysService) {}

  /** Called by the agent itself (no user), with its one-time token. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('register')
  @HttpCode(200)
  register(@Body(new ZodBody(registerBody)) body: z.infer<typeof registerBody>) {
    return this.gateways.register(body.token);
  }

  @Get()
  list(@Auth() auth: AuthContext) {
    return this.gateways.list(auth);
  }

  @Post()
  create(@Auth() auth: AuthContext, @Body(new ZodBody(createBody)) body: z.infer<typeof createBody>) {
    return this.gateways.create(auth, body.name);
  }

  @Delete(':id')
  revoke(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.gateways.revoke(auth, idParam(id));
  }
}
