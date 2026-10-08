import { useMemo } from 'react';
import { useAuth } from '../../lib/auth';

/**
 * What the signed-in user can do org-wide, in the names the ported Sangam
 * pages use. Per-form rights (from folders) come with each form instead.
 */
export function useFormPermissions() {
  const { can } = useAuth();
  return useMemo(
    () => ({
      canView: can('form.view'),
      canDesign: can('form.edit'),
      canPublish: can('form.publish'),
      /** Org settings pages (working time, webhooks). */
      canManagePages: can('org.manage'),
      canWorkRecords: can('record.work'),
      /** Sees every work item, saves views, sets the Inbox theme. */
      canAdminRecords: can('record.admin'),
      canBrowseForms: can('form.view'),
    }),
    [can],
  );
}
