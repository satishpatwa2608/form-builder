import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Badge, Button, Card, SelectField, TextField, useSubmit } from './ui';

export interface Away {
  set: boolean;
  /** In force at this moment (a start still to come is set, but not yet now). */
  now: boolean;
  from: string | null;
  until: string | null;
  toUserId: string;
}

interface Colleague {
  userId: string;
  name: string;
  status: string;
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
/** The start of a day picked in a date box, in the person's own time zone. */
const startOf = (date: string) => new Date(`${date}T00:00:00`).toISOString();
const today = () => new Date().toLocaleDateString('en-CA');

/** In one line, for the card and for the Members page. */
export function awayLine(away: Away, standIn: string | undefined) {
  const when = away.until ? `until ${day(away.until)}` : 'until they are back';
  return `${away.now ? 'Away' : `Away from ${day(away.from!)}`} ${when}${standIn ? ` · new work goes to ${standIn}` : ''}`;
}

/**
 * "I'm away": from a day, until a day (or until I say I'm back), and who gets my new work meanwhile.
 * What I already hold stays with me, so nothing moves behind anyone's back.
 */
export function AwayCard() {
  const { me } = useAuth();
  const [away, setAway] = useState<Away>();
  const [colleagues, setColleagues] = useState<Colleague[]>([]);
  const [from, setFrom] = useState('');
  const [until, setUntil] = useState('');
  const [to, setTo] = useState('');

  useEffect(() => {
    void api<Away>('/away').then(setAway, () => undefined);
    void api<Colleague[]>('/members').then((rows) => setColleagues(rows.filter((m) => m.status === 'ACTIVE')), () => undefined);
  }, []);

  const save = useSubmit(async () => {
    setAway(await api<Away>('/away', { method: 'PATCH', body: { from: from && from > today() ? startOf(from) : undefined, until: until ? startOf(until) : undefined, toUserId: to } }));
  });
  const back = useSubmit(async () => {
    setAway(await api<Away>('/away', { method: 'PATCH', body: { off: true } }));
    setFrom('');
    setUntil('');
  });
  if (!me || !away) return null;
  const others = colleagues.filter((c) => c.userId !== me.user.id);
  const standIn = others.find((c) => c.userId === away.toUserId)?.name;

  return (
    <Card
      title="Away"
      subtitle="While you are away, new work and approvals meant for you go to a colleague. What you already hold stays with you."
      actions={away.set ? <Badge tone="warn">{away.now ? 'Away now' : 'Planned'}</Badge> : <Badge tone="success">Here</Badge>}
    >
      <div className="st-stack">
        {(save.error || back.error) && <Alert tone="error">{save.error || back.error}</Alert>}
        {away.set ? (
          <>
            <p>{awayLine(away, standIn).replace('they are', 'you are')}.</p>
            {!away.toUserId && <Alert tone="warn">Nobody is standing in, so new work still comes to you.</Alert>}
            <div>
              <Button variant="secondary" busy={back.busy} onClick={() => void back.submit()}>
                I'm back
              </Button>
            </div>
          </>
        ) : (
          <form
            className="st-stack"
            onSubmit={save.submit}
          >
            <div className="st-away">
              <TextField label="From" type="date" min={today()} value={from} onChange={(e) => setFrom(e.target.value)} hint="Left empty: from now." />
              <TextField label="Back on" type="date" min={from || today()} value={until} onChange={(e) => setUntil(e.target.value)} hint="Left empty: until you say you are back." />
              <SelectField label="Give my new work to" value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">Choose a colleague…</option>
                {others.map((c) => (
                  <option key={c.userId} value={c.userId}>
                    {c.name}
                  </option>
                ))}
              </SelectField>
            </div>
            <div>
              <Button type="submit" busy={save.busy} disabled={!to}>
                Set as away
              </Button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}
