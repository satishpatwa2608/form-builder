import { buildZodSchema } from './build-zod-schema';
import { isValueField } from './field-kinds';
import { computeFormState } from './form-state';
import { formShape } from './repeat';
import type { FormDefinition, FormField, FormValues } from './types';

/**
 * Fills a form in the way a careful person would, knowing nothing about the form but its definition: every
 * field that is on show and needs an answer gets one of the right kind, and when the form objects to an answer
 * (a date in the past, an amount over a limit, a choice that does not go with another) the next plausible
 * answer is tried. It proves that a form can actually be completed and sent, and gives the builder's preview
 * example answers to show a form filled in.
 */
export const EXAMPLE_SIGNATURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const SAMPLES = ['Asha Rao', 'ABCDE1234F', '411001', 'HDFC0001234', '123456789012', 'MH12AB1234', '1234', '1234567890', 'HDFCINBB', 'P1234567', 'AB123456', '27ABCDE1234F1Z5', 'MA1AB2CD3EF456789', 'Test value for this field'];
const DAY_OFFSETS = [0, 3, -3, 40, -40, 400, -400, -11000, -2500, 1500];
const pad = (n: number) => String(n).padStart(2, '0');
const isoDay = (now: Date, offset: number) => {
  const d = new Date(now.getTime() + offset * 86_400_000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

type Path = string;
const get = (values: FormValues, path: Path): unknown => path.split('.').reduce<unknown>((at, key) => (at == null ? undefined : (at as Record<string, unknown>)[key]), values);
const set = (values: FormValues, path: Path, value: unknown) => {
  const keys = path.split('.');
  let at = values as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) at = at[key] as Record<string, unknown>;
  if (value === undefined) delete at[keys.at(-1)!];
  else at[keys.at(-1)!] = value;
};
const empty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);

export interface ExampleOptions {
  /** How a file question is answered. Left out, file questions are left empty. */
  upload?: (field: FormField) => Promise<{ uploadId: string }>;
  now?: Date;
  /** Answer every question on show, not only the required ones (a preview wants a full form; a test wants the least that passes). */
  everything?: boolean;
}

