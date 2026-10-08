import type { FormAccess, FormDefinition } from '../types';

export interface NewFormInput {
  name: string;
  code: string;
  businessId: string;
  access: FormAccess;
  description?: string;
}

/** Name -> CUSTOMER_COMPLAINT style code suggestion. */
export const suggestCode = (name: string) =>
  name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

export function createBlankForm(input: NewFormInput, user: { orgId?: string; uuid?: string }): FormDefinition {
  const stamp = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    orgId: user.orgId ?? '',
    businessId: input.businessId,
    name: input.name.trim(),
    code: input.code,
    description: input.description?.trim() || undefined,
    version: 1,
    status: 'DRAFT',
    access: input.access,
    fields: [],
    actions: {
      submit: { enabled: true, label: 'Submit' },
      cancel: { enabled: true, label: 'Clear', behavior: 'RESET' },
    },
    submission: {
      method: 'POST',
      endpointId: 'default-submit',
      success: { type: 'MESSAGE', message: 'Thank you. Your response has been submitted.' },
    },
    createdBy: user.uuid ?? 'unknown',
    updatedBy: user.uuid ?? 'unknown',
    createdAt: stamp,
    updatedAt: stamp,
  };
}
