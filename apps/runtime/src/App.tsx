import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createAutosave } from './autosave';
import type { FormDefinition, FormValues, SubmissionResult, SystemContext } from '@fb/engine';
import { isRtl, languageName, languagesOf, localize, pickLanguage, uiText } from '@fb/engine';
import { FormContainer } from '@form/runtime/FormContainer/FormContainer';
import { API_URL, publicApi, trySession } from './api';
import { createVisit } from './visit';
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

/**
 * A visit's per-question summary, sent as the person leaves the page or submits.
 * `keepalive` lets it finish after the page has gone.
 */
function trackFields(org: string, code: string, summary: object) {
  void fetch(`${API_URL}/public/forms/${code}/events?org=${encodeURIComponent(org)}`, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'fields', ...summary }) }).catch(() => undefined);
}

/** Counts only (opened / started), once per page load. Failures never bother the respondent. */
function track(org: string, code: string, type: 'view' | 'start', extra: object = {}) {
  void publicApi(`/forms/${code}/events?org=${encodeURIComponent(org)}`, { method: 'POST', body: { type, ...extra } }).catch(() => undefined);
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
  const [state, setState] = useState<{ loading: boolean; definition?: FormDefinition; unavailable?: Unavailable; error?: string; session?: Session; initialValues?: FormValues; resumed?: boolean; /** The answers came back from this device's own draft. */ kept?: boolean }>({ loading: true });
  const [branding, setBranding] = useState<Branding>();
  const pageRef = useRef<HTMLDivElement>(null);
  const values = useRef<FormValues>({});
  const started = useRef(false);
  // Which questions this visit answered, tripped on and stopped at: counted once, when the person submits or leaves.
  const visit = useRef(createVisit());
  const visitSent = useRef(false);
  // `token` is only ever one this page got from its own save; a token from the link is used to load, never to save
  // (it could have been planted by someone who wants to read what gets saved next).
  const [draft, setDraft] = useState<{ token?: string; busy?: boolean; link?: string; error?: string }>({});
  const resumeToken = useMemo(() => params.get('resume') ?? undefined, [params]);
  // Answers that save themselves (the form's own setting): the draft's token stays on this device.
  const auto = useRef<ReturnType<typeof createAutosave>>();
  const draftUrl = useCallback((t: { org: string; code: string }, rest = '') => `/forms/${t.code}/drafts${rest}?org=${encodeURIComponent(t.org)}`, []);

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
        let kept = false;
        if (definition.saveAsYouGo && definition.saveForLater !== false && !embed) {
          const start = () =>
            createAutosave({
              key: `fb-draft:${target.org}:${target.code}`,
              save: (v, token) => publicApi<{ token: string }>(draftUrl(target), { method: 'POST', body: { values: v, token } }),
            });
          auto.current = start();
          const mine = auto.current.token();
          if (mine && !resumeToken) {
            try {
              initialValues = (await publicApi<{ values: FormValues }>(draftUrl(target, '/load'), { method: 'POST', body: { token: mine } })).values;
              kept = true;
            } catch {
              // Expired, or already sent in: start clean, without a word about it.
              auto.current.forget();
              auto.current = start();
            }
          }
        }
        setState({ loading: false, definition, session: session?.orgId === target.org ? session : null, initialValues, resumed: !!initialValues && !kept, kept });
        if (resumeToken) {
          // Out of the address bar (and so out of Referer headers) once used.
          const url = new URL(window.location.href);
          url.searchParams.delete('resume');
          window.history.replaceState(null, '', url.toString());
        }
        // How long this visitor waited from following the link to having the form: the browser's own clock, whole milliseconds.
        track(target.org, target.code, 'view', { loadMs: Math.round(performance.now()) });
      } catch (e) {
        setState({ loading: false, error: (e as Error).message, session });
      }
    })();
  }, [target, resumeToken, embed, draftUrl]);

  const onValuesChange = useCallback(
    (v: FormValues) => {
      values.current = v;
      const focused = (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>('[data-field-name]')?.dataset.fieldName?.split('.')[0];
      // Started means the person answered something, not that the form filled in its own defaults.
      if (visit.current.values(v, focused) && !started.current && target && state.definition) {
        started.current = true;
        track(target.org, target.code, 'start');
      }
      // Only once the person has answered something: a form that fills in its own defaults has nothing worth keeping.
      if (started.current && state.definition) auto.current?.changed(draftValues(state.definition, v));
    },
    [target, state.definition],
  );

  const sendVisit = useCallback(
    (submitted: boolean) => {
      const summary = visit.current.summary(submitted);
      if (!target || !summary || visitSent.current) return;
      visitSent.current = true;
      trackFields(target.org, target.code, summary);
    },
    [target],
  );
  useEffect(() => {
    const interact = () => visit.current.interact();
    // `pagehide` is the last thing a page is told on phones as well as desktops.
    const leave = () => {
      sendVisit(false);
      void auto.current?.flush();
    };
    // Typing, choosing, pasting, autofill and dictation all end in one of these; the form's own changes never do.
    const signs = ['pointerdown', 'keydown', 'input', 'change'] as const;
    for (const sign of signs) document.addEventListener(sign, interact, true);
    window.addEventListener('pagehide', leave);
    return () => {
      for (const sign of signs) document.removeEventListener(sign, interact, true);
      window.removeEventListener('pagehide', leave);
    };
  }, [sendVisit]);

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

  // The language the form is shown in: asked for in the link (?lang=hi), else the browser's, if the form has it.
  const [chosenLanguage, setChosenLanguage] = useState<string>();
  const languages = state.definition ? languagesOf(state.definition) : [];
  const language = state.definition ? pickLanguage(state.definition, chosenLanguage ?? params.get('lang') ?? navigator.language) : undefined;
  const ui = useMemo(() => uiText(language, state.definition), [language, state.definition]);
  useEffect(() => {
    if (!language) return;
    // For screen readers, and so that text runs the right way.
    document.documentElement.lang = language;
    document.documentElement.dir = isRtl(language) ? 'rtl' : 'ltr';
    if (state.definition) document.title = localize(state.definition, language).name;
  }, [language, state.definition]);

  const systemContext: SystemContext = useMemo(
    () => ({
      language,
      userId: state.session?.id,
      userEmail: state.session?.email,
      userName: state.session?.name,
      sourceChannel: params.get('channel') ?? (embed ? 'EMBED' : 'WEB'),
      // Never the resume token: URL params can end up in the saved submission.
      urlParams: Object.fromEntries([...params.entries()].filter(([k]) => k !== 'resume')),
    }),
    [state.session, params, embed, language],
  );

  const onSubmitted = (result: SubmissionResult) => {
    sendVisit(true);
    for (const token of new Set([draft.token, resumeToken, auto.current?.token()].filter(Boolean))) {
      if (target) void publicApi(`/forms/${target.code}/drafts/discard?org=${encodeURIComponent(target.org)}`, { method: 'POST', body: { token } }).catch(() => undefined);
    }
    auto.current?.forget();
    setDraft({});
    if (embed && window.parent !== window) window.parent.postMessage({ type: EMBED_MESSAGE.submitted, code: target?.code, submissionId: result.submissionId }, '*');
  };

  /** The answers kept on this device are not wanted: forget them here and on the server, and show the empty form. */
  const startAgain = () => {
    const token = auto.current?.token();
    auto.current?.forget();
    const gone = target && token ? publicApi(draftUrl(target, '/discard'), { method: 'POST', body: { token } }).catch(() => undefined) : Promise.resolve();
    void gone.then(() => window.location.reload());
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
          : message?.trim() || ui('closedDefault')}
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
        {languages.length > 1 && (
          <div className="rt-language">
            <label>
              <span>{ui('language')}</span>
              <select value={language} onChange={(e) => setChosenLanguage(e.target.value)}>
                {languages.map((l) => (
                  <option key={l} value={l} lang={l}>
                    {languageName(l)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {state.resumed && <p className="rt-banner">{ui('welcomeBack')}</p>}
        {state.kept && (
          <p className="rt-banner rt-banner--kept">
            <span>{ui('keptAnswers')}</span>
            <button type="button" className="rt-save__btn" onClick={startAgain}>
              {ui('startAgain')}
            </button>
          </p>
        )}
        {draft.error && <p className="rt-banner rt-banner--error">{draft.error}</p>}
        <FormContainer
          definition={state.definition}
          systemContext={systemContext}
          submissionAdapter={httpSubmissionAdapter}
          dataSourceAdapter={publicDataSourceAdapter(state.definition)}
          onSubmitted={onSubmitted}
          onValuesChange={onValuesChange}
          onProblems={(fields) => visit.current.problems(fields)}
          initialValues={state.initialValues}
        />
        {auto.current && <p className="rt-soft rt-kept-note">{ui('keptAsYouGo')}</p>}
        {!embed && state.definition.saveForLater !== false && (
          <div className="rt-save">
            {draft.link ? (
              <div className="rt-save__link">
                <span>{ui('savedLink')}</span>
                <input readOnly value={draft.link} aria-label={ui('continueLink')} onFocus={(e) => e.currentTarget.select()} />
                <button type="button" className="rt-save__btn" onClick={() => void navigator.clipboard?.writeText(draft.link!)}>
                  {ui('copyLink')}
                </button>
              </div>
            ) : (
              <button type="button" className="rt-save__btn" disabled={draft.busy} onClick={() => void saveForLater()}>
                {draft.busy ? ui('saving') : ui('saveLater')}
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
