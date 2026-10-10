import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Alert, Badge, Button, Card, SelectField, TextField, useSubmit } from './ui';

interface PaymentSettings {
  provider: 'NONE' | 'TEST' | 'RAZORPAY' | 'STRIPE';
  keyId: string;
  secretSet: boolean;
  providers: { id: PaymentSettings['provider']; name: string }[];
}

/**
 * The organisation's payment service, used by every form that takes a payment. Chosen once here; a form only
 * says how much is due.
 */
export function PaymentsCard() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['org-payments'], queryFn: () => api<PaymentSettings>('/org/payments') });
  const [provider, setProvider] = useState<PaymentSettings['provider']>('NONE');
  const [keyId, setKeyId] = useState('');
  const [secret, setSecret] = useState('');
  const [note, setNote] = useState<string>();
  useEffect(() => {
    if (!data) return;
    setProvider(data.provider);
    setKeyId(data.keyId);
    setSecret('');
  }, [data]);
  const save = useSubmit(async () => {
    const next = await api<PaymentSettings>('/org/payments', { method: 'PUT', body: { provider, ...(provider === 'RAZORPAY' ? { keyId: keyId.trim() } : {}), ...(secret ? { secret } : {}) } });
    qc.setQueryData(['org-payments'], next);
    setNote(next.provider === 'NONE' ? 'Saved. Forms cannot take payments.' : next.provider === 'TEST' ? 'Saved. Forms that take a payment now show a practice page: no money moves.' : `Saved. Forms that take a payment now send people to ${next.providers.find((p) => p.id === next.provider)?.name}.`);
  });
  if (!data) return null;
  const sameService = provider === data.provider;
  return (
    <Card
      title="Payments"
      subtitle="The payment service that takes the money when a form asks for a payment. Each form says how much is due (its settings → Take a payment with each response)."
      actions={data.provider === 'NONE' ? undefined : data.provider === 'TEST' ? <Badge tone="warn">Practice</Badge> : <Badge tone="success">On</Badge>}
    >
      <form className="st-stack" onSubmit={save.submit} noValidate>
        {note && <Alert tone="success">{note}</Alert>}
        {save.error && !Object.keys(save.fields).length && <Alert tone="error">{save.error}</Alert>}
        <div style={{ maxWidth: 360 }}>
          <SelectField label="Take payments through" value={provider} onChange={(e) => setProvider(e.target.value as PaymentSettings['provider'])}>
            {data.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id === 'NONE' ? 'Nothing: forms do not take payments' : p.name}
              </option>
            ))}
          </SelectField>
        </div>
        {provider === 'TEST' && <Alert tone="info">For trying your forms out. The person sees a practice page with a Pay button and a Let it fail button, and the response is registered as if paid. Change this before real people pay.</Alert>}
        {provider === 'RAZORPAY' && (
          <>
            <Alert tone="info">In your Razorpay dashboard open Account &amp; Settings → API keys, and generate a key. Paste its two values here. Use a test key first: nothing else changes when you move to a live one.</Alert>
            <div className="st-grid-2">
              <TextField label="Key ID" placeholder="rzp_test_…" value={keyId} onChange={(e) => setKeyId(e.target.value)} error={save.fields.keyId} />
              <TextField label="Key secret" type="password" autoComplete="new-password" placeholder={data.secretSet && sameService ? 'Saved - type to replace' : ''} value={secret} onChange={(e) => setSecret(e.target.value)} error={save.fields.secret} />
            </div>
          </>
        )}
        {provider === 'STRIPE' && (
          <>
            <Alert tone="info">In your Stripe dashboard open Developers → API keys and copy the secret key. Use the test key (sk_test_…) first.</Alert>
            <div style={{ maxWidth: 360 }}>
              <TextField label="Secret key" type="password" autoComplete="new-password" placeholder={data.secretSet && sameService ? 'Saved - type to replace' : 'sk_test_…'} value={secret} onChange={(e) => setSecret(e.target.value)} error={save.fields.secret} />
            </div>
          </>
        )}
        <div>
          <Button type="submit" busy={save.busy}>
            Save
          </Button>
        </div>
      </form>
    </Card>
  );
}

interface SmsSettings {
  url: string;
  method: 'POST' | 'GET';
  format: 'JSON' | 'FORM';
  body: string;
  headers: { name: string; valueSet: boolean }[];
  enabled: boolean;
  testedAt: string | null;
  lastError: string;
}

/**
 * The organisation's own SMS service, whichever it is: where it is called and what is sent, as that service's
 * documentation describes. Used to send the codes that confirm a phone number on a form. Tested before it is used.
 */
