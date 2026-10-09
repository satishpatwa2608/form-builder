import { createHmac } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { safeEqual } from './crypto';

/** Private file storage for form attachments. The browser never gets credentials - only short-lived signed links. */
export interface ObjectStore {
  /** A link the browser PUTs the file to (type and size pinned). */
  presignPut(key: string, contentType: string, size: number): Promise<{ url: string; headers: Record<string, string> }>;
  /** The first `bytes` of an object (to check its real type). */
  readHead(key: string, bytes: number): Promise<Buffer>;
  move(from: string, to: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** A short-lived download link. */
  presignGet(key: string, fileName: string): Promise<string>;
  /** Stores bytes the server itself made (a generated document). */
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  /** The whole object, or null when there is none. */
  get(key: string): Promise<Buffer | null>;
}
export const OBJECT_STORE = Symbol('OBJECT_STORE');

/** S3 with the default credential chain (the IAM task role in production) - never access keys in env. */
export class S3ObjectStore implements ObjectStore {
  private readonly s3: S3Client;
  constructor(
    private readonly bucket: string,
    region: string,
  ) {
    this.s3 = new S3Client({ region });
  }
  presignPut(key: string, contentType: string, size: number) {
    return getSignedUrl(this.s3, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ContentLength: size }), { expiresIn: 300 }).then((url) => ({
      url,
      headers: { 'Content-Type': contentType },
    }));
  }
  async put(key: string, data: Buffer, contentType: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType }));
  }
  async get(key: string) {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return res.Body ? Buffer.from(await res.Body.transformToByteArray()) : null;
    } catch (e) {
      if ((e as { name?: string }).name === 'NoSuchKey') return null;
      throw e;
    }
  }
  async readHead(key: string, bytes: number) {
    const obj = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${bytes - 1}` }));
    return Buffer.from(await obj.Body!.transformToByteArray());
  }
  async move(from: string, to: string) {
    await this.s3.send(new CopyObjectCommand({ Bucket: this.bucket, CopySource: `${this.bucket}/${encodeURI(from)}`, Key: to }));
    await this.remove(from);
  }
  async remove(key: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })).catch(() => undefined);
  }
  presignGet(key: string, fileName: string) {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseContentDisposition: `attachment; filename="${fileName}"` }), { expiresIn: 300 });
  }
}

export interface LocalGrant {
  op: 'put' | 'get';
  key: string;
  exp: number;
  contentType?: string;
  size?: number;
  name?: string;
}

/**
 * Development only: files on local disk, reached through the API with
 * HMAC-signed, expiring tokens (the same shape as S3 pre-signed links).
 */
export class LocalObjectStore implements ObjectStore {
  constructor(
    private readonly dir: string,
    private readonly apiUrl: string,
    private readonly secret: Buffer,
  ) {}

  sign(grant: LocalGrant): string {
    const body = Buffer.from(JSON.stringify(grant)).toString('base64url');
    return `${body}.${createHmac('sha256', this.secret).update(body).digest('base64url')}`;
  }

  /** The grant in a token, if the signature is right and it hasn't expired. */
  verify(token: string, op: LocalGrant['op']): LocalGrant | null {
    const [body, sig] = token.split('.');
    if (!body || !sig || !safeEqual(sig, createHmac('sha256', this.secret).update(body).digest('base64url'))) return null;
    const grant = JSON.parse(Buffer.from(body, 'base64url').toString()) as LocalGrant;
    return grant.op === op && grant.exp > Date.now() ? grant : null;
  }

  /** Keys never escape the storage folder. */
  path(key: string): string {
    const root = resolve(this.dir);
    const full = resolve(join(root, key));
    if (!full.startsWith(root + sep)) throw new Error('Invalid key');
    return full;
  }

  async write(key: string, data: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }

  read(key: string) {
    return readFile(this.path(key));
  }

  async presignPut(key: string, contentType: string, size: number) {
    const token = this.sign({ op: 'put', key, contentType, size, exp: Date.now() + 300_000 });
    return { url: `${this.apiUrl}/public/local-store/${token}`, headers: { 'Content-Type': contentType } };
  }
  async put(key: string, data: Buffer) {
    await this.write(key, data);
  }
  async get(key: string) {
    return this.read(key).catch(() => null);
  }
  async readHead(key: string, bytes: number) {
    const fh = await open(this.path(key), 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const { bytesRead } = await fh.read(buf, 0, bytes, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }
  async move(from: string, to: string) {
    await mkdir(dirname(this.path(to)), { recursive: true });
    await rename(this.path(from), this.path(to));
  }
  async remove(key: string) {
    await unlink(this.path(key)).catch(() => undefined);
  }
  async presignGet(key: string, fileName: string) {
    return `${this.apiUrl}/public/local-store/${this.sign({ op: 'get', key, name: fileName, exp: Date.now() + 300_000 })}`;
  }
}
