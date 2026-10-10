import type { FormField } from '../types';
import { TEMPLATE_FRAGMENTS } from '../../templates/industry/kit';

/** Ready-made sections to start a fragment from, so nobody has to begin with an empty one. Each can be changed afterwards. */
export interface FragmentStarter {
  key: string;
  name: string;
  description: string;
  fields: FormField[];
}
const options = (...labels: string[]) => ({ type: 'STATIC' as const, options: labels.map((label) => ({ label, value: label.toUpperCase().replace(/[^A-Z0-9]+/g, '_') })) });

export const FRAGMENT_STARTERS: FragmentStarter[] = [
  ...TEMPLATE_FRAGMENTS.map((f) => ({ key: f.id, name: f.name, description: f.description ?? '', fields: f.fields })),
  {
    key: 'contact-person',
    name: 'Contact person',
    description: 'Who to speak to: name, email and phone.',
    fields: [
      { id: 'cp_name', type: 'TEXT', name: 'contactName', label: 'Name', required: true },
      { id: 'cp_email', type: 'EMAIL', name: 'contactEmail', label: 'Email', required: true, width: 'half' },
      { id: 'cp_phone', type: 'PHONE', name: 'contactPhone', label: 'Phone', required: true, width: 'half' },
    ],
  },
  {
    key: 'company',
    name: 'Company details',
    description: 'A business: its name, kind, tax numbers and website.',
    fields: [
      { id: 'co_name', type: 'TEXT', name: 'companyName', label: 'Name of the business', required: true },
      { id: 'co_kind', type: 'DROPDOWN', name: 'companyKind', label: 'It is a', width: 'half', dataSource: options('Sole proprietorship', 'Partnership', 'LLP', 'Private limited company', 'Public limited company', 'Trust or society') },
      { id: 'co_gstin', type: 'TEXT', name: 'gstin', label: 'GSTIN', width: 'half', validation: { minLength: 15, maxLength: 15 } },
      { id: 'co_pan', type: 'TEXT', name: 'pan', label: 'PAN', width: 'half', validation: { pattern: '^[A-Za-z]{5}[0-9]{4}[A-Za-z]$', messages: { pattern: 'A PAN is 5 letters, 4 digits and a letter' } } },
      { id: 'co_site', type: 'URL', name: 'website', label: 'Website', width: 'half' },
    ],
  },
  {
    key: 'emergency-contact',
    name: 'Emergency contact',
    description: 'Whom to call if something goes wrong.',
    fields: [
      { id: 'em_name', type: 'TEXT', name: 'emergencyName', label: 'Whom to call in an emergency', required: true, width: 'half' },
      { id: 'em_relation', type: 'DROPDOWN', name: 'emergencyRelation', label: 'Relation', width: 'half', dataSource: options('Spouse', 'Parent', 'Son or daughter', 'Brother or sister', 'Friend', 'Other') },
      { id: 'em_phone', type: 'PHONE', name: 'emergencyPhone', label: 'Their phone', required: true, width: 'half' },
    ],
  },
  {
    key: 'identity',
    name: 'Identity document',
    description: 'A photo identity: which one, its number and a copy.',
    fields: [
      { id: 'id_type', type: 'DROPDOWN', name: 'idType', label: 'Photo identity', required: true, width: 'half', dataSource: options('Aadhaar', 'Passport', 'Driving licence', 'Voter card', 'PAN card') },
      { id: 'id_number', type: 'TEXT', name: 'idNumber', label: 'Number on it', required: true, width: 'half' },
      { id: 'id_copy', type: 'FILE', name: 'idCopy', label: 'A copy of it', required: true },
    ],
  },
];
