import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Alert, Badge, Button, Card, SelectField, TextField, useSubmit } from './ui';

interface MailSettings {
  provider: 'DEFAULT' | 'SMTP' | 'MICROSOFT';
  enabled: boolean;
  from: string;
  fromName: string;
  smtp: { host: string; port: number; security: 'STARTTLS' | 'TLS'; username: string; passwordSet: boolean };
  microsoft: { tenantId: string; clientId: string; clientSecretSet: boolean };
  testedAt: string | null;
  lastError: string;
  lastErrorAt: string | null;
  sentTo?: string;
}

/** What the admin picks. Google is our name for one particular mail server; it is saved as that server. */
type Choice = 'DEFAULT' | 'MICROSOFT' | 'GOOGLE' | 'SMTP';
const GOOGLE_HOST = 'smtp.gmail.com';
/** Port and kind of security go together; nobody should have to know which pairs work. */
const PORTS = [
  { port: 587, security: 'STARTTLS', label: '587 (the usual one)' },
  { port: 465, security: 'TLS', label: '465' },
  { port: 25, security: 'STARTTLS', label: '25' },
  { port: 2525, security: 'STARTTLS', label: '2525' },
] as const;

export const choiceOf = (s: Pick<MailSettings, 'provider' | 'smtp'>): Choice => (s.provider === 'SMTP' ? (s.smtp.host === GOOGLE_HOST ? 'GOOGLE' : 'SMTP') : s.provider);

interface MailForm {
  from: string;
  fromName: string;
  host: string;
  port: number;
  username: string;
  password: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
}
/** The form as the saved settings fill it: secrets are never sent back, so their boxes start empty. */
const formOf = (d: MailSettings): MailForm => ({ from: d.from, fromName: d.fromName, host: d.smtp.host === GOOGLE_HOST ? '' : d.smtp.host, port: d.smtp.port, username: d.smtp.username, password: '', tenantId: d.microsoft.tenantId, clientId: d.microsoft.clientId, clientSecret: '' });

/** What is sent to the server for what is on the form: only the chosen kind's details, secrets only when typed. */
export function mailBody(choice: Choice, f: MailForm) {
  if (choice === 'DEFAULT') return { provider: 'DEFAULT' as const };
  const common = { from: f.from.trim(), fromName: f.fromName.trim() };
  if (choice === 'MICROSOFT') return { provider: 'MICROSOFT' as const, ...common, microsoft: { tenantId: f.tenantId.trim(), clientId: f.clientId.trim(), ...(f.clientSecret ? { clientSecret: f.clientSecret } : {}) } };
  const secret = f.password ? { password: f.password } : {};
  // Google: the server is known, and the sign-in is the address itself.
  if (choice === 'GOOGLE') return { provider: 'SMTP' as const, ...common, smtp: { host: GOOGLE_HOST, port: 587, security: 'STARTTLS' as const, username: f.from.trim(), ...secret } };
  const pair = PORTS.find((p) => p.port === f.port) ?? PORTS[0];
  return { provider: 'SMTP' as const, ...common, smtp: { host: f.host.trim(), port: pair.port, security: pair.security, username: f.username.trim(), ...secret } };
}

/**
 * The organisation's own mail server: emails to the people who fill in its
 * forms then come from its address. Saved, tested with an email to the admin,
 * and only then switched on.
 */
