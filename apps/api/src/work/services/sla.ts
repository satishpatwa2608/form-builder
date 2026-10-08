import type { Priority, WorkflowConfig, WorkflowStatus, WorkingCalendar } from '@fb/engine';
import { addWorkingTime, hoursMs, slaTargets, workingTimeBetween } from '@fb/engine';
import type { FormSubmission } from '../schemas/form-submission.schema';

/**
 * SLA state of a work item as plain field updates. Pure: the record service
 * decides when to apply them (creation, moves, reopen, priority change).
 *
 * - status SLA: `dueAt` from the status's own slaHours (existing).
 * - response: `responseDueAt` until the first person acts (`respondedAt`).
 * - resolution: `resolutionDueAt` until a DONE status (`resolvedAt`); it
 *   pauses in `sla.pauseIn` statuses (remaining working time is kept).
 * - escalation: step 0 = the breach itself, step n = level n (`afterHours`
 *   after the breach). `nextEscalationAt` is when the sweep takes the next step.
 */

export interface SlaContext {
  wf: WorkflowConfig;
  /** null = wall clock (24x7). */
  cal: WorkingCalendar | null;
}

type Patch = Partial<Pick<
  FormSubmission,
  | 'dueAt'
  | 'responseDueAt'
  | 'respondedAt'
  | 'resolutionDueAt'
  | 'resolutionRemainingMs'
  | 'slaPausedAt'
  | 'resolutionWarnAt'
  | 'resolutionBreachedAt'
  | 'responseBreachedAt'
  | 'escalationStep'
  | 'nextEscalationAt'
  | 'resolvedAt'
  | 'slaBreachedAt'
>>;

type SlaRecord = Pick<
  FormSubmission,
  'resolutionDueAt' | 'resolutionRemainingMs' | 'slaPausedAt' | 'escalationStep' | 'respondedAt' | 'resolvedAt' | 'resolutionWarnAt' | 'priority'
> & { createdAt?: Date };

const add = (ctx: SlaContext, from: Date, hours: number) => addWorkingTime(from, hoursMs(hours), ctx.cal);
const paused = (ctx: SlaContext, status: string) => !!ctx.wf.sla?.pauseIn?.includes(status);

/** When the sweep should take escalation step `step` (0 = the breach). */
export function escalationAt(ctx: SlaContext, step: number, resolutionDueAt: Date | null): Date | null {
  if (!resolutionDueAt) return null;
  if (step === 0) return resolutionDueAt;
  const level = ctx.wf.escalation?.levels?.[step - 1];
  return level ? add(ctx, resolutionDueAt, level.afterHours) : null;
}

/** Warn point for a resolution window that ends at `due` and is `totalMs` long. */
function warnAt(ctx: SlaContext, due: Date, totalMs: number, now: Date): Date | null {
  const pct = ctx.wf.sla?.warnAtPercent;
  if (!pct) return null;
  const leftAtWarn = (totalMs * (100 - pct)) / 100;
  const remaining = workingTimeBetween(now, due, ctx.cal);
  if (remaining <= leftAtWarn) return null; // already past the warn point
  return addWorkingTime(now, remaining - leftAtWarn, ctx.cal);
}

/** The status's own SLA (slaHours), counted in the form's calendar. */
export function statusDue(ctx: SlaContext, status: WorkflowStatus | undefined, from: Date): Date | null {
  return status?.slaHours && status.category !== 'DONE' ? add(ctx, from, status.slaHours) : null;
}

/** Fresh response + resolution targets from `from` (creation or reopen). */
export function startTargets(ctx: SlaContext, priority: Priority, status: string, from: Date, respond = true): Patch {
  const { responseHours, resolutionHours } = slaTargets(ctx.wf, priority);
  const patch: Patch = { escalationStep: 0, resolutionBreachedAt: null, resolvedAt: null };
  if (respond) patch.responseDueAt = responseHours ? add(ctx, from, responseHours) : null;
  if (!resolutionHours) return { ...patch, resolutionDueAt: null, resolutionWarnAt: null, nextEscalationAt: null };
  if (paused(ctx, status)) {
    return { ...patch, resolutionDueAt: null, resolutionRemainingMs: hoursMs(resolutionHours), slaPausedAt: from, resolutionWarnAt: null, nextEscalationAt: null };
  }
  const due = add(ctx, from, resolutionHours);
  return {
    ...patch,
    resolutionDueAt: due,
    resolutionRemainingMs: null,
    slaPausedAt: null,
    resolutionWarnAt: warnAt(ctx, due, hoursMs(resolutionHours), from),
    nextEscalationAt: escalationAt(ctx, 0, due),
  };
}

/** Field updates when a record moves into `to` (by a person, or '' for automations). */
export function onMove(ctx: SlaContext, record: SlaRecord, to: WorkflowStatus, now: Date, byPerson: boolean): Patch {
  const patch: Patch = { dueAt: statusDue(ctx, to, now), slaBreachedAt: null };
  if (byPerson && !record.respondedAt) patch.respondedAt = now;

  if (to.category === 'DONE') {
    return { ...patch, resolvedAt: now, nextEscalationAt: null, resolutionWarnAt: null };
  }
  if (record.resolvedAt) patch.resolvedAt = null; // moved out of done without a formal reopen

  const wasPaused = !!record.slaPausedAt;
  const nowPaused = paused(ctx, to.key);
  if (!wasPaused && nowPaused && record.resolutionDueAt) {
    // Stop the clock: remember the working time left.
    return {
      ...patch,
      slaPausedAt: now,
      resolutionRemainingMs: workingTimeBetween(now, record.resolutionDueAt, ctx.cal),
      resolutionDueAt: null,
      resolutionWarnAt: null,
      nextEscalationAt: null,
    };
  }
  if (wasPaused && !nowPaused && record.resolutionRemainingMs !== null && record.resolutionRemainingMs !== undefined) {
    // Restart it with the time that was left.
    const due = addWorkingTime(now, record.resolutionRemainingMs, ctx.cal);
    const total = hoursMs(slaTargets(ctx.wf, record.priority as Priority).resolutionHours ?? 0);
    return {
      ...patch,
      slaPausedAt: null,
      resolutionRemainingMs: null,
      resolutionDueAt: due,
      resolutionWarnAt: total ? warnAt(ctx, due, total, now) : null,
      nextEscalationAt: escalationAt(ctx, record.escalationStep ?? 0, due),
    };
  }
  return patch;
}

/**
 * New targets after a priority change, counted from creation (time spent
 * paused isn't re-credited - a simplification). Skipped once resolved or while paused.
 */
export function onPriority(ctx: SlaContext, record: SlaRecord, priority: Priority): Patch {
  if (record.resolvedAt || record.slaPausedAt || !record.createdAt) return {};
  const { responseHours, resolutionHours } = slaTargets(ctx.wf, priority);
  const patch: Patch = {};
  if (!record.respondedAt) patch.responseDueAt = responseHours ? add(ctx, record.createdAt, responseHours) : null;
  const due = resolutionHours ? add(ctx, record.createdAt, resolutionHours) : null;
  patch.resolutionDueAt = due;
  patch.nextEscalationAt = escalationAt(ctx, record.escalationStep ?? 0, due);
  patch.resolutionWarnAt = due && resolutionHours && !record.escalationStep ? warnAt(ctx, due, hoursMs(resolutionHours), new Date()) : null;
  return patch;
}
