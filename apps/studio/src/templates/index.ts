import customerComplaint from './customer-complaint.json';
import plantIssueReport from './plant-issue-report.json';
import supplierRegistration from './supplier-registration.json';
import { FORM_TEMPLATES as PROCESS_TEMPLATES } from '../form/builder/templates';
import { INDUSTRY_TEMPLATES } from './industry';
import { resolveSharedWorkflow, type SharedWorkflow } from '@fb/engine';
import { TEMPLATE_FRAGMENTS, TEMPLATE_WORKFLOWS } from './industry/kit';

/** Starting points for "New form" until the visual builder (and its process templates) is ported. */
export interface FormTemplate {
  key: string;
  label: string;
  description: string;
  /** Definition without identity; the server sets id, org, version, status and authorship. */
  definition: Record<string, unknown>;
  /** What to set before publishing (process templates). */
  setup?: string[];
  /** The industry a long, ready-made form belongs to. Without one it is a general starting point. */
  industry?: string;
  /** Saved inbox views made with the form, shared with the team (its overdue work, say). */
  views?: { name: string; filters: Record<string, string> }[];
}

const strip = (def: Record<string, unknown>) => {
  const { id: _id, orgId: _orgId, version: _version, status: _status, createdBy: _c, updatedBy: _u, ...rest } = def;
  return rest;
};

export const FORM_TEMPLATES: FormTemplate[] = [
  {
    key: 'blank',
    label: 'Blank form',
    description: 'Start empty (add fields in the builder).',
    definition: { businessId: '', access: 'PUBLIC', fields: [], submission: { method: 'POST', endpointId: 'default-submit' } },
  },
  { key: 'complaint', label: 'Customer complaint', description: 'Contact details, category, description and attachments.', definition: strip(customerComplaint as Record<string, unknown>) },
  { key: 'plant', label: 'Plant issue report', description: 'Machine, shift, issue type and severity for the shop floor.', definition: strip(plantIssueReport as Record<string, unknown>) },
  { key: 'supplier', label: 'Supplier registration', description: 'Company, tax and bank details for onboarding a vendor.', definition: strip(supplierRegistration as Record<string, unknown>) },
  // Whole processes (form + statuses, actions, SLA, approvals, automations), ported from Sangam.
  ...PROCESS_TEMPLATES.map((t) => ({
    key: t.key,
    label: t.name,
    description: t.description,
    setup: t.setup,
    views: t.views,
    definition: { businessId: '', submission: { method: 'POST', endpointId: 'default-submit' }, ...t.definition, name: t.name } as Record<string, unknown>,
  })),
  // Long multi-step forms by industry (./industry): each uses steps, calculations, repeating sections and its own workflow.
  ...INDUSTRY_TEMPLATES.map((t) => ({ key: t.key, label: t.name, description: t.description, setup: t.setup, industry: t.industry, definition: { businessId: '', ...t.definition, name: t.name } as Record<string, unknown> })),
];

/** "Leave request" -> "LEAVE_REQUEST" (the engine's code format). */
export const codeFromName = (name: string) =>
  name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);

interface TemplateStyle {
  id: string;
  name: string;
  description?: string;
  props: Record<string, unknown>;
}

/**
 * A template can bring its own styles (the supplier form's "Highlight box").
 * A new organisation's style library does not have them, and a form that
 * names a style the library lacks cannot be published. So before the form is
 * created, each style it uses and the library lacks is added to the library;
 * where that is refused (only admins manage styles) the form is created
 * without that style rather than left unpublishable.
 *
 * Returns the definition to create and the names of any styles left out.
 */
