import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { FormDefinition, FormValues, SubmissionResult, SystemContext } from '@fb/engine';
import { FormContainer } from '@form/runtime/FormContainer/FormContainer';
import { publicApi, trySession } from './api';
import { httpSubmissionAdapter, publicDataSourceAdapter } from './adapters';

/** Messages an embedding page can listen for when the form runs in an iframe (`?embed=1`). */
export const EMBED_MESSAGE = { submitted: 'form-builder:submitted', resize: 'form-builder:resize' } as const;

/** /f/:org/:code -> the parts, or null. */
export function parseFormPath(pathname: string): { org: string; code: string } | null {
  const m = pathname.match(/^\/f\/([A-Za-z0-9-]{1,64})\/([A-Z0-9_]{1,100})\/?$/);
  return m ? { org: m[1]!, code: m[2]! } : null;
}

/** On a customer's own domain (forms.acme.com/CODE) the org comes from the host name. */
export function parseDomainPath(pathname: string): { code: string } | null {
  const m = pathname.match(/^\/([A-Z0-9_]{1,100})\/?$/);
  return m ? { code: m[1]! } : null;
}

async function resolveTarget(): Promise<{ org: string; code: string } | null> {
  const direct = parseFormPath(window.location.pathname);
  if (direct) return direct;
  const onDomain = parseDomainPath(window.location.pathname);
  if (!onDomain) return null;
  try {
    const { org } = await publicApi<{ org: string }>(`/domains/${encodeURIComponent(window.location.hostname)}`);
    return { org, code: onDomain.code };
  } catch {
    return null;
  }
}

interface Branding {
  name: string;
  logo: string | null;
  primaryColor: string | null;
  poweredBy: boolean;
}

/** The org's colour drives the kit's accent tokens (they're resolved at :root, so each is set here). */
function brandStyle(color: string | null | undefined): CSSProperties | undefined {
  if (!color) return undefined;
  const soft = `color-mix(in srgb, ${color} 12%, white)`;
  return { '--fb-accent': color, '--primary': color, '--ring': color, '--accent-foreground': color, '--fb-accent-soft': soft, '--accent': soft } as CSSProperties;
}

/** Counts only (opened / started), once per page load. Failures never bother the respondent. */
function track(org: string, code: string, type: 'view' | 'start') {
  void publicApi(`/forms/${code}/events?org=${encodeURIComponent(org)}`, { method: 'POST', body: { type } }).catch(() => undefined);
}

/** What the server sends in place of a form that is not taking answers. */
interface Unavailable {
  unavailable: 'NOT_YET' | 'CLOSED';
  name: string;
  opensAt?: string;
  closesAt?: string;
  message?: string;
}

/** Files can't be kept in a saved draft; everything else goes as-is. */
function draftValues(def: FormDefinition, values: FormValues): FormValues {
  const files = new Set(def.fields.filter((f) => f.type === 'FILE').map((f) => f.name));
  return Object.fromEntries(Object.entries(values).filter(([k, v]) => !files.has(k) && v !== undefined && !(v instanceof File)));
}

function Notice({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="fp-public__card fp-public__notice">
      <h1 className="rt-title">{title}</h1>
      {children && <div className="rt-soft">{children}</div>}
    </div>
  );
}

type Session = Awaited<ReturnType<typeof trySession>>;

