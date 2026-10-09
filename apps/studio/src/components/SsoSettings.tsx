import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../lib/api';
import { Alert, Badge, Button, Card, Field, SelectField, TextField, useSubmit } from './ui';
import { readIdpMetadata } from '../lib/saml-metadata';

interface Sso {
  enabled: boolean;
  protocol: 'OIDC' | 'SAML';
  saml: { entryPoint: string; idpIssuer: string; certSet: boolean; certExpiresAt: string | null; entityId: string; acsUrl: string; metadataUrl: string };
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

/** Single sign-on with the customer's identity provider, by OpenID Connect or SAML 2.0. */
export function SsoCard() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['sso'], queryFn: () => api<Sso>('/org/sso') });
  const [form, setForm] = useState({ protocol: 'OIDC' as 'OIDC' | 'SAML', issuer: '', clientId: '', clientSecret: '', entryPoint: '', idpIssuer: '', cert: '', domains: '', autoProvision: false, defaultRole: 'VIEWER' });
  const [fileNote, setFileNote] = useState<{ tone: 'success' | 'error'; text: string }>();
  const [saved, setSaved] = useState<string>();
  useEffect(() => {
    if (data) setForm({ protocol: data.protocol, issuer: data.issuer, clientId: data.clientId, clientSecret: '', entryPoint: data.saml.entryPoint, idpIssuer: data.saml.idpIssuer, cert: '', domains: [...data.domains, ...data.pendingDomains.map((p) => p.domain)].join(', '), autoProvision: data.autoProvision, defaultRole: data.defaultRole });
  }, [data]);
  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));
  const refresh = () => qc.invalidateQueries({ queryKey: ['sso'] });

  const save = useSubmit(async () => {
    await api('/org/sso', {
      method: 'PUT',
      body: {
        protocol: form.protocol,
        // Only the chosen kind's details are sent: the other's stay as they were.
        ...(form.protocol === 'SAML'
          ? { saml: { entryPoint: form.entryPoint, idpIssuer: form.idpIssuer, ...(form.cert.trim() ? { cert: form.cert } : {}) } }
          : { issuer: form.issuer, clientId: form.clientId, ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}) }),
        domains: form.domains.split(/[\s,]+/).filter(Boolean),
        autoProvision: form.autoProvision,
        defaultRole: form.defaultRole,
      },
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

  /** The provider's metadata file fills in its three values; nothing is saved until the admin saves. */
  const fromFile = async (file: File | undefined) => {
    if (!file) return;
    const found = readIdpMetadata(await file.text());
    if (!found) return setFileNote({ tone: 'error', text: "That is not an identity provider's metadata file. Download it from your provider's SAML set-up page, or fill in the three boxes by hand." });
    setForm((f) => ({ ...f, ...found }));
    setFileNote({ tone: 'success', text: 'Filled in from the file. Check the values, then save.' });
  };

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
      <Card title="Single sign-on" subtitle="Sign in with Entra ID, Okta, Google Workspace or any provider that speaks OpenID Connect or SAML 2.0.">
        <Alert tone="info">Available on the Business plan and above.</Alert>
      </Card>
    );
  }
  return (
    <Card
      title="Single sign-on"
      subtitle="Sign in with Entra ID, Okta, Google Workspace or any provider that speaks OpenID Connect or SAML 2.0."
      actions={data.enabled ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}
    >
      <form className="st-stack" onSubmit={save.submit} noValidate>
        {saved && <Alert tone="success">{saved}</Alert>}
        {(save.error || onOff.error || enforce.error) && !Object.keys(save.fields).length && <Alert tone="error">{save.error ?? onOff.error ?? enforce.error}</Alert>}
        <div style={{ maxWidth: 320 }}>
          <SelectField label="My identity provider uses" value={form.protocol} onChange={(e) => set('protocol', e.target.value)}>
            <option value="OIDC">OpenID Connect</option>
            <option value="SAML">SAML 2.0</option>
          </SelectField>
        </div>
        {form.protocol !== data.protocol && data.enabled && <Alert tone="warn">Saving with a different kind of provider turns single sign-on off until you turn it on again and it has worked once.</Alert>}
        {form.protocol === 'SAML' ? (
          <>
            <Alert tone="info">
              In your provider, add a SAML application. Give it this metadata address, or the two values under it. Send the person&apos;s email address as the name ID.
              <table className="st-dns" style={{ marginTop: 8 }}>
                <tbody>
                  <tr>
                    <td>Metadata address</td>
                    <td className="st-mono">{data.saml.metadataUrl}</td>
                  </tr>
                  <tr>
                    <td>Reply (ACS) address</td>
                    <td className="st-mono">{data.saml.acsUrl}</td>
                  </tr>
                  <tr>
                    <td>Identifier (entity ID)</td>
                    <td className="st-mono">{data.saml.entityId}</td>
                  </tr>
                </tbody>
              </table>
            </Alert>
            <div className="st-row" style={{ alignItems: 'center', gap: 12 }}>
              <label className="st-btn st-btn--secondary st-btn--sm" style={{ cursor: 'pointer' }}>
                Fill in from your provider&apos;s metadata file
                <input
                  type="file"
                  accept=".xml,application/xml,text/xml"
                  hidden
                  aria-label="Provider metadata file"
                  onChange={(e) => {
                    void fromFile(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
              </label>
              <span className="st-muted">or fill in the three boxes below. The file stays on your computer.</span>
            </div>
            {fileNote && <Alert tone={fileNote.tone}>{fileNote.text}</Alert>}
            <div className="st-grid-2">
              <TextField label="Provider's sign-in address" placeholder="https://login.microsoftonline.com/<tenant>/saml2" value={form.entryPoint} onChange={(e) => set('entryPoint', e.target.value)} error={save.fields['saml.entryPoint']} />
              <TextField label="Provider's identifier (entity ID)" placeholder="https://sts.windows.net/<tenant>/" value={form.idpIssuer} onChange={(e) => set('idpIssuer', e.target.value)} />
            </div>
            <Field
              label="Provider's signing certificate"
              error={save.fields['saml.cert']}
              hint={data.saml.certSet ? `One is saved${data.saml.certExpiresAt ? `; it runs out on ${new Date(data.saml.certExpiresAt).toLocaleDateString(undefined, { dateStyle: 'long' })}` : ''}. Paste another to replace it.` : 'It is public: it checks the provider\'s signature and cannot make one.'}
            >
              {(id, describedBy) => <textarea id={id} aria-describedby={describedBy} className="st-input st-mono" rows={4} spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" value={form.cert} onChange={(e) => set('cert', e.target.value)} />}
            </Field>
          </>
        ) : (
          <>
            <Alert tone="info">
              In your provider, create a web application with redirect URI <code className="st-mono">{data.callbackUrl}</code> and scopes openid, email, profile.
            </Alert>
            <div className="st-grid-2">
              <TextField label="Issuer URL" placeholder="https://login.microsoftonline.com/<tenant>/v2.0" value={form.issuer} onChange={(e) => set('issuer', e.target.value)} error={save.fields.issuer} />
              <TextField label="Client ID" value={form.clientId} onChange={(e) => set('clientId', e.target.value)} />
              <TextField label="Client secret" type="password" autoComplete="new-password" placeholder={data.clientSecretSet ? 'Saved - type to replace' : ''} value={form.clientSecret} onChange={(e) => set('clientSecret', e.target.value)} />
            </div>
          </>
        )}
        <div className="st-grid-2">
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
