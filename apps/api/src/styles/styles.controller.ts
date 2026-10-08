import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { Auth, type AuthContext } from '../auth/auth-context';
import { RequirePermission } from '../auth/auth.guard';
import { StylesService } from './styles.service';

/** Everyone in the org can use styles; admins manage the library (as in Sangam). */
@Controller('styles')
export class StylesController {
  constructor(private readonly styles: StylesService) {}

  @Get()
  list(@Auth() auth: AuthContext) {
    return this.styles.list(auth);
  }

  @Put(':key')
  @RequirePermission('org.manage')
  upsert(@Auth() auth: AuthContext, @Param('key') key: string, @Body() body: unknown) {
    return this.styles.upsert(auth, key, body);
  }

  @Delete(':key')
  @RequirePermission('org.manage')
  remove(@Auth() auth: AuthContext, @Param('key') key: string) {
    return this.styles.remove(auth, key);
  }
}
