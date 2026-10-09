import type { Condition, FormDefinition, FormField } from './types';
import { paramReferences } from './resolve-params';

/**
 * Fragments: a section of fields kept in the organisation's library so
 * several forms can use it ("Address", "Bank details"). On a form a fragment
 * is an ordinary SECTION that remembers where it came from; the fields inside
 * it are a copy. The copy is refreshed from the library when the form is
 * opened in the builder and again when it is published, so a change to the
 * fragment reaches each form at its next publish and never alters a version
 * that is already live.
 *
 * Used twice on one form (a billing and a shipping address) each section is
 * given a prefix, and its fields are named `billing_city`, `shipping_city`.
 */
export interface Fragment {
  id: string;
  name: string;
  description?: string;
  /** What the section holds. Fields at the top have no parent. */
  fields: FormField[];
}

/** On a SECTION's props: the fragment it is a copy of. */
export interface FragmentUse {
  id: string;
  /** Put before each field's name, with an underscore. Needed when a form uses the fragment more than once. */
  prefix?: string;
}

const PREFIX = /^[A-Za-z][A-Za-z0-9]{0,19}$/;

/** The fragment a section is a copy of, if it is one. */
export function fragmentUse(field: Pick<FormField, 'type' | 'props'>): FragmentUse | null {
  const use = field.type === 'SECTION' ? (field.props?.fragment as Partial<FragmentUse> | undefined) : undefined;
  if (!use || typeof use.id !== 'string' || !use.id) return null;
  return { id: use.id, ...(typeof use.prefix === 'string' && use.prefix ? { prefix: use.prefix } : {}) };
}

/** Whether a prefix can be used in field names. */
export const isFragmentPrefix = (prefix: string): boolean => PREFIX.test(prefix);

/** Every field inside a container, however deep, in the order they appear. */
export function descendants(fields: FormField[], containerId: string): FormField[] {
  const inside = new Set<string>([containerId]);
  const out: FormField[] = [];
  // A child may be listed before its parent; keep sweeping until nothing new is found.
  for (let found = true; found; ) {
    found = false;
    for (const f of fields) {
      if (f.parentId && inside.has(f.parentId) && !inside.has(f.id)) {
        inside.add(f.id);
        found = true;
      }
    }
  }
  for (const f of fields) if (f.id !== containerId && inside.has(f.id)) out.push(f);
  return out;
}

/** The fragment section a field sits inside (and is therefore a copy, not to be edited on the form), if any. */
export function fragmentSectionOf(fields: FormField[], fieldId: string): FormField | null {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const seen = new Set<string>();
  for (let f = byId.get(fieldId); f?.parentId && !seen.has(f.id); ) {
    seen.add(f.id);
    f = byId.get(f.parentId);
    if (f && fragmentUse(f)) return f;
  }
  return null;
}

const mapCondition = (cond: Condition, rename: (name: string) => string): Condition => {
  if ('all' in cond) return { all: cond.all.map((c) => mapCondition(c, rename)) };
  if ('any' in cond) return { any: cond.any.map((c) => mapCondition(c, rename)) };
  return { ...cond, field: rename(cond.field) };
};

/** A field with its own name, and every other field it refers to, passed through `rename`. */
function renameField(field: FormField, rename: (name: string) => string): FormField {
  const params = field.dataSource?.api?.params;
  return {
    ...field,
    name: rename(field.name),
    ...(field.requiredWhen ? { requiredWhen: mapCondition(field.requiredWhen, rename) } : {}),
    ...(field.visibility ? { visibility: { ...field.visibility, when: mapCondition(field.visibility.when, rename) } } : {}),
    ...(field.dependency ? { dependency: { ...field.dependency, dependsOn: field.dependency.dependsOn.map(rename) } } : {}),
    ...(params && field.dataSource?.api
      ? {
          dataSource: {
            ...field.dataSource,
            api: { ...field.dataSource.api, params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, n: string) => `{{${rename(n)}}}`)])) },
          },
        }
      : {}),
  };
}

/** Every other field a field refers to: in its show-when and required-when, what it depends on, and its list's parameters. */
function references(field: FormField): string[] {
  const out: string[] = [];
  const walk = (c: Condition): void => {
    if ('all' in c) c.all.forEach(walk);
    else if ('any' in c) c.any.forEach(walk);
    else out.push(c.field);
  };
  if (field.requiredWhen) walk(field.requiredWhen);
  if (field.visibility) walk(field.visibility.when);
  out.push(...(field.dependency?.dependsOn ?? []), ...paramReferences(field.dataSource?.api?.params).fields);
  return out;
}

