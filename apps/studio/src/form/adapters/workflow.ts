import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FormDefinition, FormValues, Priority, WorkflowAction, WorkItemSource, WorkflowStatus, WorkingCalendar } from '../types';
import { adminApi, fieldErrorsOf, messageOf, unwrap, USE_API } from './backend';
import { uploadFile, type SubmissionAdapter } from './submission/submission-adapter';

/**
 * Records (submissions of forms with a workflow), the people they can be
 * assigned to, and the custom workflow APIs the server offers. All of this
 * lives on the server; with the local backend the builder still works and
 * the inbox explains that it needs the API.
 */
export const recordsAvailable = USE_API;

export interface Person {
  uuid: string;
  name: string;
  email: string;
  department?: string;
}

/** A flow paused at a "wait for approval" step (or one that was decided). */
export interface RecordApproval {
  runId: string;
  /** FLOW = an automation's approval step; ACTION = a named action waiting for approval. */
  kind?: 'FLOW' | 'ACTION';
  status: 'WAITING' | 'RUNNING' | 'DONE' | 'STOPPED';
  stepKey: string;
  title: string;
  instructions: string;
  approvers: string[];
  requestedAt: string;
  dueAt: string | null;
  /** ALL = every approver must approve; `approved` are the ones who have so far. */
  need?: 'ANY' | 'ALL';
  approved?: string[];
  /** Set on a step that asks several approvals at once: how many. Each is listed as its own approval. */
  parts?: number;
  decision: 'APPROVED' | 'REJECTED' | null;
  decidedBy: string;
  comment: string;
  decidedAt: string | null;
  /** The signed-in user may approve / reject it now. */
  canDecide: boolean;
}

export interface CustomWorkflow {
  key: string;
  label: string;
  description?: string;
  /** Fields its output has - offered to later steps as {{$steps.<step>.<field>}}. */
  outputs?: string[];
  /** For a step that writes to another system: the fields it fills. */
  inputs?: string[];
}

export interface RecordRow {
  uuid: string;
  /** Who held it before it was handed to the present owner. */
  handedOverBy?: string;
  files?: RecordFile[];
  /** Questions put to colleagues about this record ("Ask a colleague"). */
  asks?: RecordAsk[];
  ref: string;
  formId: string;
  formCode: string;
  formVersion: number;
  status: string;
  priority: Priority;
  source: WorkItemSource;
  /** Work fields the team filled in. */
  work: FormValues;
  assigneeId: string;
  dueAt: string | null;
  slaBreachedAt: string | null;
  responseDueAt?: string | null;
  respondedAt?: string | null;
  responseBreachedAt?: string | null;
  resolutionDueAt?: string | null;
  slaPausedAt?: string | null;
  resolutionBreachedAt?: string | null;
  escalationStep?: number;
  resolvedAt?: string | null;
  reopenCount?: number;
  submittedBy: string;
  channel: string;
  payload: FormValues;
  createdAt: string;
}

