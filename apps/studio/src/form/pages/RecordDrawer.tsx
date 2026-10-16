import { useState } from "react";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { Button } from "@ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/tabs";
import { Textarea } from "@ui/textarea";
import type { FormDefinition, Priority, WorkflowStatus } from "../types";
import { PRIORITIES } from "../types";
import { ChoiceSelect } from "../builder/components/settings";
import { ActionBar } from "./work/ActionBar";
import { WorkFieldsSection } from "./work/WorkFieldsSection";
import { SlaSummary } from "./work/SlaSummary";
import { EmailComposer } from "./work/EmailComposer";
import { ReopenBox } from "./work/ReopenBox";
import { SignaturesSection } from "./work/SignaturesSection";
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
  type RecordAsk,
  type RecordFile,
  recordFileLink,
  STAFF_FILE,
  useAddRecordFile,
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
      return `Assigned to ${who(e.data.to)}${e.data.insteadOf ? ` (${who(e.data.insteadOf)} is away)` : ""}${e.message && e.message !== "Assigned by the form's rule" ? ` - "${e.message}"` : ""}`;
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
    case "FILE":
      return `Added a file: ${e.message}`;
    case "ASK":
      return e.data.phase === "answered" ? `Answered ${who(e.data.askedBy)}: "${e.message}"` : `Asked ${who(e.data.to)} for their view: "${e.message}"`;
    case "APPROVAL":
      if (e.data.phase === "part")
        return `${String(e.data.title ?? "Approval")}: ${e.data.decision === "APPROVED" ? "approved" : "rejected"}${e.message ? ` - "${e.message}"` : ""}`;
      if (e.data.phase === "approved-by-one")
        return `${String(e.data.title ?? "Approval")}: approved, still waiting for ${((e.data.waitingFor as string[]) ?? []).map(who).join(", ")}${e.message ? ` - "${e.message}"` : ""}`;
      if (e.data.phase === "late")
        return `${String(e.data.title ?? "Approval")}: no answer in time - ${
          e.data.did === "REJECT"
            ? "treated as rejected"
            : e.data.did === "MANAGER"
              ? `passed to ${((e.data.approvers as string[]) ?? []).map(who).join(", ")}`
              : `reminded ${((e.data.approvers as string[]) ?? []).map(who).join(", ")}`
        }`;
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
  onRunAgain,
  busy,
}: {
  events: RecordEvent[];
  def: FormDefinition;
  /** Offered to a Forms admin when the flow's last word is that it stopped on a failed step. */
  onRunAgain?: () => void;
  busy?: boolean;
}) {
  const automation = def.automations?.find(
    (a) => a.id === events[0].data.automationId,
  );
  const name = automation?.name ?? events[0].message.split(":")[0];
  const failed = events.some((e) => e.data.ok === false);
  const stepText = (e: RecordEvent) =>
    e.message.slice(e.message.indexOf(":") + 1).trim();
  const last = events[events.length - 1];
  const stoppedAt =
    last.data.stopped && typeof last.data.stepIndex === "number"
      ? last.data.stepIndex + 1
      : undefined;
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
      {stoppedAt !== undefined && onRunAgain && (
        <div>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onRunAgain}>
            Run again from step {stoppedAt}
          </Button>
        </div>
      )}
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
            Waiting for{" "}
            {a.approvers
              .filter((id) => !(a.approved ?? []).includes(id))
              .map(name)
              .join(a.need === "ALL" ? " and " : ", ")}
            {a.need === "ALL" && ` · everyone must approve (${(a.approved ?? []).length} of ${a.approvers.length} so far)`}
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
/**
 * A colleague and a few words: used to hand the record over with a note, and to ask someone's view without
 * giving it away. Closed, it is one quiet link; open, a dropdown, a box and two buttons.
 */
