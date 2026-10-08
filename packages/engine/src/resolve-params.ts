import type { FormField, FormValues, SystemContext, SystemFieldSource } from './types';
import { isEmptyValue } from './field-kinds';
import { systemValue } from './default-values';

/** `{{fieldName}}` or `{{$system.BUSINESS_ID}}`. */
const REFERENCE = /\{\{\s*(\$system\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

const SYSTEM_SOURCES: ReadonlySet<string> = new Set<SystemFieldSource>([
  'ORG_ID',
  'BUSINESS_ID',
  'USER_ID',
  'USER_EMAIL',
  'USER_NAME',
  'USER_PHONE',
  'EMPLOYEE_ID',
  'FORM_ID',
  'FORM_VERSION',
  'SOURCE_CHANNEL',
  'CURRENT_DATE',
]);

export interface ParamReferences {
  fields: string[];
  system: string[];
}

/** Field names and system keys a set of params reads. */
export function paramReferences(params: Record<string, string> | undefined): ParamReferences {
  const fields = new Set<string>();
  const system = new Set<string>();
  for (const value of Object.values(params ?? {})) {
    for (const [, isSystem, name] of value.matchAll(REFERENCE)) (isSystem ? system : fields).add(name);
  }
  return { fields: [...fields], system: [...system] };
}

export interface ResolvedParams {
  params: Record<string, string>;
  /** References with no value yet - the request must wait for them. */
  unresolved: string[];
}

/**
 * Substitute references with current values. A reference to an empty field
 * (or unknown system key) leaves the param unresolved rather than sending an
 * empty filter that would return everything.
 */
export function resolveParams(
  params: Record<string, string> | undefined,
  values: FormValues,
  system: SystemContext,
): ResolvedParams {
  const out: Record<string, string> = {};
  const unresolved = new Set<string>();

  for (const [key, template] of Object.entries(params ?? {})) {
    out[key] = template.replace(REFERENCE, (_match, isSystem: string | undefined, name: string) => {
      const value = isSystem
        ? SYSTEM_SOURCES.has(name)
          ? systemValue(name as SystemFieldSource, system)
          : undefined
        : values[name];
      if (isEmptyValue(value) || typeof value === 'object') {
        unresolved.add(isSystem ? `$system.${name}` : name);
        return '';
      }
      return String(value);
    });
  }
  return { params: out, unresolved: [...unresolved] };
}

/**
 * Fields whose change should clear/reload this one: the explicit
 * `dependency.dependsOn` plus any field its API params reference.
 */
export function fieldParents(field: FormField): string[] {
  const explicit = field.dependency?.dependsOn ?? [];
  const fromParams = paramReferences(field.dataSource?.api?.params).fields;
  return [...new Set([...explicit, ...fromParams])];
}

/** parent name -> names of fields that reset when it changes. */
export function resetChildren(fields: FormField[]): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const f of fields) {
    if (f.dependency?.resetOnChange === false) continue;
    for (const parent of fieldParents(f)) {
      children.set(parent, [...(children.get(parent) ?? []), f.name]);
    }
  }
  return children;
}

/** Everything downstream of `name`, nearest first (Business -> Section -> Sub-section). */
export function descendantsOf(name: string, children: Map<string, string[]>): string[] {
  const seen = new Set<string>();
  const queue = [...(children.get(name) ?? [])];
  while (queue.length) {
    const next = queue.shift()!;
    if (seen.has(next) || next === name) continue;
    seen.add(next);
    queue.push(...(children.get(next) ?? []));
  }
  return [...seen];
}
