import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { actorOf, AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import { newId } from '../common/crypto';
import { Connector, type ConnectorDocument } from '../connectors/connector.schema';
import { Form, type FormDocument } from '../forms/form.schema';
import { Membership, type MembershipDocument } from '../orgs/org.schemas';
import { Folder, Grant, type FolderDocument, type GrantDocument } from './access.schemas';
import { PermissionService } from './permission.service';
import { canAssignRole, isAllowed, ROLES_FOR_SCOPE, type ScopeType, type ScopedRole } from './roles';

@Injectable()
export class AccessService {
  constructor(
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
    @InjectModel(Folder.name) private readonly folders: Model<FolderDocument>,
    @InjectModel(Grant.name) private readonly grants: Model<GrantDocument>,
    @InjectModel(Membership.name) private readonly memberships: Model<MembershipDocument>,
    @InjectModel(Form.name) private readonly forms: Model<FormDocument>,
    @InjectModel(Connector.name) private readonly connectorModel: Model<ConnectorDocument>,
  ) {}

  // ---------------------------------------------------------------- folders

  /**
   * The folder tree this user may see: all of it with an org-wide role that
   * views forms; otherwise the folders their grants cover, plus the parents
   * needed to reach them.
   */
  async listFolders(auth: AuthContext) {
    const all = await this.folders.find({ orgId: auth.orgId }).sort({ name: 1 }).lean();
    const view = (f: (typeof all)[number]) => ({ id: f.id, name: f.name, parentId: f.parentId, path: f.path });
    if (isAllowed(auth.role, [], 'form.view')) return all.map(view);
    const granted = (await this.grants.find({ orgId: auth.orgId, userId: auth.userId, 'scope.type': 'folder' }).lean()).map((g) => g.scope.id);
    const visible = all.filter((f) => f.path.some((id) => granted.includes(id)) || all.some((c) => c.path.includes(f.id) && c.path.some((id) => granted.includes(id))));
    return visible.map(view);
  }

  /** Org folder managers anywhere; designers inside folders they can edit. */
  private async assertCanOrganise(auth: AuthContext, folderId: string | null) {
    if (isAllowed(auth.role, [], 'folder.manage')) return;
    if (folderId && (await this.permissions.can(auth, 'form.edit', await this.permissions.folderRef(auth.orgId, folderId)))) return;
    throw new ForbiddenException("You don't have permission to do that");
  }

  async createFolder(auth: AuthContext, body: { name: string; parentId?: string | null }) {
    const parentId = body.parentId ?? null;
    await this.assertCanOrganise(auth, parentId);
    const parent = parentId ? await this.folders.findOne({ orgId: auth.orgId, id: parentId }).lean() : null;
    if (parentId && !parent) throw new NotFoundException('Parent folder not found');
    if (parent && parent.path.length >= 8) throw new BadRequestException('Folders can be nested 8 levels deep');
    if (await this.folders.exists({ orgId: auth.orgId, parentId, name: body.name })) throw new ConflictException('A folder with that name already exists here');
    const id = newId();
    await this.folders.create({ id, orgId: auth.orgId, name: body.name, parentId, path: [...(parent?.path ?? []), id], createdBy: auth.userId });
    await this.audit.record(actorOf(auth), { action: 'folder.created', targetType: 'folder', targetId: id, after: { name: body.name, parentId } });
    return this.listFolders(auth);
  }

  async renameFolder(auth: AuthContext, id: string, name: string) {
    await this.assertCanOrganise(auth, id);
    const folder = await this.folders.findOne({ orgId: auth.orgId, id });
    if (!folder) throw new NotFoundException('Folder not found');
    if (await this.folders.exists({ orgId: auth.orgId, parentId: folder.parentId, name, id: { $ne: id } })) throw new ConflictException('A folder with that name already exists here');
    const before = { name: folder.name };
    folder.set({ name });
    await folder.save();
    await this.audit.record(actorOf(auth), { action: 'folder.renamed', targetType: 'folder', targetId: id, before, after: { name } });
    return this.listFolders(auth);
  }

  /** Only empty folders: no sub-folders and no forms (any version, deleted drafts aside). Its grants go with it. */
  async deleteFolder(auth: AuthContext, id: string) {
    await this.assertCanOrganise(auth, id);
    const folder = await this.folders.findOne({ orgId: auth.orgId, id }).lean();
    if (!folder) throw new NotFoundException('Folder not found');
    if (await this.folders.exists({ orgId: auth.orgId, parentId: id })) throw new ConflictException('Empty the folder first');
    if (await this.forms.exists({ orgId: auth.orgId, folderId: id, isDeleted: false })) throw new ConflictException('Move or delete the forms in this folder first');
    await this.folders.deleteOne({ orgId: auth.orgId, id });
    const removed = await this.grants.deleteMany({ orgId: auth.orgId, 'scope.type': 'folder', 'scope.id': id });
    await this.audit.record(actorOf(auth), { action: 'folder.deleted', targetType: 'folder', targetId: id, before: { name: folder.name, grants: removed.deletedCount } });
    return this.listFolders(auth);
  }

  async folderPermissions(auth: AuthContext, id: string) {
    return { folderId: id, permissions: await this.permissions.effective(auth, await this.permissions.folderRef(auth.orgId, id)) };
  }

  // ---------------------------------------------------------------- grants

  async listGrants(auth: AuthContext, query: { userId?: string; scopeType?: ScopeType; scopeId?: string }) {
    const filter: Record<string, unknown> = { orgId: auth.orgId };
    if (query.userId) filter.userId = query.userId;
    if (query.scopeType) filter['scope.type'] = query.scopeType;
    if (query.scopeId) filter['scope.id'] = query.scopeId;
    const rows = await this.grants.find(filter).sort({ createdAt: -1 }).limit(500).lean();
    return rows.map((g) => ({ id: g.id, userId: g.userId, role: g.role, scope: g.scope }));
  }

  async createGrant(auth: AuthContext, body: { userId: string; role: ScopedRole; scope: { type: ScopeType; id: string } }) {
    if (!canAssignRole(auth.role, body.role)) throw new ForbiddenException(`You can't give the ${body.role} role`);
    if (!ROLES_FOR_SCOPE[body.scope.type].includes(body.role)) throw new BadRequestException(`${body.role} can't be given on a ${body.scope.type}`);
    if (body.scope.type === 'form') throw new BadRequestException('Give access on the form\'s folder instead');
    if (body.scope.type === 'folder') await this.permissions.folderRef(auth.orgId, body.scope.id);
    else if (!(await this.connectorModel.exists({ orgId: auth.orgId, id: body.scope.id, isDeleted: false }))) throw new NotFoundException('Connector not found');
    if (!(await this.memberships.exists({ orgId: auth.orgId, userId: body.userId, status: 'ACTIVE' }))) throw new BadRequestException('That person is not an active member');
    if (await this.grants.exists({ orgId: auth.orgId, userId: body.userId, role: body.role, 'scope.type': body.scope.type, 'scope.id': body.scope.id })) {
      throw new ConflictException('They already have that role there');
    }
    const id = newId();
    await this.grants.create({ id, orgId: auth.orgId, userId: body.userId, role: body.role, scope: body.scope, createdBy: auth.userId });
    await this.audit.record(actorOf(auth), { action: 'grant.created', targetType: 'grant', targetId: id, after: { userId: body.userId, role: body.role, scope: `${body.scope.type}:${body.scope.id}` } });
    return this.listGrants(auth, { userId: body.userId });
  }

  async deleteGrant(auth: AuthContext, id: string) {
    const grant = await this.grants.findOne({ orgId: auth.orgId, id }).lean();
    if (!grant) throw new NotFoundException('Grant not found');
    if (!canAssignRole(auth.role, grant.role)) throw new ForbiddenException(`You can't take away the ${grant.role} role`);
    await this.grants.deleteOne({ orgId: auth.orgId, id });
    await this.audit.record(actorOf(auth), { action: 'grant.removed', targetType: 'grant', targetId: id, before: { userId: grant.userId, role: grant.role, scope: `${grant.scope.type}:${grant.scope.id}` } });
    return { removed: true };
  }
}