export interface RecordEvent {
  uuid: string;
  type: 'CREATED' | 'STATUS' | 'ASSIGNED' | 'COMMENT' | 'SLA' | 'AUTOMATION' | 'PRIORITY' | 'FIELD_UPDATE' | 'APPROVAL' | 'REOPENED' | 'ESCALATED' | 'ASK' | 'EMAIL' | 'ASK' | 'FILE';
  by: string;
  message: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export type FieldFilterOp = 'eq' | 'ne' | 'contains' | 'in' | 'gte' | 'lte' | 'empty' | 'notEmpty';

/** A filter on one answer (field name) or work field ($work.<name>) of the selected form. */
export interface FieldFilter {
  field: string;
  op: FieldFilterOp;
  value?: string | number | boolean | (string | number)[];
}

export type InboxSort = 'newest' | 'oldest' | 'due' | 'priority';

export interface InboxFilters {
  formCode?: string;
  status?: string;
  priority?: Priority;
  /** `reports` = what the people I manage hold. `unassigned` is everything nobody holds for an admin, and my team's queue for anyone else. */
  assignee?: 'me' | 'unassigned' | 'reports' | '';
  /** Only records with an approval waiting on me. */
  waiting?: boolean;
  overdue?: boolean;
  /** Only items not resolved yet. */
  open?: boolean;
  /** Only what is due in this stretch of time (the calendar asks for a month at once, so also for more rows). */
  dueFrom?: string;
  dueTo?: string;
  limit?: number;
  /** Needs formCode. */
  ff?: FieldFilter[];
  sort?: InboxSort;
  q?: string;
  page: number;
}

export interface InboxPage {
  rows: RecordRow[];
  total: number;
  page: number;
  limit: number;
  forms: Record<string, { name: string; code: string; statuses: WorkflowStatus[] }>;
  people: Record<string, Person>;
  /** Record ids with an approval waiting on me. */
  waitingOnMe: string[];
}

export interface RecordDetail {
  record: RecordRow;
  definition: FormDefinition;
  events: RecordEvent[];
  approvals: RecordApproval[];
  /** Named moves available now (forms with actions). */
  actions: WorkflowAction[];
  /** Closed and still inside the form's reopen window. */
  canReopen: boolean;
  /** Where "Email requester" sends ('' = no address known). */
  contactEmail: string;
  people: Record<string, Person>;
  next: WorkflowStatus[];
  /** Nobody holds it yet: the screen offers "Take it". */
  canTake?: boolean;
  /** A colleague handed it to this person: one press returns it to them. */
  canSendBack?: boolean;
  /** A colleague asked for this person's view and is waiting for it. */
  askedOfMe?: RecordAsk | null;
}

/** "Ask a colleague": a question put to someone who does not hold the record, and their answer. */
export interface RecordAsk {
  id: string;
  by: string;
  to: string;
  question: string;
  askedAt: string;
  answer: string;
  answeredAt: string | null;
}

const KEY = ['form-platform', 'records'] as const;
export const INBOX_PAGE_SIZE = 20;

/** Offered in local mode so the builder's dropdown can be tried offline. */
const LOCAL_WORKFLOWS: CustomWorkflow[] = [
  { key: 'example-log-submission', label: 'Example: log the submission', description: 'Writes the form and reference to the server log.', outputs: ['loggedAt', 'fields'] },
  // What a step that writes to another system looks like (a connector's "insert"): it names the fields it fills.
  { key: 'c-example1-0a1b2c3d', label: 'Example CRM: insert Leads', description: 'Sends the answers to Leads', outputs: ['id'], inputs: ['Email', 'LastName', 'Description', 'Phone'] },
];

export function useCustomWorkflows(enabled = true) {
  return useQuery({
    queryKey: ['form-platform', 'custom-workflows'],
    queryFn: async () => (USE_API ? unwrap<CustomWorkflow[]>(await adminApi.get('/custom-workflows')) : LOCAL_WORKFLOWS),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** People records can be assigned to (users with a Form records module; a form's team if it has one). */
export function usePeople(enabled = true, formCode?: string) {
  return useQuery({
    queryKey: ['form-platform', 'people', formCode ?? ''],
    queryFn: async () => (USE_API ? unwrap<Person[]>(await adminApi.get('/people', { params: { formCode } })) : []),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useInbox(filters: InboxFilters) {
  return useQuery({
    queryKey: [...KEY, 'inbox', filters],
    queryFn: async () =>
      unwrap<InboxPage>(
        await adminApi.get('/records', {
          params: {
            formCode: filters.formCode || undefined,
            status: filters.status || undefined,
            priority: filters.priority || undefined,
            assignee: filters.assignee || undefined,
            waiting: filters.waiting ? 'me' : undefined,
            overdue: filters.overdue ? 'true' : undefined,
            open: filters.open ? 'true' : undefined,
            ff: filters.formCode && filters.ff?.length ? JSON.stringify(filters.ff) : undefined,
            sort: filters.sort && filters.sort !== 'newest' ? filters.sort : undefined,
            q: filters.q?.trim() || undefined,
            page: filters.page,
            limit: filters.limit ?? INBOX_PAGE_SIZE,
            dueFrom: filters.dueFrom,
            dueTo: filters.dueTo,
          },
        }),
      ),
    enabled: recordsAvailable,
    placeholderData: keepPreviousData,
  });
}

export function useRecord(id: string | undefined) {
  return useQuery({
    queryKey: [...KEY, 'one', id],
    queryFn: async () => unwrap<RecordDetail>(await adminApi.get(`/records/${id}`)),
    enabled: !!id && recordsAvailable,
  });
}

/** A document of this record sent out for signature, and how far each signer has got. */
export interface RecordSignature {
  id: string;
  title: string;
  status: 'WAITING' | 'SIGNED' | 'DECLINED' | 'EXPIRED';
  order: 'IN_ORDER' | 'PARALLEL';
  expiresAt: string;
  finishedAt?: string | null;
  hasSignedDocument: boolean;
  signers: { email: string; name: string; status: 'WAITING' | 'SENT' | 'SIGNED' | 'DECLINED'; signedAt?: string | null; declineReason?: string }[];
}

/** Kept under the record's own key, so anything that refreshes the record refreshes this too. */
export function useRecordSignatures(id: string | undefined) {
  return useQuery({
    queryKey: [...KEY, 'one', id, 'signatures'],
    queryFn: async () => unwrap<RecordSignature[]>(await adminApi.get(`/records/${id}/signatures`)),
    enabled: !!id && recordsAvailable,
  });
}

type RecordAction =
  | { kind: 'status'; to: string; note?: string }
  | { kind: 'assign'; userId: string; note?: string }
  | { kind: 'take' }
  | { kind: 'send-back' }
  | { kind: 'ask'; userId: string; question: string }
  | { kind: 'answer'; answer: string }
  | { kind: 'comment'; message: string }
  | { kind: 'decide'; runId: string; decision: 'APPROVED' | 'REJECTED'; comment?: string }
  | { kind: 'act'; key: string; comment?: string }
  | { kind: 'priority'; priority: Priority }
  | { kind: 'work'; values: FormValues }
  | { kind: 'reopen'; comment: string }
  | { kind: 'email'; subject: string; body: string; templateKey?: string; requestInfo?: boolean };

const pathOf = (a: RecordAction) =>
  a.kind === 'decide' ? `approvals/${a.runId}` : a.kind === 'comment' ? 'comments' : a.kind === 'act' ? `actions/${a.key}` : a.kind;

/** Every change returns the fresh record; the inbox list is refreshed behind it. */
/** Done, but the item is no longer with this user (reassigned, approval decided). */
export interface RecordGone {
  gone: true;
}
export const isGone = (d: RecordDetail | RecordGone | null | undefined): d is RecordGone | null | undefined => !d || 'gone' in d;

export function useRecordAction(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (action: RecordAction) => {
      const payload =
        action.kind === 'status'
          ? { to: action.to, note: action.note }
          : action.kind === 'assign'
            ? { userId: action.userId, note: action.note }
            : action.kind === 'take' || action.kind === 'send-back'
              ? {}
              : action.kind === 'ask'
                ? { userId: action.userId, question: action.question }
                : action.kind === 'answer'
                  ? { answer: action.answer }
            : action.kind === 'comment'
              ? { message: action.message }
              : action.kind === 'act'
                ? { comment: action.comment }
                : action.kind === 'priority'
                  ? { priority: action.priority }
                  : action.kind === 'work'
                    ? { values: action.values }
                    : action.kind === 'reopen'
                      ? { comment: action.comment }
                      : action.kind === 'email'
                        ? { subject: action.subject, body: action.body, templateKey: action.templateKey, requestInfo: action.requestInfo }
                        : { decision: action.decision, comment: action.comment };
      const url = `/records/${id}/${pathOf(action)}`;
      return unwrap<RecordDetail | RecordGone>(action.kind === 'work' ? await adminApi.put(url, payload) : await adminApi.post(url, payload));
    },
    onSuccess: (detail) => {
      if (isGone(detail)) qc.removeQueries({ queryKey: [...KEY, 'one', id] });
      else qc.setQueryData([...KEY, 'one', id], detail);
      void qc.invalidateQueries({ queryKey: [...KEY, 'inbox'] });
    },
  });
}

/** A file on a record: one the respondent sent with a FILE question, or one staff added (`fieldName` is `$staff`). */
export interface RecordFile {
  fieldName: string;
  uploadId: string;
  name: string;
  size: number;
  contentType: string;
  addedBy?: string;
  addedAt?: string;
}
export const STAFF_FILE = '$staff';

/** A short-lived link to download one of a record's files. */
export async function recordFileLink(recordId: string, uploadId: string): Promise<string> {
  return unwrap<{ url: string }>(await adminApi.get(`/records/${recordId}/files/${uploadId}`)).url;
}

/** Staff add a file to a record: somewhere to put it, the upload itself, then the checks that attach it. */
export function useAddRecordFile(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const ticket = unwrap<{ uploadId: string; url: string; headers: Record<string, string> }>(await adminApi.post(`/records/${id}/files`, { fileName: file.name, contentType: file.type || 'application/octet-stream', size: file.size }));
      const put = await fetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: file });
      if (!put.ok) throw new Error('The file could not be uploaded. Please try again.');
      return unwrap<RecordDetail | RecordGone>(await adminApi.post(`/records/${id}/files/${ticket.uploadId}/attach`, {}));
    },
    onSuccess: (detail) => {
      if (!isGone(detail)) qc.setQueryData([...KEY, 'one', id], detail);
    },
  });
}

export type BulkRecordAction =
  | { op: 'assign'; userId: string; note?: string }
  | { op: 'take' }
  | { op: 'priority'; priority: Priority }
  | { op: 'decide'; decision: 'APPROVED' | 'REJECTED'; comment?: string };

export interface BulkResult {
  done: number;
  /** The ones that could not be done, each with the reason. */
  failed: { id: string; error?: string }[];
}

/** The same thing done to every record ticked in the inbox; each follows the rules it would follow alone. */
export function useBulkRecords() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { ids: string[] } & BulkRecordAction) => unwrap<BulkResult>(await adminApi.post('/records/bulk', input)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...KEY] }),
  });
}

