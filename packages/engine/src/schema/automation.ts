import { FLOW_SERVICE_INFO, FLOW_SERVICES, isFlowAddress } from '../flow-services';
import { z } from 'zod';
import { NEEDS_WORKFLOW, conditionSchema, issueAdder, recipients, referencesOf } from './common';
import type { FormDefinition } from '../types';
import { conditionFields } from '../evaluate-condition';
import { stepKey } from '../workflow';

/**
 * Automations: when (submitted, status changed, overdue, a work field changed), if (a condition), then steps.
 * They name the workflow's statuses, the form's fields and work fields, and earlier steps' outputs
 * ({{$steps.<key>.<field>}}).
 */

/** Common to every step. Ids are what later steps use: {{$steps.<id>.<field>}}. */
const stepMeta = {
  id: z.string().regex(/^[a-z][a-z0-9_]{0,29}$/, 'Step keys are lower-case letters, digits and _').optional(),
  label: z.string().max(80).optional(),
  if: conditionSchema.optional(),
  continueOnError: z.boolean().optional(),
  withPrevious: z.boolean().optional(),
};

const actionSchema = z.union([
  z.object({ ...stepMeta, type: z.literal('EMAIL'), to: recipients, subject: z.string().max(200), body: z.string().max(10_000), attachDocument: z.boolean().optional() }),
  z.object({ ...stepMeta, type: z.literal('NOTIFY'), to: recipients, message: z.string().max(500) }),
  z.object({
    ...stepMeta,
    type: z.literal('CREATE_TASK'),
    title: z.string().max(100),
    description: z.string().max(1000).optional(),
    to: recipients,
    dueInHours: z.number().positive().max(8760).optional(),
  }),
  z.object({
    ...stepMeta,
    type: z.literal('APPROVAL'),
    to: recipients,
    title: z.string().max(120),
    instructions: z.string().max(2000).optional(),
    dueInHours: z.number().positive().max(8760).optional(),
    need: z.enum(['ANY', 'ALL']).optional(),
    whenLate: z.enum(['REMIND', 'MANAGER', 'REJECT']).optional(),
    byEmail: z.boolean().optional(),
    together: z.array(z.object({ to: recipients, title: z.string().max(120) })).max(5).optional(),
  }),
  z.object({
    ...stepMeta,
    type: z.literal('SIGN'),
    to: recipients,
    title: z.string().max(120),
    message: z.string().max(2000).optional(),
    order: z.enum(['IN_ORDER', 'PARALLEL']).optional(),
    expiresInDays: z.number().int().min(1).max(90).optional(),
    confirm: z.enum(['EMAIL_CODE', 'KNOWN']).optional(),
    known: z.string().max(200).optional(),
    knownLabel: z.string().max(80).optional(),
  }),
  z.object({
    ...stepMeta,
    type: z.literal('ASSIGN'),
    userId: z.string().max(64),
    by: z.enum(['PERSON', 'ANSWER', 'TURN', 'MANAGER', 'EMAIL']).optional(),
    field: z.string().max(100).optional(),
    map: z.record(z.string().max(100), z.string().min(1).max(64)).optional(),
    userIds: z.array(z.string().min(1).max(64)).max(50).optional(),
    from: z.string().max(200).optional(),
  }),
  z.object({ ...stepMeta, type: z.literal('SET_STATUS'), status: z.string().max(40) }),
  z.object({ ...stepMeta, type: z.literal('WEBHOOK'), url: z.string().max(500) }),
  z.object({ ...stepMeta, type: z.literal('GO_BACK'), to: z.string().max(30), times: z.number().int().min(1).max(10).optional() }),
  z.object({ ...stepMeta, type: z.literal('FLOW'), service: z.enum(FLOW_SERVICES), url: z.string().max(2000) }),
  z.object({ ...stepMeta, type: z.literal('HANDLER'), key: z.string().max(60), map: z.record(z.string().max(100), z.string().max(100)).optional() }),
]);

export const automationSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(100),
  enabled: z.boolean(),
  when: z.enum(['SUBMITTED', 'STATUS_CHANGED', 'SLA_BREACHED', 'SLA_APPROACHING', 'FIELD_UPDATED']),
  sla: z.enum(['STATUS', 'RESPONSE', 'RESOLUTION']).optional(),
  toStatus: z.string().optional(),
  field: z.string().optional(),
  if: conditionSchema.optional(),
  actions: z.array(actionSchema).max(10),
});

