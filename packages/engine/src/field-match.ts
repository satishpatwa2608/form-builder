/**
 * Which answer fills which field of another system, when a response is
 * written there. Names rarely agree exactly ("email" here, "Email" or
 * "Email__c" there), so they are compared the way a person would: ignoring
 * capitals, spaces, underscores and a custom-field ending. A choice made by
 * hand always wins over a guess.
 */
const plainName = (name: string) =>
  name
    .replace(/__c$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/** The answer that would fill a field with nobody choosing: the same name, else the same name read loosely. */
export function guessSource(target: string, sources: string[]): string | undefined {
  if (sources.includes(target)) return target;
  const wanted = plainName(target);
  if (!wanted) return undefined;
  const loose = sources.filter((s) => plainName(s) === wanted);
  // Two answers that read the same are not a guess anyone should rely on.
  return loose.length === 1 ? loose[0] : undefined;
}

/**
 * For each field of the other system, the answer that fills it. `chosen` is
 * what the designer picked: an answer's name, or '' for "leave it empty".
 * A choice that names an answer the form no longer has is dropped.
 */
export function matchFields(targets: string[], sources: string[], chosen: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const target of targets) {
    const pick = chosen[target];
    if (pick === '') continue;
    const source = pick !== undefined && sources.includes(pick) ? pick : guessSource(target, sources);
    if (source !== undefined) out[target] = source;
  }
  return out;
}

/** The values to send: each field of the other system with the answer matched to it, where there is one. */
export function mappedValues(targets: string[], values: Record<string, unknown>, chosen: Record<string, string> = {}): Record<string, unknown> {
  const match = matchFields(targets, Object.keys(values), chosen);
  return Object.fromEntries(Object.entries(match).filter(([, source]) => values[source] !== undefined).map(([target, source]) => [target, values[source]]));
}
