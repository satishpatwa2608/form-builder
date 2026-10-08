import type { KeyboardEvent } from "react";
import { format, formatDistanceToNow } from "date-fns";
import { Clock, ShieldCheck } from "lucide-react";
import { findStatus } from "../../engine";
import type { InboxPage, RecordRow } from "../../adapters/workflow";
import type { Priority } from "../../types";
import { PRIORITY_LABEL, StatusPill } from "../RecordDrawer";

export type InboxLayout = "table" | "cards";

/** Accent colours per theme (charts need real colours; the CSS has the same values). */
const theme = <K extends InboxThemeKey>(
  key: K,
  label: string,
  accent: string,
  accent2: string,
) =>
  ({
    key,
    label,
    accent,
    accent2,
    swatch: `linear-gradient(135deg, ${key === "midnight" ? "#0b1120" : accent}, ${key === "midnight" ? accent : accent2})`,
  }) as const;

export const INBOX_THEMES = [
  theme("classic", "Classic", "#2563eb", "#7c3aed"),
  theme("ocean", "Ocean", "#0891b2", "#0ea5e9"),
  theme("sunset", "Sunset", "#e11d48", "#f97316"),
  theme("forest", "Forest", "#059669", "#65a30d"),
  theme("lavender", "Lavender", "#7c3aed", "#db2777"),
  theme("midnight", "Midnight", "#818cf8", "#22d3ee"),
] as const;
export type InboxThemeKey =
  "classic" | "ocean" | "sunset" | "forest" | "lavender" | "midnight";
export type InboxTheme = InboxThemeKey;

interface InboxItemsProps {
  layout: InboxLayout;
  data: InboxPage | undefined;
  loading: boolean;
  emptyText: string;
  /** What the item is about (first answers). */
  summary: (row: RecordRow) => string;
  onOpen: (id: string) => void;
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

function Person({ name }: { name: string | undefined }) {
  return (
    <span className="wi-person">
      <span
        className={`wi-avatar${name ? "" : " wi-avatar--none"}`}
        aria-hidden
      >
        {name ? initials(name) : "?"}
      </span>
      <span>{name ?? "Unassigned"}</span>
    </span>
  );
}

function PriorityTag({ priority }: { priority: Priority }) {
  return (
    <span className={`fb-priority fb-priority--${priority} wi-prio`}>
      {PRIORITY_LABEL[priority] ?? priority}
    </span>
  );
}

function Due({ due }: { due: string | null }) {
  if (!due) return <span className="wi-sub">No due date</span>;
  const late = new Date(due) < new Date();
  return (
    <span
      className="wi-due"
      title={format(new Date(due), "dd MMM yyyy, HH:mm")}
    >
      <Clock size={13} aria-hidden />
      <span className={late ? "fb-overdue" : undefined}>
        {formatDistanceToNow(new Date(due), { addSuffix: true })}
      </span>
    </span>
  );
}

/** Work items as a table or as cards; a click anywhere on an item opens it. */
export function InboxItems({
  layout,
  data,
  loading,
  emptyText,
  summary,
  onOpen,
}: InboxItemsProps) {
  const rows = data?.rows ?? [];
  if (loading && !data)
    return <div className="wi-empty">Loading work items…</div>;
  if (!rows.length) return <div className="wi-empty">{emptyText}</div>;

  const status = (row: RecordRow) => (
    <StatusPill
      status={
        findStatus(
          { enabled: true, statuses: data?.forms[row.formId]?.statuses ?? [] },
          row.status,
        ) ?? { key: row.status, label: row.status, category: "OPEN" }
      }
    />
  );
  const formName = (row: RecordRow) =>
    data?.forms[row.formId]?.name ?? row.formCode;
  const assignee = (row: RecordRow) =>
    row.assigneeId
      ? (data?.people[row.assigneeId]?.name ?? "Unknown user")
      : undefined;
  const waiting = (row: RecordRow) =>
    data?.waitingOnMe.includes(row.uuid) && (
      <span className="wi-badge">
        <ShieldCheck size={12} aria-hidden />
        Needs your approval
      </span>
    );
  const ref = (row: RecordRow) => (
    <button
      type="button"
      className="wi-ref"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(row.uuid);
      }}
    >
      {row.ref || "Open"}
    </button>
  );
  // Rows and cards are clickable; the ref button stays the keyboard/screen-reader control.
  const open = (row: RecordRow) => ({
    onClick: () => onOpen(row.uuid),
    onKeyDown: (e: KeyboardEvent) =>
      e.key === "Enter" && e.target === e.currentTarget && onOpen(row.uuid),
  });

  if (layout === "cards") {
    return (
      <div className="wi-grid">
        {rows.map((row) => (
          <article
            key={row.uuid}
            className={`wi-card wi-card--${row.priority}`}
            aria-label={row.ref || "Work item"}
            {...open(row)}
          >
            <div className="wi-card__top">
              {ref(row)}
              {status(row)}
            </div>
            <div className="wi-sub">{formName(row)}</div>
            <p className="wi-card__about" title={summary(row)}>
              {summary(row) || "—"}
            </p>
            <div className="wi-card__meta">
              <PriorityTag priority={row.priority} />
              {waiting(row)}
            </div>
            <div className="wi-card__foot">
              <Person name={assignee(row)} />
              <Due due={row.dueAt} />
            </div>
            <div className="wi-sub">
              Submitted {format(new Date(row.createdAt), "dd MMM yyyy, HH:mm")}
            </div>
          </article>
        ))}
      </div>
    );
  }

  return (
    <div className="wi-table-wrap">
      <table className="wi-table">
        <thead>
          <tr>
            <th>Item</th>
            <th>About</th>
            <th>Status</th>
            <th>Priority</th>
            <th>Assigned to</th>
            <th>Due</th>
            <th>Submitted</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.uuid}
              className={`wi-row--${row.priority}`}
              {...open(row)}
            >
              <td>
                <div className="wi-cell-stack">
                  {ref(row)}
                  <span className="wi-sub">{formName(row)}</span>
                  {waiting(row)}
                </div>
              </td>
              <td>
                <div className="wi-about" title={summary(row)}>
                  {summary(row) || "—"}
                </div>
              </td>
              <td>{status(row)}</td>
              <td>
                <PriorityTag priority={row.priority} />
              </td>
              <td>
                <Person name={assignee(row)} />
              </td>
              <td>
                <Due due={row.dueAt} />
              </td>
              <td>
                <div className="wi-cell-stack">
                  <span>{format(new Date(row.createdAt), "dd MMM yyyy")}</span>
                  <span className="wi-sub">
                    {format(new Date(row.createdAt), "HH:mm")}
                  </span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