/**
 * Submits a form as a work item raised in the portal: same field handling
 * as a public submission (files uploaded first), but through the signed-in
 * endpoint - no CAPTCHA, source PORTAL.
 */
export const portalSubmissionAdapter: SubmissionAdapter = {
  async submit({ definition, payload, values, systemContext }) {
    try {
      const body: FormValues = { ...values };
      for (const f of definition.fields.filter((x) => x.type === 'FILE')) {
        const files = Array.isArray(values[f.name]) ? (values[f.name] as unknown[]) : [];
        body[f.name] = await Promise.all(files.filter((x): x is File => x instanceof File).map((file) => uploadFile(definition, f.name, file)));
      }
      const data = unwrap<{ submissionId: string; ref?: string; payload: FormValues }>(
        await adminApi.post('/work-items', { formCode: definition.code, values: body, idempotencyKey: crypto.randomUUID(), timeZone: systemContext.timeZone }),
      );
      return { ok: true, submissionId: data.submissionId, ref: data.ref || undefined, payload: data.payload };
    } catch (e) {
      return { ok: false, payload, error: messageOf(e, 'Could not create the work item'), fieldErrors: fieldErrorsOf(e) };
    }
  },
};

// ------------------------------------------------------------ WM-2 / WM-3 admin: calendar + webhooks

