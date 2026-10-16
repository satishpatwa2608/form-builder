import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, ShieldCheck, UserRound } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { Avatar } from './ui';

/** The signed-in person, top right: pressed, it offers their profile, account and security, and signing out. */
export function UserMenu() {
  const { me, signOut } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', key);
    box.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  if (!me) return null;
  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };
  /** Up and down move between the items, as in any menu. */
  const arrows = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  };

  return (
    <div className="st-usermenu" ref={box}>
      <button ref={button} type="button" className="st-usermenu__button" aria-haspopup="menu" aria-expanded={open} aria-label={`${me.user.name}: your account`} onClick={() => setOpen(!open)}>
        <span className="st-user__name">{me.user.name}</span>
        <Avatar name={me.user.name} />
      </button>
      {open && (
        <div className="st-usermenu__panel" role="menu" aria-label="Your account" onKeyDown={arrows}>
          <div className="st-usermenu__who">
            <strong>{me.user.name}</strong>
            <span className="st-muted">{me.user.email}</span>
          </div>
          <button type="button" role="menuitem" className="st-usermenu__item" onClick={() => go('/account#profile')}>
            <UserRound size={16} /> Your profile
          </button>
          <button type="button" role="menuitem" className="st-usermenu__item" onClick={() => go('/account')}>
            <ShieldCheck size={16} /> Account & security
          </button>
          <button
            type="button"
            role="menuitem"
            className="st-usermenu__item st-usermenu__item--out"
            onClick={async () => {
              setOpen(false);
              await signOut();
              navigate('/login');
            }}
          >
            <LogOut size={16} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
