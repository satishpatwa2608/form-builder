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
    </section>
  );
}