const CALENDAR_KEY = ['form-platform', 'calendar'] as const;

/** Local mode has no server calendar: show the default so the screen can still be tried. */
const LOCAL_CALENDAR: WorkingCalendar = { workingDays: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', holidays: [], utcOffsetMinutes: 330 };

export function useCalendar() {
  return useQuery({
    queryKey: CALENDAR_KEY,
    queryFn: async () => (USE_API ? unwrap<WorkingCalendar>(await adminApi.get('/calendar')) : LOCAL_CALENDAR),
  });
}

export function useSaveCalendar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (cal: WorkingCalendar) => unwrap<WorkingCalendar>(await adminApi.put('/calendar', cal)),
    onSuccess: (cal) => qc.setQueryData(CALENDAR_KEY, cal),
  });
}

export interface Webhook {
  uuid: string;
  name: string;
  url: string;
  events: string[];
  formCodes: string[];
  active: boolean;
  includeData: boolean;
  signed: boolean;
  lastDeliveryAt: string | null;
  lastResult: string;
  failures: number;
}

export interface WebhookInput {
  name: string;
  url: string;
  events: string[];
  formCodes: string[];
  active: boolean;
  includeData: boolean;
  /** Omit to keep the current secret; '' removes it. */
  secret?: string;
}

const WEBHOOKS_KEY = ['form-platform', 'webhooks'] as const;
type WebhookList = { webhooks: Webhook[]; events: string[] };

export function useWebhooks() {
  return useQuery({
    queryKey: WEBHOOKS_KEY,
    queryFn: async () => unwrap<WebhookList>(await adminApi.get('/webhooks')),
    enabled: USE_API,
  });
}

export function useSaveWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: WebhookInput }) => unwrap<WebhookList>(await adminApi.put(`/webhooks/${id}`, input)),
    onSuccess: (list) => qc.setQueryData(WEBHOOKS_KEY, list),
  });
}

export function useDeleteWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => unwrap<WebhookList>(await adminApi.delete(`/webhooks/${id}`)),
    onSuccess: (list) => qc.setQueryData(WEBHOOKS_KEY, list),
  });
}

// ------------------------------------------------------------ WM-4: saved views + dashboard

export interface WorkView {
  uuid: string;
  name: string;
  shared: boolean;
  mine: boolean;
  ownerId: string;
  /** Inbox query params as the API takes them (strings). */
  filters: Record<string, string | boolean>;
}

