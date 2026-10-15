import { useEffect, useState, useRef } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Button, Card, PageHead, SelectField, TextField, useSubmit } from '../components/ui';
import { PlanUsageCard } from '../components/PlanUsage';
import { BrandingCard, DomainsCard, PortalCard } from '../components/SiteSettings';
import { AiCard } from '../components/AiCard';
import { SsoCard } from '../components/SsoSettings';
import { MailCard } from '../components/MailSettings';
import { SealCard } from '../components/SealSettings';
import { PaymentsCard, SmsCard } from '../components/CheckoutSettings';

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
  const toggleReview = useSubmit(async () => {
    await api('/org', { method: 'PATCH', body: { security: { requireReview: !me?.org.requireReview } } });
    await reload();
    setSaved(me?.org.requireReview ? 'Forms can be published without a review again.' : 'Forms must now be approved by someone else before they are published.');
  });
  const idleChoice = useRef(30);
  const setIdle = useSubmit(async () => {
    const minutes = idleChoice.current;
    await api('/org', { method: 'PATCH', body: { security: { idleMinutes: minutes } } });
    await reload();
    setSaved(minutes ? `People are now signed out after ${minutes >= 60 ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `${minutes} minutes`} away.` : 'People are no longer signed out for being away.');
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
        <PortalCard />
        <AiCard />
        <MailCard />
        <SealCard />
        <SmsCard />
        <PaymentsCard />
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
            <div className="st-row" style={{ justifyContent: 'space-between' }}>
              <div>
                <strong>Review before publishing</strong>
                <div className="st-muted">A form goes live only once someone other than its author has approved it. Needs at least two people who can publish.</div>
              </div>
              <Button variant={me.org.requireReview ? 'danger' : 'primary'} busy={toggleReview.busy} onClick={() => void toggleReview.submit()}>
                {me.org.requireReview ? 'Stop requiring' : 'Require it'}
              </Button>
            </div>
            {toggleReview.error && <Alert tone="error">{toggleReview.error}</Alert>}
            <div className="st-row" style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
              <div>
                <strong>Sign out when away</strong>
                <div className="st-muted">Someone who leaves the builder open is signed out after this long without touching it, with a minute's warning.</div>
              </div>
              <div style={{ width: 200 }}>
                <SelectField label="Sign out after" value={String(me.org.idleMinutes ?? 30)} disabled={setIdle.busy} onChange={(e) => {
                    idleChoice.current = Number(e.target.value);
                    void setIdle.submit();
                  }}
                >
                  <option value="15">15 minutes</option>
                  <option value="30">30 minutes</option>
                  <option value="60">1 hour</option>
                  <option value="120">2 hours</option>
                  <option value="480">8 hours</option>
                  <option value="0">Never</option>
                </SelectField>
              </div>
            </div>
            {setIdle.error && <Alert tone="error">{setIdle.error}</Alert>}
          </div>
        </Card>
        <SsoCard />
      </div>
    </>
  );
}
