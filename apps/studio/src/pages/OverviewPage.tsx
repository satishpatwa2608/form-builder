import { Link } from 'react-router-dom';
import { CheckCircle2, Circle } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { useFolders, useMembers } from '../lib/queries';
import { ROLE_LABEL } from '../lib/types';
import { Badge, Card, PageHead } from '../components/ui';

export default function OverviewPage() {
  const { me, can } = useAuth();
  const members = useMembers(can('members.view'));
  const folders = useFolders();
  if (!me) return null;
  const steps = [
    { done: me.user.twoFactorEnabled, text: 'Turn on two-factor sign-in', to: '/account' },
    { done: (members.data?.length ?? 0) > 1, text: 'Invite your team', to: '/members', needs: can('members.manage') },
    { done: (folders.data?.length ?? 0) > 0, text: 'Create folders for your forms', to: '/access', needs: can('folder.manage') },
    { done: me.org.require2fa, text: 'Require two-factor for everyone', to: '/settings', needs: can('org.manage') },
  ].filter((s) => s.needs !== false);
  const left = steps.filter((s) => !s.done).length;

  return (
    <>
      <PageHead title={`Welcome, ${me.user.name.split(' ')[0]}`} subtitle={`${me.org.name} · you are ${ROLE_LABEL[me.org.role].toLowerCase()}`} />
      <div className="st-stack">
        <div className="st-stats">
          <div className="st-card st-stat">
            <span>Members</span>
            <strong>{can('members.view') ? (members.data?.filter((m) => m.status === 'ACTIVE').length ?? '…') : '—'}</strong>
          </div>
          <div className="st-card st-stat">
            <span>Folders you can see</span>
            <strong>{folders.data?.length ?? '…'}</strong>
          </div>
          <div className="st-card st-stat">
            <span>Your sign-in</span>
            <strong>{me.user.twoFactorEnabled ? <Badge tone="success">Two-factor on</Badge> : <Badge tone="warn">Password only</Badge>}</strong>
          </div>
        </div>
        <Card title="Get set up" subtitle={left ? `${left} step${left > 1 ? 's' : ''} left` : 'All done - forms and connectors arrive next.'}>
          <ul className="st-stack" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 12 }}>
            {steps.map((s) => (
              <li key={s.text} className="st-row">
                {s.done ? <CheckCircle2 size={18} color="var(--fb-success)" /> : <Circle size={18} color="var(--fb-line-strong)" />}
                {s.done ? (
                  <span className="st-muted" style={{ textDecoration: 'line-through' }}>
                    {s.text}
                  </span>
                ) : (
                  <Link className="st-link" to={s.to}>
                    {s.text}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
