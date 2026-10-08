import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Button, Card, PageHead, TextField, useSubmit } from '../components/ui';
import { PlanUsageCard } from '../components/PlanUsage';
import { BrandingCard, DomainsCard } from '../components/SiteSettings';
import { SsoCard } from '../components/SsoSettings';

export default function SettingsPage() {
  const { me, reload } = useAuth();
  const [name, setName] = useState(me?.org.name ?? '');
  const [saved, setSaved] = useState<string>();
  useEffect(() => setName(me?.org.name ?? ''), [me?.org.name]);

  const save = useSubmit(async () => {
    await api('/org', { method: 'PATCH', body: { name } });
    await reload();
    setSaved('Organisation name saved.');
  });
  const toggle2fa = useSubmit(async () => {
    await api('/org', { method: 'PATCH', body: { security: { require2fa: !me?.org.require2fa } } });
    await reload();
    setSaved(me?.org.require2fa ? 'Two-factor is no longer required.' : 'Everyone must now use two-factor sign-in.');
  });
  if (!me) return null;

  return (
    <>
      <PageHead title="Organisation" subtitle="Settings that apply to everyone in this organisation." />
      <div className="st-stack">
        {saved && <Alert tone="success">{saved}</Alert>}
        <Card title="General">
          <form className="st-row" style={{ alignItems: 'flex-end' }} onSubmit={save.submit} noValidate>
            <div style={{ flex: '1 1 280px' }}>
              <TextField label="Organisation name" value={name} onChange={(e) => setName(e.target.value)} error={save.fields.name} />
            </div>
            <Button type="submit" busy={save.busy} disabled={!name.trim() || name === me.org.name} style={{ marginBottom: save.fields.name ? 20 : 0 }}>
              Save
            </Button>
          </form>
        </Card>
        <PlanUsageCard />
        <BrandingCard />
        <DomainsCard />
        <Card title="Security" subtitle="Protect every account in the organisation.">
          <div className="st-stack">
            <div className="st-row" style={{ justifyContent: 'space-between' }}>
              <div>
                <strong>Require two-factor sign-in</strong>
                <div className="st-muted">Members without it can only reach the set-up screen until they turn it on.</div>
              </div>
              <Button variant={me.org.require2fa ? 'danger' : 'primary'} busy={toggle2fa.busy} disabled={!me.org.require2fa && !me.session.mfa} onClick={() => void toggle2fa.submit()}>
                {me.org.require2fa ? 'Stop requiring' : 'Require it'}
              </Button>
            </div>
            {!me.org.require2fa && !me.session.mfa && <Alert tone="info">Turn on two-factor for yourself first (Account & security), then sign in again with it.</Alert>}
            {toggle2fa.error && <Alert tone="error">{toggle2fa.error}</Alert>}
          </div>
        </Card>
        <SsoCard />
      </div>
    </>
  );
}
