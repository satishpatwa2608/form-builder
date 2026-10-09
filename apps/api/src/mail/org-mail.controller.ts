import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { Auth, type AuthContext } from '../auth/auth-context';
import { RequirePermission } from '../auth/auth.guard';
import { ZodBody } from '../common/zod-body';
import { OrgMailService } from './org-mail.service';

const body = z.object({
  provider: z.enum(['DEFAULT', 'SMTP', 'MICROSOFT']).optional(),
  from: z.string().max(320).optional(),
  fromName: z.string().max(100).optional(),
  smtp: z.object({ host: z.string().max(253).optional(), port: z.number().int().min(1).max(65535).optional(), security: z.enum(['STARTTLS', 'TLS']).optional(), username: z.string().max(320).optional(), password: z.string().max(1000).optional() }).optional(),
  microsoft: z.object({ tenantId: z.string().max(100).optional(), clientId: z.string().max(100).optional(), clientSecret: z.string().max(1000).optional() }).optional(),
});
const useBody = z.object({ enabled: z.boolean() });

/** The organisation's own mail server, for emails to the people who fill in its forms. */
@Controller('org/mail')
export class OrgMailController {
  constructor(private readonly mail: OrgMailService) {}

  @Get()
  @RequirePermission('org.manage')
  settings(@Auth() auth: AuthContext) {
    return this.mail.settings(auth);
  }

  @Put()
  @RequirePermission('org.manage')
  update(@Auth() auth: AuthContext, @Body(new ZodBody(body)) input: z.infer<typeof body>) {
    return this.mail.update(auth, input);
  }

  /** Each test connects to a server of the admin's choosing: a few a minute is plenty. */
  @Post('test')
  @HttpCode(200)
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @RequirePermission('org.manage')
  test(@Auth() auth: AuthContext) {
    return this.mail.test(auth);
  }

  @Post('use')
  @HttpCode(200)
  @RequirePermission('org.manage')
  use(@Auth() auth: AuthContext, @Body(new ZodBody(useBody)) input: z.infer<typeof useBody>) {
    return this.mail.use(auth, input.enabled);
  }
}