function ColleagueNote({ people, busy, open: openLabel, group, pick, note: noteLabel, hint, send, needNote, onSend }: { people: Person[]; busy: boolean; open: string; group: string; pick: string; note: string; hint: string; send: string; needNote?: boolean; onSend: (userId: string, note: string) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  if (!open)
    return (
      <Button type="button" variant="link" size="sm" className="fb-handover__open" onClick={() => setOpen(true)}>
        {openLabel}
      </Button>
    );
  return (
    <div className="fb-handover" role="group" aria-label={group}>
      <ChoiceSelect<string> ariaLabel={pick} value={to} placeholder="Choose a colleague" disabled={busy} options={people.map((p) => ({ label: p.name || p.email, value: p.uuid }))} onChange={setTo} />
      <Textarea className={VISIBLE_BORDER} rows={2} maxLength={2000} value={note} aria-label={noteLabel} placeholder={hint} onChange={(e) => setNote(e.target.value)} />
      <div className="fb-handover__buttons">
        <Button
          type="button"
          size="sm"
          disabled={busy || !to || (needNote && !note.trim())}
          onClick={async () => {
            await onSend(to, note.trim());
            setOpen(false);
            setTo("");
            setNote("");
          }}
        >
          {send}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

const sizeOf = (bytes: number) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * Everything attached to the record: what the respondent sent with the form, and what staff have added while
 * working it. Any of them can be downloaded; staff add more with one button.
 */
function RecordFiles({ recordId, files, def, people }: { recordId: string; files: RecordFile[]; def: FormDefinition; people: Record<string, Person> }) {
  const add = useAddRecordFile(recordId);
  const from = (f: RecordFile) =>
    f.fieldName === STAFF_FILE
      ? `Added by ${people[f.addedBy ?? ""]?.name ?? "staff"}${f.addedAt ? ` on ${format(new Date(f.addedAt), "dd MMM yyyy")}` : ""}`
      : `Sent with the form: ${def.fields.find((x) => x.name === f.fieldName)?.label || f.fieldName}`;
  const download = async (f: RecordFile) => {
    try {
      window.open(await recordFileLink(recordId, f.uploadId), "_blank", "noopener");
    } catch (e) {
      toast.error(messageOf(e));
    }
  };
  return (
    <section aria-label="Files" className="fb-settings" style={{ gap: 10 }}>
      {files.length === 0 ? (
        <p className="fb-muted">No files yet.</p>
      ) : (
        <ul className="fb-files">
          {files.map((f) => (
            <li key={f.uploadId}>
              <span className="fb-files__name">
                <strong>{f.name}</strong>
                <span className="fb-muted">
                  {sizeOf(f.size)} · {from(f)}
                </span>
              </span>
              <Button type="button" size="sm" variant="outline" aria-label={`Download ${f.name}`} onClick={() => void download(f)}>
                Download
              </Button>
            </li>
          ))}
        </ul>
      )}
      <label className="fb-files__add">
        <input
          type="file"
          aria-label="Add a file"
          disabled={add.isPending}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) add.mutate(file, { onSuccess: () => toast.success("File added"), onError: (err) => toast.error(messageOf(err)) });
          }}
        />
        <span className="fb-muted">{add.isPending ? "Checking the file…" : "PDFs, pictures and office documents. Each file is checked before it is added."}</span>
      </label>
    </section>
  );
}