export async function prepareTemplate(
  definition: Record<string, unknown>,
  library: { existing: () => Promise<string[]>; add: (style: TemplateStyle) => Promise<unknown> },
): Promise<{ definition: Record<string, unknown>; leftOut: string[] }> {
  const { styles, ...rest } = definition as { styles?: TemplateStyle[]; fields?: { styleId?: string }[]; theme?: { styleId?: string } };
  const fields = rest.fields ?? [];
  const used = new Set([rest.theme?.styleId, ...fields.map((f) => f.styleId)].filter((id): id is string => !!id));
  if (!used.size) return { definition: rest, leftOut: [] };

  const have = new Set(await library.existing());
  const missing = new Set<string>();
  const leftOut: string[] = [];
  for (const id of used) {
    if (have.has(id)) continue;
    const style = (styles ?? []).find((s) => s.id === id);
    try {
      if (!style) throw new Error('The template does not carry this style');
      await library.add(style);
    } catch {
      missing.add(id);
      leftOut.push(style?.name ?? id);
    }
  }
  if (!missing.size) return { definition: rest, leftOut };

  const without = <T extends { styleId?: string }>(item: T): T => {
    if (!item.styleId || !missing.has(item.styleId)) return item;
    const { styleId: _styleId, ...kept } = item;
    return kept as T;
  };
  return { definition: { ...rest, fields: fields.map(without), ...(rest.theme ? { theme: without(rest.theme) } : {}) }, leftOut };
}

/** The industries that have ready-made forms, in the order they are offered. */
export const INDUSTRIES = [...new Set(FORM_TEMPLATES.map((t) => t.industry).filter((i): i is string => !!i))];

interface FragmentLibrary {
  existing: () => Promise<{ id: string; name: string }[]>;
  add: (fragment: { name: string; description?: string; fields: unknown[] }) => Promise<{ id: string }>;
}

/**
 * A template's sections can be copies of library fragments ("Address", "Bank account"). Before the form is
 * created each fragment it uses is found in the organisation's library by name, or added to it, and the form's
 * sections are pointed at the library's own. Where adding is refused (only admins manage the library) the
 * section is left as it is and the server keeps it as a section of the form's own: nothing is lost but the link.
 *
 * Returns the definition to create and the names of the fragments now linked.
 */
export async function linkTemplateFragments(definition: Record<string, unknown>, library: FragmentLibrary): Promise<{ definition: Record<string, unknown>; linked: string[] }> {
  const fields = (definition.fields ?? []) as { type?: string; props?: { fragment?: { id?: string; prefix?: string } } }[];
  const used = [...new Set(fields.map((f) => f.props?.fragment?.id).filter((id): id is string => !!id))];
  const ours = TEMPLATE_FRAGMENTS.filter((t) => used.includes(t.id));
  if (!ours.length) return { definition, linked: [] };
  const real = new Map<string, string>();
  const linked: string[] = [];
  let have: { id: string; name: string }[] = [];
  try {
    have = await library.existing();
  } catch {
    return { definition, linked };
  }
  for (const t of ours) {
    try {
      const found = have.find((f) => f.name === t.name) ?? (await library.add({ name: t.name, description: t.description, fields: t.fields }));
      real.set(t.id, found.id);
      linked.push(t.name);
    } catch {
      /* left as a section of the form's own */
    }
  }
  return { definition: { ...definition, fields: fields.map((f) => (f.props?.fragment?.id && real.has(f.props.fragment.id) ? { ...f, props: { ...f.props, fragment: { ...f.props.fragment, id: real.get(f.props.fragment.id)! } } } : f)) }, linked };
}

interface WorkflowLibrary {
  existing: () => Promise<{ id: string; name: string }[]>;
  add: (workflow: Record<string, unknown>) => Promise<{ id: string }>;
}

/**
 * A template can run on a workflow from the library ("Service request") instead of one of its own. Before the
 * form is created that workflow is found in the organisation's library by name, or added to it, and the form
 * is pointed at it. Where the library cannot be changed the workflow is written into the form itself, so the
 * form still works: it is then the form's own, and no longer shared.
 */
export async function linkTemplateWorkflow(definition: Record<string, unknown>, library: WorkflowLibrary): Promise<{ definition: Record<string, unknown>; shared: string | null }> {
  const ref = definition.workflowRef as { id: string; refPrefix?: string } | undefined;
  const ours = ref && TEMPLATE_WORKFLOWS.find((w) => w.id === ref.id);
  if (!ref || !ours) return { definition, shared: null };
  try {
    const { id: _id, ...body } = ours;
    const found = (await library.existing()).find((w) => w.name === ours.name) ?? (await library.add(body));
    return { definition: { ...definition, workflowRef: { ...ref, id: found.id } }, shared: ours.name };
  } catch {
    const { workflowRef: _ref, ...own } = resolveSharedWorkflow(definition as never, ours as unknown as SharedWorkflow).definition as unknown as Record<string, unknown>;
    return { definition: own, shared: null };
  }
}
