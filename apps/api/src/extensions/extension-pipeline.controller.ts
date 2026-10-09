import { Body, Controller, Get, Headers, HttpCode, Ip, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { Public } from '../auth/auth.guard';
import { ZodBody } from '../common/zod-body';
import { THROTTLE } from '../work/constants';
import { FormThrottlerGuard } from '../work/controllers/form-throttler.guard';
import { ExtensionDeployService } from './extension-deploy.service';

const deployBody = z.object({ tag: z.string().min(1).max(100) });

/**
 * For an organisation's pipeline (a GitHub Action, say): push and deploy its extension on every commit, with
 * the organisation's deploy key in place of a signed-in administrator. The key opens these three routes only.
 */
@Public()
@Controller('extensions/pipeline')
@UseGuards(FormThrottlerGuard)
export class ExtensionPipelineController {
  constructor(private readonly deploys: ExtensionDeployService) {}

  private caller(authorization: string | undefined, ip: string, userAgent: string | undefined) {
    return this.deploys.callerFor(/^Bearer (\S+)$/.exec(authorization ?? '')?.[1] ?? '', ip, userAgent ?? '');
  }

  @Post('login')
  @HttpCode(200)
  @Throttle({ default: THROTTLE.submit })
  async login(@Headers('authorization') authorization: string | undefined, @Ip() ip: string, @Headers('user-agent') agent?: string) {
    return this.deploys.pushLogin(await this.caller(authorization, ip, agent));
  }

  @Post('deploy')
  @HttpCode(202)
  @Throttle({ default: THROTTLE.submit })
  async deploy(@Headers('authorization') authorization: string | undefined, @Ip() ip: string, @Body(new ZodBody(deployBody)) body: z.infer<typeof deployBody>, @Headers('user-agent') agent?: string) {
    const caller = await this.caller(authorization, ip, agent);
    return (await this.deploys.request(caller, body.tag)).deploys[0];
  }

  /** The latest request and how it went: asked again and again until it is no longer under way. */
  @Get('latest')
  @Throttle({ default: THROTTLE.read })
  async latest(@Headers('authorization') authorization: string | undefined, @Ip() ip: string, @Headers('user-agent') agent?: string) {
    return (await this.deploys.status(await this.caller(authorization, ip, agent))).deploys[0] ?? null;
  }
}
