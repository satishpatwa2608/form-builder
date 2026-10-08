import type { ReactNode } from 'react';
import { ClipboardList, Database, ShieldCheck } from 'lucide-react';
import { Logo } from '../../components/ui';

const POINTS = [
  { icon: ClipboardList, title: 'Forms that run your process', text: 'Build forms, route every submission, track SLAs and approvals.' },
  { icon: Database, title: 'Connected to your data', text: 'MongoDB, Postgres, MySQL, Supabase, REST and AWS - no copies.' },
  { icon: ShieldCheck, title: 'Secure by default', text: 'Two-factor sign-in, roles per folder, encrypted credentials, full audit log.' },
];

export function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="st-auth">
      <aside className="st-auth__brand">
        <Logo />
        <div>
          <h2>Forms, data and workflow in one secure place.</h2>
          <p>Design once, connect to your systems, and let every submission follow the process you set.</p>
          <ul className="st-auth__points">
            {POINTS.map(({ icon: Icon, title: t, text }) => (
              <li key={t}>
                <Icon aria-hidden />
                <div>
                  <strong>{t}</strong>
                  <div style={{ opacity: 0.8 }}>{text}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <small style={{ opacity: 0.7 }}>Hosted in India (AWS Mumbai)</small>
      </aside>
      <main className="st-auth__main">
        <div className="st-auth__card">
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
          {children}
        </div>
      </main>
    </div>
  );
}
