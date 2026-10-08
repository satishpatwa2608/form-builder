import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Globe, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { Alert, Badge, Button, Card, TextField, useSubmit } from './ui';

interface Branding {
  logo: string;
  primaryColor: string;
  hidePoweredBy: boolean;
  canHidePoweredBy: boolean;
}
interface Domain {
  host: string;
  verified: boolean;
  dns: { type: 'TXT'; name: string; value: string };
}

const MAX_LOGO_BYTES = 150 * 1024;

/** Logo, colour and the "Powered by" line on public forms. */
export function BrandingCard() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['branding'], queryFn: () => api<Branding>('/org/branding') });
  const [logo, setLogo] = useState('');
  const [color, setColor] = useState('');
  const [hide, setHide] = useState(false);
  const [note, setNote] = useState<{ tone: 'success' | 'error'; text: string }>();
  useEffect(() => {
    if (!data) return;
    setLogo(data.logo);
    setColor(data.primaryColor);
    setHide(data.hidePoweredBy);
  }, [data]);

  const save = useSubmit(async () => {
    await api('/org/branding', { method: 'PUT', body: { logo, primaryColor: color, hidePoweredBy: hide } });
    await qc.invalidateQueries({ queryKey: ['branding'] });
    setNote({ tone: 'success', text: 'Branding saved. Public forms show it right away.' });
  });

  const pickLogo = (file: File | undefined) => {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return setNote({ tone: 'error', text: 'Use a PNG, JPEG or WebP image.' });
    if (file.size > MAX_LOGO_BYTES) return setNote({ tone: 'error', text: 'The logo must be under 150 KB.' });
    const reader = new FileReader();
    reader.onload = () => setLogo(String(reader.result));
    reader.readAsDataURL(file);
  };

  if (!data) return null;
  return (
    <Card title="Branding" subtitle="How your public forms look to the people filling them in.">
      <form className="st-stack" onSubmit={save.submit} noValidate>
        {note && <Alert tone={note.tone}>{note.text}</Alert>}
        {save.error && <Alert tone="error">{save.error}</Alert>}
        <div className="st-row" style={{ alignItems: 'center', gap: 16 }}>
          <div className="st-brand-preview">{logo ? <img src={logo} alt="Logo preview" /> : <span className="st-muted">No logo</span>}</div>
          <label className="st-btn st-btn--secondary st-btn--sm" style={{ cursor: 'pointer' }}>
            Choose logo
            <input type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="Logo file" onChange={(e) => pickLogo(e.target.files?.[0])} />
          </label>
          {logo && (
            <Button variant="ghost" size="sm" onClick={() => setLogo('')}>
              Remove
            </Button>
          )}
        </div>
        <div className="st-row" style={{ alignItems: 'flex-end', gap: 12 }}>
          <input type="color" aria-label="Brand colour picker" value={color || '#1458e2'} onChange={(e) => setColor(e.target.value)} style={{ width: 44, height: 38, border: 0, background: 'none', padding: 0 }} />
          <div style={{ width: 160 }}>
            <TextField label="Brand colour" value={color} placeholder="#1458e2" onChange={(e) => setColor(e.target.value.trim())} error={save.fields.primaryColor} />
          </div>
        </div>
        <label className="st-check">
          <input type="checkbox" checked={hide} disabled={!data.canHidePoweredBy} onChange={(e) => setHide(e.target.checked)} />
          <span>
            Hide "Powered by Form Builder"
            {!data.canHidePoweredBy && <span className="st-field__hint" style={{ display: 'block' }}>Available on the Team plan and above.</span>}
          </span>
        </label>
        <div>
          <Button type="submit" busy={save.busy}>
            Save branding
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** forms.yourcompany.com: add, prove with a TXT record, point a CNAME. */
export function DomainsCard() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['domains'], queryFn: () => api<Domain[]>('/org/domains') });
  const [host, setHost] = useState('');
  const [note, setNote] = useState<{ tone: 'success' | 'error' | 'info'; text: string }>();
  const refresh = () => qc.invalidateQueries({ queryKey: ['domains'] });
  const add = useSubmit(async () => {
    await api('/org/domains', { method: 'POST', body: { host } });
    setHost('');
    await refresh();
  });
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      await refresh();
      setNote({ tone: 'success', text: ok });
    } catch (e) {
      setNote({ tone: 'error', text: errorMessage(e) });
    }
  };
  const runtimeHost = (import.meta.env.VITE_RUNTIME_HOST as string | undefined) ?? 'your forms edge host (VITE_RUNTIME_HOST)';

  return (
    <Card title="Custom domains" subtitle="Serve your forms from your own address, e.g. forms.yourcompany.com/CUSTOMER_COMPLAINT.">
      <div className="st-stack">
        {note && <Alert tone={note.tone}>{note.text}</Alert>}
        {(data ?? []).map((d) => (
          <div key={d.host} className="st-domain">
            <div className="st-row" style={{ justifyContent: 'space-between' }}>
              <span className="st-row" style={{ gap: 8 }}>
                <Globe size={16} />
                <strong>{d.host}</strong>
                {d.verified ? (
                  <Badge tone="success">
                    <CheckCircle2 size={12} /> Verified
                  </Badge>
                ) : (
                  <Badge tone="warn">Waiting for DNS</Badge>
                )}
              </span>
              <span className="st-row" style={{ gap: 6 }}>
                {!d.verified && (
                  <Button size="sm" onClick={() => void run(() => api(`/org/domains/${d.host}/verify`, { method: 'POST' }), `${d.host} is verified.`)}>
                    Verify
                  </Button>
                )}
                <Button variant="danger" size="sm" aria-label={`Remove ${d.host}`} onClick={() => window.confirm(`Remove ${d.host}? Links on it stop working.`) && void run(() => api(`/org/domains/${d.host}`, { method: 'DELETE' }), `${d.host} was removed.`)}>
                  <Trash2 size={14} />
                </Button>
              </span>
            </div>
            <table className="st-dns">
              <tbody>
                {!d.verified && (
                  <tr>
                    <td>TXT</td>
                    <td className="st-mono">{d.dns.name}</td>
                    <td className="st-mono">{d.dns.value}</td>
                  </tr>
                )}
                <tr>
                  <td>CNAME</td>
                  <td className="st-mono">{d.host}</td>
                  <td className="st-mono">{runtimeHost}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ))}
        <form className="st-row" style={{ alignItems: 'flex-end' }} onSubmit={add.submit} noValidate>
          <div style={{ flex: '1 1 260px' }}>
            <TextField label="Add a domain" value={host} placeholder="forms.yourcompany.com" onChange={(e) => setHost(e.target.value)} error={add.fields.host ?? add.error} />
          </div>
          <Button type="submit" busy={add.busy} disabled={!host.trim()} style={{ marginBottom: add.fields.host || add.error ? 20 : 0 }}>
            Add domain
          </Button>
        </form>
      </div>
    </Card>
  );
}
