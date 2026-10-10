import { Body, Controller, Delete, Get, Headers, HttpCode, Ip, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { Auth, type AuthContext } from '../auth/auth-context';
import { Public, RequirePermission } from '../auth/auth.guard';
import { idParam } from '../common/id-param';
import { ZodBody } from '../common/zod-body';
import { THROTTLE } from '../work/constants';
import { FormThrottlerGuard } from '../work/controllers/form-throttler.guard';
import { ExtensionRepoService } from './extension-repo.service';

const linkBody = z.object({ url: z.string().trim().min(1).max(300) });
const settingsBody = z.object({ branch: z.string().min(1).max(100).optional(), auto: z.boolean().optional() });

/** An organisation's administrators: the repository their extension is built from, and its builds. */
@Controller('extensions/repo')
export class ExtensionRepoController {
  constructor(private readonly repo: ExtensionRepoService) {}

  @Get()
  @RequirePermission('org.manage')
  view(@Auth() auth: AuthContext) {
    return this.repo.view(auth);
  }

  @Put()
  @RequirePermission('org.manage')
  link(@Auth() auth: AuthContext, @Body(new ZodBody(linkBody)) body: z.infer<typeof linkBody>) {
    return this.repo.connect(auth, body.url);
  }

  @Patch()
  @RequirePermission('org.manage')
  update(@Auth() auth: AuthContext, @Body(new ZodBody(settingsBody)) body: z.infer<typeof settingsBody>) {
    return this.repo.update(auth, body);
  }

  @Delete()
  @RequirePermission('org.manage')
  unlink(@Auth() auth: AuthContext) {
    return this.repo.disconnect(auth);
  }

  @Get('branches')
  @RequirePermission('org.manage')
  branches(@Auth() auth: AuthContext) {
    return this.repo.branches(auth);
  }

  /** "Deploy now". */
  @Post('builds')
  @HttpCode(202)
  @RequirePermission('org.manage')
  build(@Auth() auth: AuthContext) {
    return this.repo.buildNow(auth);
  }
}

/** Called from outside, with no session: the repository saying it changed, and the build machine at work. */
@Public()
@Controller('extensions')
@UseGuards(FormThrottlerGuard)
export class ExtensionBuildController {
  constructor(private readonly repo: ExtensionRepoService) {}

  @Post('repo/hook/:token')
  @HttpCode(202)
  @Throttle({ default: THROTTLE.upload })
  hook(@Param('token') token: string, @Body() body: unknown, @Ip() ip: string, @Headers('user-agent') agent?: string) {
    return this.repo.hook(token, body, { ip, userAgent: agent ?? '' });
  }

  @Post('builds/:id/job')
  @HttpCode(200)
  @Throttle({ default: THROTTLE.submit })
  job(@Param('id') id: string, @Body() body: { token?: unknown }) {
    return this.repo.job(idParam(id), body?.token);
  }

  @Post('builds/:id/result')
  @HttpCode(204)
  @Throttle({ default: THROTTLE.submit })
  async result(@Param('id') id: string, @Body() body: { token?: unknown; ok?: unknown; commit?: unknown; message?: unknown; log?: unknown }) {
    await this.repo.result(idParam(id), body ?? {});
  }
}
