export type OrgRole = 'OWNER' | 'ADMIN' | 'CONNECTOR_MANAGER' | 'DESIGNER' | 'PUBLISHER' | 'RECORDS_WORKER' | 'VIEWER';
export type ScopedRole = 'DESIGNER' | 'PUBLISHER' | 'RECORDS_WORKER' | 'VIEWER' | 'CONNECTOR_USER' | 'CONNECTOR_MANAGER';
export type Permission =
  | 'org.manage'
  | 'billing.manage'
  | 'members.view'
  | 'members.manage'
  | 'roles.grant'
  | 'audit.read'
  | 'folder.manage'
  | 'form.view'
  | 'form.edit'
  | 'form.publish'
  | 'connector.use'
  | 'connector.manage'
  | 'record.work'
  | 'record.admin';

export interface Me {
  user: { id: string; name: string; email: string; twoFactorEnabled: boolean };
  org: { id: string; name: string; role: OrgRole; permissions: Permission[]; require2fa: boolean; requireReview?: boolean; /** Minutes away before being signed out; 0 is never. */ idleMinutes?: number };
  session: { mfa: boolean };
  orgs: { id: string; name: string; role: OrgRole }[];
  /** One of the people who run this installation: may add organisations and choose their plan. */
  operator?: boolean;
  /** Whether this person may add an organisation (anyone where sign-up is open; operators where it is closed). */
  canCreateOrgs?: boolean;
}

export interface Member {
  userId: string;
  name: string;
  email: string;
  role: OrgRole;
  status: 'ACTIVE' | 'DISABLED';
  /** Optional: form teams can be whole departments. */
  department: string;
  /** Optional: approves / is told when their reports' work needs it. */
  managerId: string;
  twoFactorEnabled: boolean;
  /** Away (out of office): new work meant for them goes to `toUserId` meanwhile. */
  away?: { set: boolean; now: boolean; from: string | null; until: string | null; toUserId: string };
}

export interface Invitation {
  id: string;
  email: string;
  role: OrgRole;
  expiresAt: string;
}

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  path: string[];
}

export interface Grant {
  id: string;
  userId: string;
  role: ScopedRole;
  scope: { type: 'folder' | 'form' | 'connector'; id: string };
}

export interface AuditEntry {
  id: string;
  action: string;
  actorId: string;
  targetType: string;
  targetId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string;
  userAgent: string;
  at: string;
}

export const ROLE_LABEL: Record<OrgRole | ScopedRole, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  CONNECTOR_MANAGER: 'Connector manager',
  DESIGNER: 'Designer',
  PUBLISHER: 'Publisher',
  RECORDS_WORKER: 'Records worker',
  VIEWER: 'Viewer',
  CONNECTOR_USER: 'Connector user',
};

export const ROLE_HINT: Record<OrgRole, string> = {
  OWNER: 'Everything, including billing',
  ADMIN: 'Users, roles, settings, audit log, all connectors',
  CONNECTOR_MANAGER: 'Create connectors and manage their credentials',
  DESIGNER: 'Build forms and automations',
  PUBLISHER: 'Publish and retire forms',
  RECORDS_WORKER: 'Work the items assigned to them',
  VIEWER: 'Read-only',
};

export const ORG_ROLES: OrgRole[] = ['OWNER', 'ADMIN', 'CONNECTOR_MANAGER', 'DESIGNER', 'PUBLISHER', 'RECORDS_WORKER', 'VIEWER'];

export type FormStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

export interface FormSummary {
  id: string;
  code: string;
  name: string;
  folderId: string;
  version: number;
  status: FormStatus;
  publishedVersion: number | null;
  /** A version is live and open to anyone with its link. */
  publicLink?: boolean;
  updatedAt: string;
  permissions: Permission[];
  publishAt?: string | null;
  scheduleError?: string;
  /** Where a draft stands with its reviewers. */
  review?: 'NONE' | 'REQUESTED' | 'CHANGES_REQUESTED' | 'APPROVED';
}

export interface FormVersionRow {
  id: string;
  version: number;
  status: FormStatus;
  updatedAt: string;
  publishedAt: string | null;
}
