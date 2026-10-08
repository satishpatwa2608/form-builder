import type { FormDefinition, FormEventAction, FormEventTrigger, FormValues, SystemContext } from './types';
import { conditionHolds } from './form-state';

/** A link the form may send people to: https, or a path on the same site. */
export const safeLinkUrl = (url: unknown): string | undefined =>
  typeof url === 'string' && (/^https:\/\/[^\s]+$/i.test(url) || /^\/(?!\/)[^\s]*$/.test(url)) ? url : undefined;

/** True for the zone names this runtime knows (the browser and Node carry the same list). */
export function isTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !zone || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The actions to run now that `trigger` has happened, in order: those of every
 * enabled event for that trigger whose condition holds for `values`.
 */
export function eventActions(
  def: Pick<FormDefinition, 'events'>,
  trigger: FormEventTrigger,
  values: FormValues,
  ctx: SystemContext = {},
): FormEventAction[] {
  return (def.events ?? [])
    .filter(
      (e) =>
        !e.disabled &&
        e.on.type === trigger.type &&
        (e.on.type !== 'CLICK' || e.on.field === (trigger as { field?: string }).field) &&
        conditionHolds(e.when, values, ctx),
    )
    .flatMap((e) => e.do);
}

/** Buttons that have something to do when clicked. */
export const clickableButtons = (def: Pick<FormDefinition, 'events'>): Set<string> =>
  new Set((def.events ?? []).flatMap((e) => (!e.disabled && e.on.type === 'CLICK' ? [e.on.field] : [])));

/**
 * The data sources this form's events read, with the parameter names each may
 * send. The server uses it to decide what a public form is allowed to query.
 */
export function eventSources(def: Pick<FormDefinition, 'events'>): { key: string; params: string[] }[] {
  return (def.events ?? []).flatMap((e) =>
    e.disabled ? [] : e.do.flatMap((a) => (a.type === 'FETCH' ? [{ key: a.source.url.split('?')[0], params: Object.keys(a.source.params ?? {}) }] : [])),
  );
}
