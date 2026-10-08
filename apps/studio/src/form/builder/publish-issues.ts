import type { FormDefinition } from '../types';
import { validateFormDefinition } from '../engine';

export interface PublishIssue {
  message: string;
  /** The field the issue belongs to, so the UI can jump to it. */
  fieldId?: string;
  fieldLabel?: string;
}

/**
 * Everything that would stop this definition from publishing, attributed to
 * a field where the validator's path points at one (`fields.<index>.<key>`).
 */
export function publishIssues(def: FormDefinition): PublishIssue[] {
  const result = validateFormDefinition(def, 'publish');
  if (result.success) return [];
  return result.issues.map((issue) => {
    const match = /^fields\.(\d+)/.exec(issue.path);
    const field = match ? def.fields[Number(match[1])] : undefined;
    return {
      message: issue.message,
      fieldId: field?.id,
      fieldLabel: field ? field.label || field.name : /^(workflow|automations)\b/.test(issue.path) ? 'Workflow' : /^rules\b/.test(issue.path) ? 'Rules' : undefined,
    };
  });
}
