import { validateFormDefinition, type FormDefinition, type FormField } from '@fb/engine';

/**
 * Turning an AI service's answer into the start of a form. The service is asked for questions only, in a small
 * JSON shape of our own (DRAFT_INSTRUCTIONS). What comes back is read as untrusted text: only the kinds of
 * question listed here are taken, every limit is applied, each condition must point at an earlier question and
 * one of its choices, and the result goes through the same validation as any form. Whatever does not pass is
 * left out and said so, never published: a person reads the draft, changes it and publishes it.
 */

export const DRAFT_LIMITS = { description: 2000, fields: 60, label: 200, choices: 50, choice: 100 } as const;

/** What the service is told. The description itself is sent separately, as the user's message. */
export const DRAFT_INSTRUCTIONS = `You draft online forms. Reply with one JSON object and nothing else, in this shape:
{"title": "short name of the form", "description": "one sentence shown at the top", "questions": [
  {"label": "the question as the person filling in sees it", "type": "short_text | long_text | email | phone | number | date | choice | yes_no | file",
   "choices": ["only for choice: the answers to pick from"], "many": false, "required": true,
   "showWhen": {"question": "the label of an EARLIER choice or yes_no question", "is": ["one or more of its answers"]}}
]}
Rules: ask only what the description needs, in a sensible order, at most ${DRAFT_LIMITS.fields} questions. Use "choice" when the answers are a known list, with "many": true when several may be picked. Use showWhen for questions that only matter after a certain answer. Do not add workflows, emails, approvals, payments, scripts or anything other than questions.`;

type Kind = 'short_text' | 'long_text' | 'email' | 'phone' | 'number' | 'date' | 'choice' | 'yes_no' | 'file';
const TYPES: Record<Exclude<Kind, 'choice' | 'yes_no'>, FormField['type']> = {
  short_text: 'TEXT',
  long_text: 'TEXTAREA',
  email: 'EMAIL',
  phone: 'PHONE',
  number: 'NUMBER',
  date: 'DATE',
  file: 'FILE',
};

export interface ReadDraft {
  title: string;
  description: string;
  fields: FormField[];
  /** What was in the answer and was not used, in plain words. */
  leftOut: string[];
}