export function SmsCard() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['org-sms'], queryFn: () => api<SmsSettings>('/org/sms') });
  const [form, setForm] = useState({ url: '', method: 'POST' as SmsSettings['method'], format: 'JSON' as SmsSettings['format'], body: '', headerName: '', headerValue: '' });
  const [to, setTo] = useState('');
  const [note, setNote] = useState<string>();
  useEffect(() => {
    if (data) setForm({ url: data.url, method: data.method, format: data.format, body: data.body, headerName: data.headers[0]?.name ?? '', headerValue: '' });
  }, [data]);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const took = (next: SmsSettings) => qc.setQueryData(['org-sms'], next);
  const save = useSubmit(async () => {
    const headers = form.headerName.trim() ? [{ name: form.headerName.trim(), ...(form.headerValue ? { value: form.headerValue } : {}) }] : [];
    took(await api<SmsSettings>('/org/sms', { method: 'PUT', body: { url: form.url.trim(), method: form.method, format: form.format, body: form.body, headers } }));
    setNote('Saved. Now send a test message to your own phone.');
  });
  const test = useSubmit(async () => {
    setNote(undefined);
    const next = await api<SmsSettings>('/org/sms/test', { method: 'POST', body: { to } });
    took(next);
    if (next.enabled) setNote('The test message went through. Forms can now send codes by text message.');
  });
  if (!data) return null;
  const unchanged = form.url === data.url && form.method === data.method && form.format === data.format && form.body === data.body && form.headerName === (data.headers[0]?.name ?? '') && !form.headerValue;
  const error = save.error ?? test.error;
  return (
    <Card
      title="Text messages"
      subtitle="Your own SMS service, for the codes that confirm a phone number on a form. Any service that is called over the web works: say where it is called and what to send, as its documentation describes."
      actions={!data.url ? undefined : data.enabled ? <Badge tone="success">On</Badge> : <Badge tone="warn">Not tested</Badge>}
    >
      <form className="st-stack" onSubmit={save.submit} noValidate>
        {note && <Alert tone="success">{note}</Alert>}
        {error && !Object.keys(save.fields).length && !Object.keys(test.fields).length && <Alert tone="error">{error}</Alert>}
        {data.lastError && !error && <Alert tone="warn">The last text message did not go: {data.lastError}</Alert>}
        <TextField label="Where your SMS service is called" placeholder="https://api.your-sms-service.com/messages" value={form.url} onChange={(e) => set('url', e.target.value)} error={save.fields.url} hint="An https:// address. It may itself contain {{to}} and {{message}}." />
        <div className="st-grid-2">
          <SelectField label="How it is called" value={form.method} onChange={(e) => set('method', e.target.value as SmsSettings['method'])}>
            <option value="POST">POST (most services)</option>
            <option value="GET">GET (everything is in the address)</option>
          </SelectField>
          {form.method === 'POST' && (
            <SelectField label="What is sent is written as" value={form.format} onChange={(e) => set('format', e.target.value as SmsSettings['format'])}>
              <option value="JSON">JSON</option>
              <option value="FORM">A web form (name=value&amp;…)</option>
            </SelectField>
          )}
        </div>
        {form.method === 'POST' && (
          <div className="st-field">
            <label htmlFor="sms-body">What is sent</label>
            <textarea id="sms-body" className="st-input" style={{ height: 96, padding: 10, fontFamily: 'var(--fb-font-mono, monospace)' }} value={form.body} onChange={(e) => set('body', e.target.value)} />
            <span className="st-field__hint">
              Put <code>{'{{to}}'}</code> where the phone number goes and <code>{'{{message}}'}</code> where the text goes.
            </span>
          </div>
        )}
        <div className="st-grid-2">
          <TextField label="Header your service asks for" placeholder="Authorization" value={form.headerName} onChange={(e) => set('headerName', e.target.value)} error={save.fields.headers} />
          <TextField label="Its value" type="password" autoComplete="new-password" placeholder={data.headers[0]?.valueSet ? 'Saved - type to replace' : 'Bearer …'} value={form.headerValue} onChange={(e) => set('headerValue', e.target.value)} />
        </div>
        <div>
          <Button type="submit" busy={save.busy} disabled={unchanged}>
            Save
          </Button>
        </div>
      </form>
      {data.url && (
        <form className="st-row" style={{ alignItems: 'flex-end', marginTop: 16 }} onSubmit={test.submit} noValidate>
          <div style={{ flex: '0 1 280px' }}>
            <TextField label="Send a test message to" placeholder="+919812345678" value={to} onChange={(e) => setTo(e.target.value)} error={test.fields.to} />
          </div>
          <Button type="submit" variant="secondary" busy={test.busy} disabled={!to.trim() || !unchanged} title={unchanged ? undefined : 'Save your changes first'} style={{ marginBottom: test.fields.to ? 20 : 0 }}>
            Send the test
          </Button>
        </form>
      )}
    </Card>
  );
}