/** Someone asked for this person's view: the question, and a box for the answer. */
function AskedOfMe({ ask, who, busy, onAnswer }: { ask: RecordAsk; who: string; busy: boolean; onAnswer: (answer: string) => Promise<unknown> }) {
  const [answer, setAnswer] = useState("");
  return (
    <div className="fb-panel fb-settings fb-approval" style={{ gap: 8 }} role="group" aria-label="Your view is asked">
      <div className="fb-panel__title">{who} asks for your view</div>
      <p className="text-sm" style={{ whiteSpace: "pre-wrap" }}>
        {ask.question}
      </p>
      <Textarea className={VISIBLE_BORDER} rows={3} maxLength={2000} value={answer} aria-label="Your answer" placeholder="Your answer goes back to them; the record stays where it is" onChange={(e) => setAnswer(e.target.value)} />
      <div>
        <Button type="button" size="sm" disabled={busy || !answer.trim()} onClick={() => void onAnswer(answer.trim())}>
          Send answer
        </Button>
      </div>
    </div>
  );
}

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

  const hasWorkFields = !!def?.workflow?.enabled && !!def.workflow.workFields?.length;
  return (
    <Dialog open={!!recordId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="fb-record__dialog">
        <DialogTitle>
          {record
            ? [record.ref, def?.name ?? record.formCode]
                .filter(Boolean)
                .join(" · ")
            : "Record"}
        </DialogTitle>
        <DialogDescription>
          {record
            ? `Raised ${format(new Date(record.createdAt), "dd MMM yyyy, HH:mm")} from ${SOURCE_LABEL[record.source] ?? record.channel}`
            : " "}
        </DialogDescription>

        {isLoading && <p className="fb-muted">Loading…</p>}
        {data && def && record && wf && (
          <div className="fb-record">
            <Tabs defaultValue="answers" className="fb-record__main">
              <TabsList>
                <TabsTrigger value="answers">Answers</TabsTrigger>
                {hasWorkFields && <TabsTrigger value="work">Work details</TabsTrigger>}
                <TabsTrigger value="files">Files{(record.files ?? []).length ? ` (${record.files!.length})` : ""}</TabsTrigger>
                <TabsTrigger value="history">History</TabsTrigger>
              </TabsList>
              {/* Every tab stays in the page (only one is shown), so nothing typed in one is lost by looking at another. */}
              <TabsContent value="answers" forceMount className="fb-record__tab fb-settings">
            {data.askedOfMe && (
              <AskedOfMe
                ask={data.askedOfMe}
                who={data.people[data.askedOfMe.by]?.name ?? "A colleague"}
                busy={act.isPending}
                onAnswer={(answer) => run({ kind: "answer", answer }, "Answer sent")}
              />
            )}
            {data.approvals.length > 0 && (
              <section
                className="fb-settings"
                style={{ gap: 10 }}
                aria-label="Approvals"
              >
                {/* A step that asks several at once shows each of them; the step itself is answered by nobody. */}
                {data.approvals.filter((a) => !a.parts || a.status !== "WAITING").map((a) => (
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

            <SignaturesSection recordId={recordId} reference={record.ref} />

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

              </TabsContent>
              {hasWorkFields && (
                <TabsContent value="work" forceMount className="fb-record__tab fb-settings">
            {!!def.workflow?.enabled && !!def.workflow.workFields?.length && (
              <section>
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

                </TabsContent>
              )}
              <TabsContent value="files" forceMount className="fb-record__tab fb-settings">
                <RecordFiles recordId={record.uuid} files={record.files ?? []} def={def} people={data.people} />
              </TabsContent>
              <TabsContent value="history" forceMount className="fb-record__tab fb-settings">
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
                        busy={act.isPending}
                        onRunAgain={
                          data.canRunAgain
                            ? () => void run({ kind: "again", runId: item.runId }, "Running again - the timeline shows how it goes")
                            : undefined
                        }
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
              </TabsContent>
            </Tabs>
            <aside className="fb-record__side fb-settings" aria-label="Status and actions">
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
                  {data.canTake && (
                    <Button type="button" size="sm" className="fb-handover__take" disabled={act.isPending} onClick={() => void run({ kind: "take" }, "It's yours")}>
                      Take it
                    </Button>
                  )}
                  {data.canSendBack && (
                    <Button type="button" size="sm" variant="outline" className="fb-handover__take" disabled={act.isPending} onClick={() => void run({ kind: "send-back" }, "Sent back")}>
                      Send it back to {data.people[record.handedOverBy ?? ""]?.name ?? "whoever handed it over"}
                    </Button>
                  )}
                  <ColleagueNote
                    people={people.filter((p) => p.uuid !== record.assigneeId)}
                    busy={act.isPending}
                    open="Hand over with a note"
                    group="Hand over"
                    pick="Hand over to"
                    note="Note for them"
                    hint="What they need to know"
                    send="Hand over"
                    onSend={(userId, note) => run({ kind: "assign", userId, note }, "Handed over")}
                  />
                  <ColleagueNote
                    people={people.filter((p) => p.uuid !== record.assigneeId)}
                    busy={act.isPending}
                    open="Ask a colleague"
                    group="Ask a colleague"
                    pick="Ask"
                    note="Your question"
                    hint="They can see the record and answer; it stays with its owner"
                    send="Ask"
                    needNote
                    onSend={(userId, question) => run({ kind: "ask", userId, question }, "Asked")}
                  />
                  {(record.asks ?? []).filter((a) => !a.answeredAt).map((a) => (
                    <span key={a.id} className="fb-muted">
                      Waiting for {data.people[a.to]?.name ?? "a colleague"}&apos;s view
                    </span>
                  ))}
                </div>
              </section>
            )}

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
            {data.canRunAgain && (
              <section aria-label="Keeping" className="fb-settings" style={{ gap: 6 }}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!!record.held}
                    disabled={act.isPending}
                    onChange={(e) =>
                      void run(
                        { kind: "hold", held: e.target.checked },
                        e.target.checked ? "Kept past the retention" : "Let go: deleted with the rest when its time comes",
                      )
                    }
                  />
                  Keep this record
                </label>
                <span className="fb-muted text-sm">
                  Not deleted when your organisation's retention passes, for example while it is disputed.
                </span>
              </section>
            )}
            </aside>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
