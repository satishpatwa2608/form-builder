import type { FormDefinition, FormField, FormValues, SystemContext, SystemFieldSource } from './types';
import { emptyValueFor, isRepeat } from './field-kinds';
import { answerFields, formShape, MAX_ROWS } from './repeat';

/**
 * A system value by source. `param` is the query-string key for URL_PARAMETER.
 * Context only - the backend re-derives every one of these.
 */
export function systemValue(source: SystemFieldSource, ctx: SystemContext, param?: string): unknown {
  switch (source) {
    case 'ORG_ID':
      return ctx.orgId;
    case 'BUSINESS_ID':
      return ctx.businessId;
    case 'USER_ID':
      return ctx.userId;
    case 'USER_EMAIL':
      return ctx.userEmail;
    case 'USER_NAME':
      return ctx.userName;
    case 'USER_PHONE':
      return ctx.userPhone;
    case 'EMPLOYEE_ID':
      return ctx.employeeId;
    case 'FORM_ID':
      return ctx.formId;
    case 'FORM_VERSION':
      return ctx.formVersion;
    case 'SOURCE_CHANNEL':
      return ctx.sourceChannel;
    case 'CURRENT_DATE':
      return (ctx.now ?? new Date()).toISOString();
    case 'URL_PARAMETER':
      return param ? ctx.urlParams?.[param] : undefined;
  }
}

/** The value a HIDDEN system field carries. */
export function resolveSystemValue(field: FormField, ctx: SystemContext): unknown {
  return field.systemSource ? systemValue(field.systemSource, ctx, field.systemParam) : undefined;
}

/** The signed-in user's value for a pre-filled field, if there is one. */
export function prefillValue(field: FormField, ctx: SystemContext): string | undefined {
  if (!field.prefill) return undefined;
  const v = systemValue(field.prefill.source, ctx);
  return v === undefined || v === null || v === '' ? undefined : String(v);
}

/** Read-only for this person: a locked prefill that actually has a value (i.e. signed in). */
export const isPrefillLocked = (field: FormField, ctx: SystemContext): boolean =>
  !!field.prefill?.lock && prefillValue(field, ctx) !== undefined;

/** Form-owned context merged under whatever the host page supplies. */
export function systemContextFor(def: FormDefinition, host: SystemContext = {}): SystemContext {
  return {
    orgId: def.orgId,
    businessId: def.businessId,
    formId: def.id,
    formVersion: def.version,
    ...host,
    // A zone set on the form wins, so every person and the server agree on what "today" is.
    ...(def.timeZone ? { timeZone: def.timeZone } : {}),
  };
}

/** A new, empty row of a repeating section: each field inside at its default. */
export function defaultRow(def: Pick<FormDefinition, 'fields'>, repeat: FormField): Record<string, unknown> {
  const children = formShape(def.fields).repeats.find((r) => r.field.id === repeat.id)?.valueChildren ?? [];
  return Object.fromEntries(children.map((c) => [c.name, c.defaultValue ?? emptyValueFor(c.type)]));
}

export function buildDefaultValues(def: Pick<FormDefinition, 'fields'>, ctx: SystemContext): FormValues {
  const values: FormValues = {};
  for (const field of answerFields(def.fields)) {
    if (isRepeat(field)) {
      // Starts with as many rows as it must have, so nobody has to add the first one.
      const rows = Math.min(Math.max(field.validation?.min ?? 0, field.required ? 1 : 0), MAX_ROWS);
      values[field.name] = Array.from({ length: rows }, () => defaultRow(def, field));
      continue;
    }
    const system = field.systemSource ? resolveSystemValue(field, ctx) : prefillValue(field, ctx);
    values[field.name] = system ?? field.defaultValue ?? emptyValueFor(field.type);
  }
  return values;
}
