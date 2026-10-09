import type { FormDefinition } from '../types';
import { resolveSharedWorkflow, validateFormDefinition, type SharedWorkflow } from '../engine';

export interface PublishIssue {
  message: string;
  /** The field the issue belongs to, so the UI can jump to it. */
  fieldId?: string;
  fieldLabel?: string;
}

/**
 * Everything that would stop this definition from publishing, attributed to
 * a field where the validator's path points at one (`fields.<index>.<key>`).
 * A form that uses a library workflow is judged with that workflow written in,
 * as the server will publish it; `library` is undefined until it has loaded.
 */
export function publishIssues(form: FormDefinition, library?: SharedWorkflow[]): PublishIssue[] {
  let def = form;
  if (form.workflowRef && library) {
    const shared = library.find((w) => w.id === form.workflowRef!.id);
    if (!shared) return [{ message: 'The shared workflow this form uses is no longer in the library. Choose another, or give the form its own.', fieldLabel: 'Workflow' }];
    const resolved = resolveSharedWorkflow(form, shared);
    def = resolved.definition;
    // Until every answer is matched the workflow still names fields this form lacks; say only what to do about it.
    if (resolved.missing.length) {
      return resolved.missing.map((need) => ({ message: `"${shared.name}" needs "${need.label}". Choose which of this form's fields that is.`, fieldLabel: 'Workflow' }));
    }
  } else if (form.workflowRef) {
    // Not known yet: the form's own, unused workflow must not raise problems meanwhile.
    def = { ...form, workflow: undefined, automations: [] };
  }
  const result = validateFormDefinition(def, 'publish');
  if (result.success) return [];
  return result.issues.map((issue) => {
    const match = /^fields\.(\d+)/.exec(issue.path);
    const field = match ? def.fields[Number(match[1])] : undefined;
    return {
      message: issue.message,
      fieldId: field?.id,
      fieldLabel: field ? field.label || field.name : /^(workflow|automations)\b/.test(issue.path) ? 'Workflow' : /^(rules|events)\b/.test(issue.path) ? 'Rules' : undefined,
    };
  });
}
