import { useCallback, useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { API_URL, publicApi } from './api';

/** /portal/:org -> the organisation; /portal on a customer's own domain -> '' (found from the host name). */
export function parsePortalPath(pathname: string): { org: string } | null {
  const m = pathname.match(/^\/portal(?:\/([A-Za-z0-9-]{1,64}))?\/?$/);
  return m ? { org: m[1] ?? '' } : null;
}

interface Front {
  organisation: string;
  title: string;
  intro: string;
  forms: { code: string; name: string; description: string }[];
}
interface Mine {
  email: string;
  requests: { reference: string; form: string; sentAt: string; status: string; open: boolean; updatedAt: string }[];
}
interface Branding {
  name: string;
  logo: string | null;
  primaryColor: string | null;
  poweredBy: boolean;
}

const KEY = (org: string) => `fb-portal-${org}`;
const day = (at: string) => new Date(at).toLocaleDateString(undefined, { dateStyle: 'medium' });

/** The session lives for this browser tab only; closing the tab signs the person out. */
const stored = (org: string) => {
  try {
    return window.sessionStorage.getItem(KEY(org)) ?? undefined;
  } catch {
    return undefined;
  }
};
const store = (org: string, session?: string) => {
  try {
    if (session) window.sessionStorage.setItem(KEY(org), session);
    else window.sessionStorage.removeItem(KEY(org));
  } catch {
    // Storage switched off: the person stays signed in until they leave the page.
  }
};

async function portalApi<T>(org: string, path: string, session: string, method = 'GET'): Promise<T> {
  const res = await fetch(`${API_URL}/public/portal/${org}${path}`, { method, headers: { Authorization: `Portal ${session}` } });
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) throw Object.assign(new Error(body.message || 'Something went wrong'), { status: res.status });
  return body as T;
}

function Card({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="fp-public__card fp-public__notice">
      <h1 className="rt-title">{title}</h1>
      {children && <div className="rt-soft">{children}</div>}
    </div>
  );
}

/**
 * The requests portal: the forms an organisation offers, and, for someone who
 * has opened a link sent to their email, what they have sent and how far it has got.
 */
