import { useState } from "react";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { Button } from "@ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@ui/sheet";
import { Textarea } from "@ui/textarea";
import type { FormDefinition, Priority, WorkflowStatus } from "../types";
import { PRIORITIES } from "../types";
import { ChoiceSelect } from "../builder/components/settings";
import { ActionBar } from "./work/ActionBar";
import { WorkFieldsSection } from "./work/WorkFieldsSection";
import { SlaSummary } from "./work/SlaSummary";
import { EmailComposer } from "./work/EmailComposer";
import { ReopenBox } from "./work/ReopenBox";
import {
  answerText as fieldAnswerText,
  findStatus,
  isSignature,
  answerFields as topAnswerFields,
  formShape,
  plainAnswer,
  rowsOf,
  valuesFromPayload,
  workflowOf,
} from "../engine";
import { messageOf } from "../adapters/backend";
import {
  usePeople,
  useRecord,
  isGone,
  useRecordAction,
  type Person,
  type RecordApproval,
  type RecordEvent,
} from "../adapters/workflow";
import { PersonSelect } from "../builder/workflow/PersonSelect";
import { VISIBLE_BORDER } from "../runtime/styles";

interface RecordDrawerProps {
  recordId: string | undefined;
  onClose: () => void;
}

export function StatusPill({ status }: { status: WorkflowStatus | undefined }) {
  if (!status) return null;
  return (
    <span className={`fb-status fb-status--${status.category}`}>
      {status.label}
    </span>
  );
}

export const displayAnswer = (value: unknown): string => plainAnswer(value) || "—";

/** Option values -> their labels, so the answers read like the form. */
export function answerText(def: FormDefinition, name: string, value: unknown): string {
  return fieldAnswerText(def.fields.find((x) => x.name === name), value) || "—";
}

