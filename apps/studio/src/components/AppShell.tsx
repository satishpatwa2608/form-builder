import { IdleSignOut } from './IdleSignOut';
import { useState } from 'react';
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { BarChart3, Building2, CalendarClock, ClipboardList, Database, FilePlus2, FolderTree, Home, Inbox, Library, ListChecks, LogOut, Mails, Menu, Palette, Puzzle, ScrollText, Settings, Terminal, UserRound, Users, Webhook, Workflow, type LucideIcon } from 'lucide-react';
import { NotificationBell } from './NotificationBell';
import { useAuth } from '../lib/auth';
import type { Permission } from '../lib/types';
import { ROLE_LABEL } from '../lib/types';
import { Alert, Avatar, Badge, Button, Logo } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Shown only with this permission. */
  needs?: Permission;
  soon?: boolean;
}

const WORK: NavItem[] = [
  { to: '/', label: 'Overview', icon: Home },
  { to: '/forms', label: 'Forms', icon: ClipboardList },
  { to: '/workflows', label: 'Workflows', icon: Workflow, needs: 'form.view' },
  { to: '/fragments', label: 'Fragments', icon: Library, needs: 'form.view' },
  { to: '/lists', label: 'Lists', icon: ListChecks, needs: 'form.view' },
  { to: '/email-templates', label: 'Email templates', icon: Mails, needs: 'form.view' },
  { to: '/styles', label: 'Styles', icon: Palette, needs: 'form.view' },
  { to: '/work', label: 'Work inbox', icon: Inbox, needs: 'record.work' },
  { to: '/work/dashboard', label: 'Dashboard', icon: BarChart3, needs: 'record.work' },
  { to: '/work/new', label: 'New work item', icon: FilePlus2, needs: 'record.work' },
  { to: '/connectors', label: 'Connectors', icon: Database, needs: 'connector.use' },
];
const ADMIN: NavItem[] = [
  { to: '/members', label: 'Members', icon: Users, needs: 'members.view' },
  { to: '/access', label: 'Folders & access', icon: FolderTree },
  { to: '/logs', label: 'Logs', icon: Terminal, needs: 'audit.read' },
  { to: '/audit', label: 'Audit trail', icon: ScrollText, needs: 'audit.read' },
  { to: '/settings', label: 'Organisation', icon: Settings, needs: 'org.manage' },
  { to: '/settings/working-time', label: 'Working time', icon: CalendarClock, needs: 'org.manage' },
  { to: '/settings/webhooks', label: 'Webhooks', icon: Webhook, needs: 'org.manage' },
  { to: '/settings/extensions', label: 'Extensions', icon: Puzzle, needs: 'org.manage' },
];

function Nav({ items, onPick }: { items: NavItem[]; onPick: () => void }) {
  const { can } = useAuth();
  return (
    <>
      {items
        .filter((i) => !i.needs || can(i.needs))
        .map(({ to, label, icon: Icon, soon }) =>
          soon ? (
            <span key={to} className="st-nav st-nav--soon" title="Coming in the next phase">
              <Icon size={17} />
              {label}
              <Badge>Soon</Badge>
            </span>
          ) : (
            <NavLink key={to} to={to} end={to === '/' || to === '/work' || to === '/settings'} className="st-nav" onClick={onPick}>
              <Icon size={17} />
              {label}
            </NavLink>
          ),
        )}
    </>
  );
}

export function AppShell() {
  const { me, signOut, switchOrg, needsTwoFactor } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  if (!me) return null;
  return (
    <div className="st-app">
      <IdleSignOut />
      <aside className="st-side" data-open={open}>
        <Logo />
        <nav className="st-side__nav" aria-label="Main">
          <Nav items={WORK} onPick={() => setOpen(false)} />
          <div className="st-side__label">Administration</div>
          <Nav items={ADMIN} onPick={() => setOpen(false)} />
          {me?.operator && (
            <>
              <div className="st-side__label">This installation</div>
              <NavLink to="/customers" className="st-nav" onClick={() => setOpen(false)}>
                <Building2 size={17} />
                Customers
              </NavLink>
            </>
          )}
        </nav>
        <div className="st-side__foot">
          <NavLink to="/account" className="st-nav" onClick={() => setOpen(false)}>
            <UserRound size={17} />
            Account & security
          </NavLink>
          <Button
            variant="ghost"
            onClick={async () => {
              await signOut();
              navigate('/login');
            }}
          >
            <LogOut size={16} /> Sign out
          </Button>
        </div>
      </aside>
      <div>
        <header className="st-top">
          <div className="st-row">
            <Button variant="secondary" size="sm" className="st-menu-btn" aria-label="Menu" onClick={() => setOpen(!open)}>
              <Menu size={16} />
            </Button>
            <select className="st-select st-orgpick" aria-label="Organisation" value={me.org.id} onChange={(e) => void switchOrg(e.target.value).then(() => navigate('/'))}>
              {me.orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            <Badge tone="accent">{ROLE_LABEL[me.org.role]}</Badge>
          </div>
          <div className="st-user">
            <NotificationBell />
            <span className="st-user__name">{me.user.name}</span>
            <Avatar name={me.user.name} />
          </div>
        </header>
        <main className="st-content">
          {needsTwoFactor && (
            <div style={{ marginBottom: 16 }}>
              <Alert tone="warn">{me.org.name} requires two-factor sign-in. Set it up below to continue.</Alert>
            </div>
          )}
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** Signed-out users go to sign-in (and come back); 2FA-required orgs send users to set it up first. `bare` skips the shell (full-screen tools). */
export function RequireAuth({ bare = false }: { bare?: boolean }) {
  const { status, needsTwoFactor } = useAuth();
  const location = useLocation();
  if (status === 'loading') {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }} aria-busy>
        <span className="st-spinner" style={{ width: 28, height: 28, color: 'var(--fb-accent)' }} />
      </div>
    );
  }
  if (status === 'signedOut') return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (needsTwoFactor && location.pathname !== '/account') return <Navigate to="/account" replace />;
  return bare ? <Outlet /> : <AppShell />;
}

/** Public auth pages bounce signed-in users to the app. */
export function PublicOnly({ children }: { children: JSX.Element }) {
  const { status } = useAuth();
  if (status === 'signedIn') return <Navigate to="/" replace />;
  return children;
}
