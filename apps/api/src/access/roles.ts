/**
 * Roles and permissions (docs/plan.md, section 4). An org role (on the
 * membership) applies everywhere in the org; a grant gives a role on one
 * folder (and everything inside it), form or connector.
 */
export const PERMISSIONS = [
  'org.manage',
  'billing.manage',
  'members.view',
  'members.manage',
  'roles.grant',
  'audit.read',
  'folder.manage',
  'form.view',
  'form.edit',
  'form.publish',
  'connector.use',
  'connector.manage',
  'record.work',
  'record.admin',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ORG_ROLES = ['OWNER', 'ADMIN', 'CONNECTOR_MANAGER', 'DESIGNER', 'PUBLISHER', 'RECORDS_WORKER', 'VIEWER'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** Roles that can be granted on a scope narrower than the org. */
export const SCOPED_ROLES = ['DESIGNER', 'PUBLISHER', 'RECORDS_WORKER', 'VIEWER', 'CONNECTOR_USER', 'CONNECTOR_MANAGER'] as const;
export type ScopedRole = (typeof SCOPED_ROLES)[number];
export type Role = OrgRole | ScopedRole;

const ALL = [...PERMISSIONS];
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  OWNER: ALL,
  ADMIN: ALL.filter((p) => p !== 'billing.manage'),
  CONNECTOR_MANAGER: ['members.view', 'form.view', 'connector.use', 'connector.manage'],
  DESIGNER: ['members.view', 'form.view', 'form.edit', 'connector.use', 'record.work'],
  PUBLISHER: ['members.view', 'form.view', 'form.publish'],
  RECORDS_WORKER: ['members.view', 'record.work'],
  VIEWER: ['form.view'],
  CONNECTOR_USER: ['connector.use'],
};

/** Which scoped roles make sense on which kind of scope. */
export const ROLES_FOR_SCOPE: Record<ScopeType, readonly ScopedRole[]> = {
  folder: ['DESIGNER', 'PUBLISHER', 'RECORDS_WORKER', 'VIEWER'],
  form: ['DESIGNER', 'PUBLISHER', 'RECORDS_WORKER', 'VIEWER'],
  connector: ['CONNECTOR_USER', 'CONNECTOR_MANAGER'],
};

export type ScopeType = 'folder' | 'form' | 'connector';

export interface GrantLike {
  role: ScopedRole;
  scope: { type: ScopeType; id: string };
}

/** What a permission is being checked against. Omit for org-wide actions. */
export interface ResourceRef {
  type: ScopeType;
  id: string;
  /** Folder ids from the root down to the resource's own folder (for a folder: including itself). */
  folderPath?: string[];
}

export const permissionsOf = (role: Role): readonly Permission[] => ROLE_PERMISSIONS[role] ?? [];

/**
 * Deny by default. Allowed when the org role has the permission, or a grant
 * whose role has it covers the resource: the same form/connector, or a folder
 * on the resource's folder path (grants inherit downwards).
 */
export function isAllowed(orgRole: OrgRole, grants: readonly GrantLike[], permission: Permission, resource?: ResourceRef): boolean {
  if (permissionsOf(orgRole).includes(permission)) return true;
  if (!resource) return false;
  return grants.some((g) => {
    if (!permissionsOf(g.role).includes(permission)) return false;
    if (g.scope.type === 'folder') return !!resource.folderPath?.includes(g.scope.id);
    return g.scope.type === resource.type && g.scope.id === resource.id;
  });
}

/** An actor may hand out a role only if they hold every permission in it (no escalation); only owners make owners. */
export function canAssignRole(actorRole: OrgRole, role: Role): boolean {
  if (role === 'OWNER') return actorRole === 'OWNER';
  const mine = permissionsOf(actorRole);
  return permissionsOf(role).every((p) => mine.includes(p));
}

/**
 * Sangam's module list for a role, as the ported work code checks it
 * (record admins = 'All'; anyone who works records gets the records module).
 */
export function legacyModules(role: OrgRole): string[] {
  if (isAllowed(role, [], 'record.admin')) return ['All'];
  return isAllowed(role, [], 'record.work') ? ['FormPlatformRecordsModule'] : [];
}
