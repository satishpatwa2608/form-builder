import { useMemo, useState } from "react";
import { LayoutGrid, List, Palette } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { answerFields, valuesFromPayload } from "../engine";
import { useFormDefinitions } from "../adapters/registry/useFormRegistry";
import {
  INBOX_PAGE_SIZE,
  recordsAvailable,
  useInbox,
  useSaveWorkSettings,
  useWorkSettings,
  type InboxFilters,
  type InboxSort,
  type RecordRow,
} from "../adapters/workflow";
import { messageOf } from "../adapters/backend";
import { useFormPermissions } from "../hooks/useFormPermissions";
import { BUILT_IN_VIEWS, ViewsBar } from "./work/ViewsBar";
import { FieldFilters } from "./work/FieldFilters";
import { ChoiceSelect } from "../builder/components/settings";
import { answerText, PRIORITY_LABEL, RecordDrawer } from "./RecordDrawer";
import {
  INBOX_THEMES,
  InboxItems,
  type InboxLayout,
  type InboxTheme,
} from "./work/InboxItems";
import { PRIORITIES, type Priority } from "../types";
import "../styles/form-builder.css";
import "../styles/work-inbox.css";

interface RecordsInboxPageProps {
  /** Record to open on arrival (links in notifications and emails). */
  recordId?: string;
  onOpenRecord: (id: string | undefined) => void;
  /** Start in this built-in view (dashboard links), e.g. "overdue". */
  preset?: string;
}

const ALL = "__all__";

/** Per-viewer display choices; storage can be unavailable (private mode), so never required. */
function usePreference<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key) as T | null;
      return saved && allowed.includes(saved) ? saved : fallback;
    } catch {
      return fallback;
    }
  });
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(key, v);
    } catch {
      // Not remembered - fine.
    }
  };
  return [value, set];
}
const LAYOUTS = ["table", "cards"] as const;
const isTheme = (v: string | undefined): v is InboxTheme =>
  INBOX_THEMES.some((t) => t.key === v);
type Assignee = "me" | "waiting" | "unassigned" | "reports" | typeof ALL;

/**
 * Submissions of forms that track records, across every such form: filter,
 * open one, move it along. Anyone with a Form records (or designer /
 * publisher / admin) module works here.
 */
