import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Pause, Play, SlidersHorizontal } from 'lucide-react';
import { api, apiFile, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Button, Card, PageHead, useSubmit } from '../components/ui';

type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
interface Line {
  id: string;
  at: string;
  level: Level;
  area: string;
  message: string;
  context: Record<string, string | number | boolean>;
}
interface Settings {
  areas: { area: string; label: string; level: Level; recording: Level }[];
  debugUntil: string | null;
  keepDays: number;
  limits: { maxKeepDays: number; maxDebugHours: number };
}

const LEVEL_WORD: Record<Level, string> = { DEBUG: 'Debug', INFO: 'Info', WARN: 'Warning', ERROR: 'Error' };
/** What the "show" list offers: a level and everything more serious. */
const SHOW: { value: Level; label: string }[] = [
  { value: 'DEBUG', label: 'Everything, debug included' },
  { value: 'INFO', label: 'Info and above' },
  { value: 'WARN', label: 'Warnings and errors' },
  { value: 'ERROR', label: 'Errors only' },
];
/** What an area can be set to record. */
const RECORD: { value: Level; label: string }[] = [
  { value: 'DEBUG', label: 'Debug (everything, for a while)' },
  { value: 'INFO', label: 'Info (the usual)' },
  { value: 'WARN', label: 'Warnings and errors' },
  { value: 'ERROR', label: 'Errors only' },
];

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
/** A line's time as a log shows it, in the reader's own time zone. */
export function lineTime(at: string): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
/** The facts beside a message, written key=value. */
export const factsOf = (context: Line['context']) =>
  Object.entries(context)
    .map(([k, v]) => `${k}=${typeof v === 'string' && /[\s="]/.test(v) ? JSON.stringify(v) : v}`)
    .join('  ');

const queryOf = (f: { level: Level; area: string; q: string }, extra: Record<string, string> = {}) =>
  new URLSearchParams({ ...(f.level !== 'DEBUG' ? { level: f.level } : {}), ...(f.area ? { area: f.area } : {}), ...(f.q.trim() ? { q: f.q.trim() } : {}), ...extra }).toString();

/**
 * The organisation's log: what the product did on its behalf, line by line,
 * with a level on each. Read here, followed live, or taken away as a file;
 * what each part of the product records is set underneath.
 */
