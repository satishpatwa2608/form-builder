import { useState } from 'react';
import { useAuth } from '../lib/auth';
import { useAudit, useMembers } from '../lib/queries';
import type { AuditEntry } from '../lib/types';
import { Avatar, Badge, Button, Card, PageHead } from '../components/ui';

/** Plain-language names for audit actions. */
export const ACTION_LABEL: Record<string, string> = {
  'auth.signup': 'Created the organisation',
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'auth.login_failed': 'Failed sign-in',
  'auth.login_locked': 'Sign-in while locked',
  'auth.2fa_failed': 'Wrong two-factor code',
  'auth.2fa_enabled': 'Turned on two-factor',
  'auth.2fa_disabled': 'Turned off two-factor',
  'auth.password_changed': 'Changed password',
  'auth.password_reset': 'Reset password',
  'auth.email_verified': 'Confirmed email',
  'auth.refresh_reused': 'Stolen session blocked',
  'org.created': 'Created organisation',
  'org.updated': 'Changed organisation settings',
  'member.invited': 'Invited a member',
  'invitation.revoked': 'Withdrew an invitation',
  'invitation.accepted': 'Joined',
  'member.updated': 'Changed a member',
  'member.removed': 'Removed a member',
  'folder.created': 'Created a folder',
  'folder.renamed': 'Renamed a folder',
  'folder.deleted': 'Deleted a folder',
  'grant.created': 'Gave folder access',
  'grant.removed': 'Removed folder access',
  'form.created': 'Created a form',
  'form.published': 'Published a form',
  'form.version_created': 'Started a new form version',
  'form.archived': 'Archived a form',
  'form.deleted': 'Deleted a form draft',
  'form.moved': 'Moved a form',
  'style.saved': 'Saved a style',
  'style.deleted': 'Deleted a style',
};
const RISKY = new Set(['auth.login_failed', 'auth.login_locked', 'auth.2fa_failed', 'auth.refresh_reused', 'auth.2fa_disabled', 'member.removed']);

const describe = (e: AuditEntry) => {
  const v = e.after ?? e.before;
  if (!v) return '';
  return Object.entries(v)
    .filter(([, x]) => x !== null && x !== '' && typeof x !== 'object')
    .map(([k, x]) => `${k}: ${String(x)}`)
    .join(' · ');
};

export default function AuditPage() {
  const { can } = useAuth();
  const members = useMembers(can('members.view'));
  const [action, setAction] = useState('');
  const [pages, setPages] = useState<(string | undefined)[]>([undefined]);
  const who = (id: string) => members.data?.find((m) => m.userId === id)?.name ?? 'Someone';

  return (
    <>
      <PageHead
        title="Audit log"
        subtitle="Everything that changed, who did it and from where. Entries can't be edited or deleted."
        actions={
          <select className="st-select" style={{ width: 240 }} aria-label="Filter by action" value={action} onChange={(e) => (setAction(e.target.value), setPages([undefined]))}>
            <option value="">All activity</option>
            {Object.entries(ACTION_LABEL).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        }
      />
      <Card bodyless>
        <div className="st-table-wrap">
          <table className="st-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>What</th>
                <th>Details</th>
                <th>From</th>
              </tr>
            </thead>
            {pages.map((before, i) => (
              <AuditRows key={before ?? 'first'} action={action} before={before} who={who} onMore={i === pages.length - 1 ? (next) => setPages([...pages, next]) : undefined} />
            ))}
          </table>
        </div>
      </Card>
    </>
  );
}

function AuditRows({ action, before, who, onMore }: { action: string; before?: string; who: (id: string) => string; onMore?: (next: string) => void }) {
  const { data, isLoading } = useAudit(action, before);
  if (isLoading) {
    return (
      <tbody>
        <tr>
          <td colSpan={5} className="st-empty">
            Loading…
          </td>
        </tr>
      </tbody>
    );
  }
  if (!data?.entries.length && !before) {
    return (
      <tbody>
        <tr>
          <td colSpan={5} className="st-empty">
            Nothing recorded yet.
          </td>
        </tr>
      </tbody>
    );
  }
  return (
    <tbody>
      {data?.entries.map((e) => (
        <tr key={e.id}>
          <td className="st-muted" style={{ whiteSpace: 'nowrap' }}>
            {new Date(e.at).toLocaleString()}
          </td>
          <td>
            <div className="st-person">
              <Avatar name={who(e.actorId)} />
              <strong>{who(e.actorId)}</strong>
            </div>
          </td>
          <td>{RISKY.has(e.action) ? <Badge tone="danger">{ACTION_LABEL[e.action] ?? e.action}</Badge> : (ACTION_LABEL[e.action] ?? e.action)}</td>
          <td className="st-muted">{describe(e)}</td>
          <td className="st-mono st-muted">{e.ip || '—'}</td>
        </tr>
      ))}
      {onMore && data?.next && (
        <tr>
          <td colSpan={5} style={{ textAlign: 'center' }}>
            <Button variant="secondary" size="sm" onClick={() => onMore(data.next!)}>
              Load older
            </Button>
          </td>
        </tr>
      )}
    </tbody>
  );
}
