import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

interface Note {
  id: string;
  message: string;
  recordId: string;
  ref: string;
  formName: string;
  readAt: string | null;
  createdAt: string;
}

/** The signed-in user's notifications (polled each minute); clicking one opens the work item. */
export function NotificationBell() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const { data } = useQuery({ queryKey: ['notifications'], queryFn: () => api<{ notifications: Note[]; unread: number }>('/notifications'), refetchInterval: 60_000 });

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const read = async (id?: string) => {
    qc.setQueryData(['notifications'], await api(id ? `/notifications/${id}/read` : '/notifications/read', { method: 'POST' }));
  };

  return (
    <div className="st-bell" ref={box}>
      <button type="button" className="st-btn st-btn--ghost st-btn--sm" aria-label={`Notifications${data?.unread ? ` (${data.unread} unread)` : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Bell size={18} />
        {!!data?.unread && <span className="st-bell__count">{data.unread > 9 ? '9+' : data.unread}</span>}
      </button>
      {open && (
        <div className="st-bell__panel st-card" role="dialog" aria-label="Notifications">
          <div className="st-row" style={{ justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--fb-line)' }}>
            <strong>Notifications</strong>
            {!!data?.unread && (
              <button type="button" className="st-link" style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => void read()}>
                Mark all read
              </button>
            )}
          </div>
          {data?.notifications.length ? (
            <ul className="st-bell__list">
              {data.notifications.map((n) => (
                <li key={n.id} data-unread={!n.readAt}>
                  <button
                    type="button"
                    onClick={() => {
                      void read(n.id);
                      setOpen(false);
                      if (n.recordId) navigate(`/work?record=${encodeURIComponent(n.recordId)}`);
                    }}
                  >
                    <span>{n.message}</span>
                    <small className="st-muted">{new Date(n.createdAt).toLocaleString()}</small>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="st-empty">Nothing yet.</p>
          )}
        </div>
      )}
    </div>
  );
}
