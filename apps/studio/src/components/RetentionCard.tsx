import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Alert, Button, Card, SelectField, useSubmit } from './ui';

interface Retention {
  days: number | null;
  /** Published forms whose answers are kept only here: they go when the retention passes. */
  keptHereOnly: string[];
  /** Records that go at the next run (within the hour). */
  due: number;
}

const CHOICES: { value: string; label: string }[] = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'keep', label: 'Keep everything' },
];

/**
 * How long responses are kept after they are closed. Open work is never deleted; a record handed to the
 * organisation's own system goes only after it got there; a record an admin keeps stays. The audit trail keeps a year.
 */
export function RetentionCard() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['retention'], queryFn: () => api<Retention>('/retention'), retry: false });
  const [choice, setChoice] = useState('7');
  const [note, setNote] = useState<string>();
  const current = data ? (data.days === null ? 'keep' : String(data.days)) : '7';
  useEffect(() => setChoice(current), [current]);
  const save = useSubmit(async () => {
    await api('/org', { method: 'PATCH', body: { retention: { days: choice === 'keep' ? null : Number(choice) } } });
    await qc.invalidateQueries({ queryKey: ['retention'] });
    setNote(choice === 'keep' ? 'Saved. Nothing is deleted by the retention.' : `Saved. Closed records go ${CHOICES.find((c) => c.value === choice)?.label} after they are closed.`);
  });
  if (!data) return null;
  return (
    <Card title="Keeping data" subtitle="How long responses, their files and PDFs are kept here after they are closed. Keep your business records in your own system with a connector or a webhook.">
      <form className="st-stack" onSubmit={save.submit} noValidate>
        {note && <Alert tone="success">{note}</Alert>}
        {save.error && <Alert tone="error">{save.error}</Alert>}
        <SelectField label="Delete closed records after" value={choice} onChange={(e) => setChoice(e.target.value)}>
          {CHOICES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </SelectField>
        <p className="st-muted" style={{ margin: 0, fontSize: 13 }}>
          Counted from when a record is closed (or sent, for a form without a workflow). Open work is never deleted. A record a form hands to your own system is deleted only after it got there. A Forms admin can keep any one record with "Keep this record". The audit trail is kept for a year; it holds no answers.
        </p>
        {data.days !== null && data.keptHereOnly.length > 0 && (
          <Alert tone="warn">
            {`These forms keep their answers only here, so they go when the time passes: ${data.keptHereOnly.join(', ')}. Add a step that sends them to your own system to keep them.`}
          </Alert>
        )}
        {data.days !== null && <span className="st-muted" style={{ fontSize: 13 }}>{data.due === 1 ? '1 record goes at the next run, within the hour.' : `${data.due} records go at the next run, within the hour.`}</span>}
        <div>
          <Button type="submit" busy={save.busy} disabled={choice === current}>
            Save
          </Button>
        </div>
      </form>
    </Card>
  );
}
