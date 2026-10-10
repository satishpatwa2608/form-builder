/**
 * A small vocabulary for writing long forms as a tree (steps holding fields, columns, tabs, repeating sections)
 * and turning that tree into the flat field list a form definition holds. Only used by the industry templates.
 */
export type Node = { type: string; name: string; label?: string; children?: Node[]; columns?: Node[][]; weights?: number[]; [key: string]: unknown };
type Extra = Record<string, unknown>;
type Opt = string | [value: string, label: string];

const code = (label: string) =>
  label
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
export const opts = (...items: Opt[]) => ({ type: 'STATIC' as const, options: items.map((o) => (Array.isArray(o) ? { value: o[0], label: o[1] } : { value: code(o), label: o })) });

const field = (type: string) => (name: string, label: string, extra: Extra = {}): Node => ({ type, name, label, ...extra });
const choice = (type: string) => (name: string, label: string, options: Opt[], extra: Extra = {}): Node => ({ type, name, label, dataSource: opts(...options), ...extra });

export const text = field('TEXT');
export const area = field('TEXTAREA');
export const num = field('NUMBER');
export const email = field('EMAIL');
export const phone = field('PHONE');
export const date = field('DATE');
export const dateTime = field('DATETIME');
export const time = field('TIME');
export const month = field('MONTH');
export const url = field('URL');
export const color = field('COLOR');
export const check = field('CHECKBOX');
export const toggle = field('SWITCH');
export const file = field('FILE');
export const sign = field('SIGNATURE');
export const button = field('BUTTON');
export const dropdown = choice('DROPDOWN');
export const radio = choice('RADIO');
export const multi = choice('MULTI_SELECT');
export const checks = choice('CHECKBOX_GROUP');
export const yesNo = (name: string, label: string, extra: Extra = {}) => radio(name, label, [['YES', 'Yes'], ['NO', 'No']], extra);
export const slider = (name: string, label: string, min: number, max: number, step: number, extra: Extra = {}): Node => ({ type: 'SLIDER', name, label, validation: { min, max }, props: { step }, ...extra });
export const stepper = (name: string, label: string, min: number, max: number, extra: Extra = {}): Node => ({ type: 'STEPPER', name, label, validation: { min, max }, props: { step: 1 }, ...extra });
export const note = (name: string, content: string, extra: Extra = {}): Node => ({ type: 'HTML', name, props: { content }, ...extra });
export const picture = (name: string, alt: string): Node => ({ type: 'IMAGE', name, props: { alt } });
export const consent = (name: string, label: string, terms: string, extra: Extra = {}): Node => ({ type: 'CONSENT', name, label, required: true, props: { text: terms }, ...extra });
export const hidden = (name: string, systemSource: string, systemParam?: string): Node => ({ type: 'HIDDEN', name, systemSource, ...(systemParam ? { systemParam } : {}) });
export const captcha = (): Node => ({ type: 'CAPTCHA', name: 'captchaToken' });

/** A step of the form (a top-level section), or a titled group inside one. */
export const section = (name: string, label: string, children: Node[], extra: Extra = {}): Node => ({ type: 'SECTION', name, label, children, ...extra });
export const columns = (name: string, cols: Node[][], weights?: number[]): Node => ({ type: 'COLUMNS', name, columns: cols, weights });
export const tabs = (name: string, sections: Node[], orientation: 'horizontal' | 'vertical' = 'horizontal'): Node => ({ type: 'TABS', name, children: sections, props: { orientation } });
export const accordion = (name: string, sections: Node[]): Node => ({ type: 'ACCORDION', name, children: sections });
/** A section people add copies of. `totals` names the number fields inside it that are added up. */
export const repeat = (name: string, label: string, children: Node[], rows: { min?: number; max?: number; totals?: string[] } = {}, extra: Extra = {}): Node => ({
  type: 'REPEAT',
  name,
  label,
  children,
  validation: { ...(rows.min !== undefined ? { min: rows.min } : {}), ...(rows.max !== undefined ? { max: rows.max } : {}) },
  ...(rows.totals ? { props: { totals: rows.totals } } : {}),
  ...extra,
});

