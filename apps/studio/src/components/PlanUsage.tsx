import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Badge, Card } from './ui';

interface Limits {
  forms: number | null;
  submissionsPerMonth: number | null;
  members: number | null;
  connectors: number | null;
  gateways: number | null;
  customDomains: number | null;
  removeBranding: boolean;
  sso: boolean;
}
export interface Usage {
  plan: string;
  planName: string;
  month: string;
  limits: Limits;
  usage: { forms: number; members: number; connectors: number; gateways: number; customDomains: number; submissionsThisMonth: number };
}

export const useUsage = () => useQuery({ queryKey: ['org-usage'], queryFn: () => api<Usage>('/org/usage') });

const ROWS: { key: keyof Usage['usage']; limit: keyof Limits; label: string }[] = [
  { key: 'submissionsThisMonth', limit: 'submissionsPerMonth', label: 'Responses this month' },
  { key: 'forms', limit: 'forms', label: 'Forms' },
  { key: 'members', limit: 'members', label: 'Seats (members + invitations)' },
  { key: 'connectors', limit: 'connectors', label: 'Connectors' },
  { key: 'gateways', limit: 'gateways', label: 'Gateways' },
  { key: 'customDomains', limit: 'customDomains', label: 'Custom domains' },
];

/** The plan and how much of it is used, with a bar per limit. */
export function PlanUsageCard() {
  const { data } = useUsage();
  if (!data) return null;
  return (
    <Card title="Plan & usage" subtitle={`You're on the ${data.planName} plan. Responses reset on the 1st of each month (UTC).`} actions={<Badge tone="accent">{data.planName}</Badge>}>
      <div className="st-usage">
        {ROWS.map((r) => {
          const used = data.usage[r.key];
          const limit = data.limits[r.limit] as number | null;
          const pct = limit === null ? 0 : limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100));
          const tone = limit !== null && used >= limit ? 'full' : pct >= 80 ? 'high' : '';
          return (
            <div key={r.key} className="st-usage__row">
              <div className="st-usage__label">
                <span>{r.label}</span>
                <span className="st-muted">
                  {used.toLocaleString()} / {limit === null ? 'unlimited' : limit === 0 ? 'not included' : limit.toLocaleString()}
                </span>
              </div>
              <div className="st-usage__bar" role="progressbar" aria-label={r.label} aria-valuenow={used} aria-valuemax={limit ?? undefined}>
                <span className={`st-usage__fill ${tone}`} style={{ width: `${limit === null ? 4 : pct}%` }} />
              </div>
            </div>
          );
        })}
        <div className="st-row" style={{ gap: 6 }}>
          <Badge tone={data.limits.sso ? 'success' : undefined}>Single sign-on {data.limits.sso ? 'included' : 'not included'}</Badge>
          <Badge tone={data.limits.removeBranding ? 'success' : undefined}>{data.limits.removeBranding ? 'Your branding only' : '"Powered by Form Builder" shown on forms'}</Badge>
        </div>
      </div>
    </Card>
  );
}
