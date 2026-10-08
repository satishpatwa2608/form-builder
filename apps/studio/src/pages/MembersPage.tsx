import { useState } from 'react';
import { MailPlus, ShieldCheck, Trash2, X } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction, useInvitations, useMembers } from '../lib/queries';
import { ORG_ROLES, ROLE_HINT, ROLE_LABEL, type Member, type OrgRole } from '../lib/types';
import { Alert, Avatar, Badge, Button, Card, PageHead, SelectField, TextField, useSubmit } from '../components/ui';

export default function MembersPage() {
  const { me, can } = useAuth();
  const manage = can('members.manage');
  const members = useMembers();
  const invitations = useInvitations(manage);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string }>();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('DESIGNER');

  const invite = useSubmit(async () => {
    await api('/invitations', { method: 'POST', body: { email, role } });
    setMessage({ tone: 'success', text: `Invitation sent to ${email}.` });
    setEmail('');
    await invitations.refetch();
  });
  const done = (text: string) => ({ onSuccess: () => setMessage({ tone: 'success', text }), onError: (e: Error) => setMessage({ tone: 'error', text: errorMessage(e) }) });
  const update = useAction((a: { userId: string; body: Partial<Pick<Member, 'role' | 'status' | 'department' | 'managerId'>> }) => api(`/members/${a.userId}`, { method: 'PATCH', body: a.body }), [['members']]);
  const remove = useAction((userId: string) => api(`/members/${userId}`, { method: 'DELETE' }), [['members']]);
  const revoke = useAction((id: string) => api(`/invitations/${id}`, { method: 'DELETE' }), [['invitations']]);
  // Owners can hand out any role; others only roles below owner (the server checks the rest).
  const roleChoices = ORG_ROLES.filter((r) => r !== 'OWNER' || me?.org.role === 'OWNER');

  return (
    <>
      <PageHead title="Members" subtitle="Who can work in this organisation, and their role here." />
      <div className="st-stack">
        {message && <Alert tone={message.tone}>{message.text}</Alert>}
        {manage && (
          <Card title="Invite someone" subtitle="They get an email link that works for 7 days.">
            <form className="st-row" style={{ alignItems: 'flex-end' }} onSubmit={invite.submit} noValidate>
              <div style={{ flex: '2 1 240px' }}>
                <TextField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} error={invite.fields.email} />
              </div>
              <div style={{ flex: '1 1 180px' }}>
                <SelectField label="Role" value={role} onChange={(e) => setRole(e.target.value as OrgRole)} hint={ROLE_HINT[role]}>
                  {roleChoices.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </SelectField>
              </div>
              <Button type="submit" busy={invite.busy} disabled={!email} style={{ marginBottom: 20 }}>
                <MailPlus size={16} /> Send invitation
              </Button>
            </form>
            {invite.error && !invite.fields.email && <Alert tone="error">{invite.error}</Alert>}
          </Card>
        )}

        <Card title="Team" subtitle={members.data?.length === 1 ? '1 person' : `${members.data?.length ?? 0} people`} bodyless>
          <div className="st-table-wrap">
            <table className="st-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Role</th>
                  <th>Department</th>
                  <th>Manager</th>
                  <th>Two-factor</th>
                  <th>Status</th>
                  {manage && <th aria-label="Actions" />}
                </tr>
              </thead>
              <tbody>
                {(members.data ?? []).map((m) => {
                  const self = m.userId === me?.user.id;
                  return (
                    <tr key={m.userId}>
                      <td>
                        <div className="st-person">
                          <Avatar name={m.name} />
                          <div>
                            <strong>
                              {m.name} {self && <Badge>You</Badge>}
                            </strong>
                            <span>{m.email}</span>
                          </div>
                        </div>
                      </td>
                      <td>
                        {manage ? (
                          <select
                            className="st-select"
                            style={{ height: 32, width: 180 }}
                            aria-label={`Role of ${m.name}`}
                            value={m.role}
                            onChange={(e) => update.mutate({ userId: m.userId, body: { role: e.target.value as OrgRole } }, done(`${m.name} is now ${ROLE_LABEL[e.target.value as OrgRole]}.`))}
                          >
                            {(roleChoices.includes(m.role) ? roleChoices : [m.role, ...roleChoices]).map((r) => (
                              <option key={r} value={r}>
                                {ROLE_LABEL[r]}
                              </option>
                            ))}
                          </select>
                        ) : (
                          ROLE_LABEL[m.role]
                        )}
                      </td>
                      <td>
                        {manage ? (
                          <input
                            className="st-input"
                            style={{ height: 32, width: 140 }}
                            aria-label={`Department of ${m.name}`}
                            defaultValue={m.department}
                            placeholder="-"
                            onBlur={(e) => e.target.value.trim() !== m.department && update.mutate({ userId: m.userId, body: { department: e.target.value.trim() } }, done(`${m.name}'s department saved.`))}
                          />
                        ) : (
                          m.department || <span className="st-muted">-</span>
                        )}
                      </td>
                      <td>
                        {manage ? (
                          <select
                            className="st-select"
                            style={{ height: 32, width: 160 }}
                            aria-label={`Manager of ${m.name}`}
                            value={m.managerId}
                            onChange={(e) => update.mutate({ userId: m.userId, body: { managerId: e.target.value } }, done(`${m.name}'s manager saved.`))}
                          >
                            <option value="">No manager</option>
                            {(members.data ?? [])
                              .filter((x) => x.userId !== m.userId && x.status === 'ACTIVE')
                              .map((x) => (
                                <option key={x.userId} value={x.userId}>
                                  {x.name}
                                </option>
                              ))}
                          </select>
                        ) : (
                          members.data?.find((x) => x.userId === m.managerId)?.name ?? <span className="st-muted">-</span>
                        )}
                      </td>
                      <td>{m.twoFactorEnabled ? <Badge tone="success"><ShieldCheck size={12} /> On</Badge> : <Badge>Off</Badge>}</td>
                      <td>{m.status === 'ACTIVE' ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Disabled</Badge>}</td>
                      {manage && (
                        <td style={{ textAlign: 'right' }}>
                          {!self && (
                            <div className="st-row" style={{ justifyContent: 'flex-end' }}>
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() =>
                                  update.mutate(
                                    { userId: m.userId, body: { status: m.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' } },
                                    done(m.status === 'ACTIVE' ? `${m.name} is disabled and signed out.` : `${m.name} can sign in again.`),
                                  )
                                }
                              >
                                {m.status === 'ACTIVE' ? 'Disable' : 'Enable'}
                              </Button>
                              <Button
                                variant="danger"
                                size="sm"
                                aria-label={`Remove ${m.name}`}
                                onClick={() => window.confirm(`Remove ${m.name} from ${me?.org.name}?`) && remove.mutate(m.userId, done(`${m.name} was removed.`))}
                              >
                                <Trash2 size={14} />
                              </Button>
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

        {manage && (
          <Card title="Pending invitations" bodyless>
            {invitations.data?.length ? (
              <div className="st-table-wrap">
                <table className="st-table">
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>Role</th>
                      <th>Expires</th>
                      <th aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {invitations.data.map((i) => (
                      <tr key={i.id}>
                        <td>{i.email}</td>
                        <td>{ROLE_LABEL[i.role]}</td>
                        <td className="st-muted">{new Date(i.expiresAt).toLocaleDateString()}</td>
                        <td style={{ textAlign: 'right' }}>
                          <Button variant="ghost" size="sm" onClick={() => revoke.mutate(i.id, done(`Invitation to ${i.email} withdrawn.`))}>
                            <X size={14} /> Withdraw
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="st-empty">No invitations waiting.</p>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
