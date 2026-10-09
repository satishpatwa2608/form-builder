import type { FormValues } from '@fb/engine';

const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** What one visit to a form is counted as: nothing about the answers themselves, only which questions. */
export interface VisitSummary {
  answered: string[];
  mistakes: string[];
  /** The last question touched, when the person left without submitting. */
  leftAt?: string;
}

/**
 * Follows one visit. Values that change before the person has touched the
 * page (defaults, things filled in on opening) are not theirs and are not
 * counted; after that, a changed value is a question they answered.
 */
export function createVisit() {
  let previous: FormValues | undefined;
  let latest: FormValues = {};
  let interacted = false;
  let last: string | undefined;
  const touched = new Set<string>();
  const mistakes = new Set<string>();

  return {
    /** The person clicked or typed somewhere on the page. */
    interact() {
      interacted = true;
    },
    /**
     * The form's values now. `focused` is the question the person is on, if known.
     * Returns true the first time an answer of theirs changes: that is when they have started.
     */
    values(values: FormValues, focused?: string): boolean {
      const before = previous;
      previous = values;
      latest = values;
      if (!before || !interacted) return false;
      const changed = [...new Set([...Object.keys(before), ...Object.keys(values)])].filter((k) => !same(before[k], values[k]));
      if (!changed.length) return false;
      const first = touched.size === 0;
      for (const name of changed) touched.add(name);
      // One answer can change others (a rule clears or calculates): the one being worked on is where the person is.
      last = focused && changed.includes(focused) ? focused : (changed[0] ?? last);
      return first;
    },
    /** Questions that showed a mistake when the person tried to go on. */
    problems(names: string[]) {
      for (const name of names) mistakes.add(name.split('.')[0]!);
    },
    /** What to count for this visit, or null when the person never started. */
    summary(submitted: boolean): VisitSummary | null {
      if (!touched.size) return null;
      return { answered: [...touched].filter((name) => !isEmpty(latest[name])), mistakes: [...mistakes], ...(submitted || !last ? {} : { leftAt: last }) };
    },
  };
}
