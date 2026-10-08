import { canAssignRole, isAllowed, type GrantLike } from './roles';

describe('isAllowed', () => {
  const grants: GrantLike[] = [
    { role: 'DESIGNER', scope: { type: 'folder', id: 'quality' } },
    { role: 'CONNECTOR_USER', scope: { type: 'connector', id: 'sales-db' } },
  ];

  it('org roles apply everywhere; the default is deny', () => {
    expect(isAllowed('ADMIN', [], 'members.manage')).toBe(true);
    expect(isAllowed('VIEWER', [], 'form.edit')).toBe(false);
    expect(isAllowed('VIEWER', [], 'form.edit', { type: 'form', id: 'f1', folderPath: ['other'] })).toBe(false);
  });

  it('a folder grant covers everything below that folder, and nothing else', () => {
    expect(isAllowed('VIEWER', grants, 'form.edit', { type: 'form', id: 'f1', folderPath: ['quality', 'audits'] })).toBe(true);
    expect(isAllowed('VIEWER', grants, 'form.edit', { type: 'folder', id: 'audits', folderPath: ['quality', 'audits'] })).toBe(true);
    expect(isAllowed('VIEWER', grants, 'form.edit', { type: 'form', id: 'f2', folderPath: ['hr'] })).toBe(false);
    // The grant's role limits it: a designer can't publish.
    expect(isAllowed('VIEWER', grants, 'form.publish', { type: 'form', id: 'f1', folderPath: ['quality'] })).toBe(false);
    // No org-wide action from a scoped grant.
    expect(isAllowed('VIEWER', grants, 'form.edit')).toBe(false);
  });

  it('a connector grant allows using that connector only, never managing it', () => {
    expect(isAllowed('DESIGNER', grants, 'connector.use', { type: 'connector', id: 'sales-db' })).toBe(true);
    expect(isAllowed('VIEWER', grants, 'connector.use', { type: 'connector', id: 'hr-db' })).toBe(false);
    expect(isAllowed('VIEWER', grants, 'connector.manage', { type: 'connector', id: 'sales-db' })).toBe(false);
  });
});

describe('canAssignRole', () => {
  it('no escalation: only roles whose permissions the actor holds; only owners make owners', () => {
    expect(canAssignRole('OWNER', 'OWNER')).toBe(true);
    expect(canAssignRole('ADMIN', 'OWNER')).toBe(false);
    expect(canAssignRole('ADMIN', 'ADMIN')).toBe(true);
    expect(canAssignRole('ADMIN', 'DESIGNER')).toBe(true);
    expect(canAssignRole('DESIGNER', 'VIEWER')).toBe(true);
    expect(canAssignRole('DESIGNER', 'PUBLISHER')).toBe(false);
  });
});
