import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../lib/api';
import { Alert, Badge, Button, Card, SelectField, TextField, useSubmit } from './ui';

interface Sso {
  enabled: boolean;
  issuer: string;
  clientId: string;
  clientSecretSet: boolean;
  domains: string[];
  pendingDomains: { domain: string; dns: { type: 'TXT'; name: string; value: string } }[];
  autoProvision: boolean;
  defaultRole: string;
  enforce: boolean;
  lastSuccessAt: string | null;
  callbackUrl: string;
  available: boolean;
}
const ROLES = ['VIEWER', 'RECORDS_WORKER', 'DESIGNER', 'PUBLISHER', 'CONNECTOR_MANAGER', 'ADMIN'];

/** OpenID Connect with the customer's identity provider. */
export function SsoCard() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['sso'], queryFn: () => api<Sso>('/org/sso') });
  const [form, setForm] = useState({ issuer: '', clientId: '', clientSecret: '', domains: '', autoProvision: false, defaultRole: 'VIEWER' });
  const [saved, setSaved] = useState<string>();
  useEffect(() => {
    if (data) setForm({ issuer: data.issuer, clientId: data.clientId, clientSecret: '', domains: [...data.domains, ...data.pendingDomains.map((p) => p.domain)].join(', '), autoProvision: data.autoProvision, defaultRole: data.defaultRole });
  }, [data]);
  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));
  const refresh = () => qc.invalidateQueries({ queryKey: ['sso'] });

  const save = useSubmit(async () => {
    await api('/org/sso', {
      method: 'PUT',
      body: { issuer: form.issuer, clientId: form.clientId, ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}), domains: form.domains.split(/[\s,]+/).filter(Boolean), autoProvision: form.autoProvision, defaultRole: form.defaultRole },
    });
    await refresh();
    setSaved('Single sign-on settings saved.');
  });
  const onOff = useSubmit(async () => {
    const enabled = !data!.enabled;
    await api('/org/sso', { method: 'PUT', body: { enabled } });
    await refresh();
    setSaved(enabled ? 'Single sign-on is on.' : 'Single sign-on is off.');
  });
  const enforce = useSubmit(async () => {
    const next = !data!.enforce;
    await api('/org/sso', { method: 'PUT', body: { enforce: next } });
    await refresh();
    setSaved(next ? 'Password sign-in is now refused for your domains.' : 'Password sign-in is allowed again.');
  });

  const verify = async (domain: string) => {
    try {
      await api(`/org/sso/domains/${domain}/verify`, { method: 'POST' });
      await refresh();
      setSaved(`${domain} is verified.`);
    } catch (e) {
      save.setError(errorMessage(e));
    }
  };

  if (!data) return null;
  if (!data.available) {
    return (
      <Card title="Single sign-on" subtitle="Sign in with Entra ID, Okta, Google Workspace or any OpenID Connect provider.">
        <Alert tone="info">Available on the Business plan and above.</Alert>
      </Card>
    );
  }
  return (
    <Card
      title="Single sign-on"
      subtitle="Sign in with Entra ID, Okta, Google Workspace or any OpenID Connect provider."
      actions={data.enabled ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}
    >
      <form className="st-stack" onSubmit={save.submit} noValidate>
        {saved && <Alert tone="success">{saved}</Alert>}
        {(save.error || onOff.error || enforce.error) && !Object.keys(save.fields).length && <Alert tone="error">{save.error ?? onOff.error ?? enforce.error}</Alert>}
        <Alert tone="info">
          In your provider, create a web application with redirect URI <code className="st-mono">{data.callbackUrl}</code> and scopes openid, email, profile.
        </Alert>
        <div className="st-grid-2">
          <TextField label="Issuer URL" placeholder="https://login.microsoftonline.com/<tenant>/v2.0" value={form.issuer} onChange={(e) => set('issuer', e.target.value)} error={save.fields.issuer} />
          <TextField label="Client ID" value={form.clientId} onChange={(e) => set('clientId', e.target.value)} />
          <TextField label="Client secret" type="password" autoComplete="new-password" placeholder={data.clientSecretSet ? 'Saved - type to replace' : ''} value={form.clientSecret} onChange={(e) => set('clientSecret', e.target.value)} />
          <TextField label="Email domains" placeholder="acme.com, acme.in" hint="Only addresses on these domains can sign in through this provider." value={form.domains} onChange={(e) => set('domains', e.target.value)} error={save.fields.domains} />
        </div>
        {data.domains.length > 0 && (
          <div className="st-row" style={{ gap: 6 }}>
            {data.domains.map((d) => (
              <Badge key={d} tone="success">
                {d} verified
              </Badge>
            ))}
          </div>
        )}
        {data.pendingDomains.map((p) => (
          <div key={p.domain} className="st-domain">
            <div className="st-row" style={{ justifyContent: 'space-between' }}>
              <span>
                Prove you own <strong>{p.domain}</strong>: add this DNS record, then verify.
              </span>
              <Button size="sm" onClick={() => void verify(p.domain)}>
                Verify
              </Button>
            </div>
            <table className="st-dns">
              <tbody>
                <tr>
                  <td>TXT</td>
                  <td className="st-mono">{p.dns.name}</td>
                  <td className="st-mono">{p.dns.value}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ))}
        <label className="st-check">
          <input type="checkbox" checked={form.autoProvision} onChange={(e) => set('autoProvision', e.target.checked)} />
          <span>
            Add people automatically on their first sign-in
            <span className="st-field__hint" style={{ display: 'block' }}>
              Otherwise they need an invitation first.
            </span>
          </span>
        </label>
        {form.autoProvision && (
          <div style={{ maxWidth: 260 }}>
            <SelectField label="Role for new people" value={form.defaultRole} onChange={(e) => set('defaultRole', e.target.value)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r.replace('_', ' ').toLowerCase()}
                </option>
              ))}
            </SelectField>
          </div>
        )}
        <div className="st-row">
          <Button type="submit" busy={save.busy}>
            Save
          </Button>
          <Button variant={data.enabled ? 'danger' : 'secondary'} busy={onOff.busy} onClick={() => void onOff.submit()}>
            {data.enabled ? 'Turn off' : 'Turn on'}
          </Button>
          {data.enabled && (
            <Button variant="secondary" busy={enforce.busy} disabled={!data.enforce && !data.lastSuccessAt} onClick={() => void enforce.submit()} title={data.lastSuccessAt ? '' : 'Sign in with SSO once first'}>
              {data.enforce ? 'Allow passwords again' : 'Require SSO'}
            </Button>
          )}
        </div>
        {data.enabled && !data.lastSuccessAt && <p className="st-muted" style={{ margin: 0, fontSize: 12 }}>Test it: sign out and use "Sign in with SSO". Requiring SSO unlocks after one successful sign-in.</p>}
      </form>
    </Card>
  );
}
