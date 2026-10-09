import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { Auth, type AuthContext } from '../auth/auth-context';
import { RequirePermission } from '../auth/auth.guard';
import { idParam } from '../common/id-param';
import { WorkflowsService } from './workflows.service';

/** The workflow library: everyone in the org can pick from it; admins manage it (like styles). */
@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  @Get()
  list(@Auth() auth: AuthContext) {
    return this.workflows.list(auth);
  }

  @Post()
  @RequirePermission('org.manage')
  create(@Auth() auth: AuthContext, @Body() body: unknown) {
    return this.workflows.create(auth, body);
  }

  @Put(':id')
  @RequirePermission('org.manage')
  update(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return this.workflows.update(auth, idParam(id), body);
  }

  @Delete(':id')
  @RequirePermission('org.manage')
  remove(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.workflows.remove(auth, idParam(id));
  }
}