export default function PortalPage({ org: orgFromPath }: { org: string }) {
  const [org, setOrg] = useState<string | null | undefined>(orgFromPath || undefined);
  const [front, setFront] = useState<Front>();
  const [branding, setBranding] = useState<Branding>();
  const [failed, setFailed] = useState<string>();
  const [session, setSession] = useState<string>();
  const [mine, setMine] = useState<Mine>();
  const [email, setEmail] = useState('');
  const [asked, setAsked] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // On a customer's own domain the organisation comes from the host name.
  useEffect(() => {
    if (orgFromPath) return;
    publicApi<{ org: string }>(`/domains/${encodeURIComponent(window.location.hostname)}`).then(
      (d) => setOrg(d.org),
      () => setOrg(null),
    );
  }, [orgFromPath]);

  const load = useCallback(async (o: string, s: string) => {
    try {
      setMine(await portalApi<Mine>(o, '/requests', s));
      setSession(s);
    } catch {
      // Run out, or signed out elsewhere: back to asking for a link.
      store(o);
      setSession(undefined);
      setMine(undefined);
    }
  }, []);

  useEffect(() => {
    if (!org) return;
    void publicApi<Branding>(`/orgs/${encodeURIComponent(org)}/branding`).then(setBranding, () => undefined);
    publicApi<Front>(`/portal/${org}`).then(
      (f) => {
        setFront(f);
        document.title = `${f.title} - ${f.organisation}`;
      },
      (e: Error) => setFailed(e.message),
    );
    const url = new URL(window.location.href);
    const key = url.searchParams.get('key');
    if (key) {
      // Out of the address bar (and the browser's history) as soon as it is read: it works once.
      url.searchParams.delete('key');
      window.history.replaceState(null, '', url.toString());
      publicApi<{ session: string }>(`/portal/${org}/session`, { method: 'POST', body: { key } }).then(
        (opened) => {
          store(org, opened.session);
          void load(org, opened.session);
        },
        (e: Error) => setError(e.message),
      );
    } else {
      const s = stored(org);
      if (s) void load(org, s);
    }
  }, [org, load]);

  const ask = async (e: FormEvent) => {
    e.preventDefault();
    if (!org) return;
    setBusy(true);
    setError(undefined);
    try {
      await publicApi(`/portal/${org}/link`, { method: 'POST', body: { email } });
      setAsked(email.trim());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const signOut = () => {
    if (org && session) void portalApi(org, '/session', session, 'DELETE').catch(() => undefined);
    if (org) store(org);
    setSession(undefined);
    setMine(undefined);
    setAsked(undefined);
    setEmail('');
  };

  const brand = branding?.primaryColor
    ? ({ '--fb-accent': branding.primaryColor, '--primary': branding.primaryColor, '--ring': branding.primaryColor } as CSSProperties)
    : undefined;

  let body: ReactNode;
  if (org === null) body = <Card title="Page not found">Check the link you were given.</Card>;
  else if (failed) body = <Card title="This page isn't available">{failed}</Card>;
  else if (!front || !org) body = <Card title="Loading…" />;
  else {
    const open = mine?.requests.filter((r) => r.open) ?? [];
    body = (
      <div className="fp-public__card rt-portal">
        <p className="rt-soft">{front.organisation}</p>
        <h1 className="rt-title">{front.title}</h1>
        {front.intro && <p className="rt-portal__intro">{front.intro}</p>}

        <section aria-labelledby="rt-portal-mine">
          <h2 id="rt-portal-mine" className="rt-portal__heading">
            Your requests
          </h2>
          {error && (
            <p className="rt-banner rt-banner--error" role="alert">
              {error}
            </p>
          )}
          {mine ? (
            <>
              <p className="rt-soft">
                Signed in as {mine.email}.{' '}
                <button type="button" className="rt-save__btn" onClick={signOut}>
                  Sign out
                </button>
              </p>
              {mine.requests.length === 0 ? (
                <p>Nothing has been sent from this address yet.</p>
              ) : (
                <>
                  <p>{open.length === 0 ? 'Nothing is open at the moment.' : `${open.length} open ${open.length === 1 ? 'request' : 'requests'}.`}</p>
                  <div className="rt-portal__scroll">
                    <table className="rt-portal__table">
                      <thead>
                        <tr>
                          <th scope="col">Reference</th>
                          <th scope="col">Form</th>
                          <th scope="col">Sent</th>
                          <th scope="col">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {mine.requests.map((r, i) => (
                          <tr key={`${r.reference}-${i}`}>
                            <th scope="row">{r.reference || '-'}</th>
                            <td>{r.form}</td>
                            <td>{day(r.sentAt)}</td>
                            <td>
                              <span className={`rt-portal__status${r.open ? ' rt-portal__status--open' : ''}`}>{r.status}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          ) : asked ? (
            <p role="status">
              If {asked} is an address we can write to, a link is on its way. Open it on this device to see your requests. It works once, for 30 minutes.{' '}
              <button type="button" className="rt-save__btn" onClick={() => setAsked(undefined)}>
                Use another address
              </button>
            </p>
          ) : (
            <form className="rt-portal__ask" onSubmit={(e) => void ask(e)}>
              <label htmlFor="rt-portal-email">To see what you have sent and how far it has got, enter your email address. We will send you a link; there is no password.</label>
              <div className="rt-portal__row">
                <input id="rt-portal-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
                <button type="submit" className="rt-sign__primary" disabled={busy}>
                  {busy ? 'Sending…' : 'Email me a link'}
                </button>
              </div>
            </form>
          )}
        </section>

        <section aria-labelledby="rt-portal-forms">
          <h2 id="rt-portal-forms" className="rt-portal__heading">
            Start something new
          </h2>
          {front.forms.length === 0 ? (
            <p className="rt-soft">There are no forms here at the moment.</p>
          ) : (
            <ul className="rt-portal__forms">
              {front.forms.map((f) => (
                <li key={f.code}>
                  <a className="fb-link" href={orgFromPath ? `/f/${org}/${f.code}` : `/${f.code}`}>
                    {f.name}
                  </a>
                  {f.description && <span className="rt-soft">{f.description}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="fp-public" style={brand}>
      {branding?.logo && (
        <header className="rt-brand">
          <img src={branding.logo} alt={branding.name} />
        </header>
      )}
      {body}
      {(branding?.poweredBy ?? true) && <p className="fp-public__footer">Powered by Form Builder</p>}
    </div>
  );
}