export function MailCard() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['org-mail'], queryFn: () => api<MailSettings>('/org/mail') });
  const [choice, setChoice] = useState<Choice>('DEFAULT');
  const [form, setForm] = useState<MailForm>({ from: '', fromName: '', host: '', port: 587, username: '', password: '', tenantId: '', clientId: '', clientSecret: '' });
  const [note, setNote] = useState<string>();
  useEffect(() => {
    if (!data) return;
    setChoice(choiceOf(data));
    setForm(formOf(data));
  }, [data]);
  const set = (k: keyof typeof form, v: string | number) => setForm((f) => ({ ...f, [k]: v }));
  const took = (next: MailSettings) => qc.setQueryData(['org-mail'], next);

  const save = useSubmit(async () => {
    took(await api<MailSettings>('/org/mail', { method: 'PUT', body: mailBody(choice, form) }));
    setNote(choice === 'DEFAULT' ? 'Saved. Emails go out from Form Builder.' : 'Saved. Now send yourself a test email.');
  });
  const test = useSubmit(async () => {
    setNote(undefined);
    try {
      const next = await api<MailSettings>('/org/mail/test', { method: 'POST' });
      took(next);
      setNote(`A test email is on its way to ${next.sentTo}. When it arrives, switch this on.`);
    } finally {
      await qc.invalidateQueries({ queryKey: ['org-mail'] });
    }
  });
  const use = useSubmit(async () => {
    const enabled = !data!.enabled;
    took(await api<MailSettings>('/org/mail/use', { method: 'POST', body: { enabled } }));
    setNote(enabled ? 'On. Emails to the people who fill in your forms now come from your address.' : 'Off. Emails go out from Form Builder again.');
  });

  if (!data) return null;
  const saved = choiceOf(data);
  // What is on the screen is what was saved: only then does a test say anything about it.
  const unchanged = saved === choice && JSON.stringify(form) === JSON.stringify(formOf(data));
  const error = save.error ?? test.error ?? use.error;
  return (
    <Card
      title="Email sending"
      subtitle="Emails to the people who fill in your forms (workflow emails, messages to a requester, signing invitations, portal links) can go out through your own mail server, from your own address."
      actions={data.provider === 'DEFAULT' ? undefined : data.enabled ? <Badge tone="success">On</Badge> : data.testedAt ? <Badge tone="accent">Tested, not on</Badge> : <Badge tone="warn">Not tested</Badge>}
    >
      <form className="st-stack" onSubmit={save.submit} noValidate>
        {note && <Alert tone="success">{note}</Alert>}
        {error && !Object.keys(save.fields).length && <Alert tone="error">{error}</Alert>}
        {data.lastError && !error && (
          <Alert tone="warn">
            The last email through your mail server did not go{data.lastErrorAt ? ` (${new Date(data.lastErrorAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })})` : ''}: {data.lastError}
          </Alert>
        )}
        <div style={{ maxWidth: 360 }}>
          <SelectField label="Send them through" value={choice} onChange={(e) => setChoice(e.target.value as Choice)}>
            <option value="DEFAULT">Form Builder (nothing to set up)</option>
            <option value="MICROSOFT">Microsoft 365</option>
            <option value="GOOGLE">Google Workspace or Gmail</option>
            <option value="SMTP">Another mail server (SMTP)</option>
          </SelectField>
        </div>
        {choice !== 'DEFAULT' && (
          <div className="st-grid-2">
            <TextField label={choice === 'MICROSOFT' ? 'Mailbox to send from' : 'Address to send from'} type="email" placeholder="helpdesk@yourcompany.com" value={form.from} onChange={(e) => set('from', e.target.value)} error={save.fields.from} />
            <TextField label="Name shown to the reader" placeholder="Your organisation's name" value={form.fromName} onChange={(e) => set('fromName', e.target.value)} />
          </div>
        )}
        {choice === 'MICROSOFT' && (
          <>
            <Alert tone="info">In Microsoft Entra, register an application, give it the <strong>Mail.Send</strong> application permission with admin consent, and create a client secret. Then paste its three values here.</Alert>
            <div className="st-grid-2">
              <TextField label="Directory (tenant) ID" value={form.tenantId} onChange={(e) => set('tenantId', e.target.value)} error={save.fields['microsoft.tenantId']} />
              <TextField label="Application (client) ID" value={form.clientId} onChange={(e) => set('clientId', e.target.value)} />
              <TextField label="Client secret" type="password" autoComplete="new-password" placeholder={data.microsoft.clientSecretSet ? 'Saved - type to replace' : ''} value={form.clientSecret} onChange={(e) => set('clientSecret', e.target.value)} />
            </div>
          </>
        )}
        {choice === 'GOOGLE' && (
          <>
            <Alert tone="info">Sign in to that Google account, turn on 2-Step Verification, and create an <strong>app password</strong>. Paste it here: it is not the account&apos;s own password.</Alert>
            <div style={{ maxWidth: 360 }}>
              <TextField label="App password" type="password" autoComplete="new-password" placeholder={data.smtp.passwordSet && saved === 'GOOGLE' ? 'Saved - type to replace' : ''} value={form.password} onChange={(e) => set('password', e.target.value)} />
            </div>
          </>
        )}
        {choice === 'SMTP' && (
          <div className="st-grid-2">
            <TextField label="Mail server" placeholder="smtp.yourcompany.com" value={form.host} onChange={(e) => set('host', e.target.value)} error={save.fields['smtp.host']} />
            <SelectField label="Port" value={String(PORTS.some((p) => p.port === form.port) ? form.port : 587)} onChange={(e) => set('port', Number(e.target.value))} error={save.fields['smtp.port']} hint="The connection is always encrypted.">
              {PORTS.map((p) => (
                <option key={p.port} value={p.port}>
                  {p.label}
                </option>
              ))}
            </SelectField>
            <TextField label="User name" autoComplete="off" value={form.username} onChange={(e) => set('username', e.target.value)} />
            <TextField label="Password" type="password" autoComplete="new-password" placeholder={data.smtp.passwordSet && saved === 'SMTP' ? 'Saved - type to replace' : ''} value={form.password} onChange={(e) => set('password', e.target.value)} />
          </div>
        )}
        <div className="st-row">
          <Button type="submit" busy={save.busy} disabled={unchanged}>
            Save
          </Button>
          {data.provider !== 'DEFAULT' && (
            <Button variant="secondary" busy={test.busy} disabled={!unchanged} title={unchanged ? '' : 'Save your changes first'} onClick={() => void test.submit()}>
              Send me a test email
            </Button>
          )}
          {data.provider !== 'DEFAULT' && (data.enabled || data.testedAt) && (
            <Button variant={data.enabled ? 'danger' : 'primary'} busy={use.busy} disabled={!unchanged} onClick={() => void use.submit()}>
              {data.enabled ? 'Stop using it' : 'Switch it on'}
            </Button>
          )}
        </div>
        <p className="st-muted" style={{ margin: 0, fontSize: 12 }}>
          Emails to your own team (invitations, password resets, notifications) always come from Form Builder. If your mail server refuses an email, the step that sent it fails and says why; nothing is sent from our address in its place.
        </p>
      </form>
    </Card>
  );
}
