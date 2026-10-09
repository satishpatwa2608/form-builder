import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { AuthContext } from '../auth/auth-context';
import { Folder, Grant, type FolderDocument, type GrantDocument } from './access.schemas';
import { isAllowed, PERMISSIONS, type OrgRole, type Permission, type ResourceRef } from './roles';

/** The single place permission decisions are made (docs/plan.md, section 4.2). */
@Injectable()
export class PermissionService {
  constructor(
    @InjectModel(Grant.name) private readonly grants: Model<GrantDocument>,
    @InjectModel(Folder.name) private readonly folders: Model<FolderDocument>,
  ) {}

  private grantsOf(auth: AuthContext) {
    return this.grants.find({ orgId: auth.orgId, userId: auth.userId }).lean();
  }

  async can(auth: AuthContext, permission: Permission, resource?: ResourceRef): Promise<boolean> {
    if (isAllowed(auth.role, [], permission)) return true;
    if (!resource) return false;
    return isAllowed(auth.role, await this.grantsOf(auth), permission, resource);
  }

  async assert(auth: AuthContext, permission: Permission, resource?: ResourceRef): Promise<void> {
    if (!(await this.can(auth, permission, resource))) throw new ForbiddenException("You don't have permission to do that");
  }

  /** Everything this user may do on a resource (for the UI). */
  async effective(auth: AuthContext, resource: ResourceRef): Promise<Permission[]> {
    const grants = await this.grantsOf(auth);
    return PERMISSIONS.filter((p) => isAllowed(auth.role, grants, p, resource));
  }

  /** Of these members, the ones who may do `permission` on a resource (for telling the right people about it). */
  async whoCan(orgId: string, members: readonly { userId: string; role: OrgRole }[], permission: Permission, resource: ResourceRef): Promise<string[]> {
    const grants = await this.grants.find({ orgId, userId: { $in: members.map((m) => m.userId) } }).lean();
    return members.filter((m) => isAllowed(m.role, grants.filter((g) => g.userId === m.userId), permission, resource)).map((m) => m.userId);
  }

  async folderRef(orgId: string, folderId: string): Promise<ResourceRef> {
    const folder = await this.folders.findOne({ orgId, id: folderId }).lean();
    if (!folder) throw new NotFoundException('Folder not found');
    return { type: 'folder', id: folder.id, folderPath: folder.path };
  }
}