export async function exampleAnswers(def: FormDefinition, { upload, now = new Date(), everything = false }: ExampleOptions = {}): Promise<{ values: FormValues; problems: Record<string, string> }> {
  const shape = formShape(def.fields);
  const values: FormValues = {};
  const tried = new Map<Path, number>();
  const stuck = new Set<Path>();
  const uploads = new Map<string, { uploadId: string }[]>();
  const offeredOnce = new Set<Path>();

  const candidates = async (field: FormField, path: Path, allowed: ReadonlySet<string> | undefined): Promise<unknown[]> => {
    const v = field.validation ?? {};
    const options = (field.dataSource?.options ?? []).map((o) => o.value).filter((o) => !allowed || allowed.has(o));
    switch (field.type) {
      case 'RADIO':
      case 'DROPDOWN':
        return options;
      case 'MULTI_SELECT':
      case 'CHECKBOX_GROUP':
        return options.map((o) => [o]);
      case 'CHECKBOX':
      case 'SWITCH':
      case 'CONSENT':
        return [true, false];
      case 'NUMBER':
      case 'STEPPER':
      case 'SLIDER':
        return [...new Set([v.min ?? 1, 1, 2, 5, 60, 500, 5000, 100_000, 2_500_000, v.max ?? 2_500_000])].filter((n) => (v.min === undefined || n >= v.min) && (v.max === undefined || n <= v.max));
      case 'DATE':
        return DAY_OFFSETS.map((o) => isoDay(now, o));
      case 'DATETIME':
        return DAY_OFFSETS.map((o) => `${isoDay(now, o)}T10:30`);
      case 'TIME':
        return ['10:00', '18:30', '07:00'];
      case 'MONTH':
        return ['2024-06', '2026-09', '2019-01'];
      case 'EMAIL':
        return ['tester@example.test'];
      case 'PHONE':
        return ['+919812345678'];
      case 'URL':
        return ['https://example.com/page'];
      case 'COLOR':
        return ['#336699'];
      case 'SIGNATURE':
        return [EXAMPLE_SIGNATURE];
      case 'FILE': {
        if (!upload) return [];
        if (!uploads.has(field.name)) uploads.set(field.name, [await upload(field)]);
        return [uploads.get(field.name)];
      }
      case 'TEXTAREA':
        return ['This is a careful and complete answer, written out in full so that the person reading it has everything they need. '.repeat(Math.ceil((v.minLength ?? 60) / 110)).slice(0, v.maxLength ?? 4000).trim()];
      default: {
        // The second box of a pair ("… again") repeats the first.
        const twin = path.replace(/Again$/, '');
        if (twin !== path && !empty(get(values, twin))) return [get(values, twin)];
        const fits = (s: string) => (!v.pattern || new RegExp(v.pattern).test(s)) && (v.minLength === undefined || s.length >= v.minLength) && (v.maxLength === undefined || s.length <= v.maxLength);
        return SAMPLES.filter(fits);
      }
    }
  };

  let problems: Record<string, string> = {};
  for (let pass = 0; pass < 400; pass++) {
    const state = computeFormState(def, values, { now });
    Object.assign(values, state.values);
    // Rows first: a repeating section that needs rows gets the fewest it accepts.
    for (const r of shape.repeats) {
      const s = state.states.get(r.field.name);
      const need = s?.visible ? Math.max(r.field.validation?.min ?? 0, s.required ? 1 : 0) : 0;
      const rows = (values[r.field.name] as FormValues[] | undefined) ?? [];
      if (rows.length < need) values[r.field.name] = [...rows, ...Array.from({ length: need - rows.length }, () => ({}))];
    }
    const places: { field: FormField; path: Path }[] = [
      ...shape.top.filter((f) => isValueField(f) && f.type !== 'HIDDEN' && f.type !== 'REPEAT').map((field) => ({ field, path: field.name })),
      ...shape.repeats.flatMap((r) => ((values[r.field.name] as unknown[] | undefined) ?? []).flatMap((_, i) => r.valueChildren.map((field) => ({ field, path: `${r.field.name}.${i}.${field.name}` })))),
    ];
    let changed = false;
    for (const { field, path } of places) {
      const s = state.states.get(path);
      if (!s?.visible || state.calculated.has(path) || state.disabled.has(path)) continue;
      // Asked once only when it is not required: an optional answer the form objects to is given up, not fought over.
      const wanted = s.required || (everything && !offeredOnce.has(path));
      if (wanted && empty(get(values, path))) {
        offeredOnce.add(path);
        const offered = await candidates(field, path, state.options.get(path));
        if (offered.length) {
          set(values, path, offered[Math.min(tried.get(path) ?? 0, offered.length - 1)]);
          changed = true;
        }
      }
    }
    if (changed) continue;

    const result = buildZodSchema(def, { now }).safeParse(values);
    problems = result.success ? {} : Object.fromEntries(result.error.issues.map((i) => [i.path.join('.'), i.message]));
    const next = Object.keys(problems).find((p) => !stuck.has(p));
    if (!next) break;
    // The form objects to this answer: try the next one of its kind.
    const field = places.find((p) => p.path === next)?.field;
    const offered = field ? await candidates(field, next, state.options.get(next)) : [];
    const now_ = JSON.stringify(get(values, next));
    // What was a good answer may have stopped being offered when another answer changed: start again from what is offered now.
    if (field && offered.length && !offered.some((o) => JSON.stringify(o) === now_) && !tried.has(`${next}#reset`)) {
      tried.set(`${next}#reset`, 1);
      tried.set(next, 0);
      set(values, next, offered[0]);
      continue;
    }
    const at = (tried.get(next) ?? 0) + 1;
    if (!field || at >= offered.length) stuck.add(next);
    else {
      tried.set(next, at);
      set(values, next, offered[at]);
    }
  }
  return { values, problems };
}
