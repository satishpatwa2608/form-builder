import { useEffect, useRef, useState, type FormEvent, type PointerEvent, type ReactNode } from 'react';
import { isSignature } from '@fb/engine';
import { API_URL, publicApi } from './api';

/** /sign/:token -> the token in a signer's link, or null. */
export function parseSignPath(pathname: string): string | null {
  const m = pathname.match(/^\/sign\/(fbsig_[A-Za-z0-9_-]{20,200})\/?$/);
  return m ? m[1]! : null;
}

interface SignView {
  title: string;
  message: string;
  organisation: string;
  reference: string;
  email: string;
  /** WAITING: not this person's turn yet. SENT: theirs to sign. The rest are endings. */
  status: 'WAITING' | 'SENT' | 'SIGNED' | 'DECLINED' | 'EXPIRED';
  expiresAt: string;
  others: ('SIGNED' | 'DECLINED' | 'PENDING')[];
}

const WIDTH = 600;
const HEIGHT = 180;

function Card({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="fp-public__card fp-public__notice">
      <h1 className="rt-title">{title}</h1>
      {children && <div className="rt-soft">{children}</div>}
    </div>
  );
}

/**
 * The page a signer opens from their email. The link is the only thing that
 * lets them in, so it is kept out of what other sites are told (no referrer).
 */
