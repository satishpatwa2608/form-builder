import { Controller, Get, Param, Post } from '@nestjs/common';
import { Auth, type AuthContext } from '../auth/auth-context';
import { RequirePermission } from '../auth/auth.guard';
import { idParam } from '../common/id-param';
import { ExtensionsService } from './extensions.service';

/**
 * An organisation's extensions. Installing one is an operator's job (the
 * `extension` command); here admins see what theirs offers and re-read it
 * after a new version, and designers get the lists and checks to pick from.
 */
@Controller('extensions')
export class ExtensionsController {
  constructor(private readonly extensions: ExtensionsService) {}

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

  /** Checks a designer can switch on for a form. */
  @Get('checks')
  checks(@Auth() auth: AuthContext) {
    return this.extensions.checks(auth.orgId);
  }
}
