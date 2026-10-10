import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Copy, Download, ShieldCheck, ShieldOff } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { AwayCard } from '../components/AwayCard';
import { Alert, Badge, Button, Card, PageHead, PasswordStrength, SelectField, TextField, useSubmit } from '../components/ui';

function TwoFactorCard() {
  const { me, reload } = useAuth();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string; qr?: string }>();
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>();
  const [disabling, setDisabling] = useState(false);
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (setup && !setup.qr) void QRCode.toDataURL(setup.otpauthUrl, { margin: 1, width: 320 }).then((qr) => setSetup((s) => (s ? { ...s, qr } : s)));
  }, [setup]);

  const start = useSubmit(async () => setSetup(await api<{ secret: string; otpauthUrl: string }>('/auth/2fa/setup', { method: 'POST' })));
  const enable = useSubmit(async () => {
    const res = await api<{ recoveryCodes: string[] }>('/auth/2fa/enable', { method: 'POST', body: { code } });
    setCodes(res.recoveryCodes);
    setSetup(undefined);
    setCode('');
    await reload();
  });
  const disable = useSubmit(async () => {
    await api('/auth/2fa/disable', { method: 'POST', body: { password, code } });
    setDisabling(false);
    setPassword('');
    setCode('');
    await reload();
  });
  if (!me) return null;

  const download = () => {
    const blob = new Blob([`Form Builder recovery codes for ${me.user.email}\nEach code works once.\n\n${codes!.join('\n')}\n`], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'form-builder-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <Card
      title="Two-factor sign-in"
      subtitle="A code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…) on top of your password."
      actions={me.user.twoFactorEnabled ? <Badge tone="success"><ShieldCheck size={12} /> On</Badge> : <Badge tone="warn">Off</Badge>}
    >
      <div className="st-stack">
        {codes && (
          <>
            <Alert tone="success">Two-factor is on. Save these recovery codes now - each works once if you lose your phone. They won't be shown again.</Alert>
            <div className="st-codes st-mono" aria-label="Recovery codes">
              {codes.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </div>
            <div className="st-row">
              <Button variant="secondary" size="sm" onClick={() => void navigator.clipboard?.writeText(codes.join('\n'))}>
                <Copy size={14} /> Copy
              </Button>
              <Button variant="secondary" size="sm" onClick={download}>
                <Download size={14} /> Download
              </Button>
              <Button size="sm" onClick={() => setCodes(undefined)}>
                I've saved them
              </Button>
            </div>
          </>
        )}

        {!me.user.twoFactorEnabled && !setup && !codes && (
          <div className="st-row">
            <Button busy={start.busy} onClick={() => void start.submit()}>
              <ShieldCheck size={16} /> Set up two-factor
            </Button>
            {start.error && <Alert tone="error">{start.error}</Alert>}
          </div>
        )}

        {setup && (
          <form className="st-stack" onSubmit={enable.submit} noValidate>
            <div className="st-qr">
              {setup.qr ? <img src={setup.qr} alt="QR code for your authenticator app" /> : <div style={{ width: 168, height: 168 }} />}
              <div className="st-stack" style={{ gap: 8, flex: '1 1 240px' }}>
                <strong>1. Scan this with your authenticator app</strong>
                <span className="st-muted">Can't scan? Enter this key instead:</span>
                <code className="st-mono" style={{ wordBreak: 'break-all' }}>
                  {setup.secret.match(/.{1,4}/g)?.join(' ')}
                </code>
              </div>
            </div>
            <strong>2. Enter the 6-digit code it shows</strong>
            <div className="st-row" style={{ alignItems: 'flex-start' }}>
              <div style={{ width: 200 }}>
                <TextField label="Code" className="st-input--code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
              </div>
              <Button type="submit" busy={enable.busy} disabled={code.length !== 6} style={{ marginTop: 26 }}>
                Turn on
              </Button>
              <Button variant="ghost" onClick={() => setSetup(undefined)} style={{ marginTop: 26 }}>
                Cancel
              </Button>
            </div>
            {enable.error && <Alert tone="error">{enable.error}</Alert>}
          </form>
        )}

        {me.user.twoFactorEnabled && !codes && (
          <>
            {!me.session.mfa && <Alert tone="info">This session signed in before two-factor was on. Sign out and in again to use it here.</Alert>}
            {disabling ? (
              <form className="st-stack" onSubmit={disable.submit} noValidate>
                <div className="st-grid-2">
                  <TextField label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                  <TextField label="Code or recovery code" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
                </div>
                {disable.error && <Alert tone="error">{disable.error}</Alert>}
                <div className="st-row">
                  <Button type="submit" variant="danger" busy={disable.busy} disabled={!password || !code}>
                    <ShieldOff size={16} /> Turn off two-factor
                  </Button>
                  <Button variant="ghost" onClick={() => setDisabling(false)}>
                    Keep it on
                  </Button>
                </div>
              </form>
            ) : (
              <div>
                <Button variant="secondary" onClick={() => setDisabling(true)} disabled={me.org.require2fa}>
                  Turn off
                </Button>
                {me.org.require2fa && <div className="st-field__hint" style={{ marginTop: 6 }}>{me.org.name} requires two-factor sign-in.</div>}
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

function PasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [done, setDone] = useState(false);
  const change = useSubmit(async () => {
    await api('/auth/password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
    setDone(true);
    setCurrent('');
    setNext('');
  });
  return (
    <Card title="Password" subtitle="Changing it signs you out on your other devices.">
      <form className="st-stack" onSubmit={change.submit} noValidate>
        {done && <Alert tone="success">Password changed. Other devices were signed out.</Alert>}
        {change.error && !change.fields.newPassword && <Alert tone="error">{change.error}</Alert>}
        <div className="st-grid-2">
          <TextField label="Current password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          <div className="st-stack" style={{ gap: 6 }}>
            <TextField label="New password" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} error={change.fields.newPassword} />
            <PasswordStrength value={next} />
          </div>
        </div>
        <div>
          <Button type="submit" busy={change.busy} disabled={!current || next.length < 10}>
            Change password
          </Button>
        </div>
      </form>
    </Card>
  );
}

function NewOrgCard({ operator }: { operator: boolean }) {
  const { switchOrg } = useAuth();
  const [name, setName] = useState('');
  const [plan, setPlan] = useState('FREE');
  const create = useSubmit(async () => {
    const org = await api<{ id: string }>('/orgs', { method: 'POST', body: operator ? { name, plan } : { name } });
    await switchOrg(org.id);
  });
  return (
    <Card
      title={operator ? 'Add a customer' : 'Another organisation'}
      subtitle={operator ? "A new organisation for a customer, on the plan they have bought. You'll be its owner to begin with: invite their person under Members, make them an owner, then leave." : "Keep a separate workspace, e.g. for another company. You'll be its owner."}
    >
      <form className="st-row" style={{ alignItems: 'flex-end' }} onSubmit={create.submit} noValidate>
        {create.error && !Object.keys(create.fields).length && <Alert tone="error">{create.error}</Alert>}
        <div style={{ flex: '1 1 260px' }}>
          <TextField label="Organisation name" value={name} onChange={(e) => setName(e.target.value)} error={create.fields.name} />
        </div>
        {operator && (
          <div style={{ width: 180 }}>
            <SelectField label="Plan" value={plan} onChange={(e) => setPlan(e.target.value)}>
              <option value="FREE">Free</option>
              <option value="TEAM">Team</option>
              <option value="BUSINESS">Business</option>
              <option value="ENTERPRISE">Enterprise</option>
            </SelectField>
          </div>
        )}
        <Button type="submit" variant="secondary" busy={create.busy} disabled={!name.trim()}>
          Create and switch
        </Button>
      </form>
    </Card>
  );
}

export default function AccountPage() {
  const { me, needsTwoFactor } = useAuth();
  if (!me) return null;
  return (
    <>
      <PageHead title="Account & security" subtitle={`${me.user.name} · ${me.user.email}`} />
      <div className="st-stack">
        <TwoFactorCard />
        {!needsTwoFactor && (
          <>
            <AwayCard />
            <PasswordCard />
            {me.operator ? (
              <Card title="Customers" subtitle="You run this installation: add customers and set their plans on the Customers page.">
                <Link className="st-link" to="/customers">
                  Open Customers
                </Link>
              </Card>
            ) : (
              me.canCreateOrgs !== false && <NewOrgCard operator={false} />
            )}
          </>
        )}
      </div>
    </>
  );
}
