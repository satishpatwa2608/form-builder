import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Alert, Badge, Button, Card, TextField, useSubmit } from './ui';

interface Seal {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  fingerprint: string;
  selfIssued: boolean;
  /** The organisation's own certificate, not the one made for it here. */
  own: boolean;
  /** Its own ran out on this date, so the one made here is in use. */
  ownRanOut?: string;
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'long' });

/** A file's bytes as base64, which is how the certificate is sent (it is a few kilobytes). */
async function base64Of(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/**
 * The certificate that seals the organisation's PDFs (forms that have "Seal the PDF" on, and their signed copies).
 * Every organisation has one made for it; an organisation with a certificate from a certificate authority can
 * add that instead, so a stranger's PDF reader also recognises who sealed the document.
 */
export function SealCard() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['org-seal'], queryFn: () => api<Seal>('/org/seal') });
  const [adding, setAdding] = useState(false);
  const [password, setPassword] = useState('');
  const [chosen, setChosen] = useState<File>();
  const [note, setNote] = useState<string>();
  const picker = useRef<HTMLInputElement>(null);
  const took = (next: Seal) => qc.setQueryData(['org-seal'], next);

  const add = useSubmit(async () => {
    if (!chosen) throw new Error('Choose the certificate file first.');
    if (chosen.size > 100_000) throw new Error('That file is too large to be a certificate.');
    took(await api<Seal>('/org/seal', { method: 'PUT', body: { file: await base64Of(chosen), password } }));
    setAdding(false);
    setPassword('');
    setChosen(undefined);
    setNote('Saved. PDFs are sealed with your certificate from now on.');
  });
  const remove = useSubmit(async () => {
    took(await api<Seal>('/org/seal', { method: 'DELETE' }));
    setNote('PDFs are sealed with the certificate made for you here from now on.');
  });

  return (
    <Card title="Certificate for sealing PDFs" subtitle="A sealed PDF cannot be changed without that showing. Forms seal their PDFs when 'Seal the PDF' is on in the form's settings.">
      {!data ? (
        <p className="st-muted">Loading…</p>
      ) : (
        <div className="st-stack" style={{ gap: 12 }}>
          {data.ownRanOut && <Alert tone="error">Your own certificate ran out on {day(data.ownRanOut)}. PDFs are being sealed with the certificate made for you here until you add a new one.</Alert>}
          {note && <Alert tone="success">{note}</Alert>}
          <div className="st-stack" style={{ gap: 4 }} role="group" aria-label="The certificate in use">
            <div className="st-row" style={{ gap: 8 }}>
              <strong>{data.subject}</strong>
              <Badge tone={data.own ? 'success' : undefined}>{data.own ? 'Your own certificate' : 'Made for you by Form Builder'}</Badge>
            </div>
            <span className="st-muted">
              {data.selfIssued ? 'Issued by itself' : `Issued by ${data.issuer}`} · good until {day(data.validTo)}
            </span>
            <span className="st-muted" style={{ fontSize: 12, wordBreak: 'break-all' }}>
              Fingerprint (SHA-256): {data.fingerprint}
            </span>
          </div>
          {!data.own && (
            <p className="st-muted" style={{ margin: 0 }}>
              This certificate proves a document has not changed since it was sealed. A PDF reader will say it does not know who issued it. If you have a certificate from a certificate authority, add it and readers will recognise your
              organisation too.
            </p>
          )}
          {adding ? (
            <div className="st-stack" style={{ gap: 10, maxWidth: 520 }} role="group" aria-label="Add your own certificate">
              <div className="st-row" style={{ gap: 8 }}>
                <input
                  ref={picker}
                  type="file"
                  accept=".pfx,.p12,.pem,.crt,.cer,.key,application/x-pkcs12"
                  aria-label="Certificate file"
                  style={{ display: 'none' }}
                  onChange={(e) => setChosen(e.target.files?.[0])}
                />
                <Button variant="secondary" size="sm" onClick={() => picker.current?.click()}>
                  Choose the certificate file
                </Button>
                <span className="st-muted">{chosen ? chosen.name : 'A .pfx or .p12 file, or PEM text with the certificate and its key'}</span>
              </div>
              <TextField label="Its password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} hint="Leave empty if the file has none. The certificate's key is kept encrypted and is never shown again." />
              {add.error && <Alert tone="error">{add.error}</Alert>}
              <div className="st-row" style={{ gap: 8 }}>
                <Button size="sm" busy={add.busy} onClick={() => void add.submit()}>
                  Use this certificate
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="st-row" style={{ gap: 8 }}>
              <Button variant="secondary" size="sm" onClick={() => { setAdding(true); setNote(undefined); }}>
                {data.own ? 'Replace it with another' : 'Add our own certificate'}
              </Button>
              {data.own && (
                <Button variant="ghost" size="sm" busy={remove.busy} onClick={() => void remove.submit()}>
                  Go back to the one made for us
                </Button>
              )}
            </div>
          )}
          {remove.error && <Alert tone="error">{remove.error}</Alert>}
        </div>
      )}
    </Card>
  );
}