export default function SignPage({ token }: { token: string }) {
  const [view, setView] = useState<SignView>();
  const [failed, setFailed] = useState<string>();
  const [name, setName] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [drawn, setDrawn] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const documentUrl = `${API_URL}/public/sign/${token}/document`;

  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    document.head.appendChild(meta);
    publicApi<SignView>(`/sign/${token}`).then(
      (v) => {
        setView(v);
        document.title = v.title;
      },
      (e: Error) => setFailed(e.message),
    );
    return () => meta.remove();
  }, [token]);

  const context = () => {
    const ctx = canvas.current?.getContext('2d') ?? null;
    if (ctx) {
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#111827';
      ctx.fillStyle = '#111827';
    }
    return ctx;
  };
  /** Pointer position in canvas pixels, whatever size the pad is shown at. */
  const at = (e: PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - box.left) / (box.width || WIDTH)) * WIDTH, y: ((e.clientY - box.top) / (box.height || HEIGHT)) * HEIGHT };
  };
  const start = (e: PointerEvent<HTMLCanvasElement>) => {
    drawing.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const { x, y } = at(e);
    const ctx = context();
    ctx?.beginPath();
    ctx?.moveTo(x, y);
    ctx?.lineTo(x + 0.1, y + 0.1);
    ctx?.stroke();
    setDrawn(true);
  };
  const move = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const { x, y } = at(e);
    const ctx = context();
    ctx?.lineTo(x, y);
    ctx?.stroke();
  };
  const end = () => {
    drawing.current = false;
  };
  const clear = () => {
    context()?.clearRect(0, 0, WIDTH, HEIGHT);
    setDrawn(false);
  };

  const send = async (path: string, body: unknown) => {
    setBusy(true);
    setError(undefined);
    try {
      setView(await publicApi<SignView>(path, { method: 'POST', body }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sign = (e: FormEvent) => {
    e.preventDefault();
    const fullName = name.trim();
    if (!fullName) return setError('Type your full name.');
    if (!agreed) return setError('Tick the box to say you have read the document and agree to sign it.');
    // Nothing drawn: the typed name is the signature, so people who cannot draw can still sign.
    if (!drawn) {
      const ctx = context();
      if (ctx) {
        ctx.clearRect(0, 0, WIDTH, HEIGHT);
        ctx.font = 'italic 48px "Brush Script MT", "Segoe Script", cursive';
        ctx.textBaseline = 'middle';
        ctx.fillText(fullName, 24, HEIGHT / 2, WIDTH - 48);
      }
    }
    const signature = canvas.current?.toDataURL('image/png');
    if (!isSignature(signature)) return setError('Draw your signature in the box.');
    void send(`/sign/${token}`, { name: fullName, signature, agreed: true });
  };

  let body: ReactNode;
  if (failed) body = <Card title="This link can't be used">{failed}</Card>;
  else if (!view) body = <Card title="Loading…" />;
  else if (view.status === 'SIGNED') {
    const waiting = view.others.filter((o) => o === 'PENDING').length;
    body = (
      <Card title="Thank you, you have signed">
        {waiting > 0 ? (
          <p>
            {waiting === 1 ? 'One other person still has' : `${waiting} other people still have`} to sign. This link will show the completed document once everyone has.
          </p>
        ) : (
          <p>
            Everyone has signed.{' '}
            <a className="fb-link" href={documentUrl} target="_blank" rel="noopener noreferrer">
              Open the signed document (PDF)
            </a>
          </p>
        )}
      </Card>
    );
  } else if (view.status === 'DECLINED') body = <Card title="This document was declined">Nobody is being asked to sign it any more. {view.organisation} has been told.</Card>;
  else if (view.status === 'EXPIRED') body = <Card title="The time to sign has passed">Ask {view.organisation} to send the document again if it still needs your signature.</Card>;
  else if (view.status === 'WAITING') body = <Card title="It is not your turn yet">Someone else signs before you. You will get an email at {view.email} when it is your turn.</Card>;
  else {
    body = (
      <div className="fp-public__card">
        <p className="rt-soft">{view.organisation} asks you to sign</p>
        <h1 className="rt-title">{view.title}</h1>
        {view.reference && <p className="rt-soft">Reference {view.reference}</p>}
        {view.message && <p className="rt-sign__message">{view.message}</p>}
        <p className="rt-sign__doc">
          <a className="fb-link" href={documentUrl} target="_blank" rel="noopener noreferrer">
            Read the document (PDF, opens in a new tab)
          </a>
        </p>
        {error && (
          <p className="rt-banner rt-banner--error" role="alert">
            {error}
          </p>
        )}
        {declining ? (
          <form
            className="rt-sign__form"
            onSubmit={(e) => {
              e.preventDefault();
              void send(`/sign/${token}/decline`, { reason });
            }}
          >
            <label className="rt-sign__field">
              <span>Why are you declining? (optional)</span>
              <textarea value={reason} maxLength={500} rows={3} onChange={(e) => setReason(e.target.value)} />
            </label>
            <p className="rt-soft">Declining ends the request for everyone: nobody else will be asked to sign.</p>
            <div className="rt-sign__actions">
              <button type="submit" className="rt-sign__primary rt-sign__primary--danger" disabled={busy}>
                {busy ? 'Sending…' : 'Decline to sign'}
              </button>
              <button type="button" className="rt-save__btn" onClick={() => setDeclining(false)}>
                Go back
              </button>
            </div>
          </form>
        ) : (
          <form className="rt-sign__form" onSubmit={sign} noValidate>
            <label className="rt-sign__field">
              <span>Your full name</span>
              <input value={name} maxLength={100} autoComplete="name" aria-required onChange={(e) => setName(e.target.value)} />
            </label>
            <div className="rt-sign__field">
              <span id="rt-sign-pad">Your signature</span>
              <canvas
                ref={canvas}
                width={WIDTH}
                height={HEIGHT}
                className="rt-sign__pad"
                role="img"
                aria-labelledby="rt-sign-pad"
                aria-describedby="rt-sign-hint"
                onPointerDown={start}
                onPointerMove={move}
                onPointerUp={end}
                onPointerLeave={end}
                onPointerCancel={end}
              />
              <span id="rt-sign-hint" className="rt-soft">
                Draw with your mouse or finger, or leave the box empty to sign with your typed name.{' '}
                {drawn && (
                  <button type="button" className="rt-save__btn" onClick={clear}>
                    Clear
                  </button>
                )}
              </span>
            </div>
            <label className="rt-sign__agree">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
              <span>I have read the document and agree to sign it electronically.</span>
            </label>
            <div className="rt-sign__actions">
              <button type="submit" className="rt-sign__primary" disabled={busy}>
                {busy ? 'Signing…' : 'Sign'}
              </button>
              <button type="button" className="rt-save__btn" onClick={() => setDeclining(true)}>
                Decline
              </button>
            </div>
            <p className="rt-soft">
              Signing as {view.email}. Open until {new Date(view.expiresAt).toLocaleDateString(undefined, { dateStyle: 'long' })}.
            </p>
          </form>
        )}
      </div>
    );
  }

  return (
    <div className="fp-public">
      {body}
      <p className="fp-public__footer">Powered by Form Builder</p>
    </div>
  );
}
