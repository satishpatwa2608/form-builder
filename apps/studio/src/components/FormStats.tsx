import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts';
import { api } from '../lib/api';

interface Stats {
  days: number;
  series: { day: string; views: number; starts: number; submissions: number }[];
  totals: { views: number; starts: number; submissions: number };
  startRate: number | null;
  completionRate: number | null;
  /** How quickly the form appeared for real visitors; null until one has reported. */
  speed: { loads: number; averageMs: number; under1s: number | null; under2s: number | null; under4s: number | null } | null;
}

/** How fast the form is for the people opening it, in a sentence. */
export function speedLine(speed: NonNullable<Stats['speed']>): string {
  const seconds = (speed.averageMs / 1000).toFixed(1);
  const quick = speed.under2s ?? 0;
  const slow = Math.round((100 - (speed.under4s ?? 100)) * 10) / 10;
  return `The form appears in ${seconds} seconds on average; ${quick}% of visits have it within 2 seconds${slow > 0 ? `, and ${slow}% wait more than 4` : ''}. From ${speed.loads.toLocaleString()} ${speed.loads === 1 ? 'visit' : 'visits'}.`;
}

/** Opened -> started -> submitted for one form (counts only; nothing about who). */
export function FormStats({ formId }: { formId: string }) {
  const [days, setDays] = useState(30);
  const { data } = useQuery({ queryKey: ['form-stats', formId, days], queryFn: () => api<Stats>(`/forms/${formId}/stats?days=${days}`) });
  if (!data) return null;
  const pct = (v: number | null) => (v === null ? '–' : `${v}%`);
  const tiles = [
    { label: 'Opened', value: data.totals.views.toLocaleString() },
    { label: 'Started', value: data.totals.starts.toLocaleString() },
    { label: 'Submitted', value: data.totals.submissions.toLocaleString() },
    { label: 'Started after opening', value: pct(data.startRate) },
    { label: 'Completed after starting', value: pct(data.completionRate) },
  ];
  return (
    <section className="st-card" style={{ padding: 16, marginBottom: 16 }} aria-label="Form analytics">
      <div className="st-row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <strong>Analytics</strong>
        <select className="st-select" style={{ width: 140, height: 32 }} aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>
      <div className="st-stats">
        {tiles.map((t) => (
          <div key={t.label} className="st-stat">
            <div className="st-stat__value">{t.value}</div>
            <div className="st-stat__label">{t.label}</div>
          </div>
        ))}
      </div>
      <div className="st-stats__chart">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data.series} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
            <XAxis dataKey="day" tickFormatter={(d: string) => d.slice(5)} tick={{ fontSize: 11 }} minTickGap={24} />
            <Tooltip />
            <Area type="monotone" dataKey="views" name="Opened" stroke="var(--fb-muted)" fill="var(--fb-surface-2)" />
            <Area type="monotone" dataKey="submissions" name="Submitted" stroke="var(--fb-accent)" fill="var(--fb-accent-soft)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {data.speed && (
        <p className="st-muted" style={{ margin: '12px 0 0' }} aria-label="Loading speed">
          {speedLine(data.speed)}
        </p>
      )}
      <FieldStats formId={formId} days={days} />
    </section>
  );
}

interface FieldReport {
  days: number;
  starts: number;
  submissions: number;
  fields: { name: string; label: string; answered: number; mistakes: number; leftAt: number }[];
}

/** In plain words, where the people who gave up stopped. Nothing to say until someone has. */
export function whereTheyStop(report: FieldReport): string | null {
  const left = report.fields.reduce((n, f) => n + f.leftAt, 0);
  const worst = [...report.fields].sort((a, b) => b.leftAt - a.leftAt)[0];
  if (!left || !worst) return null;
  return `Of ${left} ${left === 1 ? 'person who started and left' : 'people who started and left'}, ${worst.leftAt === left ? (left === 1 ? 'they' : 'all') : worst.leftAt} stopped at "${worst.label}".`;
}

/** Question by question: how many answered it, tripped on it, and left the form at it. */
function FieldStats({ formId, days }: { formId: string; days: number }) {
  const { data } = useQuery({ queryKey: ['form-field-stats', formId, days], queryFn: () => api<FieldReport>(`/forms/${formId}/field-stats?days=${days}`) });
  if (!data || !data.fields.some((f) => f.answered || f.mistakes || f.leftAt)) return null;
  const of = (n: number) => (data.starts ? ` (${Math.min(100, Math.round((n / data.starts) * 100))}%)` : '');
  const summary = whereTheyStop(data);
  return (
    <div style={{ marginTop: 16 }}>
      <strong>Question by question</strong>
      {summary && <p className="st-muted" style={{ margin: '4px 0 8px' }}>{summary}</p>}
      <div style={{ overflowX: 'auto' }}>
        <table className="st-table" aria-label="Question by question">
          <thead>
            <tr>
              <th scope="col">Question</th>
              <th scope="col">Answered</th>
              <th scope="col">Made a mistake</th>
              <th scope="col">Left the form here</th>
            </tr>
          </thead>
          <tbody>
            {data.fields.map((f) => (
              <tr key={f.name}>
                <th scope="row" style={{ fontWeight: 500, textAlign: 'start' }}>{f.label}</th>
                <td>
                  {f.answered.toLocaleString()}
                  {of(f.answered)}
                </td>
                <td>{f.mistakes.toLocaleString()}</td>
                <td>{f.leftAt.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="st-muted" style={{ marginTop: 6, fontSize: 12 }}>Counts only: nothing about who answered or what they wrote. Percentages are of the people who started.</p>
    </div>
  );
}
