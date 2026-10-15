import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../lib/api';
import { Alert, Badge, Button, Card, PageHead, SelectField, TextField, useSubmit } from '../components/ui';

export interface Customer {
  id: string;
  name: string;
  plan: 'FREE' | 'TEAM' | 'BUSINESS' | 'ENTERPRISE';
  planName: string;
  createdAt: string | null;
  owners: { name: string; email: string }[];
  invitedOwners: string[];
  members: number;
  memberLimit: number | null;
  forms: number;
  responsesThisMonth: number;
  lastActiveAt: string | null;
  /** Background work that gave up in the last 30 days: a count only. */
  failedWork?: number;
}

const PLANS: { value: Customer['plan']; label: string }[] = [
  { value: 'FREE', label: 'Free' },
  { value: 'TEAM', label: 'Team' },
  { value: 'BUSINESS', label: 'Business' },
  { value: 'ENTERPRISE', label: 'Enterprise' },
];
const day = (at: string | null) => (at ? new Date(at).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');

/** What the button under a customer's owner says, by what that customer needs. */
export const ownerAction = (c: Pick<Customer, 'owners' | 'invitedOwners'>) => (c.owners.length ? 'Replace a lost owner' : c.invitedOwners.length ? 'Send the invitation again' : 'Invite an owner');

/** How long ago, in the words someone scanning a list wants: today, yesterday, 12 days ago. */
export function ago(at: string | null, now = Date.now()): string {
  if (!at) return 'Never';
  const days = Math.floor((now - new Date(at).getTime()) / 86_400_000);
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 60 ? `${days} days ago` : day(at);
}

/**
 * For the people who run the installation: every customer, the plan it is
 * on, who owns it and how much it is used. A customer is added here and its
 * plan changed here. Nothing on this page opens what is inside a customer.
 */
export default function CustomersPage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['customers'], queryFn: () => api<Customer[]>('/operator/customers'), retry: false });
  const [form, setForm] = useState({ name: '', plan: 'TEAM' as Customer['plan'], ownerEmail: '' });
  const [note, setNote] = useState<{ tone: 'success' | 'error'; text: string }>();
  const [inviting, setInviting] = useState<string>();
  const [inviteEmail, setInviteEmail] = useState('');
  const took = (rows: Customer[]) => qc.setQueryData(['customers'], rows);

  const add = useSubmit(async () => {
    took(await api<Customer[]>('/operator/customers', { method: 'POST', body: form }));
    setNote({ tone: 'success', text: `${form.name.trim()} was added on the ${PLANS.find((p) => p.value === form.plan)!.label} plan. An invitation to own it has gone to ${form.ownerEmail.trim()}.` });
    setForm({ name: '', plan: 'TEAM', ownerEmail: '' });
  });
  const setPlan = async (c: Customer, plan: Customer['plan']) => {
    try {
      took(await api<Customer[]>(`/operator/customers/${c.id}`, { method: 'PATCH', body: { plan } }));
      setNote({ tone: 'success', text: `${c.name} is now on the ${PLANS.find((p) => p.value === plan)!.label} plan.` });
    } catch (e) {
      setNote({ tone: 'error', text: errorMessage(e) });
    }
  };
  const invite = async (c: Customer) => {
    try {
      took(await api<Customer[]>(`/operator/customers/${c.id}/owner-invitations`, { method: 'POST', body: { email: inviteEmail } }));
      setNote({ tone: 'success', text: `An invitation to own ${c.name} has gone to ${inviteEmail.trim()}.` });
      setInviting(undefined);
      setInviteEmail('');
    } catch (e) {
      setNote({ tone: 'error', text: errorMessage(e) });
    }
  };

  if (error) return <PageHead title="Page not found" subtitle="There is nothing at this address." />;
  const rows = data ?? [];
  return (
    <>
      <PageHead title="Customers" subtitle="Every organisation on this installation: its plan, who owns it and how much it is used. You see none of what is inside a customer unless they invite you." />
      <div className="st-stack">
        {note && <Alert tone={note.tone}>{note.text}</Alert>}
        <Card title="Add a customer" subtitle="Creates their organisation on the plan they bought and emails their person an invitation to own it. You are not made a member of it.">
          <form className="st-row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }} onSubmit={add.submit} noValidate>
            {add.error && !Object.keys(add.fields).length && (
              <div style={{ flexBasis: '100%' }}>
                <Alert tone="error">{add.error}</Alert>
              </div>
            )}
            <div style={{ flex: '1 1 220px' }}>
              <TextField label="Customer's name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} error={add.fields.name} />
            </div>
            <div style={{ width: 170 }}>
              <SelectField label="Plan" value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value as Customer['plan'] })}>
                {PLANS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </SelectField>
            </div>
            <div style={{ flex: '1 1 240px' }}>
              <TextField label="Their owner's email" type="email" value={form.ownerEmail} onChange={(e) => setForm({ ...form, ownerEmail: e.target.value })} error={add.fields.ownerEmail} />
            </div>
            <Button type="submit" busy={add.busy} disabled={!form.name.trim() || !form.ownerEmail.trim()}>
              Add and invite
            </Button>
          </form>
        </Card>
        <Card bodyless>
          <div className="st-table-wrap">
            <table className="st-table" aria-label="Customers">
              <thead>
                <tr>
                  <th scope="col">Customer</th>
                  <th scope="col">Plan</th>
                  <th scope="col">Owner</th>
                  <th scope="col">People</th>
                  <th scope="col">Forms</th>
                  <th scope="col">Responses this month</th>
                  <th scope="col" title="Background work that gave up after its tries in the last 30 days">Failed work</th>
                  <th scope="col">Last active</th>
                  <th scope="col">Since</th>
                </tr>
              </thead>
              <tbody>
                {isLoading && (
                  <tr>
                    <td colSpan={8} className="st-empty">
                      Loading…
                    </td>
                  </tr>
                )}
                {rows.map((c) => (
                  <tr key={c.id}>
                    <th scope="row" style={{ textAlign: 'start' }}>
                      {c.name}
                    </th>
                    <td>
                      <select className="st-select" style={{ height: 32, width: 140 }} aria-label={`Plan for ${c.name}`} value={c.plan} onChange={(e) => void setPlan(c, e.target.value as Customer['plan'])}>
                        {PLANS.map((p) => (
                          <option key={p.value} value={p.value}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      {c.owners.map((o) => (
                        <div key={o.email}>
                          {o.name} <span className="st-muted">{o.email}</span>
                        </div>
                      ))}
                      {c.invitedOwners.map((e) => (
                        <div key={e}>
                          <span className="st-muted">{e}</span> <Badge tone="warn">Invited</Badge>
                        </div>
                      ))}
                      {!c.owners.length && !c.invitedOwners.length && <Badge tone="danger">No owner</Badge>}
                      {inviting === c.id ? (
                        <form
                          className="st-row"
                          style={{ gap: 6, marginTop: 6 }}
                          onSubmit={(e) => {
                            e.preventDefault();
                            void invite(c);
                          }}
                        >
                          <input className="st-input" style={{ height: 32, width: 220 }} type="email" aria-label={`Email to invite as owner of ${c.name}`} value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
                          <Button type="submit" size="sm" disabled={!inviteEmail.trim()}>
                            Send
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setInviting(undefined)}>
                            Cancel
                          </Button>
                        </form>
                      ) : (
                        // Offered where it is needed: nobody owns the customer yet. Once someone does, further owners are
                        // theirs to add under Members; the smaller link is for when their only owner has gone.
                        <div>
                          <Button size="sm" variant="ghost" onClick={() => (setInviting(c.id), setInviteEmail(c.owners.length ? '' : (c.invitedOwners[0] ?? '')))} aria-label={`${ownerAction(c)} (${c.name})`}>
                            {ownerAction(c)}
                          </Button>
                        </div>
                      )}
                    </td>
                    <td>
                      {c.members}
                      {c.memberLimit !== null && <span className="st-muted"> of {c.memberLimit}</span>}
                    </td>
                    <td>{c.forms}</td>
                    <td>{c.responsesThisMonth.toLocaleString()}</td>
                    <td>{c.failedWork ? <Badge tone="danger">{c.failedWork}</Badge> : <span className="st-muted">0</span>}</td>
                    <td title={c.lastActiveAt ? new Date(c.lastActiveAt).toLocaleString() : ''}>{ago(c.lastActiveAt)}</td>
                    <td className="st-muted">{day(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}