/** Publish-level checks: automations only refer to things that exist. */
export function checkAutomations(def: FormDefinition, ctx: z.RefinementCtx) {
  const add = issueAdder(ctx);
  const { fields, wf, statusKeys, workFieldNames, knownRef } = referencesOf(def);
  const needsWorkflow = NEEDS_WORKFLOW;
  (def.automations ?? []).forEach((auto, i) => {
    const at = (k: string) => ['automations', i, k];
    if (!auto.name.trim()) add(at('name'), 'Give the automation a name');
    if (!auto.actions.length) add(at('actions'), `"${auto.name}" has no steps`);
    if (!wf?.enabled && auto.when !== 'SUBMITTED') add(at('when'), needsWorkflow);
    if (auto.when === 'FIELD_UPDATED' && auto.field && !workFieldNames.has(auto.field)) add(at('field'), `Unknown work field "${auto.field}"`);
    if (auto.toStatus && !statusKeys.has(auto.toStatus)) add(at('toStatus'), `Unknown status "${auto.toStatus}"`);
    if (auto.if) {
      for (const ref of conditionFields(auto.if)) {
        if (!knownRef(ref)) add(at('if'), ref.startsWith('$') && !wf?.enabled ? needsWorkflow : `Condition uses unknown field "${ref}"`);
      }
    }
    const seen = new Set<string>();
    auto.actions.forEach((action, k) => {
      const missing = (what: string) => add(at('actions'), `"${auto.name}": ${what}`);
      const key = stepKey(action, k);
      if (seen.has(key)) missing(`two steps use the key "${key}"`);
      // A step's condition may test answers, the status, and outputs of steps above it.
      for (const ref of action.if ? conditionFields(action.if) : []) {
        const earlier = /^\$steps\.([a-z0-9_]+)\./.exec(ref)?.[1];
        const ok = earlier ? seen.has(earlier) : knownRef(ref);
        if (!ok) missing(`step ${k + 1}'s condition uses "${ref}", which isn't an answer${wf?.enabled ? ', the status' : ''} or an earlier step's output`);
      }
      seen.add(key);
      if ((action.type === 'EMAIL' || action.type === 'NOTIFY' || action.type === 'CREATE_TASK' || action.type === 'APPROVAL' || action.type === 'SIGN') && !action.to.length) {
        missing(action.type === 'APPROVAL' ? 'choose who approves' : action.type === 'SIGN' ? 'choose who signs' : 'add who it goes to');
      }
      if (action.type === 'APPROVAL' && !action.title.trim()) missing('the approval needs a title');
      if (action.type === 'APPROVAL' && action.together?.some((part) => !part.to.length || !part.title.trim())) missing('each approval asked at the same time needs who approves and what they approve');
      if (action.type === 'SIGN' && !action.title.trim()) missing('say what is being signed');
      if (action.type === 'SIGN' && action.confirm === 'KNOWN' && (!action.known?.trim() || !action.knownLabel?.trim())) missing('say what the signers must know before they can sign, and what to call it');
      if (action.type === 'EMAIL' && (!action.subject.trim() || !action.body.trim())) missing('the email needs a subject and a message');
      if (action.type === 'NOTIFY' && !action.message.trim()) missing('the notification needs a message');
      if (action.type === 'CREATE_TASK' && !action.title.trim()) missing('the task needs a title');
      if (action.type === 'ASSIGN' && wf?.enabled) {
        const by = action.by ?? 'PERSON';
        if (by === 'PERSON' && !action.userId) missing('choose who to assign');
        if (by === 'ANSWER' && (!action.field || !fields.has(action.field))) missing('choose the answer that decides who gets it');
        if (by === 'ANSWER' && !Object.keys(action.map ?? {}).length && !action.userId) missing('say who gets it for each answer');
        if (by === 'TURN' && !action.userIds?.length) missing('choose the people who take it in turn');
        if (by === 'EMAIL' && !action.from?.trim()) missing('say where the person\'s email comes from');
      }
      if (action.type === 'WEBHOOK' && !/^https:\/\/[^\s/]+\.[^\s]+$/.test(action.url)) missing('webhooks need a full https URL');
      if (action.type === 'FLOW' && !isFlowAddress(action.service, action.url)) {
        missing(action.url.trim() ? `that is not a ${FLOW_SERVICE_INFO[action.service].label} address` : `paste the ${FLOW_SERVICE_INFO[action.service].label} flow's address`);
      }
      if (action.type === 'HANDLER' && !/^[a-z0-9-]{1,60}$/.test(action.key)) missing('choose a custom API');
      if (action.type === 'GO_BACK') {
        const earlier = auto.actions.slice(0, k).map((step, n) => stepKey(step, n));
        if (!earlier.includes(action.to)) missing(k === 0 ? 'there is no earlier step to go back to' : 'choose the earlier step to go back to');
      }
      const recipients = 'to' in action && action.type !== 'GO_BACK' ? action.to : [];
      for (const r of recipients) {
        if (r.kind === 'FIELD' && fields.get(r.field)?.type !== 'EMAIL') add(at('actions'), `"${r.field}" is not an email field`);
        if ((r.kind === 'ASSIGNEE' || r.kind === 'MANAGER') && !wf?.enabled) add(at('actions'), `The assignee: ${needsWorkflow}`);
      }
      if ((action.type === 'SET_STATUS' || action.type === 'ASSIGN') && !wf?.enabled) add(at('actions'), needsWorkflow);
      else if (action.type === 'SET_STATUS' && !statusKeys.has(action.status)) add(at('actions'), `Unknown status "${action.status}"`);
      if ((action.type === 'NOTIFY' || action.type === 'CREATE_TASK' || action.type === 'APPROVAL') && action.to.some((r) => r.kind === 'FIELD' || r.kind === 'EMAIL')) {
        add(at('actions'), 'Notifications, tasks and approvals go to Prism users (assignee, submitter or a chosen user)');
      }
    });
  });
  if ((def.automations?.length ?? 0) > 30) add(['automations'], 'A form can have at most 30 automations');
}

