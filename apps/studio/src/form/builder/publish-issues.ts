import type { FormDefinition } from '../types';
import { fragmentUse, fragmentUseProblems, resolveSharedWorkflow, validateFormDefinition, type Fragment, type SharedWorkflow } from '../engine';

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
export function publishIssues(form: FormDefinition, library?: SharedWorkflow[], fragments?: Fragment[]): PublishIssue[] {
  // Sections copied from fragments: told apart when used twice, and still in the library (once that is known).
  const sections = form.fields.filter((f) => fragmentUse(f));
  const fromFragments: PublishIssue[] = [
    ...fragmentUseProblems(form.fields).map((message) => ({ message })),
    ...(fragments ? sections.filter((s) => !fragments.some((f) => f.id === fragmentUse(s)!.id)) : []).map((s) => ({
      message: `The fragment "${s.label || s.name}" is no longer in the library. Detach the section to keep its fields, or remove it.`,
      fieldId: s.id,
      fieldLabel: s.label || s.name,
    })),
  ];
  if (fromFragments.length) return fromFragments;
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
