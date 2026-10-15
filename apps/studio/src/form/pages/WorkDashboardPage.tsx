import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { format, parseISO } from "date-fns";
import {
  AlarmClock,
  CalendarClock,
  CheckCircle2,
  Flame,
  Inbox,
  ShieldCheck,
  TrendingUp,
  UserX,
  Users,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useAuth } from "../../lib/auth";
import { useFormDefinitions } from "../adapters/registry/useFormRegistry";
import {
  recordsAvailable,
  useWorkDashboard,
  useWorkSettings,
} from "../adapters/workflow";
import { ChoiceSelect } from "../builder/components/settings";
import { PRIORITY_LABEL } from "./RecordDrawer";
import { INBOX_THEMES } from "./work/InboxItems";
import type { Priority } from "../types";
import "../styles/form-builder.css";
import "../styles/work-inbox.css";
import "../styles/work-dashboard.css";

interface WorkDashboardPageProps {
  /** Open the Inbox on a built-in view: mine, approvals, unassigned, overdue, all. */
  onOpenView: (preset: string) => void;
}

const ALL = "__all__";
const PRIORITY_COLOR: Record<string, string> = {
  CRITICAL: "#dc2626",
  HIGH: "#ea580c",
  LOW: "#94a3b8",
  NONE: "#cbd5e1",
};

