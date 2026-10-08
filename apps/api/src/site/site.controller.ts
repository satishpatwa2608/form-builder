import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { Auth, type AuthContext } from '../auth/auth-context';
import { Public, RequirePermission } from '../auth/auth.guard';
import { ZodBody } from '../common/zod-body';
import { FormContextService } from '../work/services/form-context.service';
import { THROTTLE } from '../work/constants';
import { SiteService } from './site.service';

const brandingBody = z.object({ logo: z.string().max(250_000).optional(), primaryColor: z.string().max(7).optional(), hidePoweredBy: z.boolean().optional() });
const domainBody = z.object({ host: z.string().trim().min(4).max(253) });
const hostParam = z.string().regex(/^[a-z0-9.-]{4,253}$/);

@Controller('org')
export class SiteController {
  constructor(private readonly site: SiteService) {}

  @Get('branding')
  branding(@Auth() auth: AuthContext) {
    return this.site.branding(auth);
  }

  @Put('branding')
  @RequirePermission('org.manage')
  updateBranding(@Auth() auth: AuthContext, @Body(new ZodBody(brandingBody)) body: z.infer<typeof brandingBody>) {
    return this.site.updateBranding(auth, body);
  }

  @Get('domains')
  @RequirePermission('org.manage')
  domains(@Auth() auth: AuthContext) {
    return this.site.domains(auth);
  }

  @Post('domains')
  @RequirePermission('org.manage')
  addDomain(@Auth() auth: AuthContext, @Body(new ZodBody(domainBody)) body: z.infer<typeof domainBody>) {
    return this.site.addDomain(auth, body.host);
  }

  @Post('domains/:host/verify')
  @HttpCode(200)
  @RequirePermission('org.manage')
  verifyDomain(@Auth() auth: AuthContext, @Param('host', new ZodBody(hostParam)) host: string) {
    return this.site.verifyDomain(auth, host);
  }

  @Delete('domains/:host')
  @RequirePermission('org.manage')
  removeDomain(@Auth() auth: AuthContext, @Param('host', new ZodBody(hostParam)) host: string) {
    return this.site.removeDomain(auth, host);
  }
}

/** What the public form page needs before it renders: whose form, and how it looks. */
@Public()
@Controller('public')
export class SitePublicController {
  constructor(
    private readonly site: SiteService,
    private readonly context: FormContextService,
  ) {}

  @Get('orgs/:org/branding')
  @Throttle({ default: THROTTLE.read })
  async branding(@Param('org') org: string) {
    return this.site.publicBranding(await this.context.resolveOrgId(org));
  }

  @Get('domains/:host')
  @Throttle({ default: THROTTLE.read })
  async domain(@Param('host') host: string) {
    return { org: await this.site.orgForHost(host) };
  }
}
