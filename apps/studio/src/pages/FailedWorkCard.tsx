import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../lib/api';
import { Alert, Button, Card } from '../components/ui';

export interface FailedWork {
  jobs: { id: string; what: string; recordId: string; ref: string; error: string; attempts: number; at: string }[];
  flows: { recordId: string; ref: string; form: string; runId: string; automation: string; step: number; error: string; at: string }[];
}

const when = (at: string) => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const recordLink = (recordId: string, ref: string) =>
  recordId ? (
    <Link className="st-link" to={`/work?record=${encodeURIComponent(recordId)}`}>
      {ref || 'the record'}
    </Link>
  ) : null;

/**
 * For Forms admins: what went wrong in the last 30 days and is still wrong. Background work that gave up after
 * its tries, and flows that stopped on a failed step, each with the reason and "Run again". Shows nothing when
 * all is well.
 */
export function FailedWorkCard() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['failed-work'], queryFn: () => api<FailedWork>('/failed-work'), retry: false });
  const [busy, setBusy] = useState<string>();
  const [note, setNote] = useState<{ tone: 'success' | 'error'; text: string }>();
  if (!data || (!data.jobs.length && !data.flows.length)) return null;

  const again = async (key: string, path: string, done: string) => {
    setBusy(key);
    try {
      await api(path, { method: 'POST' });
      setNote({ tone: 'success', text: done });
      await qc.invalidateQueries({ queryKey: ['failed-work'] });
    } catch (e) {
      setNote({ tone: 'error', text: errorMessage(e) });
    } finally {
      setBusy(undefined);
    }
  };
  const count = data.jobs.length + data.flows.length;

  return (
    <Card title="Work that failed" subtitle={`${count} ${count === 1 ? 'thing' : 'things'} in the last 30 days still need a look. Put the cause right, then run it again.`}>
      <div className="st-stack" style={{ gap: 12 }}>
        {note && <Alert tone={note.tone}>{note.text}</Alert>}
        <ul className="st-stack" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 12 }}>
          {data.flows.map((f) => (
            <li key={f.runId} className="st-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <strong>
                  {f.automation} stopped at step {f.step}
                </strong>{' '}
                <span className="st-muted">
                  · {f.form} · {recordLink(f.recordId, f.ref)} · {when(f.at)}
                </span>
                {f.error && <div className="st-muted" style={{ overflowWrap: 'anywhere' }}>{f.error}</div>}
              </div>
              <Button
                size="sm"
                variant="secondary"
                busy={busy === f.runId}
                disabled={!!busy}
                onClick={() => void again(f.runId, `/records/${encodeURIComponent(f.recordId)}/runs/${encodeURIComponent(f.runId)}/again`, `${f.automation} is running again from step ${f.step}. The record's timeline shows how it goes.`)}
              >
                Run again from step {f.step}
              </Button>
            </li>
          ))}
          {data.jobs.map((j) => (
            <li key={j.id} className="st-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <strong>{j.what}</strong>{' '}
                <span className="st-muted">
                  {j.recordId && <>· {recordLink(j.recordId, j.ref)} </>}· gave up after {j.attempts} {j.attempts === 1 ? 'try' : 'tries'} · {when(j.at)}
                </span>
                {j.error && <div className="st-muted" style={{ overflowWrap: 'anywhere' }}>{j.error}</div>}
              </div>
              <Button size="sm" variant="secondary" busy={busy === j.id} disabled={!!busy} onClick={() => void again(j.id, `/failed-work/jobs/${encodeURIComponent(j.id)}/retry`, `${j.what} will be tried again now.`)}>
                Run again
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
