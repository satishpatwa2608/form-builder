import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Auth, type AuthContext } from '../auth/auth-context';
import { RequirePermission } from '../auth/auth.guard';
import { idParam } from '../common/id-param';
import { ZodBody } from '../common/zod-body';
import { AccessService } from './access.service';
import { SCOPED_ROLES } from './roles';

const name = z.string().trim().min(1).max(100);
const id = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const folderBody = z.object({ name, parentId: id.nullable().optional() });
const renameBody = z.object({ name });
const grantBody = z.object({ userId: id, role: z.enum(SCOPED_ROLES), scope: z.object({ type: z.enum(['folder', 'form', 'connector']), id }) });
const grantQuery = z.object({ userId: id.optional(), scopeType: z.enum(['folder', 'form', 'connector']).optional(), scopeId: id.optional() });

@Controller()
export class AccessController {
  constructor(private readonly access: AccessService) {}

  @Get('folders')
  folders(@Auth() auth: AuthContext) {
    return this.access.listFolders(auth);
  }

  @Post('folders')
  createFolder(@Auth() auth: AuthContext, @Body(new ZodBody(folderBody)) body: z.infer<typeof folderBody>) {
    return this.access.createFolder(auth, body);
  }

  @Get('folders/:id/permissions')
  folderPermissions(@Auth() auth: AuthContext, @Param('id') folderId: string) {
    return this.access.folderPermissions(auth, idParam(folderId));
  }

  @Patch('folders/:id')
  renameFolder(@Auth() auth: AuthContext, @Param('id') folderId: string, @Body(new ZodBody(renameBody)) body: z.infer<typeof renameBody>) {
    return this.access.renameFolder(auth, idParam(folderId), body.name);
  }

  @Delete('folders/:id')
  deleteFolder(@Auth() auth: AuthContext, @Param('id') folderId: string) {
    return this.access.deleteFolder(auth, idParam(folderId));
  }

  @Get('grants')
  @RequirePermission('roles.grant')
  grants(@Auth() auth: AuthContext, @Query(new ZodBody(grantQuery)) query: z.infer<typeof grantQuery>) {
    return this.access.listGrants(auth, query);
  }

  @Post('grants')
  @RequirePermission('roles.grant')
  createGrant(@Auth() auth: AuthContext, @Body(new ZodBody(grantBody)) body: z.infer<typeof grantBody>) {
    return this.access.createGrant(auth, body);
  }

  @Delete('grants/:id')
  @RequirePermission('roles.grant')
  deleteGrant(@Auth() auth: AuthContext, @Param('id') grantId: string) {
    return this.access.deleteGrant(auth, idParam(grantId));
  }
}
