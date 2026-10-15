import { randomBytes } from 'node:crypto';
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { SecretBox } from './crypto';

/**
 * Envelope encryption for customer credentials: each secret gets its own
 * data key; only the wrapped (encrypted) data key is stored next to it.
 * Production wraps with AWS KMS (the key never leaves KMS); development
 * wraps with the local SECRET_KEY.
 */
export interface KeyProvider {
  readonly name: 'local' | 'kms';
  /** A fresh data key: the plain key to use now, and the wrapped form to store. */
  newDataKey(context: Record<string, string>): Promise<{ plain: Buffer; wrapped: string }>;
  unwrap(wrapped: string, context: Record<string, string>): Promise<Buffer>;
}
export const KEY_PROVIDER = Symbol('KEY_PROVIDER');

export class LocalKeyProvider implements KeyProvider {
  readonly name = 'local' as const;
  private readonly box: SecretBox;
  constructor(masterKey: Buffer, previous: Buffer[] = []) {
    this.box = new SecretBox(masterKey, previous);
  }
  async newDataKey(context: Record<string, string>) {
    const plain = randomBytes(32);
    // The context is bound in, like a KMS encryption context: a key can't be moved to another record.
    return { plain, wrapped: this.box.seal(JSON.stringify({ k: plain.toString('base64'), c: context })) };
  }
  async unwrap(wrapped: string, context: Record<string, string>) {
    const { k, c } = JSON.parse(this.box.open(wrapped)) as { k: string; c: Record<string, string> };
    if (JSON.stringify(c) !== JSON.stringify(context)) throw new Error('Key context mismatch');
    return Buffer.from(k, 'base64');
  }
}

export class KmsKeyProvider implements KeyProvider {
  readonly name = 'kms' as const;
  private readonly kms: KMSClient;
  constructor(
    private readonly keyId: string,
    region: string,
  ) {
    this.kms = new KMSClient({ region });
  }
  async newDataKey(context: Record<string, string>) {
    const out = await this.kms.send(new GenerateDataKeyCommand({ KeyId: this.keyId, KeySpec: 'AES_256', EncryptionContext: context }));
    return { plain: Buffer.from(out.Plaintext!), wrapped: Buffer.from(out.CiphertextBlob!).toString('base64') };
  }
  async unwrap(wrapped: string, context: Record<string, string>) {
    const out = await this.kms.send(new DecryptCommand({ CiphertextBlob: Buffer.from(wrapped, 'base64'), EncryptionContext: context }));
    return Buffer.from(out.Plaintext!);
  }
}

/** Seal / open a JSON value with a data key (AES-256-GCM, fresh IV each time). */
export const sealWith = (key: Buffer, value: unknown) => new SecretBox(key).seal(JSON.stringify(value));
export const openWith = <T>(key: Buffer, sealed: string) => JSON.parse(new SecretBox(key).open(sealed)) as T;
