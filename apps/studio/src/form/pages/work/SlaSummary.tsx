import { format, formatDistanceToNow } from 'date-fns';
import type { RecordRow } from '../../adapters/workflow';

/** Response / resolution targets of an item at a glance (only what the form uses). */
export function SlaSummary({ record }: { record: RecordRow }) {
  const rows: { label: string; text: string; tone?: 'bad' | 'ok' | 'muted' }[] = [];
  const when = (iso: string) => format(new Date(iso), 'dd MMM, HH:mm');
  const rel = (iso: string) => formatDistanceToNow(new Date(iso), { addSuffix: true });

  if (record.responseDueAt || record.respondedAt) {
    if (record.respondedAt) {
      const late = !!record.responseDueAt && new Date(record.respondedAt) > new Date(record.responseDueAt);
      rows.push({ label: 'First response', text: `${late ? 'Late' : 'On time'} · ${when(record.respondedAt)}`, tone: late ? 'bad' : 'ok' });
    } else if (record.responseDueAt) {
      const over = new Date(record.responseDueAt) < new Date();
      rows.push({ label: 'First response', text: `${over ? 'Overdue' : 'Due'} ${rel(record.responseDueAt)}`, tone: over ? 'bad' : undefined });
    }
  }
  if (record.resolvedAt) {
    const late = !!record.resolutionBreachedAt;
    rows.push({ label: 'Resolution', text: `${late ? 'Resolved late' : 'Resolved'} · ${when(record.resolvedAt)}`, tone: late ? 'bad' : 'ok' });
  } else if (record.slaPausedAt) {
    rows.push({ label: 'Resolution', text: `Clock paused since ${when(record.slaPausedAt)}`, tone: 'muted' });
  } else if (record.resolutionDueAt) {
    const over = new Date(record.resolutionDueAt) < new Date();
    rows.push({ label: 'Resolution', text: `${over ? 'Overdue' : 'Due'} ${rel(record.resolutionDueAt)}`, tone: over ? 'bad' : undefined });
  }
  if ((record.escalationStep ?? 0) > 1) rows.push({ label: 'Escalated', text: `Level ${(record.escalationStep ?? 1) - 1}`, tone: 'bad' });
  if (record.reopenCount) rows.push({ label: 'Reopened', text: `${record.reopenCount} time${record.reopenCount === 1 ? '' : 's'}` });
  if (!rows.length) return null;

  return (
    <dl className="fb-answers" aria-label="SLA">
      {rows.map((r) => (
        <div key={r.label} style={{ display: 'contents' }}>
          <dt>{r.label}</dt>
          <dd className={r.tone === 'bad' ? 'fb-overdue' : r.tone === 'muted' ? 'fb-muted' : undefined}>{r.text}</dd>
        </div>
      ))}
    </dl>
  );
}
