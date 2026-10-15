import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const newId = () => randomUUID();

/** A random token for links and refresh cookies (base64url, 256 bits). */
export const randomToken = () => randomBytes(32).toString('base64url');

/** Tokens are stored as SHA-256 hashes only; the raw value exists only in the email or cookie. */
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * AES-256-GCM with a random IV per value: `v1.<iv>.<tag>.<ciphertext>` (base64url).
 * The key comes from config for now; the KMS envelope version (per-org data
 * keys) replaces it before connectors ship (docs/plan.md, section 5.3).
 */
export class SecretBox {
  /**
   * `previous`: keys this installation used before. What they sealed still opens (while the operator re-seals
   * it, see cli/rotate-secrets.ts); everything is sealed with `key`.
   */
  constructor(
    private readonly key: Buffer,
    private readonly previous: Buffer[] = [],
  ) {
    if (key.length !== 32) throw new Error('SecretBox needs a 32-byte key');
    for (const k of previous) if (k.length !== 32) throw new Error('SecretBox needs 32-byte keys');
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), data].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
  }

  open(sealed: string): string {
    return this.opened(sealed).plain;
  }

  /**
   * The same value sealed with the current key, when only a previous key opens it; null when the current key
   * already does, or when it is not one of this installation's (a value sealed by a data key, say).
   */
  reseal(sealed: string): string | null {
    try {
      const { plain, current } = this.opened(sealed);
      return current ? null : this.seal(plain);
    } catch {
      return null;
    }
  }

  private opened(sealed: string): { plain: string; current: boolean } {
    const [v, iv, tag, data] = sealed.split('.');
    if (v !== 'v1' || !iv || !tag || !data) throw new Error('Unknown secret format');
    let failure: unknown;
    for (const [i, key] of [this.key, ...this.previous].entries()) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        // The tag makes a wrong key fail here, never open to the wrong text.
        return { plain: Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8'), current: i === 0 };
      } catch (e) {
        failure = e;
      }
    }
    throw failure;
  }
}

/** The installation's own box: SECRET_KEY, and the keys in SECRET_KEY_PREVIOUS while a rotation is under way. */
export function installationBox(config: { SECRET_KEY: string; SECRET_KEY_PREVIOUS?: string }): SecretBox {
  return new SecretBox(Buffer.from(config.SECRET_KEY, 'base64'), previousKeys(config));
}

export const previousKeys = (config: { SECRET_KEY_PREVIOUS?: string }): Buffer[] =>
  (config.SECRET_KEY_PREVIOUS ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => Buffer.from(k, 'base64'));
