import type { CaptchaConfig } from '../../types';

/**
 * Provider-independent CAPTCHA. Only the public site key is ever used here;
 * verifying the token needs the secret key and happens on the server (Phase 4).
 */
export interface CaptchaWidget {
  /** Get a fresh token on demand (INVISIBLE / V3). */
  execute(): Promise<string>;
  /** Tokens are single-use: reset after every submit attempt. */
  reset(): void;
}

export interface CaptchaRenderOptions {
  siteKey: string;
  mode: CaptchaConfig['mode'];
  onToken: (token: string) => void;
  onExpire: () => void;
}

export interface CaptchaProvider {
  render(container: HTMLElement, options: CaptchaRenderOptions): Promise<CaptchaWidget>;
}

const scripts = new Map<string, Promise<void>>();

/** Load a provider script once per page. */
function loadScript(src: string): Promise<void> {
  const existing = scripts.get(src);
  if (existing) return existing;
  const promise = new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.defer = true;
    el.onload = () => resolve();
    el.onerror = () => {
      scripts.delete(src);
      reject(new Error(`Could not load ${src}`));
    };
    document.head.appendChild(el);
  });
  scripts.set(src, promise);
  return promise;
}

/** Resolves the next token the widget's callback delivers. */
function tokenWaiter() {
  let pending: ((token: string) => void) | null = null;
  return {
    wait: () => new Promise<string>((resolve) => (pending = resolve)),
    deliver: (token: string) => {
      pending?.(token);
      pending = null;
    },
  };
}

interface Grecaptcha {
  ready(cb: () => void): void;
  render(el: HTMLElement, opts: Record<string, unknown>): number;
  execute(idOrKey: number | string, opts?: Record<string, unknown>): Promise<string> | void;
  reset(id?: number): void;
}

interface Turnstile {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  execute(el: HTMLElement | string): void;
  reset(id?: string): void;
}

declare global {
  interface Window {
    grecaptcha?: Grecaptcha;
    turnstile?: Turnstile;
  }
}

export const recaptchaProvider: CaptchaProvider = {
  async render(container, { siteKey, mode, onToken, onExpire }) {
    if (mode === 'V3') {
      await loadScript(`https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(siteKey)}`);
      const g = window.grecaptcha!;
      await new Promise<void>((resolve) => g.ready(resolve));
      return {
        execute: async () => {
          const token = (await g.execute(siteKey, { action: 'submit' })) as string;
          onToken(token);
          return token;
        },
        reset: () => {},
      };
    }

    await loadScript('https://www.google.com/recaptcha/api.js?render=explicit');
    const g = window.grecaptcha!;
    await new Promise<void>((resolve) => g.ready(resolve));
    const waiter = tokenWaiter();
    const id = g.render(container, {
      sitekey: siteKey,
      size: mode === 'INVISIBLE' ? 'invisible' : 'normal',
      callback: (token: string) => {
        onToken(token);
        waiter.deliver(token);
      },
      'expired-callback': onExpire,
    });
    return {
      execute: () => {
        const next = waiter.wait();
        void g.execute(id);
        return next;
      },
      reset: () => g.reset(id),
    };
  },
};

export const turnstileProvider: CaptchaProvider = {
  async render(container, { siteKey, mode, onToken, onExpire }) {
    await loadScript('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
    const t = window.turnstile!;
    const waiter = tokenWaiter();
    const invisible = mode !== 'CHECKBOX';
    const id = t.render(container, {
      sitekey: siteKey,
      execution: invisible ? 'execute' : 'render',
      appearance: invisible ? 'interaction-only' : 'always',
      callback: (token: string) => {
        onToken(token);
        waiter.deliver(token);
      },
      'expired-callback': onExpire,
    });
    return {
      execute: () => {
        const next = waiter.wait();
        t.execute(container);
        return next;
      },
      reset: () => t.reset(id),
    };
  },
};

export const captchaProviders: Record<CaptchaConfig['provider'], CaptchaProvider> = {
  RECAPTCHA: recaptchaProvider,
  TURNSTILE: turnstileProvider,
};

/** Token the mock check produces - the backend must reject it outside development. */
export const MOCK_CAPTCHA_TOKEN_PREFIX = 'mock-captcha-';