/** A short, stable id for the copy of one fragment field in one section (field ids are at most 64 characters). */
function copyId(sectionId: string, sourceId: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (const ch of `${sectionId}\u0000${sourceId}`) {
    a = Math.imul(a ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    b = Math.imul(b ^ ch.charCodeAt(0), 0x811c9dc5) >>> 0;
  }
  return `fr_${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

/** The fields a fragment puts inside one section: named for that section, and pointing at each other by their new names. */
export function fragmentCopy(section: FormField, fragment: Fragment): FormField[] {
  const prefix = fragmentUse(section)?.prefix;
  const inside = new Set(fragment.fields.map((f) => f.name));
  // Only names that belong to the fragment are changed; `$`-names and anything else are left as written.
  const rename = (name: string) => (prefix && inside.has(name) ? `${prefix}_${name}` : name);
  const ids = new Map(fragment.fields.map((f) => [f.id, copyId(section.id, f.id)]));
  return fragment.fields.map((f) => ({ ...renameField(f, rename), id: ids.get(f.id)!, parentId: f.parentId ? (ids.get(f.parentId) ?? section.id) : section.id }));
}

/**
 * The form with every fragment section holding the library's current fields.
 * `missing` lists sections whose fragment is no longer in the library (they
 * keep the copy they have); `changed` says whether anything differs.
 */
export function syncFragments<T extends Pick<FormDefinition, 'fields'>>(def: T, library: Fragment[]): { definition: T; missing: FormField[]; changed: boolean } {
  const byId = new Map(library.map((f) => [f.id, f]));
  const missing: FormField[] = [];
  let fields = def.fields;
  for (const section of def.fields.filter((f) => fragmentUse(f))) {
    const fragment = byId.get(fragmentUse(section)!.id);
    if (!fragment) {
      missing.push(section);
      continue;
    }
    const old = new Set(descendants(fields, section.id).map((f) => f.id));
    const kept = fields.filter((f) => !old.has(f.id));
    const at = kept.findIndex((f) => f.id === section.id);
    fields = [...kept.slice(0, at + 1), ...fragmentCopy(section, fragment), ...kept.slice(at + 1)];
  }
  const changed = JSON.stringify(fields) !== JSON.stringify(def.fields);
  return { definition: changed ? { ...def, fields } : def, missing, changed };
}

/**
 * What a section holds, as it would be kept in the library: the fields inside
 * it with the section's prefix taken off their names, and the ones at the top
 * given no parent.
 */
export function extractFragment(fields: FormField[], sectionId: string): FormField[] {
  const section = fields.find((f) => f.id === sectionId);
  const inside = descendants(fields, sectionId);
  const prefix = section ? fragmentUse(section)?.prefix : undefined;
  const names = new Set(inside.map((f) => f.name));
  const start = prefix ? `${prefix}_` : '';
  const rename = (name: string) => (start && names.has(name) && name.startsWith(start) ? name.slice(start.length) : name);
  return inside.map((f) => {
    const { parentId, ...rest } = renameField(f, rename);
    return parentId === sectionId ? rest : { ...rest, parentId };
  });
}

/** Why a set of fields cannot be kept as a fragment; empty when it can. */
export function fragmentProblems(fields: FormField[]): string[] {
  const problems: string[] = [];
  if (!fields.some((f) => !['COLUMNS', 'SECTION', 'TABS', 'ACCORDION', 'HTML', 'IMAGE'].includes(f.type))) problems.push('A fragment needs at least one field');
  const names = new Set(fields.map((f) => f.name));
  for (const f of fields) {
    const what = f.label || f.name;
    if (f.type === 'CAPTCHA') problems.push('A CAPTCHA belongs to the form, not to a fragment');
    if (fragmentUse(f)) problems.push(`"${what}" is itself a fragment; a fragment cannot hold another`);
    for (const ref of new Set(references(f))) {
      if (!ref.startsWith('$') && !names.has(ref)) problems.push(`"${what}" depends on "${ref}", which is not part of the fragment`);
    }
  }
  return [...new Set(problems)];
}

/** Why a form's fragment sections cannot be published as they are; empty when they can. */
export function fragmentUseProblems(fields: FormField[]): string[] {
  const problems: string[] = [];
  const sections = fields.filter((f) => fragmentUse(f));
  const byFragment = new Map<string, FormField[]>();
  for (const s of sections) byFragment.set(fragmentUse(s)!.id, [...(byFragment.get(fragmentUse(s)!.id) ?? []), s]);
  for (const s of sections) {
    const { prefix } = fragmentUse(s)!;
    const what = s.label || s.name;
    const raw = (s.props?.fragment as { prefix?: unknown }).prefix;
    if (raw !== undefined && raw !== '' && !(typeof raw === 'string' && isFragmentPrefix(raw))) problems.push(`The prefix of "${what}" must be letters and digits, starting with a letter`);
    const twins = byFragment.get(fragmentUse(s)!.id)!;
    if (twins.length > 1 && twins.filter((t) => (fragmentUse(t)!.prefix ?? '') === (prefix ?? '')).length > 1) {
      problems.push(`"${what}" is used more than once on this form. Give each one a different prefix so their answers are kept apart.`);
    }
  }
  return [...new Set(problems)];
}
