import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { Auth, type AuthContext } from '../auth/auth-context';
import { RequirePermission } from '../auth/auth.guard';
import { idParam } from '../common/id-param';
import { ListsService, type ListInput } from './lists.service';

/** Master data: lists of choices kept once and used by dropdowns on many forms. Everyone can read; administrators change. */
@Controller('lists')
export class ListsController {
  constructor(private readonly lists: ListsService) {}

  @Get()
  list(@Auth() auth: AuthContext) {
    return this.lists.list(auth);
  }

  /** For the builder's "where do the options come from". */
  @Get('sources')
  sources(@Auth() auth: AuthContext) {
    return this.lists.sources(auth.orgId);
  }

  @Post()
  @RequirePermission('org.manage')
  create(@Auth() auth: AuthContext, @Body() body: ListInput) {
    return this.lists.create(auth, body ?? {});
  }

  @Put(':id')
  @RequirePermission('org.manage')
  update(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: ListInput) {
    return this.lists.update(auth, idParam(id), body ?? {});
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('org.manage')
  remove(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.lists.remove(auth, idParam(id));
  }
}
