import type { FormDefinition } from './types';

/**
 * What only the server acts on. None of it is needed to draw a form or check
 * an answer, and all of it says something about the organisation's inside:
 * who is emailed and assigned, which systems are called and at what address,
 * who may see the records.
 */
const SERVER_ONLY = ['automations', 'workflow', 'workflowRef', 'recordAccess', 'submitChecks', 'document', 'listOnPortal', 'startedFrom', 'createdBy', 'updatedBy'] as const;

export type PublicFormDefinition = Omit<FormDefinition, (typeof SERVER_ONLY)[number]>;

/** The copy of a published form that is given to whoever opens its link. */
export function publicCopy(def: FormDefinition): PublicFormDefinition {
  const copy: Record<string, unknown> = { ...def };
  for (const key of SERVER_ONLY) delete copy[key];
  // Where a form's opening answers come from stays on the server; the page only learns that there are some to ask for.
  if (def.openWith) copy.openWith = { by: def.openWith.by, ...(def.openWith.only ? { only: true } : {}) };
  return copy as unknown as PublicFormDefinition;
}
