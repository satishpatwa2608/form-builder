import customerComplaint from './customer-complaint.json';
import plantIssueReport from './plant-issue-report.json';
import supplierRegistration from './supplier-registration.json';
import { FORM_TEMPLATES as PROCESS_TEMPLATES } from '../form/builder/templates';
import { INDUSTRY_TEMPLATES } from './industry';

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
