import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Alert, Button, Card, useSubmit } from './ui';

interface AiStatus {
  available: boolean;
  enabled: boolean;
  used: number;
  limit: number | null;
}

/**
 * Whether the organisation lets AI draft its forms. Off until an admin turns it on, and shown only where the
 * installation has an AI service. What it sends is said plainly: the description someone types, nothing else.
 */
export function AiCard() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['ai-status'], queryFn: () => api<AiStatus>('/ai/status'), retry: false });
  const [on, setOn] = useState(false);
  const [note, setNote] = useState<string>();
  useEffect(() => {
    if (data) setOn(data.enabled);
  }, [data]);
  const save = useSubmit(async () => {
    await api('/org', { method: 'PATCH', body: { ai: { drafting: on } } });
    await qc.invalidateQueries({ queryKey: ['ai-status'] });
    setNote(on ? 'Saved. "Describe it (AI)" is now offered under New form.' : 'Saved. Forms are no longer drafted from a description.');
  });
  if (!data?.available) return null;
  return (
    <Card title="Drafting forms with AI" subtitle="Someone making a new form can describe it in plain words and get its questions drafted, to read and change before it is published.">
      <form className="st-stack" onSubmit={save.submit} noValidate>
        {note && <Alert tone="success">{note}</Alert>}
        {save.error && <Alert tone="error">{save.error}</Alert>}
        <label className="st-check">
          <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
          <span>Let people draft forms from a description</span>
        </label>
        <p className="st-muted" style={{ margin: 0, fontSize: 13 }}>
          Only the description they type is sent to the AI service: never responses, records, connected data or passwords. Each use is in the audit trail.{' '}
          {data.limit === null ? `${data.used} drafted this month.` : `${data.used} of ${data.limit} drafts used this month.`}
        </p>
        <div>
          <Button type="submit" busy={save.busy} disabled={on === data.enabled}>
            Save
          </Button>
        </div>
      </form>
    </Card>
  );
}