/** No animation where motion is unwanted (or can't be asked about, e.g. tests). */
const calm = () =>
  typeof window === "undefined" ||
  !window.matchMedia ||
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Counts up to `target` (ease-out). */
function useCountUp(target: number) {
  const [value, setValue] = useState(() => (calm() ? target : 0));
  useEffect(() => {
    if (calm()) return setValue(target);
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / 900);
      setValue(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return Number.isInteger(target) ? Math.round(value) : value.toFixed(1);
}

/** False on the first paint, then true: lets widths and arcs animate in from zero. */
function useMounted() {
  const [on, setOn] = useState(calm);
  useEffect(() => {
    const id = requestAnimationFrame(() => setOn(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return on;
}

const delay = (i: number) => ({ "--wd-i": i }) as CSSProperties;

function Kpi({
  label,
  value,
  icon,
  tone,
  onClick,
  i,
}: {
  label: string;
  value: number;
  icon: ReactNode;
  tone?: "bad" | "warn" | "good";
  onClick?: () => void;
  i: number;
}) {
  const shown = useCountUp(value);
  const body = (
    <>
      <span className="wd-kpi__top">
        <span className="wd-kpi__icon" aria-hidden>
          {icon}
        </span>
        {onClick && <span className="wd-kpi__go">Open →</span>}
      </span>
      <span className="wd-kpi__value">{shown}</span>
      <span className="wd-kpi__label">{label}</span>
    </>
  );
  const className = `wd-kpi wd-anim${tone ? ` wd-kpi--${tone}` : ""}`;
  return onClick ? (
    <button
      type="button"
      className={className}
      style={delay(i)}
      onClick={onClick}
    >
      {body}
    </button>
  ) : (
    <div className={className} style={delay(i)}>
      {body}
    </div>
  );
}

function Gauge({ value }: { value: number | null }) {
  const on = useMounted();
  const r = 70;
  const c = 2 * Math.PI * r;
  const pct = value ?? 0;
  const bad = value !== null && value < 80;
  return (
    <div className="wd-gauge">
      <svg width="170" height="170" viewBox="0 0 170 170" aria-hidden>
        <defs>
          <linearGradient id="wd-gauge" x1="0" y1="0" x2="1" y2="1">
            <stop
              offset="0%"
              stopColor={bad ? "#f97316" : "var(--wi-accent)"}
              style={{ stopColor: bad ? "#f97316" : "var(--wi-accent)" }}
            />
            <stop
              offset="100%"
              stopColor={bad ? "#dc2626" : "var(--wi-accent-2)"}
              style={{ stopColor: bad ? "#dc2626" : "var(--wi-accent-2)" }}
            />
          </linearGradient>
        </defs>
        <circle
          className="wd-gauge__track"
          cx="85"
          cy="85"
          r={r}
          fill="none"
          strokeWidth="14"
        />
        <circle
          className="wd-gauge__arc"
          cx="85"
          cy="85"
          r={r}
          fill="none"
          stroke="url(#wd-gauge)"
          strokeWidth="14"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={on ? c * (1 - pct / 100) : c}
        />
      </svg>
      <div className="wd-gauge__text">
        <strong className={bad ? "wd-bad" : undefined}>
          {value === null ? "—" : `${value}%`}
        </strong>
        <span>within SLA</span>
      </div>
    </div>
  );
}

function Bars({
  title,
  rows,
  i,
}: {
  title: string;
  rows: { label: string; value: number; bad?: number; avatar?: boolean }[];
  i: number;
}) {
  const on = useMounted();
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <section className="wd-panel wd-anim" style={delay(i)} aria-label={title}>
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p className="wd-empty">Nothing open.</p>
      ) : (
        <div className="wd-bars">
          {rows.map((r) => (
            <div key={r.label} className="wd-bar">
              <span className="wd-bar__label">
                {r.avatar && (
                  <span
                    className={`wi-avatar${r.label === "Unassigned" ? " wi-avatar--none" : ""}`}
                    aria-hidden
                  >
                    {r.label === "Unassigned"
                      ? "?"
                      : r.label
                          .split(/\s+/)
                          .slice(0, 2)
                          .map((w) => w[0]?.toUpperCase())
                          .join("")}
                  </span>
                )}
                <span>{r.label}</span>
              </span>
              <span className="wd-bar__count">
                {r.value}
                {r.bad ? (
                  <span className="fb-overdue"> · {r.bad} overdue</span>
                ) : null}
              </span>
              <span
                className="wd-bar__track"
                title={r.bad ? `${r.bad} overdue` : undefined}
              >
                <span
                  className="wd-bar__fill"
                  style={{
                    width: on
                      ? `${((r.value - (r.bad ?? 0)) / max) * 100}%`
                      : 0,
                  }}
                />
                {!!r.bad && (
                  <span
                    className="wd-bar__fill wd-bar__fill--bad"
                    style={{ width: on ? `${(r.bad / max) * 100}%` : 0 }}
                  />
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function TrendTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
}) {
  if (!active || !payload?.length || !label) return null;
  return (
    <div className="wd-tooltip">
      <strong>{format(parseISO(label), "EEE, dd MMM")}</strong>
      {payload.map((p) => (
        <div key={p.name} style={{ color: p.color }}>
          {p.name}: {p.value}
        </div>
      ))}
    </div>
  );
}

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
};

/**
 * The Work dashboard: my day (cards open the matching Inbox view), the team's
 * workload, and how well the SLAs are kept. Counts follow the same visibility
 * as the Inbox; the look follows the org's Inbox theme.
 */
export default function WorkDashboardPage({
  onOpenView,
}: WorkDashboardPageProps) {
  const [formCode, setFormCode] = useState<string>();
  const [days, setDays] = useState(30);
  const [team, setTeam] = useState<string>();
  const { data, isLoading } = useWorkDashboard(formCode, days, team);
  const { data: forms = [] } = useFormDefinitions();
  const { data: settings } = useWorkSettings();
  const user = useAuth().me?.user;
  const theme =
    INBOX_THEMES.find((t) => t.key === settings?.inboxTheme) ?? INBOX_THEMES[0];
  const tracked = useMemo(() => {
    const latest = new Map<string, string>();
    for (const f of forms) if (f.workflow?.enabled) latest.set(f.code, f.name);
    return [...latest.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [forms]);
  const formName = (code: string) =>
    tracked.find(([c]) => c === code)?.[1] ?? code;
  // Hours from the API (1 decimal); short times read better in minutes.
  const hrs = (v: number | null) =>
    v === null ? "—" : v === 0 ? "< 5 min" : v < 1 ? `${Math.round(v * 60)} min` : `${v} h`;
  const pct = (v: number | null) => (v === null ? "—" : `${v}%`);
  const firstName = user?.name?.split(/\s+/)[0];

  const priorities = (data?.team.byPriority ?? []).map((p) => ({
    key: p.priority,
    name: PRIORITY_LABEL[p.priority as Priority] ?? "Not set",
    value: p.open,
    color: PRIORITY_COLOR[p.priority] ?? theme.accent,
  }));
  const trend = data?.performance.trend ?? [];

  return (
    <div className="wi p-6 space-y-6" data-theme={theme.key}>
      <header className="wi-hero wd-hero wd-anim">
        <div>
          <h1>{firstName ? `${greeting()}, ${firstName}` : "Dashboard"}</h1>
          <p>
            Your work, the team's workload and SLA performance ·{" "}
            {format(new Date(), "EEEE, dd MMM")}
          </p>
        </div>
        <div className="wd-hero__filters">
          <ChoiceSelect
            ariaLabel="Form"
            value={formCode ?? ALL}
            options={[
              { label: "All forms", value: ALL },
              ...tracked.map(([c, n]) => ({ label: n, value: c })),
            ]}
            onChange={(v) => setFormCode(v === ALL ? undefined : v)}
          />
          <ChoiceSelect<"7" | "30" | "90">
            ariaLabel="Period"
            value={String(days) as "7" | "30" | "90"}
            options={[
              { label: "Last 7 days", value: "7" },
              { label: "Last 30 days", value: "30" },
              { label: "Last 90 days", value: "90" },
            ]}
            onChange={(v) => setDays(Number(v))}
          />
          {(data?.teams?.length ?? 0) > 0 && (
            <ChoiceSelect
              ariaLabel="Team"
              value={team ?? ALL}
              options={[
                { label: "All teams", value: ALL },
                ...(data?.teams ?? []).map((t) => ({ label: t, value: t })),
              ]}
              onChange={(v) => setTeam(v === ALL ? undefined : v)}
            />
          )}
        </div>
      </header>

      {!recordsAvailable ? (
        <p className="wi-empty">
          Work items are kept by the server. This app is running on local
          storage only.
        </p>
      ) : isLoading || !data ? (
        <p className="wi-empty">Loading your dashboard…</p>
      ) : (
        <>
          <section className="wd-section" aria-label="My work">
            <div className="wd-heading">
              <h2>My work</h2>
              <span>Click a card to open those items</span>
            </div>
            <div className="wd-kpis">
              <Kpi
                i={1}
                label="Open, assigned to me"
                value={data.me.open}
                icon={<Inbox size={18} />}
                onClick={() => onOpenView("mine")}
              />
              <Kpi
                i={2}
                label="Overdue"
                value={data.me.overdue}
                icon={<AlarmClock size={18} />}
                tone={data.me.overdue > 0 ? "bad" : undefined}
                onClick={() => onOpenView("overdue")}
              />
              <Kpi
                i={3}
                label="Due today"
                value={data.me.dueToday}
                icon={<CalendarClock size={18} />}
                tone={data.me.dueToday > 0 ? "warn" : undefined}
                onClick={() => onOpenView("mine")}
              />
              <Kpi
                i={4}
                label="Waiting for my approval"
                value={data.me.waitingMyApproval}
                icon={<ShieldCheck size={18} />}
                onClick={() => onOpenView("approvals")}
              />
              <Kpi
                i={5}
                label="Resolved today"
                value={data.me.resolvedToday}
                icon={<CheckCircle2 size={18} />}
                tone="good"
              />
            </div>
          </section>

          <section className="wd-grid-2" aria-label="Performance">
            <div className="wd-panel wd-anim" style={delay(6)}>
              <div className="wd-panel__head">
                <h3>Raised vs resolved · last {data.days} days</h3>
                <div className="wd-legend">
                  <span>
                    <i style={{ background: theme.accent }} />
                    Raised {data.performance.created}
                  </span>
                  <span>
                    <i style={{ background: "#10b981" }} />
                    Resolved {data.performance.resolved}
                  </span>
                </div>
              </div>
              <div className="wd-chart">
                {trend.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={trend}
                      margin={{ top: 8, right: 8, left: -18, bottom: 0 }}
                    >
                      <defs>
                        <linearGradient
                          id="wd-raised"
                          x1="0"
                          y1="0"
                          x2="0"
                          y2="1"
                        >
                          <stop
                            offset="0%"
                            stopColor={theme.accent}
                            stopOpacity={0.35}
                          />
                          <stop
                            offset="100%"
                            stopColor={theme.accent}
                            stopOpacity={0}
                          />
                        </linearGradient>
                        <linearGradient
                          id="wd-resolved"
                          x1="0"
                          y1="0"
                          x2="0"
                          y2="1"
                        >
                          <stop
                            offset="0%"
                            stopColor="#10b981"
                            stopOpacity={0.3}
                          />
                          <stop
                            offset="100%"
                            stopColor="#10b981"
                            stopOpacity={0}
                          />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis
                        dataKey="date"
                        tickLine={false}
                        axisLine={false}
                        minTickGap={24}
                        tickFormatter={(d: string) =>
                          format(parseISO(d), "dd MMM")
                        }
                      />
                      <YAxis
                        allowDecimals={false}
                        tickLine={false}
                        axisLine={false}
                        width={40}
                      />
                      <Tooltip content={<TrendTooltip />} />
                      <Area
                        type="monotone"
                        dataKey="raised"
                        name="Raised"
                        stroke={theme.accent}
                        strokeWidth={2.5}
                        fill="url(#wd-raised)"
                        animationDuration={1100}
                      />
                      <Area
                        type="monotone"
                        dataKey="resolved"
                        name="Resolved"
                        stroke="#10b981"
                        strokeWidth={2.5}
                        fill="url(#wd-resolved)"
                        animationDuration={1300}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="wd-empty">No activity in this period.</p>
                )}
              </div>
            </div>
            <div className="wd-panel wd-anim" style={delay(7)}>
              <div className="wd-panel__head">
                <h3>SLA performance</h3>
                <TrendingUp size={16} aria-hidden />
              </div>
              <Gauge value={data.performance.slaCompliance} />
              <div className="wd-minis">
                <div className="wd-mini">
                  <strong>{hrs(data.performance.avgFirstResponseHours)}</strong>
                  <span>Avg. first response</span>
                </div>
                <div className="wd-mini">
                  <strong>{hrs(data.performance.avgResolutionHours)}</strong>
                  <span>Avg. resolution time</span>
                </div>
                <div className="wd-mini">
                  <strong>{data.performance.resolved}</strong>
                  <span>Resolved</span>
                </div>
                <div className="wd-mini">
                  <strong>{pct(data.performance.reopenRate)}</strong>
                  <span>Reopened</span>
                </div>
              </div>
            </div>
          </section>

          <section className="wd-section" aria-label="Team">
            <div className="wd-heading">
              <h2>Team</h2>
              <span>Everything you can see</span>
            </div>
            <div className="wd-kpis">
              <Kpi
                i={8}
                label="Open"
                value={data.team.open}
                icon={<Users size={18} />}
                onClick={() => onOpenView("all")}
              />
              <Kpi
                i={9}
                label="Unassigned"
                value={data.team.unassigned}
                icon={<UserX size={18} />}
                tone={data.team.unassigned > 0 ? "warn" : undefined}
                onClick={() => onOpenView("unassigned")}
              />
              <Kpi
                i={10}
                label="Overdue"
                value={data.team.overdue}
                icon={<AlarmClock size={18} />}
                tone={data.team.overdue > 0 ? "bad" : undefined}
                onClick={() => onOpenView("overdue")}
              />
              <Kpi
                i={11}
                label="Escalated"
                value={data.team.escalated}
                icon={<Flame size={18} />}
                tone={data.team.escalated > 0 ? "bad" : undefined}
              />
            </div>
          </section>

          <div className="wd-grid-3">
            <Bars
              i={12}
              title="Open by person"
              rows={data.team.byAssignee.map((r) => ({
                label: r.name,
                value: r.open,
                bad: r.overdue,
                avatar: true,
              }))}
            />
            <section
              className="wd-panel wd-anim"
              style={delay(13)}
              aria-label="Open by priority"
            >
              <h3>Open by priority</h3>
              {priorities.length === 0 ? (
                <p className="wd-empty">Nothing open.</p>
              ) : (
                <>
                  <div className="wd-donut">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={priorities}
                          dataKey="value"
                          nameKey="name"
                          innerRadius={55}
                          outerRadius={80}
                          paddingAngle={3}
                          stroke="none"
                          animationDuration={1000}
                        >
                          {priorities.map((p) => (
                            <Cell key={p.key} fill={p.color} />
                          ))}
                        </Pie>
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="wd-donut__center">
                      <div>
                        <strong>{data.team.open}</strong>
                        <span>open</span>
                      </div>
                    </div>
                  </div>
                  <ul className="wd-keys">
                    {priorities.map((p) => (
                      <li key={p.key}>
                        <i style={{ background: p.color }} />
                        {p.name}
                        <b>{p.value}</b>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
            <Bars
              i={14}
              title="Open by form"
              rows={data.team.byForm.map((r) => ({
                label: formName(r.formCode),
                value: r.open,
              }))}
            />
          </div>
        </>
      )}
    </div>
  );
}
