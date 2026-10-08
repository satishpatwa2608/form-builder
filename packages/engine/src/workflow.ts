import type { FormDefinition, FormValues, Priority, WorkflowAction, WorkflowConfig, WorkflowStatus } from './types';
import { evaluateCondition } from './evaluate-condition';

/**
 * Pure workflow rules shared by server (enforcement) and browser (what the UI
 * offers). No I/O here.
 */

/** Used when a form has no workflow of its own - every submission is still a record. */
export const DEFAULT_WORKFLOW: WorkflowConfig = {
  enabled: true,
  statuses: [
    { key: 'NEW', label: 'New', category: 'OPEN' },
    { key: 'IN_PROGRESS', label: 'In progress', category: 'IN_PROGRESS' },
    { key: 'CLOSED', label: 'Closed', category: 'DONE' },
  ],
};

export const workflowOf = (def: Pick<FormDefinition, 'workflow'>): WorkflowConfig =>
  def.workflow?.enabled && def.workflow.statuses.length ? def.workflow : DEFAULT_WORKFLOW;

/** CUSTOMER_COMPLAINT -> CC, unless the workflow sets its own prefix. */
export const refPrefixOf = (def: Pick<FormDefinition, 'code' | 'workflow'>): string =>
  def.workflow?.refPrefix ||
  def.code
    .split('_')
    .filter(Boolean)
    .map((p) => p[0])
    .join('')
    .slice(0, 6) ||
  'REC';

export const formatRef = (prefix: string, seq: number) => `${prefix}-${String(seq).padStart(6, '0')}`;

/** First matching rule, else the default (MEDIUM). */
export function initialPriority(wf: WorkflowConfig, values: FormValues): Priority {
  const rule = wf.priority?.rules?.find((r) => evaluateCondition(r.if, values));
  return rule?.priority ?? wf.priority?.default ?? 'MEDIUM';
}

/** Response / resolution targets for a priority (per-priority overrides win). */
export function slaTargets(wf: WorkflowConfig, priority: Priority): { responseHours?: number; resolutionHours?: number } {
  const sla = wf.sla;
  if (!sla) return {};
  const p = sla.byPriority?.[priority] ?? {};
  return { responseHours: p.responseHours ?? sla.responseHours, resolutionHours: p.resolutionHours ?? sla.resolutionHours };
}

/** Actions a record in `status` offers (named moves). */
export function actionsFor(wf: WorkflowConfig, status: string): WorkflowAction[] {
  return (wf.actions ?? []).filter((a) => a.to !== status && (!a.from?.length || a.from.includes(status)));
}

export const initialStatus = (wf: WorkflowConfig): WorkflowStatus => wf.statuses[0];

export const findStatus = (wf: WorkflowConfig, key: string | undefined): WorkflowStatus | undefined =>
  wf.statuses.find((s) => s.key === key);

/** Statuses a record in `from` may move to (never itself). */
export function allowedNext(wf: WorkflowConfig, from: string): WorkflowStatus[] {
  const listed = wf.transitions?.[from];
  return wf.statuses.filter((s) => s.key !== from && (!listed || listed.includes(s.key)));
}

export const canTransition = (wf: WorkflowConfig, from: string, to: string) => allowedNext(wf, from).some((s) => s.key === to);

/** When a record entering `status` at `from` is due, if that status has an SLA. */
export function dueAt(status: WorkflowStatus | undefined, from: Date): Date | null {
  return status?.slaHours && status.category !== 'DONE' ? new Date(from.getTime() + status.slaHours * 3600_000) : null;
}

/** Stored payload (keys after submission.mapping) -> values by field name, for rules and templates. */
export function valuesFromPayload(def: Pick<FormDefinition, 'fields' | 'submission'>, payload: FormValues): FormValues {
  const mapping = def.submission.mapping ?? {};
  const out: FormValues = {};
  for (const f of def.fields) {
    const key = mapping[f.name] ?? f.name;
    if (key in payload) out[f.name] = payload[key];
  }
  return out;
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

export interface TemplateContext {
  values: FormValues;
  /** Work fields filled by the team. */
  work?: FormValues;
  record: { ref: string; status: string; link: string };
  form: { name: string };
  /** Outputs of steps that already ran, by step id. */
  steps?: Record<string, unknown>;
}

const TOKEN = /\{\{\s*(\$record\.|\$form\.|\$steps\.|\$work\.)?([A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+){0,4})\s*\}\}/g;

/** Key of a step's output: its id, or its position for steps saved before ids existed. */
export const stepKey = (step: { id?: string }, index: number) => step.id || `s${index + 1}`;

/** Read `a.b.c` from nested plain objects (own keys only). */
export function readPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * What conditions test: answers, `$status`, and step outputs flattened to
 * `$steps.<id>.<field>` (one level - enough for "if CRM said duplicate").
 */
export function conditionValues(
  values: FormValues,
  status: string,
  steps: Record<string, unknown> = {},
  extra: { priority?: string; work?: FormValues } = {},
): FormValues {
  const out: FormValues = { ...values, $status: status };
  if (extra.priority) out.$priority = extra.priority;
  for (const [k, v] of Object.entries(extra.work ?? {})) out[`$work.${k}`] = v;
  for (const [id, data] of Object.entries(steps)) {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const [k, v] of Object.entries(data)) out[`$steps.${id}.${k}`] = v as FormValues[string];
    }
  }
  return out;
}

function display(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? (x as { name?: string }).name ?? '' : String(x))).join(', ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 500);
  return String(v);
}

/**
 * Fill {{field}}, {{$record.x}}, {{$form.x}}. `html` escapes every value, so a
 * submitted answer can never inject markup into an email. Unknown tokens
 * render empty.
 */
export function renderTemplate(template: string, ctx: TemplateContext, html: boolean): string {
  return template.replace(TOKEN, (_m, scope: string | undefined, name: string) => {
    const raw =
      scope === '$record.'
        ? readPath(ctx.record, name)
        : scope === '$form.'
          ? readPath(ctx.form, name)
          : scope === '$steps.'
            ? readPath(ctx.steps ?? {}, name)
            : scope === '$work.'
              ? readPath(ctx.work ?? {}, name)
            : name.includes('.')
              ? undefined
              : ctx.values[name];
    const text = display(raw);
    return html ? escapeHtml(text) : text;
  });
}
