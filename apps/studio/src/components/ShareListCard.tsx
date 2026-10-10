import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Badge, Button, Card, useSubmit } from './ui';

interface Colleague {
  userId: string;
  name: string;
  status: string;
}

/**
 * "Share my list": the colleagues ticked here may see and open the records I hold, under "Shared with me" in
 * their Work inbox. It goes one way, and they do not become the owner of anything.
 */
export function ShareListCard() {
  const { me } = useAuth();
  const [colleagues, setColleagues] = useState<Colleague[]>([]);
  const [saved, setSaved] = useState<string[]>();
  const [chosen, setChosen] = useState<string[]>([]);

  useEffect(() => {
    void api<{ sharedWith: string[] }>('/sharing').then((s) => {
      setSaved(s.sharedWith);
      setChosen(s.sharedWith);
    }, () => undefined);
    void api<Colleague[]>('/members').then((rows) => setColleagues(rows.filter((m) => m.status === 'ACTIVE')), () => undefined);
  }, []);

  const save = useSubmit(async () => {
    const s = await api<{ sharedWith: string[] }>('/sharing', { method: 'PATCH', body: { userIds: chosen } });
    setSaved(s.sharedWith);
    setChosen(s.sharedWith);
  });
  if (!me || !saved) return null;
  const others = colleagues.filter((c) => c.userId !== me.user.id);
  const changed = [...chosen].sort().join() !== [...saved].sort().join();

  return (
    <Card
      title="Share my work list"
      subtitle="Colleagues you tick can see and open the records you hold, under “Shared with me” in their Work inbox. It goes one way, and the records stay yours."
      actions={saved.length ? <Badge tone="accent">Shared with {saved.length}</Badge> : <Badge>Not shared</Badge>}
    >
      <form className="st-stack" onSubmit={save.submit}>
        {save.error && <Alert tone="error">{save.error}</Alert>}
        {others.length === 0 ? (
          <p className="st-muted">There is nobody else in the organisation yet.</p>
        ) : (
          <div className="st-away" role="group" aria-label="Colleagues to share with">
            {others.map((c) => (
              <label key={c.userId} className="st-row" style={{ gap: 8 }}>
                <input type="checkbox" checked={chosen.includes(c.userId)} onChange={(e) => setChosen((was) => (e.target.checked ? [...was, c.userId] : was.filter((id) => id !== c.userId)))} />
                {c.name}
              </label>
            ))}
          </div>
        )}
        <div>
          <Button type="submit" variant="secondary" busy={save.busy} disabled={!changed}>
            Save
          </Button>
        </div>
      </form>
    </Card>
  );
}