/** Inbox filters <-> the API's query shape (what views store). */
export function filtersToQuery(f: InboxFilters): Record<string, string> {
  const q: Record<string, string> = {};
  if (f.formCode) q.formCode = f.formCode;
  if (f.status) q.status = f.status;
  if (f.priority) q.priority = f.priority;
  if (f.assignee) q.assignee = f.assignee;
  if (f.waiting) q.waiting = 'me';
  if (f.overdue) q.overdue = 'true';
  if (f.open) q.open = 'true';
  if (f.q?.trim()) q.q = f.q.trim();
  if (f.formCode && f.ff?.length) q.ff = JSON.stringify(f.ff);
  if (f.sort && f.sort !== 'newest') q.sort = f.sort;
  return q;
}

export function queryToFilters(q: Record<string, string | boolean>): InboxFilters {
  let ff: FieldFilter[] | undefined;
  try {
    ff = typeof q.ff === 'string' ? (JSON.parse(q.ff) as FieldFilter[]) : undefined;
  } catch {
    ff = undefined;
  }
  return {
    page: 1,
    formCode: typeof q.formCode === 'string' ? q.formCode : undefined,
    status: typeof q.status === 'string' ? q.status : undefined,
    priority: typeof q.priority === 'string' ? (q.priority as Priority) : undefined,
    assignee: q.assignee === 'me' || q.assignee === 'unassigned' || q.assignee === 'reports' ? q.assignee : '',
    waiting: q.waiting === 'me' || q.waiting === true,
    overdue: q.overdue === 'true' || q.overdue === true,
    open: q.open === 'true' || q.open === true,
    q: typeof q.q === 'string' ? q.q : undefined,
    ff,
    sort: typeof q.sort === 'string' ? (q.sort as InboxSort) : undefined,
  };
}

const VIEWS_KEY = ['form-platform', 'work-views'] as const;

export function useWorkViews() {
  return useQuery({
    queryKey: VIEWS_KEY,
    queryFn: async () => unwrap<WorkView[]>(await adminApi.get('/work-views')),
    enabled: recordsAvailable,
  });
}

export function useSaveWorkView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, name, shared, filters }: { id: string; name: string; shared: boolean; filters: InboxFilters }) =>
      unwrap<WorkView[]>(await adminApi.put(`/work-views/${id}`, { name, shared, filters: filtersToQuery(filters) })),
    onSuccess: (views) => qc.setQueryData(VIEWS_KEY, views),
  });
}

export function useDeleteWorkView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => unwrap<WorkView[]>(await adminApi.delete(`/work-views/${id}`)),
    onSuccess: (views) => qc.setQueryData(VIEWS_KEY, views),
  });
}

/** Org-wide Work settings: everyone reads them, Form admins change them. */
export interface WorkSettings {
  inboxTheme: string;
}
const SETTINGS_KEY = ['form-platform', 'work-settings'] as const;

export function useWorkSettings() {
  return useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: async () => unwrap<WorkSettings>(await adminApi.get('/work-settings')),
    enabled: recordsAvailable,
  });
}

export function useSaveWorkSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (settings: WorkSettings) => unwrap<WorkSettings>(await adminApi.put('/work-settings', settings)),
    onMutate: (settings) => qc.setQueryData(SETTINGS_KEY, settings),
    onSuccess: (settings) => qc.setQueryData(SETTINGS_KEY, settings),
    onError: () => void qc.invalidateQueries({ queryKey: SETTINGS_KEY }),
  });
}

export interface WorkDashboard {
  days: number;
  me: { open: number; overdue: number; dueToday: number; waitingMyApproval: number; resolvedToday: number };
  team: {
    open: number;
    unassigned: number;
    overdue: number;
    escalated: number;
    byAssignee: { userId: string; name: string; open: number; overdue: number }[];
    byForm: { formCode: string; open: number }[];
    /** 'NONE' for items from before priorities existed. */
    byPriority: { priority: Priority | 'NONE'; open: number }[];
  };
  performance: {
    created: number;
    resolved: number;
    slaCompliance: number | null;
    avgResolutionHours: number | null;
    avgFirstResponseHours: number | null;
    reopenRate: number | null;
    /** Raised / resolved per day of the period (org time zone), oldest first. */
    trend?: { date: string; raised: number; resolved: number }[];
  };
}

export function useWorkDashboard(formCode: string | undefined, days: number) {
  return useQuery({
    queryKey: ['form-platform', 'work-dashboard', formCode ?? '', days],
    queryFn: async () => unwrap<WorkDashboard>(await adminApi.get('/work-dashboard', { params: { formCode: formCode || undefined, days } })),
    enabled: recordsAvailable,
  });
}
