/**
 * A small vocabulary for writing long forms as a tree (steps holding fields, columns, tabs, repeating sections)
 * and turning that tree into the flat field list a form definition holds. Only used by the industry templates.
 */
import { fragmentCopy, type FormField, type Fragment } from '@fb/engine';

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
export function flatten(prefix: string, given: Node[], parentId?: string, column?: number): Record<string, unknown>[] {
  let nodes = given;
  // Values the system fills in sit unseen inside the first step: on their own at the top they would make an empty step of their own.
  const first = !parentId ? given.find((n) => n.type === 'SECTION') : undefined;
  if (first) {
    const unseen = given.filter((n) => n.type === 'HIDDEN');
    nodes = given.filter((n) => n.type !== 'HIDDEN').map((n) => (n === first ? { ...n, children: [...(n.children ?? []), ...unseen] } : n));
  }
  const out: Record<string, unknown>[] = [];
  for (const node of nodes) {
    const { children, columns: cols, weights, ...rest } = node;
    const id = `${prefix}_${node.name}`;
    const props = cols ? { ...(rest.props as object | undefined), columns: weights ?? cols.map(() => 1) } : rest.props;
    const use = rest.fragment as { id: string; prefix: string } | undefined;
    if (use) {
      // A section that is a copy of a library fragment: its fields are the fragment's, named for this use of it.
      const { fragment: _use, ...sectionNode } = rest;
      const sectionField = { id, ...sectionNode, props: { fragment: use }, ...(parentId ? { parentId, ...(column ? { column } : {}) } : {}) } as unknown as FormField;
      out.push(sectionField as unknown as Record<string, unknown>, ...(fragmentCopy(sectionField, TEMPLATE_FRAGMENTS.find((f) => f.id === use.id)!) as unknown as Record<string, unknown>[]));
      continue;
    }
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

/**
 * Sections kept once in the organisation's library and used by many forms. A form holds a copy, named for
 * where it is used (`owner_city`, `delivery_city`); change the fragment in the library and every form takes
 * the change at its next publish. "New form" adds them to the library the first time one is needed.
 */
export const TEMPLATE_FRAGMENTS: Fragment[] = [
  {
    id: 'tpl-address',
    name: 'Address',
    description: 'A postal address: lines, city, state and PIN code.',
    fields: [
      { id: 'adr_line', type: 'TEXTAREA', name: 'address', label: 'House, street and area', required: true, validation: { maxLength: 300 } },
      { id: 'adr_city', type: 'TEXT', name: 'city', label: 'City', required: true, width: 'third' },
      { id: 'adr_state', type: 'DROPDOWN', name: 'state', label: 'State', required: true, width: 'third', dataSource: opts(...STATES) },
      { id: 'adr_pin', type: 'TEXT', name: 'pin', label: 'PIN code', required: true, width: 'third', validation: { pattern: '^[1-9][0-9]{5}$', messages: { pattern: 'A PIN code is 6 digits' } } },
    ] as FormField[],
  },
  {
    id: 'tpl-bank-account',
    name: 'Bank account',
    description: 'An account to pay money into: holder, number, IFSC and bank.',
    fields: [
      { id: 'bnk_holder', type: 'TEXT', name: 'accountHolder', label: 'Account holder', required: true, width: 'half' },
      { id: 'bnk_number', type: 'TEXT', name: 'accountNo', label: 'Account number', required: true, width: 'half', validation: { pattern: '^[0-9]{9,18}$', messages: { pattern: 'An account number is 9 to 18 digits' } } },
      { id: 'bnk_ifsc', type: 'TEXT', name: 'ifsc', label: 'IFSC', required: true, width: 'half', validation: { pattern: '^[A-Za-z]{4}0[A-Za-z0-9]{6}$', messages: { pattern: 'An IFSC is 11 characters, for example HDFC0001234' } } },
      { id: 'bnk_bank', type: 'TEXT', name: 'bankName', label: 'Bank and branch', required: true, width: 'half' },
    ] as FormField[],
  },
];
const fragmentSection = (id: string, prefix: string, label: string): Node[] => [{ type: 'SECTION', name: `${prefix}Block`, label, fragment: { id, prefix } }];

/** The Address fragment, under the heading given; its fields are `<prefix>_address`, `_city`, `_state` and `_pin`. */
export const address = (p: string, label = 'Address') => fragmentSection('tpl-address', p, label);
/** The Bank account fragment: `<prefix>_accountHolder`, `_accountNo`, `_ifsc` and `_bankName`. */
export const bank = (p: string, label = 'Bank account') => fragmentSection('tpl-bank-account', p, label);

/** Statuses, in the order work moves through them; the last two are the ways it ends. */
export const confirmation = (id: string, emailField: string, subject: string, body: string) => ({
  id,
  name: 'Confirmation to the applicant',
  enabled: true,
  when: 'SUBMITTED',
  actions: [{ type: 'EMAIL', to: [{ kind: 'FIELD', field: emailField }], subject, body }],
});

// ── Shorthand for writing many forms the same way ──────────────────────────

/** A status of the workflow: its key, what people call it, where it stands, and (if any) the hours it may take. */
export const st = (key: string, label: string, category: 'OPEN' | 'IN_PROGRESS' | 'DONE', slaHours?: number) => ({ key, label, category, ...(slaHours ? { slaHours } : {}) });
/** A button on a record: what it is called, the statuses it is offered in, and where it moves the record. */
export const act = (key: string, label: string, from: string[], to: string, more: Record<string, unknown> = {}) => ({ key, label, from, to, ...more });
export const flow = (refPrefix: string, statuses: ReturnType<typeof st>[], actions: ReturnType<typeof act>[], more: Record<string, unknown> = {}) => ({
  enabled: true,
  refPrefix,
  statuses,
  assignment: { type: 'NONE' },
  priority: { default: 'MEDIUM' },
  actions,
  ...more,
});
/** The three things almost every form asks of the person: who they are and how to reach them. */
export const contact = (nameLabel = 'Full name') => [text('fullName', nameLabel, req), email('email', 'Email', { ...req, ...half }), phone('mobile', 'Mobile number', { ...req, ...half })];
/** The last things on a form: what the person declares, and their signature. */
export const declare = (terms: string, signer = 'Your signature') => [consent('declaration', 'Declaration', terms), sign('signature', signer, req)];

/** A form in steps, with a last look before sending, save-and-return and a PDF of each response. */
export function make(
  key: string,
  industry: string,
  name: string,
  description: string,
  setup: string[],
  tree: Node[],
  more: Record<string, unknown> = {},
): IndustryTemplate {
  const { intro, ...rest } = more as { intro?: string };
  return {
    key,
    industry,
    name,
    description,
    setup,
    definition: {
      access: 'PUBLIC',
      description: intro ?? description,
      layout: { mode: 'steps', review: true },
      saveForLater: true,
      document: { keep: true, title: name },
      submission: { method: 'POST', endpointId: 'default-submit' },
      fields: flatten(key.replace(/[^a-z0-9]/g, ''), tree),
      ...rest,
    },
  };
}

/**
 * A workflow kept once in the organisation's library and used by several forms. A form names it instead of
 * building its own; when the form is published the workflow is copied into that version. "New form" adds it to
 * the library the first time a form needs it.
 */
export const TEMPLATE_WORKFLOWS = [
  {
    id: 'tpl-service-request',
    name: 'Service request',
    description: 'A request someone sends in and a desk completes: received, in hand, waiting for the person, done or declined. Used as it is by several forms.',
    // What it reads from whichever form uses it.
    fields: [{ name: 'email', label: "The requester's email", type: 'EMAIL' }],
    workflow: flow(
      'SR',
      [st('RECEIVED', 'Received', 'OPEN', 8), st('IN_HAND', 'In hand', 'IN_PROGRESS', 24), st('WAITING', 'Waiting for the requester', 'IN_PROGRESS'), st('COMPLETED', 'Completed', 'DONE'), st('DECLINED', 'Declined', 'DONE')],
      [
        act('start', 'Start work', ['RECEIVED', 'WAITING'], 'IN_HAND'),
        act('ask', 'Ask the requester', ['RECEIVED', 'IN_HAND'], 'WAITING', { requireComment: true }),
        act('complete', 'Complete', ['IN_HAND'], 'COMPLETED'),
        act('decline', 'Decline', ['RECEIVED', 'IN_HAND'], 'DECLINED', { requireComment: true }),
      ],
      { contactEmailField: 'email', requestInfoStatus: 'WAITING', reopen: { to: 'IN_HAND', withinDays: 15 }, sla: { calendar: 'WORKING', responseHours: 8, resolutionHours: 40, pauseIn: ['WAITING'], warnAtPercent: 80 } },
    ),
    automations: [
      { id: 'sr_received', name: 'Tell the requester we have it', enabled: true, when: 'SUBMITTED', actions: [{ type: 'EMAIL', to: [{ kind: 'FIELD', field: 'email' }], subject: 'We have your request', body: 'Thank you. Your request has reached us and you will hear from us when it is done.' }] },
      { id: 'sr_done', name: 'Tell the requester it is done', enabled: true, when: 'STATUS_CHANGED', toStatus: 'COMPLETED', actions: [{ type: 'EMAIL', to: [{ kind: 'FIELD', field: 'email' }], subject: 'Your request is complete', body: 'Your request has been completed. Reply within 15 days if anything is not right and we will look again.' }] },
      { id: 'sr_late', name: 'Raise a late request', enabled: true, when: 'SLA_BREACHED', sla: 'RESOLUTION', actions: [{ type: 'NOTIFY', to: [{ kind: 'MANAGER' }], message: 'A service request has passed its service time.' }] },
    ],
  },
];
