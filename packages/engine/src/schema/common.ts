import { z } from 'zod';
import { isValueField } from '../field-kinds';
import type { Condition, FormDefinition } from '../types';

/**
 * What the four parts of a form definition share: conditions, the people a step or an approval goes to, and
 * what a condition may name. Form (fields, rules, events, data sources), workflow (statuses, moves, approvals,
 * time limits), automation (triggers and steps) and document (the PDF) each have a module of their own beside
 * this one; definition.schema.ts puts them together.
 */

export const operatorSchema = z.enum([
  'equals',
  'notEquals',
  'contains',
  'notContains',
  'in',
  'notIn',
  'isEmpty',
  'isNotEmpty',
  'greaterThan',
  'lessThan',
  'greaterThanOrEqual',
  'lessThanOrEqual',
]);

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(conditionSchema).min(1) }),
    z.object({ any: z.array(conditionSchema).min(1) }),
    z.object({ field: z.string().min(1), operator: operatorSchema, value: z.unknown().optional() }),
  ]),
);

export const languageCode = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/, 'Use a language code such as en, hi or ar');

// Structure only: drafts are saved while half-filled. "Required" is checked at publish (checkWorkflow).
export const recipientSchema = z.union([
  z.object({ kind: z.literal('ASSIGNEE') }),
  z.object({ kind: z.literal('SUBMITTER') }),
  z.object({ kind: z.literal('USER'), userId: z.string().min(1).max(64) }),
  z.object({ kind: z.literal('MANAGER') }),
  z.object({ kind: z.literal('FIELD'), field: z.string().min(1) }),
  z.object({ kind: z.literal('EMAIL'), email: z.email() }),
]);

export const recipients = z.array(recipientSchema).max(10);

/** One problem with the definition, at a path. */
export type AddIssue = (path: (string | number)[], message: string) => void;

export const issueAdder =
  (ctx: z.RefinementCtx): AddIssue =>
  (path, message) =>
    ctx.addIssue({ code: 'custom', path, message });

export const NEEDS_WORKFLOW = 'Turn on the workflow (statuses) to use this';

/**
 * What a workflow's or an automation's condition and steps may refer to: the form's answers by name; with a
 * workflow, its statuses, $status, $priority and $work.<field>.
 */
export function referencesOf(def: FormDefinition) {
  const fields = new Map(def.fields.map((f) => [f.name, f]));
  const wf = def.workflow;
  const statusKeys = new Set((wf?.enabled ? wf.statuses : []).map((st) => st.key));
  const workFieldNames = new Set((wf?.enabled ? wf.workFields ?? [] : []).filter(isValueField).map((f) => f.name));
  /** Answers, plus (with a workflow) $status, $priority and $work.<field>. */
  const knownRef = (ref: string) =>
    ref === '$status' || ref === '$priority' ? !!wf?.enabled : ref.startsWith('$work.') ? workFieldNames.has(ref.slice(6)) : fields.has(ref);
  return { fields, wf, statusKeys, workFieldNames, knownRef };
}