/** A repeating section's rows, one line each, under the labels people saw. */
function RowsTable({ def, repeat, rows }: { def: FormDefinition; repeat: FormDefinition["fields"][number]; rows: Record<string, unknown>[] }) {
  const columns = (formShape(def.fields).repeats.find((r) => r.field.id === repeat.id)?.valueChildren ?? []).filter((c) => rows.some((row) => plainAnswer(row[c.name]) !== ""));
  if (!rows.length || !columns.length) return <>—</>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="fb-rows-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.id} scope="col">
                {c.label || c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c.id}>{fieldAnswerText(c, row[c.name]) || "—"}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const PRIORITY_LABEL: Record<Priority, string> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High", CRITICAL: "Critical" };
const SOURCE_LABEL: Record<string, string> = { PUBLIC_FORM: "public form", PORTAL: "the Work portal", MODULE: "another app", API: "the API" };
const fieldValue = (v: unknown) =>
  v === null || v === undefined || v === "" ? "(empty)" : typeof v === "boolean" ? (v ? "Yes" : "No") : Array.isArray(v) ? v.join(", ") : String(v);

function describe(
  e: RecordEvent,
  def: FormDefinition,
  people: Record<string, Person>,
): string {
  const who = (id: unknown) =>
    typeof id === "string" && id
      ? (people[id]?.name ?? "Unknown user")
      : "no one";
  const status = (key: unknown) =>
    findStatus(workflowOf(def), String(key))?.label ?? String(key);
  switch (e.type) {
    case "CREATED":
      return e.message || "Submitted";
    case "STATUS":
      return `${typeof e.data.actionLabel === "string" ? `${e.data.actionLabel}: ` : ""}moved from ${status(e.data.from)} to ${status(e.data.to)}${e.message ? ` - "${e.message}"` : ""}`;
    case "PRIORITY":
      return `Priority changed from ${PRIORITY_LABEL[e.data.from as Priority] ?? e.data.from} to ${PRIORITY_LABEL[e.data.to as Priority] ?? e.data.to}`;
    case "FIELD_UPDATE":
      return ((e.data.changes as { label: string; from: unknown; to: unknown }[]) ?? [])
        .map((c) => `${c.label}: ${fieldValue(c.from)} → ${fieldValue(c.to)}`)
        .join("\n");
    case "ASSIGNED":
      return `Assigned to ${who(e.data.to)}`;
    case "SLA":
      return e.data.kind === "RESPONSE"
        ? "First response time missed"
        : e.data.kind === "RESOLUTION"
          ? "Resolution time missed"
          : e.data.kind === "APPROACHING"
            ? "Resolution time almost up"
            : `Overdue in ${status(e.data.status)}`;
    case "ESCALATED":
      return e.message;
    case "REOPENED":
      return `Reopened (${String(e.data.count ?? 1)}) into ${status(e.data.to)}${e.message ? ` - "${e.message}"` : ""}`;
    case "APPROVAL":
      return e.data.phase === "decided"
        ? `${String(e.data.actionLabel)}: ${e.data.decision === "APPROVED" ? "approved" : "rejected"}${e.message ? ` - "${e.message}"` : ""}`
        : `${String(e.data.actionLabel)}: approval requested from ${((e.data.approvers as string[]) ?? []).map(who).join(", ")}${e.message ? ` - "${e.message}"` : ""}`;
    case "EMAIL":
      return `Emailed ${String(e.data.to)}: "${String(e.data.subject)}"${e.data.requestInfo ? " (information requested)" : ""}\n${String(e.data.body ?? "")}`;
    default:
      return e.message;
  }
}

type TimelineItem =
  | { kind: "event"; event: RecordEvent }
  | { kind: "run"; runId: string; events: RecordEvent[] };

/** Automation steps of one run are shown together, as a small flow (like an AEM workflow instance). */
function groupRuns(events: RecordEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const runs = new Map<string, RecordEvent[]>();
  for (const e of events) {
    const runId =
      e.type === "AUTOMATION" && typeof e.data.runId === "string"
        ? e.data.runId
        : undefined;
    if (!runId) {
      items.push({ kind: "event", event: e });
      continue;
    }
    const existing = runs.get(runId);
    if (existing) existing.push(e);
    else {
      const list = [e];
      runs.set(runId, list);
      items.push({ kind: "run", runId, events: list });
    }
  }
  return items;
}

function RunItem({
  events,
  def,
}: {
  events: RecordEvent[];
  def: FormDefinition;
}) {
  const automation = def.automations?.find(
    (a) => a.id === events[0].data.automationId,
  );
  const name = automation?.name ?? events[0].message.split(":")[0];
  const failed = events.some((e) => e.data.ok === false);
  const stepText = (e: RecordEvent) =>
    e.message.slice(e.message.indexOf(":") + 1).trim();
  return (
    <li className={failed ? "fb-timeline__failed" : undefined}>
      <div>
        <strong>{name}</strong>{" "}
        {failed ? "- stopped or had a failed step" : "- ran"}
      </div>
      <ol className="fb-run">
        {events.map((e) => (
          <li
            key={e.uuid}
            className={
              e.data.ok === false
                ? "fb-run__step fb-run__step--failed"
                : e.data.skipped
                  ? "fb-run__step fb-run__step--skipped"
                  : "fb-run__step"
            }
          >
            <span aria-hidden>
              {e.data.ok === false ? "✗" : e.data.skipped ? "↷" : "✓"}
            </span>
            {typeof e.data.stepIndex === "number" && !e.data.stopped
              ? `${e.data.stepIndex + 1}. `
              : ""}
            {stepText(e)}
          </li>
        ))}
      </ol>
      <div className="fb-timeline__meta">
        Automation · {format(new Date(events[0].createdAt), "dd MMM, HH:mm")}
      </div>
    </li>
  );
}

function EventItem({
  event: e,
  def,
  people,
}: {
  event: RecordEvent;
  def: FormDefinition;
  people: Record<string, Person>;
}) {
  return (
    <li
      className={
        e.type === "AUTOMATION" && e.data.ok === false
          ? "fb-timeline__failed"
          : undefined
      }
    >
      <div style={{ whiteSpace: "pre-wrap" }}>{describe(e, def, people)}</div>
      <div className="fb-timeline__meta">
        {e.by
          ? (people[e.by]?.name ?? "Unknown user")
          : e.type === "AUTOMATION" || e.type === "SLA"
            ? "Automation"
            : "System"}{" "}
        · {format(new Date(e.createdAt), "dd MMM, HH:mm")}
      </div>
    </li>
  );
}

/** A flow waiting at (or past) an approval step: decide here, or see who's deciding / who decided. */
function ApprovalCard({
  approval: a,
  people,
  busy,
  onDecide,
}: {
  approval: RecordApproval;
  people: Record<string, Person>;
  busy: boolean;
  onDecide: (
    decision: "APPROVED" | "REJECTED",
    comment: string,
  ) => Promise<boolean>;
}) {
  const [note, setNote] = useState("");
  const name = (id: string) => people[id]?.name ?? "Unknown user";
  const overdue =
    a.status === "WAITING" && !!a.dueAt && new Date(a.dueAt) < new Date();
  return (
    <div className="fb-panel fb-settings fb-approval" style={{ gap: 8 }}>
      <div className="fb-panel__title">
        {a.status === "WAITING" ? "Approval needed" : "Approval"}
      </div>
      <strong>{a.title}</strong>
      {a.instructions && (
        <p className="text-sm" style={{ whiteSpace: "pre-wrap" }}>
          {a.instructions}
        </p>
      )}
      {a.status === "WAITING" ? (
        <>
          <span className="fb-muted">
            Waiting for {a.approvers.map(name).join(", ")}
            {a.dueAt && (
              <span className={overdue ? "fb-overdue" : undefined}>
                {" "}
                · due {format(new Date(a.dueAt), "dd MMM, HH:mm")}
              </span>
            )}
          </span>
          {a.canDecide && (
            <>
              <Textarea
                className={VISIBLE_BORDER}
                rows={2}
                maxLength={2000}
                value={note}
                aria-label="Approval comment"
                placeholder="Comment (optional)"
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => void onDecide("APPROVED", note.trim())}
                >
                  Approve
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void onDecide("REJECTED", note.trim())}
                >
                  Reject
                </Button>
              </div>
            </>
          )}
        </>
      ) : (
        <span className={a.decision === "REJECTED" ? "fb-overdue" : "text-sm"}>
          {a.decision === "APPROVED"
            ? "Approved"
            : a.decision === "REJECTED"
              ? "Rejected"
              : "Closed"}
          {a.decidedBy ? ` by ${name(a.decidedBy)}` : ""}
          {a.decidedAt
            ? ` · ${format(new Date(a.decidedAt), "dd MMM, HH:mm")}`
            : ""}
          {a.comment ? ` - "${a.comment}"` : ""}
        </span>
      )}
    </div>
  );
}

