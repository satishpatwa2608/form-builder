import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ConnectorError } from '../registry';
import type { ConnectorContext, EntityRef } from '../types';

/** Identifiers (tables, collections, columns) are never taken from input unless they're in the exposed list. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export function assertIdentifier(name: string, allowed?: string[]): string {
  if (!IDENT.test(name)) throw new ConnectorError('UNSUPPORTED', `"${name.slice(0, 40)}" is not a valid name`);
  if (allowed && !allowed.includes(name)) throw new ConnectorError('UNSUPPORTED', `"${name}" is not exposed`);
  return name;
}

export type Primitive = string | number | boolean | null;
const isPrimitive = (v: unknown): v is Primitive => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** Filter values: exact matches on exposed fields, primitives only (no operators, no objects). */
export function filtersFrom(entity: EntityRef, params: Record<string, unknown>): [string, Primitive][] {
  return Object.entries(params)
    .filter(([k]) => !k.startsWith('$'))
    .map(([k, v]) => {
      assertIdentifier(k, entity.fields);
      if (!isPrimitive(v)) throw new ConnectorError('UNSUPPORTED', `Filter "${k}" must be a plain value`);
      return [k, v] as [string, Primitive];
    });
}

/** Values to write: only exposed fields, primitives or string lists. */
export function rowFrom(entity: EntityRef, values: Record<string, unknown>): Record<string, Primitive | string[]> {
  const row: Record<string, Primitive | string[]> = {};
  for (const [k, v] of Object.entries(values)) {
    if (!entity.fields.includes(k)) continue;
    if (isPrimitive(v)) row[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) row[k] = v as string[];
  }
  if (!Object.keys(row).length) throw new ConnectorError('UNSUPPORTED', 'Nothing to write: no values for the exposed fields');
  return row;
}

/**
 * The row a service sends back after a write, for later steps to use: the
 * exposed fields and the key it gave the row, nothing else it happened to include.
 */
export function savedRow(entity: EntityRef, row: unknown, keyField: string): Record<string, unknown>[] {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
  const keep = new Set([...entity.fields, keyField]);
  return [Object.fromEntries(Object.entries(row as Record<string, unknown>).filter(([k]) => keep.has(k)))];
}

const now = () => performance.now();
export const elapsed = (start: number) => Math.round(now() - start);
export { now };

/** RFC1918, loopback, link-local, CGNAT, unique-local and metadata addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

const MAX_BYTES = 2 * 1024 * 1024;

/**
 * fetch with the connector SSRF rules: https only (http only for private
 * networks in development), the host resolved first and refused if it's
 * private, an optional host allow-list, no redirects, a size cap.
 */
export async function safeFetch(ctx: ConnectorContext, url: string, init: RequestInit = {}): Promise<{ status: number; json: unknown; text: string }> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new ConnectorError('UNSUPPORTED', 'Invalid URL');
  }
  const allowed = ctx.connector.allowedHosts;
  if (allowed?.length && !allowed.includes(target.hostname.toLowerCase())) throw new ConnectorError('UNSUPPORTED', `${target.hostname} is not in this connector's allowed hosts`);
  if (!ctx.allowPrivateNetwork) {
    if (target.protocol !== 'https:') throw new ConnectorError('UNSUPPORTED', 'Only https URLs are allowed');
    const host = target.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
    if (!addresses.length || addresses.some(isPrivateAddress)) throw new ConnectorError('UNSUPPORTED', `${target.hostname} resolves to a private address`);
  }
  const res = await fetch(target, { ...init, redirect: 'error', signal: ctx.signal });
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new ConnectorError('FAILED', 'The response is too large');
      }
      chunks.push(value);
    }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

/** Field list of sample rows (the discovered shape of a collection or response). */
export function fieldsOf(rows: Record<string, unknown>[]): { name: string; type: 'string' | 'number' | 'boolean' | 'date' | 'object' | 'array' | 'unknown' }[] {
  const types = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      const t = v === null || v === undefined ? 'unknown' : Array.isArray(v) ? 'array' : v instanceof Date ? 'date' : typeof v === 'object' ? (v.constructor?.name === 'ObjectId' ? 'string' : 'object') : typeof v;
      if (!types.has(k)) types.set(k, new Set());
      types.get(k)!.add(t);
    }
  }
  return [...types.entries()].map(([name, set]) => {
    const known = [...set].filter((t) => t !== 'unknown');
    const type = (known.length === 1 ? known[0] : known.length ? 'unknown' : 'unknown') as 'string';
    return { name, type };
  });
}

/** Database hosts get the same rule as URLs: resolved, and refused if private (use the gateway agent for those). */
export async function assertPublicHost(ctx: ConnectorContext, host: string): Promise<void> {
  if (ctx.allowPrivateNetwork) return;
  const h = host.replace(/^\[|\]$/g, '');
  const addresses = isIP(h) ? [h] : (await lookup(h, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new ConnectorError('FAILED', `Can't resolve ${host}`);
  if (addresses.some(isPrivateAddress)) throw new ConnectorError('UNSUPPORTED', `${host} is a private address - connect it through the gateway agent`);
}

/** Hosts in a mongodb:// URI (mongodb+srv:// names its SRV domain). */
export function mongoHosts(uri: string): string[] {
  const m = uri.match(/^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/);
  return m ? m[1]!.split(',').map((h) => h.replace(/:\d+$/, '')) : [];
}

const tokens = new Map<string, { token: string; until: number }>();

/**
 * An application signing in as itself (OAuth client credentials): the token it is given, kept until shortly
 * before it runs out. The token address goes through the same network rules as the service itself.
 */
export async function applicationToken(ctx: ConnectorContext, s: { tokenUrl?: string; clientId?: string; scope?: string }): Promise<string> {
  if (!s.tokenUrl || !s.clientId || !ctx.secrets.clientSecret) throw new ConnectorError('UNSUPPORTED', 'Sign-in needs a token address, a client ID and a client secret');
  const key = `${ctx.connector.id}:${s.tokenUrl}:${s.clientId}:${ctx.secrets.clientSecret.length}`;
  const hit = tokens.get(key);
  if (hit && hit.until > Date.now()) return hit.token;
  const r = await safeFetch(ctx, s.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: s.clientId, client_secret: ctx.secrets.clientSecret, ...(s.scope ? { scope: s.scope } : {}) }).toString(),
  });
  const body = (r.json ?? {}) as { access_token?: string; expires_in?: number };
  if (r.status !== 200 || !body.access_token) throw new ConnectorError('FAILED', 'Sign-in was refused: check the token address, client ID, secret and scope');
  if (tokens.size > 200) tokens.clear();
  tokens.set(key, { token: body.access_token, until: Date.now() + Math.max(30, (body.expires_in ?? 300) - 60) * 1000 });
  return body.access_token;
}
