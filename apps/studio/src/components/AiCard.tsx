import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Alert, Button, Card, TextField, useSubmit } from './ui';

interface AiStatus {
  available: boolean;
  enabled: boolean;
  ownKey: { hint: string; setAt: string | null } | null;
  used: number;
  limit: number | null;
}

/**
 * Drafting forms with AI, on the organisation's own key: it pays the AI service for what it uses. The key is
 * checked when it is saved and never shown again. What is sent is said plainly: the description someone types.
 */
export function AiCard() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['ai-status'], queryFn: () => api<AiStatus>('/ai/status'), retry: false });
  const [on, setOn] = useState(false);
  const [key, setKey] = useState('');
  const [note, setNote] = useState<string>();
  useEffect(() => {
    if (data) setOn(data.enabled);
  }, [data]);
  const took = (next: AiStatus) => qc.setQueryData(['ai-status'], next);
  const saveKey = useSubmit(async () => {
    took(await api<AiStatus>('/ai/key', { method: 'PUT', body: { key: key.trim() } }));
    setKey('');
    setNote('The key works and is saved. Now switch drafting on below.');
  });
  const removeKey = useSubmit(async () => {
    took(await api<AiStatus>('/ai/key', { method: 'DELETE' }));
    setNote('The key is removed. Forms are no longer drafted with it.');
  });
  const save = useSubmit(async () => {
    await api('/org', { method: 'PATCH', body: { ai: { drafting: on } } });
    await qc.invalidateQueries({ queryKey: ['ai-status'] });
    setNote(on ? 'Saved. "Describe it (AI)" is now offered under New form.' : 'Saved. Forms are no longer drafted from a description.');
  });
  if (!data) return null;
  const error = saveKey.error ?? removeKey.error ?? save.error;
  return (
    <Card title="Drafting forms with AI" subtitle="Someone making a new form can describe it in plain words and get its questions drafted, to read and change before it is published.">
      <div className="st-stack">
        {note && <Alert tone="success">{note}</Alert>}
        {error && !saveKey.fields.key && <Alert tone="error">{error}</Alert>}
        <p className="st-muted" style={{ margin: 0, fontSize: 13 }}>
          It uses your organisation's own Anthropic (Claude) account: put its API key here, and each draft is charged to that account, usually a few rupees. Only the description someone types is sent: never responses, records, connected data or passwords. Each use is in the audit trail.
        </p>
        {data.ownKey ? (
          <div className="st-row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>
              Key ending <code>…{data.ownKey.hint}</code>
            </span>
            <Button variant="ghost" size="sm" busy={removeKey.busy} onClick={() => void removeKey.submit()}>
              Remove the key
            </Button>
          </div>
        ) : (
          <form className="st-row" style={{ alignItems: 'flex-end', gap: 8, flexWrap: 'wrap' }} onSubmit={saveKey.submit} noValidate>
            <div style={{ flex: '1 1 320px' }}>
              <TextField label="Your Anthropic API key" type="password" autoComplete="off" placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} error={saveKey.fields.key} hint="From console.anthropic.com, under API keys. It is checked, then kept sealed." />
            </div>
            <Button type="submit" variant="secondary" busy={saveKey.busy} disabled={!key.trim()}>
              Save the key
            </Button>
          </form>
        )}
        <form className="st-stack" onSubmit={save.submit} noValidate>
          <label className="st-check">
            <input type="checkbox" checked={on} disabled={!data.available} onChange={(e) => setOn(e.target.checked)} />
            <span>Let people draft forms from a description</span>
          </label>
          {!data.available && <span className="st-muted" style={{ fontSize: 13 }}>Save a key first.</span>}
          {data.limit !== null && data.available && <span className="st-muted" style={{ fontSize: 13 }}>{`${data.used} of ${data.limit} drafts used this month.`}</span>}
          <div>
            <Button type="submit" busy={save.busy} disabled={on === data.enabled || !data.available}>
              Save
            </Button>
          </div>
        </form>
      </div>
    </Card>
  );
}
