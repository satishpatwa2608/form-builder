import { useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import { Download } from "lucide-react";
import { Button } from "@ui/button";
import { useFormDefinitions } from "../adapters/registry/useFormRegistry";
import { recordsAvailable, useWorkReport, type ReportRow, type WorkReport } from "../adapters/workflow";
import { ChoiceSelect } from "../builder/components/settings";
import "../styles/form-builder.css";
import "../styles/work-inbox.css";
import "../styles/work-dashboard.css";

const ALL = "__all__";
type Period = "7" | "30" | "90" | "365";

/** Hours as a person reads them: minutes when short, days when long. */
export function duration(hours: number | null): string {
  if (hours === null) return "—";
  if (hours < 1) return hours === 0 ? "< 5 min" : `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${hours} h`;
  return `${Math.round((hours / 24) * 10) / 10} days`;
}

const COLUMNS: { key: keyof Omit<ReportRow, "key" | "label">; label: string }[] = [
  { key: "opened", label: "Opened" },
  { key: "resolved", label: "Resolved" },
  { key: "medianResolveHours", label: "Median time to resolve" },
  { key: "openNow", label: "Open now" },
  { key: "overdueNow", label: "Overdue now" },
];

/** The report as a CSV, as shown: one row per group and a total, with the period and the choices at the top. */
export function reportCsv(report: WorkReport, about: { form: string; team: string }): string {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    // A leading = + - @ would be read as a formula by a spreadsheet.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const by = report.choices.find((c) => c.value === report.by)?.label ?? report.by;
  const lines = [
    [`Report: ${about.form}`, `${format(parseISO(report.from), "dd MMM yyyy")} to ${format(parseISO(report.to), "dd MMM yyyy")}`, about.team],
    [by, ...COLUMNS.map((c) => (c.key === "medianResolveHours" ? "Median hours to resolve" : c.label))],
    ...report.groups.map((g) => [g.label, g.opened, g.resolved, g.medianResolveHours, g.openNow, g.overdueNow]),
    ["Total", report.total.opened, report.total.resolved, report.total.medianResolveHours, report.total.openNow, report.total.overdueNow],
  ];
  return lines.map((l) => l.map(cell).join(",")).join("\n") + "\n";
}

/**
 * For a manager comparing places and teams: for a chosen period, how many records were opened, how many were
 * resolved and how long that took (the median, so one odd case does not skew it), and how many are open and
 * overdue now, side by side by one choice (a property, a complaint type, a team, a person, a priority). The same
 * people and records as the inbox; a CSV of what is shown.
 */
export default function WorkReportsPage() {
  const { data: forms = [] } = useFormDefinitions();
  const tracked = useMemo(() => {
    const latest = new Map<string, string>();
    for (const f of forms) if (f.workflow?.enabled) latest.set(f.code, f.name);
    return [...latest.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [forms]);
  const [formCode, setFormCode] = useState<string>();
  const [days, setDays] = useState<Period>("30");
  const [by, setBy] = useState<string>();
  const [team, setTeam] = useState<string>();
  const { data, isLoading, error } = useWorkReport({ formCode, days: Number(days), by, team });
  const most = Math.max(1, ...(data?.groups ?? []).map((g) => Math.max(g.opened, g.openNow)));
  const formName = formCode ? (tracked.find(([c]) => c === formCode)?.[1] ?? formCode) : "All forms";

  const download = () => {
    if (!data) return;
    const blob = new Blob([reportCsv(data, { form: formName, team: team ? `Team: ${team}` : "All teams" })], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `report-${(formCode ?? "all-forms").toLowerCase()}-${days}-days.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="wi p-6 space-y-6">
      <header className="wi-hero wd-hero">
        <div>
          <h1>Reports</h1>
          <p>Opened, resolved, how long it took, and what is open and late now, side by side.</p>
        </div>
        <div className="wd-hero__filters" style={{ flexWrap: "wrap" }}>
          <ChoiceSelect
            ariaLabel="Form"
            value={formCode ?? ALL}
            options={[{ label: "All forms", value: ALL }, ...tracked.map(([c, n]) => ({ label: n, value: c }))]}
            onChange={(v) => {
              setFormCode(v === ALL ? undefined : v);
              // A question of one form means nothing for another.
              setBy(undefined);
            }}
          />
          <ChoiceSelect<Period>
            ariaLabel="Period"
            value={days}
            options={[
              { label: "Last 7 days", value: "7" },
              { label: "Last 30 days", value: "30" },
              { label: "Last 90 days", value: "90" },
              { label: "Last 12 months", value: "365" },
            ]}
            onChange={setDays}
          />
          {data && <ChoiceSelect ariaLabel="Compare by" value={data.by} options={data.choices} onChange={setBy} />}
          {data && data.teams.length > 0 && (
            <ChoiceSelect
              ariaLabel="Team"
              value={team ?? ALL}
              options={[{ label: "All teams", value: ALL }, ...data.teams.map((t) => ({ label: t, value: t }))]}
              onChange={(v) => setTeam(v === ALL ? undefined : v)}
            />
          )}
        </div>
      </header>

      {!recordsAvailable ? (
        <p className="wi-empty">Work items are kept by the server. This app is running on local storage only.</p>
      ) : error ? (
        <p className="wi-empty" role="alert">
          {(error as Error).message}
        </p>
      ) : isLoading || !data ? (
        <p className="wi-empty">Working out the numbers…</p>
      ) : (
        <section className="fb-panel fb-settings" style={{ gap: 10, padding: 14 }} aria-label="Report">
          <div className="flex items-center gap-2" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
            <span className="text-sm">
              {formName} · {format(parseISO(data.from), "dd MMM")} to {format(parseISO(data.to), "dd MMM yyyy")}
              {team ? ` · ${team}` : ""}
            </span>
            <Button type="button" size="sm" variant="outline" onClick={download} disabled={!data.groups.length}>
              <Download size={14} /> Download CSV
            </Button>
          </div>
          {data.partial && (
            <p className="text-sm" role="status">
              There are more records than one report reads at once: these numbers are of the first 50,000. Choose a form or a shorter period.
            </p>
          )}
          {!data.groups.length ? (
            <p className="wi-empty">Nothing was opened or resolved in this period, and nothing is open.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="wd-table" style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th scope="col" style={{ textAlign: "start" }}>
                      {data.choices.find((c) => c.value === data.by)?.label}
                    </th>
                    {COLUMNS.map((c) => (
                      <th key={c.key} scope="col" style={{ textAlign: "end" }}>
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.groups.map((g) => (
                    <tr key={g.key || g.label}>
                      <th scope="row" style={{ textAlign: "start", fontWeight: 500 }}>
                        {g.label}
                        <div aria-hidden style={{ height: 4, marginTop: 4, borderRadius: 2, background: "var(--muted, #e5e7eb)", width: "100%", maxWidth: 220 }}>
                          <div style={{ height: 4, borderRadius: 2, background: "var(--primary, #1458e2)", width: `${Math.round((Math.max(g.opened, g.openNow) / most) * 100)}%` }} />
                        </div>
                      </th>
                      <td style={{ textAlign: "end" }}>{g.opened}</td>
                      <td style={{ textAlign: "end" }}>{g.resolved}</td>
                      <td style={{ textAlign: "end" }}>{duration(g.medianResolveHours)}</td>
                      <td style={{ textAlign: "end" }}>{g.openNow}</td>
                      <td style={{ textAlign: "end", color: g.overdueNow ? "var(--destructive, #dc2626)" : undefined }}>{g.overdueNow}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row" style={{ textAlign: "start" }}>
                      Total
                    </th>
                    <td style={{ textAlign: "end" }}>{data.total.opened}</td>
                    <td style={{ textAlign: "end" }}>{data.total.resolved}</td>
                    <td style={{ textAlign: "end" }}>{duration(data.total.medianResolveHours)}</td>
                    <td style={{ textAlign: "end" }}>{data.total.openNow}</td>
                    <td style={{ textAlign: "end" }}>{data.total.overdueNow}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