export default function RecordsInboxPage({
  recordId,
  onOpenRecord,
  preset,
}: RecordsInboxPageProps) {
  const [filters, setFilters] = useState<InboxFilters>(
    () =>
      BUILT_IN_VIEWS.find((v) => v.key === preset)?.filters ??
      BUILT_IN_VIEWS[0].filters,
  );
  const { data, isLoading } = useInbox(filters);
  const { data: forms = [] } = useFormDefinitions();
  const set = (changes: Partial<InboxFilters>) =>
    setFilters((f) => ({ ...f, page: 1, ...changes }));
  const [layout, setLayout] = usePreference<InboxLayout>(
    "fb-inbox-layout",
    LAYOUTS,
    "table",
  );
  // The theme is the org's, set by a Form admin; the layout is each viewer's own.
  const { canAdminRecords: admin } = useFormPermissions();
  const { data: settings } = useWorkSettings();
  const saveSettings = useSaveWorkSettings();
  const theme: InboxTheme = isTheme(settings?.inboxTheme)
    ? settings.inboxTheme
    : "classic";
  const setTheme = (inboxTheme: InboxTheme) =>
    saveSettings.mutate(
      { inboxTheme },
      {
        onSuccess: () => toast.success("Theme saved for everyone"),
        onError: (e) => toast.error(messageOf(e)),
      },
    );

  // Forms that track records (latest version of each code) for the filter.
  const tracked = useMemo(() => {
    const latest = new Map<string, (typeof forms)[number]>();
    for (const f of forms)
      if (f.workflow?.enabled && (latest.get(f.code)?.version ?? 0) < f.version)
        latest.set(f.code, f);
    return [...latest.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [forms]);
  const selectedForm = tracked.find((f) => f.code === filters.formCode);
  const statusChoices = selectedForm?.workflow?.statuses ?? [];

  /** First few answers, so a row says what it's about. */
  const summary = (row: RecordRow) => {
    const def = forms.find((f) => f.id === row.formId);
    if (!def) return "";
    const values = valuesFromPayload(def, row.payload);
    return answerFields(def.fields)
      .filter(
        (f) =>
          f.type !== "REPEAT" &&
          f.type !== "SIGNATURE" &&
          f.type !== "HIDDEN" &&
          f.type !== "CAPTCHA" &&
          f.type !== "FILE" &&
          values[f.name] !== undefined &&
          values[f.name] !== "",
      )
      .slice(0, 2)
      .map((f) => answerText(def, f.name, values[f.name]))
      .join(" · ");
  };

  return (
    <div className="wi p-6 space-y-6" data-theme={theme}>
      <header className="wi-hero">
        <div>
          <h1>Inbox</h1>
          <p>Work items you can see, and anything waiting for your approval</p>
        </div>
        {data && (
          <div className="wi-stats">
            <div className="wi-stat">
              <strong>{data.total}</strong>
              <span>Matching</span>
            </div>
            <div className="wi-stat">
              <strong>{data.waitingOnMe.length}</strong>
              <span>Awaiting my approval</span>
            </div>
          </div>
        )}
      </header>

      {!recordsAvailable ? (
        <p className="fb-muted">
          Records are kept by the server. This app is running on local storage
          only.
        </p>
      ) : (
        <>
          <div className="wi-toolbar">
            <ViewsBar
              admin={admin}
              filters={filters}
              onPick={(f) => setFilters({ ...f, page: 1 })}
            />
            <div className="wi-tools">
              <div className="wi-seg" role="group" aria-label="Layout">
                {LAYOUTS.map((l) => (
                  <button
                    key={l}
                    type="button"
                    aria-pressed={layout === l}
                    onClick={() => setLayout(l)}
                  >
                    {l === "table" ? (
                      <List size={14} />
                    ) : (
                      <LayoutGrid size={14} />
                    )}
                    {l === "table" ? "Table" : "Cards"}
                  </button>
                ))}
              </div>
              {admin && (
                <div
                  className="wi-swatches"
                  role="group"
                  aria-label="Theme"
                  title="Inbox theme for everyone"
                >
                  <Palette size={14} aria-hidden />
                  {INBOX_THEMES.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      className="wi-swatch"
                      style={{ background: t.swatch }}
                      title={t.label}
                      aria-label={`${t.label} theme`}
                      aria-pressed={theme === t.key}
                      disabled={saveSettings.isPending}
                      onClick={() => setTheme(t.key)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="wi-filters space-y-3">
            <div className="fb-filters" role="search">
              <ChoiceSelect<Assignee>
                ariaLabel="Assigned to"
                value={filters.waiting ? "waiting" : filters.assignee || ALL}
                options={[
                  { label: "Assigned to me", value: "me" },
                  { label: "Waiting for my approval", value: "waiting" },
                  { label: admin ? "Unassigned" : "My team's queue", value: "unassigned" as const },
                  { label: "Held by my team", value: "reports" as const },
                  { label: "Everyone", value: ALL },
                ]}
                onChange={(v) =>
                  set(
                    v === "waiting"
                      ? { waiting: true, assignee: "" }
                      : { waiting: false, assignee: v === ALL ? "" : v },
                  )
                }
              />
              <ChoiceSelect
                ariaLabel="Form"
                value={filters.formCode ?? ALL}
                options={[
                  { label: "All forms", value: ALL },
                  ...tracked.map((f) => ({ label: f.name, value: f.code })),
                ]}
                onChange={(v) =>
                  set({
                    formCode: v === ALL ? undefined : v,
                    status: undefined,
                    ff: undefined,
                  })
                }
              />
              {statusChoices.length > 0 && (
                <ChoiceSelect
                  ariaLabel="Status"
                  value={filters.status ?? ALL}
                  options={[
                    { label: "Any status", value: ALL },
                    ...statusChoices.map((s) => ({
                      label: s.label,
                      value: s.key,
                    })),
                  ]}
                  onChange={(v) => set({ status: v === ALL ? undefined : v })}
                />
              )}
              <ChoiceSelect<Priority | typeof ALL>
                ariaLabel="Priority"
                value={filters.priority ?? ALL}
                options={[
                  { label: "Any priority", value: ALL },
                  ...PRIORITIES.map((p) => ({
                    label: PRIORITY_LABEL[p],
                    value: p,
                  })),
                ]}
                onChange={(v) => set({ priority: v === ALL ? undefined : v })}
              />
              <ChoiceSelect<"all" | "overdue">
                ariaLabel="Due"
                value={filters.overdue ? "overdue" : "all"}
                options={[
                  { label: "Any due date", value: "all" },
                  { label: "Overdue only", value: "overdue" },
                ]}
                onChange={(v) => set({ overdue: v === "overdue" })}
              />
              <ChoiceSelect<InboxSort>
                ariaLabel="Sort"
                value={filters.sort ?? "newest"}
                options={[
                  { label: "Newest first", value: "newest" },
                  { label: "Oldest first", value: "oldest" },
                  { label: "Due soonest", value: "due" },
                  { label: "Highest priority", value: "priority" },
                ]}
                onChange={(sort) => set({ sort })}
              />
              <Input
                aria-label="Search"
                placeholder="Reference or text in the answers…"
                value={filters.q ?? ""}
                maxLength={60}
                onChange={(e) => set({ q: e.target.value })}
              />
            </div>
            {selectedForm && (
              <FieldFilters
                form={selectedForm}
                value={filters.ff ?? []}
                onChange={(ff) => set({ ff: ff.length ? ff : undefined })}
              />
            )}
          </div>

          <InboxItems
            layout={layout}
            data={data}
            loading={isLoading}
            summary={summary}
            onOpen={(id) => onOpenRecord(id)}
            emptyText={
              filters.waiting
                ? "Nothing is waiting for your approval."
                : filters.assignee === "reports"
                  ? "Nobody you manage holds any open work. (Managers are set on the Members page.)"
                  : filters.assignee === "unassigned" && !admin
                    ? "Nothing is waiting in your team's queue."
                    : filters.assignee === "me"
                  ? "Nothing assigned to you."
                  : "No records."
            }
          />
          {data && data.total > INBOX_PAGE_SIZE && (
            <div className="flex items-center justify-end gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={filters.page <= 1}
                onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}
              >
                Previous
              </Button>
              <span className="fb-muted">
                Page {filters.page} of {Math.ceil(data.total / INBOX_PAGE_SIZE)}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={filters.page * INBOX_PAGE_SIZE >= data.total}
                onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}

      <RecordDrawer
        recordId={recordId}
        onClose={() => onOpenRecord(undefined)}
      />
    </div>
  );
}