/** One record: answers, what can be done with it, and everything that happened to it. */
export function RecordDrawer({ recordId, onClose }: RecordDrawerProps) {
  const { data, isLoading } = useRecord(recordId);
  const { data: people = [] } = usePeople(!!recordId, data?.record.formCode);
  const act = useRecordAction(recordId);
  const [comment, setComment] = useState("");

  /** Every change goes through here: when it took the item away from me (reassigned, approval decided), close it. */
  const perform = async (action: Parameters<typeof act.mutateAsync>[0]) => {
    const detail = await act.mutateAsync(action);
    if (isGone(detail)) {
      toast.info("Done - this item is no longer with you");
      onClose();
    }
    return detail;
  };

  const run = async (
    action: Parameters<typeof act.mutateAsync>[0],
    done: string,
  ) => {
    try {
      await perform(action);
      toast.success(done);
      return true;
    } catch (e) {
      toast.error(messageOf(e));
      return false;
    }
  };

  const def = data?.definition;
  const record = data?.record;
  const wf = def ? workflowOf(def) : undefined;
  const values = def && record ? valuesFromPayload(def, record.payload) : {};
  const fields = def
    ? topAnswerFields(def.fields).filter(
        (f) => f.type !== "HIDDEN" && f.type !== "CAPTCHA",
      )
    : [];
  const overdue = !!record?.dueAt && new Date(record.dueAt) < new Date();

  return (
    <Sheet open={!!recordId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        style={{
          width: "min(640px, 100vw)",
          maxWidth: "100vw",
          overflowY: "auto",
          padding: 24,
        }}
      >
        <SheetTitle>
          {record
            ? [record.ref, def?.name ?? record.formCode]
                .filter(Boolean)
                .join(" · ")
            : "Record"}
        </SheetTitle>
        <SheetDescription>
          {record
            ? `Raised ${format(new Date(record.createdAt), "dd MMM yyyy, HH:mm")} from ${SOURCE_LABEL[record.source] ?? record.channel}`
            : " "}
        </SheetDescription>

        {isLoading && <p className="fb-muted">Loading…</p>}
        {data && def && record && wf && (
          <div className="fb-settings" style={{ gap: 20, marginTop: 16 }}>
            {data.approvals.length > 0 && (
              <section
                className="fb-settings"
                style={{ gap: 10 }}
                aria-label="Approvals"
              >
                {data.approvals.map((a) => (
                  <ApprovalCard
                    key={a.runId}
                    approval={a}
                    people={data.people}
                    busy={act.isPending}
                    onDecide={(decision, note) =>
                      run(
                        {
                          kind: "decide",
                          runId: a.runId,
                          decision,
                          comment: note,
                        },
                        decision === "APPROVED" ? "Approved" : "Rejected",
                      )
                    }
                  />
                ))}
              </section>
            )}

            {def.workflow?.enabled && (
              <section
                className="fb-settings"
                style={{ gap: 10 }}
                aria-label="Status and owner"
              >
                <div
                  className="flex items-center gap-2"
                  style={{ flexWrap: "wrap" }}
                >
                  <StatusPill status={findStatus(wf, record.status)} />
                  <span className={`fb-priority fb-priority--${record.priority}`}>{PRIORITY_LABEL[record.priority] ?? record.priority}</span>
                  {record.dueAt && (
                    <span
                      className={overdue ? "fb-overdue text-sm" : "fb-muted"}
                    >
                      {overdue ? "Overdue by " : "Due in "}
                      {formatDistanceToNow(new Date(record.dueAt))}
                    </span>
                  )}
                </div>
                <SlaSummary record={record} />
                {data.canReopen && (
                  <ReopenBox
                    busy={act.isPending}
                    onReopen={async (comment) => {
                      await perform({ kind: "reopen", comment });
                      toast.success("Reopened");
                    }}
                  />
                )}
                <ActionBar
                  // While an action waits for approval, no other move can be made.
                  actions={data.approvals.some((a) => a.kind === "ACTION" && a.status === "WAITING") ? [] : data.actions}
                  busy={act.isPending}
                  onAct={async (key, note) => {
                    await perform({ kind: "act", key, comment: note });
                    toast.success(data.actions.find((a) => a.key === key)?.label ?? "Done");
                  }}
                />
                {data.next.length > 0 && (
                  <div
                    className="flex items-center gap-2"
                    style={{ flexWrap: "wrap" }}
                  >
                    <span className="text-sm">Move to:</span>
                    {data.next.map((s) => (
                      <Button
                        key={s.key}
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={act.isPending}
                        onClick={() =>
                          run(
                            { kind: "status", to: s.key },
                            `Moved to ${s.label}`,
                          )
                        }
                      >
                        {s.label}
                      </Button>
                    ))}
                  </div>
                )}
                <EmailComposer
                  to={data.contactEmail}
                  templates={def.workflow?.emailTemplates ?? []}
                  requestInfoLabel={def.workflow?.requestInfoStatus && def.workflow.requestInfoStatus !== record.status ? findStatus(wf, def.workflow.requestInfoStatus)?.label : undefined}
                  busy={act.isPending}
                  onSend={async (mail) => {
                    await perform({ kind: "email", ...mail });
                    toast.success("Email sent");
                  }}
                />
                <div className="fb-setting">
                  <span className="fb-setting__label">Priority</span>
                  <ChoiceSelect<Priority>
                    ariaLabel="Priority"
                    value={record.priority}
                    disabled={act.isPending}
                    options={PRIORITIES.map((p) => ({ label: PRIORITY_LABEL[p], value: p }))}
                    onChange={(priority) => void run({ kind: "priority", priority }, `Priority: ${PRIORITY_LABEL[priority]}`)}
                  />
                </div>
                <div className="fb-setting">
                  <span className="fb-setting__label">Assigned to</span>
                  <PersonSelect
                    people={people}
                    value={record.assigneeId}
                    placeholder="No one"
                    disabled={act.isPending}
                    onChange={(userId) =>
                      void run(
                        { kind: "assign", userId },
                        userId ? "Assigned" : "Unassigned",
                      )
                    }
                  />
                </div>
              </section>
            )}

            {!!def.workflow?.enabled && !!def.workflow.workFields?.length && (
              <section aria-label="Work details">
                <div className="fb-panel__title">Work details</div>
                <WorkFieldsSection
                  key={`${record.uuid}:${JSON.stringify(record.work ?? {})}`}
                  definition={def}
                  work={record.work ?? {}}
                  readOnly={findStatus(wf, record.status)?.category === "DONE"}
                  onSave={async (values) => {
                    await perform({ kind: "work", values });
                    toast.success("Saved");
                  }}
                />
              </section>
            )}

            <section aria-label="Answers">
              <div className="fb-panel__title">Answers</div>
              <dl className="fb-answers">
                {fields.map((f) => (
                  <div key={f.id} style={{ display: "contents" }}>
                    <dt>{f.label || f.name}</dt>
                    <dd>
                      {f.type === "SIGNATURE" && isSignature(values[f.name]) ? (
                        // Checked to be a PNG data URL, so it is safe as an image source.
                        <img src={values[f.name] as string} alt={`${f.label || f.name}, signed`} style={{ maxWidth: 240, border: "1px solid var(--border)", borderRadius: 6, background: "#fff" }} />
                      ) : f.type === "REPEAT" ? (
                        <RowsTable def={def} repeat={f} rows={rowsOf(values[f.name])} />
                      ) : f.type === "FILE" ? (
                        displayAnswer(values[f.name])
                      ) : (
                        answerText(def, f.name, values[f.name])
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>

            <section
              className="fb-settings"
              style={{ gap: 8 }}
              aria-label="Comment"
            >
              <div className="fb-panel__title">Add a comment</div>
              <Textarea
                className={VISIBLE_BORDER}
                rows={3}
                maxLength={2000}
                value={comment}
                aria-label="Comment"
                onChange={(e) => setComment(e.target.value)}
              />
              <Button
                type="button"
                size="sm"
                style={{ alignSelf: "flex-start" }}
                disabled={!comment.trim() || act.isPending}
                onClick={async () => {
                  if (
                    await run(
                      { kind: "comment", message: comment.trim() },
                      "Comment added",
                    )
                  )
                    setComment("");
                }}
              >
                Comment
              </Button>
            </section>

            <section aria-label="Timeline">
              <div className="fb-panel__title">Timeline</div>
              <ol className="fb-timeline">
                {groupRuns(data.events)
                  .reverse()
                  .map((item) =>
                    item.kind === "run" ? (
                      <RunItem
                        key={item.runId}
                        events={item.events}
                        def={def}
                      />
                    ) : (
                      <EventItem
                        key={item.event.uuid}
                        event={item.event}
                        def={def}
                        people={data.people}
                      />
                    ),
                  )}
              </ol>
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