/** The JSON object in a reply, even when wrapped in a code fence or a sentence. */
function jsonIn(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1)) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** "Which property?" -> "whichProperty"; unique among `taken`. */
function nameFrom(label: string, taken: Set<string>): string {
  const words = label
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);
  let base = words.map((w, i) => (i ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('') || 'question';
  if (!/^[A-Za-z_]/.test(base)) base = `q${base}`;
  base = base.slice(0, 40);
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
  taken.add(name);
  return name;
}

/** "Leak or plumbing" -> "LEAK_OR_PLUMBING"; unique among `taken`. */
function codeFrom(label: string, taken: Set<string>): string {
  const base =
    label
      .normalize('NFKD')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'OPTION';
  let code = base;
  for (let n = 2; taken.has(code); n++) code = `${base}_${n}`;
  taken.add(code);
  return code;
}

export function readDraft(reply: string): ReadDraft {
  const leftOut: string[] = [];
  const json = jsonIn(reply);
  if (!json) return { title: '', description: '', fields: [], leftOut: ['The answer was not in the form asked for, so nothing could be drafted. Try again, or describe the form differently.'] };
  for (const key of Object.keys(json)) if (!['title', 'description', 'questions'].includes(key)) leftOut.push(`"${clean(key, 40)}" in the answer: only questions are drafted`);
  const raw = Array.isArray(json.questions) ? json.questions : [];
  if (raw.length > DRAFT_LIMITS.fields) leftOut.push(`${raw.length - DRAFT_LIMITS.fields} questions after the first ${DRAFT_LIMITS.fields}`);

  const names = new Set<string>();
  const fields: FormField[] = [];
  /** Earlier questions by their label, with their choices by label, for conditions. */
  const earlier = new Map<string, { name: string; choices: Map<string, string> }>();
  raw.slice(0, DRAFT_LIMITS.fields).forEach((q, i) => {
    const item = q && typeof q === 'object' && !Array.isArray(q) ? (q as Record<string, unknown>) : {};
    const label = clean(item.label, DRAFT_LIMITS.label);
    const kind = String(item.type ?? '') as Kind;
    if (!label) return leftOut.push(`Question ${i + 1}: it had no wording`);
    if (!(kind in TYPES) && kind !== 'choice' && kind !== 'yes_no') return leftOut.push(`"${label}": "${clean(item.type, 30)}" is not a kind of question that is drafted`);
    const field: FormField = { id: `ai_${i + 1}`, type: 'TEXT', name: nameFrom(label, names), label, ...(item.required === true ? { required: true } : {}) } as FormField;
    const choices = new Map<string, string>();
    if (kind === 'choice' || kind === 'yes_no') {
      const given = kind === 'yes_no' ? ['Yes', 'No'] : (Array.isArray(item.choices) ? item.choices : []).map((c) => clean(c, DRAFT_LIMITS.choice)).filter(Boolean);
      const unique = [...new Set(given)].slice(0, DRAFT_LIMITS.choices);
      if (unique.length < 2) return leftOut.push(`"${label}": a choice needs at least two answers`);
      const codes = new Set<string>();
      for (const c of unique) choices.set(c.toLowerCase(), codeFrom(c, codes));
      const many = kind === 'choice' && item.many === true;
      field.type = many ? 'MULTI_SELECT' : unique.length > 4 ? 'DROPDOWN' : 'RADIO';
      field.dataSource = { type: 'STATIC', options: unique.map((c) => ({ label: c, value: choices.get(c.toLowerCase())! })) };
      if (!many) earlier.set(label.toLowerCase(), { name: field.name, choices });
    } else field.type = TYPES[kind as keyof typeof TYPES];

    const when = item.showWhen && typeof item.showWhen === 'object' ? (item.showWhen as Record<string, unknown>) : undefined;
    if (when) {
      const on = earlier.get(clean(when.question, DRAFT_LIMITS.label).toLowerCase());
      const is = (Array.isArray(when.is) ? when.is : [when.is]).map((v) => on?.choices.get(clean(v, DRAFT_LIMITS.choice).toLowerCase())).filter((v): v is string => !!v);
      if (on && is.length) field.visibility = { when: is.length === 1 ? { field: on.name, operator: 'equals', value: is[0] } : { field: on.name, operator: 'in', value: is } };
      else leftOut.push(`"${label}": shown always, because the answer it depends on was not found among the questions above it`);
    }
    fields.push(field);
  });
  return { title: clean(json.title, 120), description: clean(json.description, 500), fields: checked(fields, leftOut), leftOut };
}

/** What passes the form's own validation; a question it objects to is left out (with any that depend on it). */
function checked(fields: FormField[], leftOut: string[]): FormField[] {
  let list = fields;
  for (let round = 0; round < 10 && list.length; round++) {
    const def = { id: 'draft', orgId: 'o', businessId: '', name: 'Draft', code: 'DRAFT', version: 1, status: 'DRAFT', access: 'PUBLIC', fields: list, submission: { method: 'POST', endpointId: 'default-submit' }, createdBy: 'ai', updatedBy: 'ai' } as FormDefinition;
    const result = validateFormDefinition(def, 'publish');
    if (result.success) return list;
    const bad = new Set(('issues' in result ? result.issues : []).map((i) => /^fields\.(\d+)/.exec(i.path)?.[1]).filter((v): v is string => v !== undefined).map(Number));
    if (!bad.size) {
      leftOut.push('The draft did not pass the form checks, so its questions were left out');
      return [];
    }
    const gone = new Set([...bad].map((i) => list[i]!.name));
    for (const i of bad) leftOut.push(`"${list[i]!.label}": it did not pass the form checks`);
    list = list.filter((f, i) => !bad.has(i)).map((f) => {
      const on = (f.visibility?.when as { field?: string } | undefined)?.field;
      if (!on || !gone.has(on)) return f;
      const { visibility: _gone, ...rest } = f;
      return rest as FormField;
    });
  }
  return list;
}
