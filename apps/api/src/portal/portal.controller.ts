import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/auth.guard';
import { THROTTLE } from '../work/constants';
import { FormThrottlerGuard } from '../work/controllers/form-throttler.guard';
import { FormContextService } from '../work/services/form-context.service';
import { PortalService } from './portal.service';

/** The requests portal, for the people an organisation serves. Nothing here needs a studio account. */
@Public()
@Controller('public/portal/:org')
@UseGuards(FormThrottlerGuard)
export class PortalController {
  constructor(
    private readonly portal: PortalService,
    private readonly context: FormContextService,
  ) {}

  @Get()
  @Throttle({ default: THROTTLE.read })
  async front(@Param('org') org: string) {
    return this.portal.front(await this.context.resolveOrgId(org));
  }

  @Post('link')
  @HttpCode(202)
  @Throttle({ default: THROTTLE.submit })
  async link(@Param('org') org: string, @Body() body: { email?: unknown }) {
    return this.portal.sendLink(await this.context.resolveOrgId(org), body?.email);
  }

  @Post('session')
  @HttpCode(200)
  @Throttle({ default: THROTTLE.submit })
  async open(@Param('org') org: string, @Body() body: { key?: unknown }) {
    return this.portal.open(await this.context.resolveOrgId(org), body?.key);
  }

  @Delete('session')
  @HttpCode(204)
  @Throttle({ default: THROTTLE.read })
  async close(@Param('org') org: string, @Headers('authorization') authorization?: string) {
    await this.portal.close(await this.context.resolveOrgId(org), authorization);
  }

  @Get('requests')
  @Throttle({ default: THROTTLE.read })
  async requests(@Param('org') org: string, @Headers('authorization') authorization?: string) {
    return this.portal.requests(await this.context.resolveOrgId(org), authorization);
  }
}
