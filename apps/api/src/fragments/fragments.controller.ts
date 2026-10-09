import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { Auth, type AuthContext } from '../auth/auth-context';
import { RequirePermission } from '../auth/auth.guard';
import { idParam } from '../common/id-param';
import { FragmentsService } from './fragments.service';

/** The fragment library: everyone in the org can place fragments on forms; admins manage it (like styles). */
@Controller('fragments')
export class FragmentsController {
  constructor(private readonly fragments: FragmentsService) {}

  @Get()
  list(@Auth() auth: AuthContext) {
    return this.fragments.list(auth);
  }

  @Post()
  @RequirePermission('org.manage')
  create(@Auth() auth: AuthContext, @Body() body: unknown) {
    return this.fragments.create(auth, body);
  }

  @Put(':id')
  @RequirePermission('org.manage')
  update(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return this.fragments.update(auth, idParam(id), body);
  }

  @Delete(':id')
  @RequirePermission('org.manage')
  remove(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.fragments.remove(auth, idParam(id));
  }
}
