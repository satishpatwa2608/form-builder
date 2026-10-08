import customerComplaint from './customer-complaint.json';
import plantIssueReport from './plant-issue-report.json';
import supplierRegistration from './supplier-registration.json';
import { FORM_TEMPLATES as PROCESS_TEMPLATES } from '../form/builder/templates';

/** Starting points for "New form" until the visual builder (and its process templates) is ported. */
export interface FormTemplate {
  key: string;
  label: string;
  description: string;
  /** Definition without identity; the server sets id, org, version, status and authorship. */
  definition: Record<string, unknown>;
  /** What to set before publishing (process templates). */
  setup?: string[];
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
];

/** "Leave request" -> "LEAVE_REQUEST" (the engine's code format). */
export const codeFromName = (name: string) =>
  name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
