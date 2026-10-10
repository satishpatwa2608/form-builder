import type { Automation, FormDefinition, WorkflowConfig } from '../../types';
import { ACTION_LABEL, canRunWithPrevious } from './workflow-edits';

/** One way a record gets from a status to another, as the picture draws it. */
export interface MapMove {
  /** The button's words; empty for a plain allowed move. */
  label: string;
  /** Status keys it can be pressed in. `any` means every status but the one it leads to. */
  from: string[];
  any: boolean;
  to: string;
  needsApproval: boolean;
  /** Where a rejected approval sends it, when that is somewhere else. */
  onReject?: string;
  /** Its place among the workflow's buttons, when it is one (and not a tick in the table of allowed moves). */
  action?: number;
}

/**
 * The moves of a workflow, however it says them: named buttons, a table of allowed moves, or neither (staff
 * may then move a record to any status, which is said in words instead of drawn as a web of arrows).
 */
export function workflowMoves(wf: WorkflowConfig): { moves: MapMove[]; free: boolean } {
  const keys = new Set(wf.statuses.map((s) => s.key));
  if (wf.actions?.length) {
    return {
      free: false,
      moves: wf.actions
        .map((a, action) => ({ a, action }))
        .filter(({ a }) => keys.has(a.to))
        .map(({ a, action }) => {
          const named = (a.from ?? []).filter((k) => keys.has(k) && k !== a.to);
          return {
            action,
            label: a.label,
            from: named.length ? named : wf.statuses.map((s) => s.key).filter((k) => k !== a.to),
            any: !named.length,
            to: a.to,
            needsApproval: !!a.approval,
            onReject: a.approval?.onReject && keys.has(a.approval.onReject) ? a.approval.onReject : undefined,
          };
        }),
    };
  }
  if (wf.transitions) {
    return {
      free: false,
      moves: Object.entries(wf.transitions).flatMap(([from, tos]) => (keys.has(from) ? tos.filter((to) => keys.has(to) && to !== from).map((to) => ({ label: '', from: [from], any: false, to, needsApproval: false })) : [])),
    };
  }
  return { free: true, moves: [] };
}

/** The same picture in sentences: for screen readers, and for anyone who would rather read it. */
export function describeMoves(wf: WorkflowConfig): string[] {
  const name = (key: string) => wf.statuses.find((s) => s.key === key)?.label ?? key;
  const { moves, free } = workflowMoves(wf);
  if (free) return ['Staff can move a record to any status.'];
  return moves.map((m) => {
    const from = m.any ? 'any other status' : m.from.map(name).join(' or ');
    const approval = m.needsApproval ? `, once approved${m.onReject ? ` (if rejected: ${name(m.onReject)})` : ''}` : '';
    return `${m.label ? `${m.label}: ` : ''}${from} to ${name(m.to)}${approval}`;
  });
}

const WHEN: Record<Automation['when'], string> = {
  SUBMITTED: 'When a form is submitted',
  STATUS_CHANGED: 'When the status changes',
  SLA_BREACHED: 'When a time limit is missed',
  FIELD_UPDATED: 'When a work field changes',
  SLA_APPROACHING: 'When time is almost up',
};

/** Each automation as a row of boxes: when it starts, then its steps in order. */
export function automationLanes(form: Pick<FormDefinition, 'automations' | 'workflow'>) {
  const name = (key: string) => form.workflow?.statuses.find((s) => s.key === key)?.label ?? key;
  return (form.automations ?? []).map((a, index) => ({
    index,
    name: a.name || 'Untitled',
    off: !a.enabled,
    when: a.when === 'STATUS_CHANGED' && a.toStatus ? `When the status becomes ${name(a.toStatus)}` : WHEN[a.when],
    steps: a.actions.map((step, i) => ({ label: step.label || ACTION_LABEL[step.type], type: step.type, conditional: !!step.if, together: !!step.withPrevious && canRunWithPrevious(a.actions, i) })),
  }));
}