// Small pieces of wording used on almost every field.
export const req = { required: true } as const;
export const half = { width: 'half' } as const;
export const third = { width: 'third' } as const;
export const twoThirds = { width: 'two-thirds' } as const;
export const is = (fieldName: string, value: unknown) => ({ field: fieldName, operator: 'equals' as const, value });
export const isNot = (fieldName: string, value: unknown) => ({ field: fieldName, operator: 'notEquals' as const, value });
export const has = (fieldName: string, value: unknown) => ({ field: fieldName, operator: 'contains' as const, value });
export const oneOf = (fieldName: string, values: unknown[]) => ({ field: fieldName, operator: 'in' as const, value: values });
export const showIf = (when: unknown) => ({ visibility: { when } });
export const pattern = (regex: string, message: string, more: Extra = {}) => ({ validation: { pattern: regex, messages: { pattern: message }, ...more } });

/** The tree as the flat list a definition holds: every field gets an id and says which container (and column) it is in. */
export function flatten(prefix: string, nodes: Node[], parentId?: string, column?: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const node of nodes) {
    const { children, columns: cols, weights, ...rest } = node;
    const id = `${prefix}_${node.name}`;
    const props = cols ? { ...(rest.props as object | undefined), columns: weights ?? cols.map(() => 1) } : rest.props;
    out.push({ id, ...rest, ...(props ? { props } : {}), ...(parentId ? { parentId, ...(column ? { column } : {}) } : {}) });
    if (children) out.push(...flatten(prefix, children, id));
    cols?.forEach((items, i) => out.push(...flatten(prefix, items, id, i)));
  }
  return out;
}

/** A calculation: the field always shows what the formula works out to. */
export const calc = (id: string, target: string, formula: string, name?: string) => ({ id, ...(name ? { name } : {}), then: [{ type: 'SET_VALUE' as const, target, value: formula }] });
/** A check across fields: when the condition holds, the field shows the message and the form cannot be sent. */
export const refuse = (id: string, when: string, target: string, message: string) => ({ id, when: { expr: when }, then: [{ type: 'ERROR' as const, target, message }] });
/** The second list offers only what goes with the choice made in the first. */
export const narrow = (prefix: string, parent: string, target: string, map: Record<string, string[]>) =>
  Object.entries(map).map(([value, values], i) => ({ id: `${prefix}_${i + 1}`, name: `${target} for ${value}`, when: is(parent, value), then: [{ type: 'SET_OPTIONS' as const, target, values }] }));

export interface IndustryTemplate {
  key: string;
  industry: string;
  name: string;
  description: string;
  /** What to set before publishing. */
  setup: string[];
  definition: Record<string, unknown>;
}

export const STATES = ['Andhra Pradesh', 'Delhi', 'Gujarat', 'Haryana', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Punjab', 'Rajasthan', 'Tamil Nadu', 'Telangana', 'Uttar Pradesh', 'West Bengal', 'Other'];
export const RELATIONS = ['Spouse', 'Son', 'Daughter', 'Father', 'Mother', 'Brother', 'Sister', 'Other'];
export const PAN = pattern('^[A-Za-z]{5}[0-9]{4}[A-Za-z]$', 'A PAN is 5 letters, 4 digits and a letter, for example ABCDE1234F');
export const PIN = pattern('^[1-9][0-9]{5}$', 'A PIN code is 6 digits');
export const IFSC = pattern('^[A-Za-z]{4}0[A-Za-z0-9]{6}$', 'An IFSC is 11 characters, for example HDFC0001234');

/** The address block almost every form asks for, with its own field names. */
export const address = (p: string, label = 'Address') => [
  area(`${p}Address`, label, { ...req, validation: { maxLength: 300 } }),
  text(`${p}City`, 'City', { ...req, ...third }),
  dropdown(`${p}State`, 'State', STATES, { ...req, ...third }),
  text(`${p}Pin`, 'PIN code', { ...req, ...third, ...PIN }),
];

/** Statuses, in the order work moves through them; the last two are the ways it ends. */
export const confirmation = (id: string, emailField: string, subject: string, body: string) => ({
  id,
  name: 'Confirmation to the applicant',
  enabled: true,
  when: 'SUBMITTED',
  actions: [{ type: 'EMAIL', to: [{ kind: 'FIELD', field: emailField }], subject, body }],
});
