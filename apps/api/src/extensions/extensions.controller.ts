import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { Auth, type AuthContext } from '../auth/auth-context';
import { RequirePermission } from '../auth/auth.guard';
import { idParam } from '../common/id-param';
import { ZodBody } from '../common/zod-body';
import { ExtensionDeployService } from './extension-deploy.service';
import { ExtensionsService } from './extensions.service';

const deployBody = z.object({ tag: z.string().min(1).max(100) });

/**
 * An organisation's extensions. Admins see what theirs offers and re-read it after a new version, and designers
 * get the lists and checks to pick from. Where the installation is set up for it, admins also deploy their own
 * code by themselves (the routes under /extensions/deploy); elsewhere an operator installs it for them.
 */
@Controller('extensions')
export class ExtensionsController {
  constructor(
    private readonly extensions: ExtensionsService,
    private readonly deploys: ExtensionDeployService,
  ) {}

  /** Whether the organisation can deploy its own code here, and how its last requests went. */
  @Get('deploy')
  @RequirePermission('org.manage')
  deployStatus(@Auth() auth: AuthContext) {
    return this.deploys.status(auth);
  }

  /** A password to push an image with: for an hour, to this organisation's own space. */
  @Post('deploy/login')
  @HttpCode(200)
  @RequirePermission('org.manage')
  pushLogin(@Auth() auth: AuthContext) {
    return this.deploys.pushLogin(auth);
  }

  @Get('deploy/images')
  @RequirePermission('org.manage')
  images(@Auth() auth: AuthContext) {
    return this.deploys.images(auth);
  }

  @Post('deploy')
  @HttpCode(202)
  @RequirePermission('org.manage')
  deploy(@Auth() auth: AuthContext, @Body(new ZodBody(deployBody)) body: z.infer<typeof deployBody>) {
    return this.deploys.request(auth, body.tag);
  }

  @Delete('deploy')
  @HttpCode(202)
  @RequirePermission('org.manage')
  undeploy(@Auth() auth: AuthContext) {
    return this.deploys.remove(auth);
  }

  @Get()
  @RequirePermission('org.manage')
  list(@Auth() auth: AuthContext) {
    return this.extensions.list(auth.orgId);
  }

  @Post(':id/refresh')
  @RequirePermission('org.manage')
  refresh(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.extensions.refresh(auth, idParam(id));
  }

  /** Dropdown lists a designer can bind (the same shape as /connectors/sources). */
  @Get('sources')
  sources(@Auth() auth: AuthContext) {
    return this.extensions.sources(auth.orgId);
  }

  /** Fields the organisation's own code draws, for a designer to place on a form. */
  @Get('fields')
  fields(@Auth() auth: AuthContext) {
    return this.extensions.fields(auth.orgId);
  }

  /** Checks a designer can switch on for a form. */
  @Get('checks')
  checks(@Auth() auth: AuthContext) {
    return this.extensions.checks(auth.orgId);
  }
}
