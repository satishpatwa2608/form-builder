import type { FormValues } from '@fb/engine';

/** How often answers are sent while the person keeps typing: often enough to lose little, seldom enough to be no burden. */
export const AUTOSAVE_EVERY_MS = 30_000;

interface AutosaveOptions {
  /** Where this form's draft is remembered on this device. */
  key: string;
  /** Sends the answers; `token` is the draft this page last saved, which the server retires for the new one it returns. */
  save: (values: FormValues, token: string | undefined) => Promise<{ token: string }>;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  everyMs?: number;
}

/**
 * Answers that save themselves. A change starts a clock; when it runs out the latest answers are sent, however
 * many changes there were meanwhile, so typing never means a request per key. The draft's token is kept on this
 * device only, which is what lets the same person find their answers again without a link.
 *
 * Saving is a kindness, not a promise: a save that fails (offline, private browsing with no storage) is tried
 * again at the next change and never interrupts the person.
 */
export function createAutosave({ key, save, storage = window.localStorage, everyMs = AUTOSAVE_EVERY_MS }: AutosaveOptions) {
  let latest: FormValues | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending = false;
  let stopped = false;

  const read = () => {
    try {
      return storage.getItem(key) ?? undefined;
    } catch {
      return undefined;
    }
  };
  const write = (token: string | undefined) => {
    try {
      if (token) storage.setItem(key, token);
      else storage.removeItem(key);
    } catch {
      // No storage here: the answers are still saved, they just cannot be found again without the link.
    }
  };

  async function send() {
    timer = undefined;
    if (stopped || sending || !latest) return;
    const values = latest;
    latest = undefined;
    sending = true;
    try {
      write((await save(values, read())).token);
    } catch {
      // Keep them for the next try, unless newer ones have arrived since.
      latest ??= values;
    } finally {
      sending = false;
      // Answers that changed while this was on its way go with the next tick.
      if (latest && !stopped && !timer) timer = setTimeout(() => void send(), everyMs);
    }
  }

  return {
    /** The draft this device has for the form, if any. */
    token: read,
    /** The answers changed. */
    changed(values: FormValues) {
      if (stopped) return;
      latest = values;
      timer ??= setTimeout(() => void send(), everyMs);
    },
    /** Send now what is waiting (the person is leaving the page). */
    flush() {
      if (timer) clearTimeout(timer);
      return send();
    },
    /** Submitted, or the person chose to start again: nothing more is saved and this device forgets the draft. */
    forget() {
      stopped = true;
      latest = undefined;
      if (timer) clearTimeout(timer);
      timer = undefined;
      write(undefined);
    },
  };
}
