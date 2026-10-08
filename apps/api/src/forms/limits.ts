/** Hard limits on anything a designer or the public can send (ported from Sangam form-platform). */
export const LIMITS = {
  /** JSON size of a submission's values. */
  valuesBytes: 256 * 1024,
  /** JSON size of a form definition. */
  definitionBytes: 512 * 1024,
  maxFields: 300,
  textLength: 20_000,
  arrayItems: 100,
  /** Regex `pattern` in field validation. */
  patternLength: 200,
} as const;