export default function LogsPage() {
  const { can } = useAuth();
  const [level, setLevel] = useState<Level>('INFO');
  const [area, setArea] = useState('');
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [follow, setFollow] = useState(true);
  const [older, setOlder] = useState<Line[]>([]);
  const [olderFrom, setOlderFrom] = useState<string | null>(null);
  const [open, setOpen] = useState<string>();
  const [showSettings, setShowSettings] = useState(false);
  const [problem, setProblem] = useState<string>();
  const filter = { level, area, q };

  // Typing searches once the person pauses, not on every letter.
  useEffect(() => {
    const t = setTimeout(() => setQ(typed), 300);
    return () => clearTimeout(t);
  }, [typed]);
  // A different question starts from the newest lines again.
  useEffect(() => {
    setOlder([]);
    setOlderFrom(null);
  }, [level, area, q]);

  const settings = useQuery({ queryKey: ['log-settings'], queryFn: () => api<Settings>('/org/logs/settings') });
  const newest = useQuery({
    queryKey: ['logs', level, area, q],
    queryFn: () => api<{ lines: Line[]; next: string | null }>(`/org/logs?${queryOf(filter, { limit: '200' })}`),
    // Following: the newest lines are asked for again every few seconds.
    refetchInterval: follow ? 3000 : false,
    placeholderData: keepPreviousData,
  });
  const lines = [...(newest.data?.lines ?? []), ...older.filter((o) => !(newest.data?.lines ?? []).some((n) => n.id === o.id))];
  const next = older.length ? olderFrom : (newest.data?.next ?? null);

  const loadOlder = async () => {
    if (!next) return;
    try {
      const page = await api<{ lines: Line[]; next: string | null }>(`/org/logs?${queryOf(filter, { limit: '200', before: next })}`);
      setOlder((o) => [...o, ...page.lines]);
      setOlderFrom(page.next);
    } catch (e) {
      setProblem(errorMessage(e));
    }
  };
  const download = async () => {
    try {
      const url = URL.createObjectURL(await apiFile(`/org/logs/download?${queryOf(filter)}`));
      const link = document.createElement('a');
      link.href = url;
      link.download = `form-builder-${new Date().toISOString().slice(0, 10)}.log`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setProblem(errorMessage(e));
    }
  };

  const debugging = settings.data?.areas.filter((a) => a.recording === 'DEBUG') ?? [];
  return (
    <>
      <PageHead
        title="Logs"
        subtitle="What Form Builder did for your organisation, line by line: responses, workflow steps, connectors, email, sign-ins and changes. Answers people gave are never written here."
        actions={
          <div className="st-row" style={{ gap: 8 }}>
            <Button variant="secondary" size="sm" onClick={() => setFollow((f) => !f)} aria-pressed={follow} title={follow ? 'New lines appear by themselves' : 'The list stays as it is until you follow again'}>
              {follow ? <Pause size={14} /> : <Play size={14} />} {follow ? 'Following' : 'Follow'}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void download()}>
              <Download size={14} /> Download
            </Button>
            <Button variant={showSettings ? 'primary' : 'secondary'} size="sm" onClick={() => setShowSettings((s) => !s)} aria-expanded={showSettings}>
              <SlidersHorizontal size={14} /> What is recorded
            </Button>
          </div>
        }
      />
      <div className="st-stack">
        {problem && <Alert tone="error">{problem}</Alert>}
        {debugging.length > 0 && settings.data?.debugUntil && (
          <Alert tone="info">
            Debug is on for {debugging.map((a) => a.label).join(', ')} until {new Date(settings.data.debugUntil).toLocaleTimeString(undefined, { timeStyle: 'short' })}; it then goes back to Info by itself.
          </Alert>
        )}
        {showSettings && settings.data && <LogSettings settings={settings.data} canChange={can('org.manage')} />}
        <Card bodyless>
          <div className="st-logbar">
            <label>
              <span>Show</span>
              <select className="st-select" aria-label="Show" value={level} onChange={(e) => setLevel(e.target.value as Level)}>
                {SHOW.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>From</span>
              <select className="st-select" aria-label="From" value={area} onChange={(e) => setArea(e.target.value)}>
                <option value="">Every part</option>
                {settings.data?.areas.map((a) => (
                  <option key={a.area} value={a.area}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ flex: '1 1 220px' }}>
              <span>Find</span>
              <input className="st-input" aria-label="Find" placeholder="Words in the message, a form code, or a reference" value={typed} onChange={(e) => setTyped(e.target.value)} />
            </label>
          </div>
          <div className="st-log" role="log" aria-label="Log lines" aria-live={follow ? 'polite' : 'off'}>
            {newest.isLoading && <p className="st-empty">Loading…</p>}
            {!newest.isLoading && lines.length === 0 && (
              <p className="st-empty">
                Nothing here{level === 'DEBUG' || !(area || q) ? '' : ' for this choice'}.{level !== 'DEBUG' ? ' Debug lines are recorded only for the parts set to Debug under "What is recorded".' : ''}
              </p>
            )}
            {lines.map((l) => (
              <button key={l.id} type="button" className={`st-logline st-logline--${l.level.toLowerCase()}`} aria-expanded={open === l.id} onClick={() => setOpen(open === l.id ? undefined : l.id)}>
                <time dateTime={l.at}>{lineTime(l.at)}</time>
                <span className="st-logline__level">{l.level}</span>
                <span className="st-logline__area">[{l.area}]</span>
                <span className="st-logline__text">
                  {l.message}
                  {open !== l.id && Object.keys(l.context).length > 0 && <span className="st-logline__facts">{factsOf(l.context)}</span>}
                </span>
                {open === l.id && (
                  <dl className="st-logline__more">
                    <dt>Level</dt>
                    <dd>{LEVEL_WORD[l.level]}</dd>
                    <dt>From</dt>
                    <dd>{settings.data?.areas.find((a) => a.area === l.area)?.label ?? l.area}</dd>
                    {Object.entries(l.context).map(([k, v]) => (
                      <span key={k} style={{ display: 'contents' }}>
                        <dt>{k}</dt>
                        <dd>{String(v)}</dd>
                      </span>
                    ))}
                  </dl>
                )}
              </button>
            ))}
            {next && (
              <div style={{ textAlign: 'center', padding: 10 }}>
                <Button variant="secondary" size="sm" onClick={() => void loadOlder()}>
                  Load older lines
                </Button>
              </div>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}

/** A level for each part of the product, how long debug runs, and how long lines are kept. */
function LogSettings({ settings, canChange }: { settings: Settings; canChange: boolean }) {
  const qc = useQueryClient();
  const [levels, setLevels] = useState<Record<string, Level>>(() => Object.fromEntries(settings.areas.map((a) => [a.area, a.level])));
  const [hours, setHours] = useState(1);
  const [keepDays, setKeepDays] = useState(settings.keepDays);
  const [note, setNote] = useState<string>();
  useEffect(() => {
    setLevels(Object.fromEntries(settings.areas.map((a) => [a.area, a.level])));
    setKeepDays(settings.keepDays);
  }, [settings]);
  const anyDebug = Object.values(levels).includes('DEBUG');
  const save = useSubmit(async () => {
    const next = await api<Settings>('/org/logs/settings', { method: 'PUT', body: { levels, keepDays, ...(anyDebug ? { debugHours: hours } : {}) } });
    qc.setQueryData(['log-settings'], next);
    setNote(anyDebug ? `Saved. Debug runs for ${hours} ${hours === 1 ? 'hour' : 'hours'}, then goes back to Info by itself.` : 'Saved.');
  });
  return (
    <Card title="What is recorded" subtitle="Each part of the product records at its own level: that level and everything more serious. Debug records far more, to find a fault, and switches itself back.">
      <form className="st-stack" onSubmit={save.submit} noValidate>
        {note && <Alert tone="success">{note}</Alert>}
        {save.error && <Alert tone="error">{save.error}</Alert>}
        {!canChange && <Alert tone="info">Only someone who manages the organisation can change these.</Alert>}
        <div className="st-loglevels" role="group" aria-label="Level for each part">
          {settings.areas.map((a) => (
            <label key={a.area}>
              <span>
                {a.label}
                {a.level === 'DEBUG' && a.recording !== 'DEBUG' && <em className="st-muted"> (debug has run out: recording Info)</em>}
              </span>
              <select className="st-select" aria-label={a.label} disabled={!canChange} value={levels[a.area] ?? 'INFO'} onChange={(e) => setLevels((l) => ({ ...l, [a.area]: e.target.value as Level }))}>
                {RECORD.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <div className="st-row" style={{ gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          {anyDebug && (
            <label className="st-field" style={{ width: 220 }}>
              <span>Keep debug on for</span>
              <select className="st-select" aria-label="Keep debug on for" disabled={!canChange} value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                <option value={1}>1 hour</option>
                <option value={4}>4 hours</option>
                <option value={settings.limits.maxDebugHours}>{settings.limits.maxDebugHours} hours</option>
              </select>
            </label>
          )}
          <label className="st-field" style={{ width: 220 }}>
            <span>Keep lines for</span>
            <select className="st-select" aria-label="Keep lines for" disabled={!canChange} value={keepDays} onChange={(e) => setKeepDays(Number(e.target.value))}>
              {[...new Set([1, 7, 14, settings.limits.maxKeepDays, keepDays])].sort((a, b) => a - b).map((d) => (
                <option key={d} value={d}>
                  {d} {d === 1 ? 'day' : 'days'}
                </option>
              ))}
            </select>
          </label>
          {canChange && (
            <Button type="submit" busy={save.busy}>
              Save
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}