export default function App() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const embed = params.get('embed') === '1';
  const [target, setTarget] = useState<{ org: string; code: string } | null>();
  const [state, setState] = useState<{ loading: boolean; definition?: FormDefinition; unavailable?: Unavailable; error?: string; session?: Session; initialValues?: FormValues; resumed?: boolean }>({ loading: true });
  const [branding, setBranding] = useState<Branding>();
  const pageRef = useRef<HTMLDivElement>(null);
  const values = useRef<FormValues>({});
  const started = useRef(false);
  // `token` is only ever one this page got from its own save; a token from the link is used to load, never to save
  // (it could have been planted by someone who wants to read what gets saved next).
  const [draft, setDraft] = useState<{ token?: string; busy?: boolean; link?: string; error?: string }>({});
  const resumeToken = useMemo(() => params.get('resume') ?? undefined, [params]);

  useEffect(() => {
    void resolveTarget().then((t) => setTarget(t));
  }, []);

  useEffect(() => {
    if (target === undefined) return;
    if (!target) return setState({ loading: false });
    void publicApi<Branding>(`/orgs/${encodeURIComponent(target.org)}/branding`).then(setBranding, () => undefined);
    void (async () => {
      // Silent: a signed-in studio user gets their details filled in; everyone else stays anonymous.
      const session = await trySession();
      try {
        const loaded = await publicApi<FormDefinition | Unavailable>(`/forms/${target.code}?org=${encodeURIComponent(target.org)}`);
        document.title = loaded.name;
        if ('unavailable' in loaded) return setState({ loading: false, unavailable: loaded });
        const definition = loaded;
        let initialValues: FormValues | undefined;
        if (resumeToken) {
          try {
            initialValues = (await publicApi<{ values: FormValues }>(`/forms/${target.code}/drafts/load?org=${encodeURIComponent(target.org)}`, { method: 'POST', body: { token: resumeToken } })).values;
          } catch (e) {
            setDraft({ error: (e as Error).message });
          }
        }
        setState({ loading: false, definition, session: session?.orgId === target.org ? session : null, initialValues, resumed: !!initialValues });
        if (resumeToken) {
          // Out of the address bar (and so out of Referer headers) once used.
          const url = new URL(window.location.href);
          url.searchParams.delete('resume');
          window.history.replaceState(null, '', url.toString());
        }
        track(target.org, target.code, 'view');
      } catch (e) {
        setState({ loading: false, error: (e as Error).message, session });
      }
    })();
  }, [target, resumeToken]);

  const onValuesChange = useCallback(
    (v: FormValues) => {
      values.current = v;
      if (!started.current && target && state.definition) {
        started.current = true;
        track(target.org, target.code, 'start');
      }
    },
    [target, state.definition],
  );

  const saveForLater = async () => {
    if (!target || !state.definition) return;
    setDraft((d) => ({ ...d, busy: true, error: undefined }));
    try {
      const saved = await publicApi<{ token: string; expiresAt: string }>(`/forms/${target.code}/drafts?org=${encodeURIComponent(target.org)}`, {
        method: 'POST',
        // Sending a token only retires it (the server always issues a new one), so the link's old draft goes too.
        body: { values: draftValues(state.definition, values.current), token: draft.token ?? resumeToken },
      });
      const url = new URL(window.location.href);
      url.searchParams.set('resume', saved.token);
      setDraft({ token: saved.token, link: url.toString() });
    } catch (e) {
      setDraft((d) => ({ ...d, busy: false, error: (e as Error).message }));
    }
  };

  // In an iframe, keep the parent told how tall we are.
  useEffect(() => {
    if (!embed || !pageRef.current || window.parent === window) return;
    const el = pageRef.current;
    const observer = new ResizeObserver(() => window.parent.postMessage({ type: EMBED_MESSAGE.resize, code: target?.code, height: el.scrollHeight }, '*'));
    observer.observe(el);
    return () => observer.disconnect();
  }, [embed, target, state.definition]);

  const systemContext: SystemContext = useMemo(
    () => ({
      userId: state.session?.id,
      userEmail: state.session?.email,
      userName: state.session?.name,
      sourceChannel: params.get('channel') ?? (embed ? 'EMBED' : 'WEB'),
      // Never the resume token: URL params can end up in the saved submission.
      urlParams: Object.fromEntries([...params.entries()].filter(([k]) => k !== 'resume')),
    }),
    [state.session, params, embed],
  );

  const onSubmitted = (result: SubmissionResult) => {
    for (const token of new Set([draft.token, resumeToken].filter(Boolean))) {
      if (target) void publicApi(`/forms/${target.code}/drafts/discard?org=${encodeURIComponent(target.org)}`, { method: 'POST', body: { token } }).catch(() => undefined);
    }
    setDraft({});
    if (embed && window.parent !== window) window.parent.postMessage({ type: EMBED_MESSAGE.submitted, code: target?.code, submissionId: result.submissionId }, '*');
  };

  let body: ReactNode;
  if (target === undefined) body = <Notice title="Loading form…" />;
  else if (!target) body = <Notice title="Form not found">Check the link you were given.</Notice>;
  else if (state.loading) body = <Notice title="Loading form…" />;
  else if (state.unavailable) {
    const { unavailable, name, opensAt, message } = state.unavailable;
    const when = opensAt ? new Date(opensAt) : undefined;
    body = (
      <Notice title={name}>
        {unavailable === 'NOT_YET'
          ? `This form is not open yet.${when && !Number.isNaN(when.getTime()) ? ` It opens on ${when.toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' })}.` : ''}`
          : message?.trim() || 'This form is closed and no longer takes answers.'}
      </Notice>
    );
  } else if (!state.definition) body = <Notice title="This form isn't available">{state.error ?? 'It may have been closed, or the link may be wrong.'}</Notice>;
  else if (state.definition.access === 'AUTHENTICATED' && !state.session) {
    body = (
      <Notice title={state.definition.name}>
        Please <a className="fb-link" href={`${import.meta.env.VITE_STUDIO_URL ?? 'http://localhost:5173'}/login`}>sign in</a> to fill in this form, then open this link again.
      </Notice>
    );
  } else {
    body = (
      <div className="fp-public__card">
        {state.resumed && <p className="rt-banner">Welcome back - your saved answers are filled in. Attachments need to be added again.</p>}
        {draft.error && <p className="rt-banner rt-banner--error">{draft.error}</p>}
        <FormContainer
          definition={state.definition}
          systemContext={systemContext}
          submissionAdapter={httpSubmissionAdapter}
          dataSourceAdapter={publicDataSourceAdapter(state.definition)}
          onSubmitted={onSubmitted}
          onValuesChange={onValuesChange}
          initialValues={state.initialValues}
        />
        {!embed && state.definition.saveForLater !== false && (
          <div className="rt-save">
            {draft.link ? (
              <div className="rt-save__link">
                <span>Saved. Use this private link to continue on any device within 30 days - anyone with it can see your answers:</span>
                <input readOnly value={draft.link} aria-label="Link to continue later" onFocus={(e) => e.currentTarget.select()} />
                <button type="button" className="rt-save__btn" onClick={() => void navigator.clipboard?.writeText(draft.link!)}>
                  Copy link
                </button>
              </div>
            ) : (
              <button type="button" className="rt-save__btn" disabled={draft.busy} onClick={() => void saveForLater()}>
                {draft.busy ? 'Saving…' : 'Save and continue later'}
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={pageRef} className={`fp-public${embed ? ' fp-public--embed' : ''}`} style={brandStyle(branding?.primaryColor)}>
      {!embed && branding?.logo && (
        <header className="rt-brand">
          <img src={branding.logo} alt={branding.name} />
        </header>
      )}
      {body}
      {!embed && (branding?.poweredBy ?? true) && <p className="fp-public__footer">Powered by Form Builder</p>}
    </div>
  );
}
