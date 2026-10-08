import {
  AlignLeft,
  AtSign,
  Calendar,
  CalendarClock,
  CheckSquare,
  ChevronDownSquare,
  CircleDot,
  Code,
  Columns2,
  PanelTop,
  EyeOff,
  Hash,
  ListChecks,
  MousePointerClick,
  Paperclip,
  Phone,
  ShieldCheck,
  Type,
  type LucideIcon,
} from 'lucide-react';
import type { FieldType, FormField } from '../types';

export interface PaletteItem {
  type: FieldType;
  label: string;
  icon: LucideIcon;
  /** Why the item is disabled (e.g. a second CAPTCHA). */
  unavailable?: string;
}

export interface PaletteGroup {
  title: string;
  items: PaletteItem[];
}

export const PALETTE_GROUPS: PaletteGroup[] = [
  {
    title: 'Layout',
    items: [
      { type: 'COLUMNS', label: 'Columns', icon: Columns2 },
      { type: 'SECTION', label: 'Section', icon: PanelTop },
    ],
  },
  {
    title: 'Basic',
    items: [
      { type: 'TEXT', label: 'Text', icon: Type },
      { type: 'TEXTAREA', label: 'Paragraph', icon: AlignLeft },
      { type: 'NUMBER', label: 'Number', icon: Hash },
      { type: 'EMAIL', label: 'Email', icon: AtSign },
      { type: 'PHONE', label: 'Phone', icon: Phone },
      { type: 'DATE', label: 'Date', icon: Calendar },
      { type: 'DATETIME', label: 'Date & time', icon: CalendarClock },
    ],
  },
  {
    title: 'Selection',
    items: [
      { type: 'DROPDOWN', label: 'Dropdown', icon: ChevronDownSquare },
      { type: 'RADIO', label: 'Radio', icon: CircleDot },
      { type: 'CHECKBOX', label: 'Checkbox', icon: CheckSquare },
      { type: 'MULTI_SELECT', label: 'Multi-select', icon: ListChecks },
    ],
  },
  {
    title: 'Advanced',
    items: [
      { type: 'FILE', label: 'File upload', icon: Paperclip },
      { type: 'HTML', label: 'Content block', icon: Code },
      { type: 'BUTTON', label: 'Link button', icon: MousePointerClick },
      { type: 'CAPTCHA', label: 'CAPTCHA', icon: ShieldCheck },
    ],
  },
  {
    title: 'System',
    items: [{ type: 'HIDDEN', label: 'Hidden value', icon: EyeOff }],
  },
];

const ITEMS = new Map(PALETTE_GROUPS.flatMap((g) => g.items).map((i) => [i.type, i]));

export const paletteItem = (type: FieldType): PaletteItem | undefined => ITEMS.get(type);

const DEFAULT_LABEL: Partial<Record<FieldType, string>> = {
  TEXT: 'Text',
  TEXTAREA: 'Details',
  NUMBER: 'Number',
  EMAIL: 'Email',
  PHONE: 'Phone',
  DATE: 'Date',
  DATETIME: 'Date & time',
  DROPDOWN: 'Choose one',
  RADIO: 'Pick one',
  CHECKBOX: 'I agree',
  MULTI_SELECT: 'Choose any',
  FILE: 'Attachments',
  HTML: 'Section heading',
  SECTION: 'Section',
  BUTTON: 'Learn more',
};

/** `dropdown_1`, `dropdown_2`, ... - the first name of that pattern not already taken. */
export function uniqueFieldName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const stem = base.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  for (let n = 1; ; n++) {
    const candidate = `${stem}_${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Palette groups with per-form availability applied (one CAPTCHA per form). */
export function paletteFor(fields: FormField[]): PaletteGroup[] {
  const hasCaptcha = fields.some((f) => f.type === 'CAPTCHA');
  return PALETTE_GROUPS.map((g) => ({
    ...g,
    items: g.items.map((item) =>
      item.type === 'CAPTCHA' && hasCaptcha ? { ...item, unavailable: 'This form already has a CAPTCHA' } : item,
    ),
  }));
}

/** CAPTCHA settings a form gets when its first CAPTCHA field is added. Site key is filled in later. */
export const DEFAULT_CAPTCHA_CONFIG = { enabled: true, provider: 'RECAPTCHA', siteKey: '', mode: 'CHECKBOX' } as const;

/** A new field of `type` with sensible defaults, valid enough to preview immediately. */
export function createField(type: FieldType, takenNames: Iterable<string>): FormField {
  const taken = new Set(takenNames);
  const field: FormField = {
    id: crypto.randomUUID(),
    type,
    // CAPTCHA uses the payload key the backend expects.
    name: type === 'CAPTCHA' && !taken.has('captchaToken') ? 'captchaToken' : uniqueFieldName(type, taken),
  };
  const label = DEFAULT_LABEL[type];
  if (label) field.label = label;

  switch (type) {
    case 'DROPDOWN':
    case 'RADIO':
    case 'MULTI_SELECT':
      field.dataSource = {
        type: 'STATIC',
        options: [
          { label: 'Option 1', value: 'OPTION_1' },
          { label: 'Option 2', value: 'OPTION_2' },
        ],
      };
      break;
    case 'TEXTAREA':
      field.props = { rows: 4 };
      break;
    case 'HIDDEN':
      field.systemSource = 'BUSINESS_ID';
      break;
    case 'BUTTON':
      field.props = { href: '' };
      break;
    case 'FILE':
      field.validation = { max: 1 };
      field.props = { accept: ['image/*', 'application/pdf'], maxSizeMB: 5 };
      break;
    case 'HTML':
      field.props = { content: '' };
      break;
    case 'COLUMNS':
      field.props = { columns: [1, 1] };
      break;
    case 'SECTION':
      field.props = { description: '', collapsible: false };
      break;
  }
  return field;
}

/** Column layouts offered for a Columns block (relative widths). */
export const COLUMN_PRESETS: { label: string; value: string; weights: number[] }[] = [
  { label: '2 equal columns', value: '1-1', weights: [1, 1] },
  { label: '2 columns, wide right (1 : 2)', value: '1-2', weights: [1, 2] },
  { label: '2 columns, wide left (2 : 1)', value: '2-1', weights: [2, 1] },
  { label: '3 equal columns', value: '1-1-1', weights: [1, 1, 1] },
  { label: '3 columns, wide middle (1 : 2 : 1)', value: '1-2-1', weights: [1, 2, 1] },
  { label: '4 equal columns', value: '1-1-1-1', weights: [1, 1, 1, 1] },
];
