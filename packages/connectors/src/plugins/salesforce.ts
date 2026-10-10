import { z } from 'zod';
import { ConnectorError } from '../registry';
import type { ConnectorContext, ConnectorPlugin, Entity, EntityField } from '../types';
import { assertIdentifier, elapsed, filtersFrom, now, rowFrom, safeFetch, type Primitive } from './shared';

/**
 * Salesforce, through its REST API. It signs in as an application (a
 * Connected App with the client credentials flow), so no person's password
 * is stored. Objects and their fields are found from Salesforce itself.
 * Reads are exact-match SOQL on exposed fields; writes create or update one
 * record with only the exposed fields.
 */
const API_VERSION = 'v60.0';
/** The standard objects forms most often read or write; custom objects are always offered. */
const COMMON = new Set(['Lead', 'Contact', 'Account', 'Case', 'Opportunity', 'Campaign', 'CampaignMember', 'Task', 'Event', 'Product2', 'Order', 'Asset']);
const MAX_OBJECTS = 60;

const settingsSchema = z.object({
  /** The organisation's own Salesforce address (My Domain), e.g. https://acme.my.salesforce.com */
  instanceUrl: z.string().url(),
  clientId: z.string().min(1).max(300),
});
type Settings = z.infer<typeof settingsSchema>;

function settingsOf(ctx: ConnectorContext): Settings & { base: string } {
  const parsed = settingsSchema.safeParse(ctx.connector.settings);
  if (!parsed.success) throw new ConnectorError('UNSUPPORTED', 'The Salesforce connector settings are not valid');
  let host = '';
  try {
    host = new URL(parsed.data.instanceUrl).hostname.toLowerCase();
  } catch {
    /* refused below */
  }
  // Only Salesforce's own addresses: the client secret is sent there.
  if (!ctx.allowPrivateNetwork && !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.(salesforce\.com|force\.com)$/.test(host)) {
    throw new ConnectorError('UNSUPPORTED', 'Use your Salesforce address, for example https://yourcompany.my.salesforce.com');
  }
  return { ...parsed.data, base: parsed.data.instanceUrl.replace(/\/+$/, '') };
}

const tokens = new Map<string, { token: string; until: number }>();

async function bearer(ctx: ConnectorContext, s: Settings & { base: string }): Promise<Record<string, string>> {
  const secret = ctx.secrets.clientSecret;
  if (!secret) throw new ConnectorError('UNSUPPORTED', 'The consumer secret is missing');
  const key = `${ctx.connector.id}:${s.base}:${s.clientId}:${secret.length}`;
  const hit = tokens.get(key);
  if (hit && hit.until > Date.now()) return { Authorization: `Bearer ${hit.token}` };
  const r = await safeFetch(ctx, `${s.base}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: s.clientId, client_secret: secret }).toString(),
  });
  const body = (r.json ?? {}) as { access_token?: string };
  if (r.status !== 200 || !body.access_token) {
    throw new ConnectorError('FAILED', 'Salesforce refused the sign-in: check the consumer key and secret, and that the connected app allows the client credentials flow with a "run as" user');
  }
  if (tokens.size > 200) tokens.clear();
  // Salesforce does not say how long a token lasts; a short life here costs one extra sign-in now and then.
  tokens.set(key, { token: body.access_token, until: Date.now() + 15 * 60_000 });
  return { Authorization: `Bearer ${body.access_token}` };
}

/**
 * A value as SOQL writes it. Text is quoted with backslashes and quotes
 * escaped, which is all SOQL needs for a quoted string, so nothing typed
 * into a form can end the value and add to the query.
 */
export function soqlLiteral(v: Primitive): string {
  if (v === null) return 'null';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new ConnectorError('UNSUPPORTED', 'That number cannot be used in a filter');
    return String(v);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
}

/** Salesforce's own names: letters, digits and underscores (custom ones end in __c). */
const name = (n: string, allowed?: string[]) => assertIdentifier(n, allowed);
const RECORD_ID = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/;

/** The statement for a read. Pure, so it is tested without Salesforce. */
export function buildSoql(entity: { key: string; fields: string[] }, where: [string, Primitive][], limit: number): string {
  const fields = entity.fields.map((f) => name(f));
  if (!fields.length) throw new ConnectorError('UNSUPPORTED', 'No fields are exposed');
  const conditions = where.map(([k, v]) => `${name(k, entity.fields)} = ${soqlLiteral(v)}`);
  return `SELECT ${fields.join(', ')} FROM ${name(entity.key)}${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} LIMIT ${Math.max(1, Math.min(2000, Math.floor(limit)))}`;
}

const TYPES: Record<string, EntityField['type']> = {
  string: 'string', textarea: 'string', email: 'string', phone: 'string', url: 'string', picklist: 'string', id: 'string', reference: 'string', multipicklist: 'string', combobox: 'string',
  int: 'number', double: 'number', currency: 'number', percent: 'number', long: 'number',
  boolean: 'boolean',
  date: 'date', datetime: 'date',
};
const plain = (row: unknown): Record<string, unknown> => Object.fromEntries(Object.entries(row && typeof row === 'object' ? (row as Record<string, unknown>) : {}).filter(([k]) => k !== 'attributes'));
const failed = (status: number) => new ConnectorError('FAILED', `Salesforce answered ${status}`);

export const salesforcePlugin: ConnectorPlugin = {
  type: 'salesforce',
  label: 'Salesforce',
  settingsSchema,
  secretsSchema: z.object({ clientSecret: z.string().min(1).max(1000) }),
  operations: ['list', 'get', 'lookup', 'insert', 'update'],

  async test(ctx) {
    const start = now();
    const s = settingsOf(ctx);
    const r = await safeFetch(ctx, `${s.base}/services/data/${API_VERSION}/limits`, { headers: { Accept: 'application/json', ...(await bearer(ctx, s)) } });
    return r.status === 200 ? { ok: true, message: 'Connected to Salesforce', latencyMs: elapsed(start) } : { ok: false, message: `Salesforce answered ${r.status}` };
  },

  async discover(ctx): Promise<Entity[]> {
    const s = settingsOf(ctx);
    const headers = { Accept: 'application/json', ...(await bearer(ctx, s)) };
    const all = await safeFetch(ctx, `${s.base}/services/data/${API_VERSION}/sobjects`, { headers });
    if (all.status !== 200) throw failed(all.status);
    type Described = { name: string; label: string; custom: boolean; queryable: boolean };
    const wanted = (((all.json as { sobjects?: Described[] } | undefined)?.sobjects ?? []) as Described[])
      .filter((o) => o.queryable && (o.custom || COMMON.has(o.name)) && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(o.name))
      // The well-known ones first, then the organisation's own.
      .sort((a, b) => Number(a.custom) - Number(b.custom) || a.name.localeCompare(b.name))
      .slice(0, MAX_OBJECTS);
    const out: (Entity & { keyField?: string })[] = [];
    // A few at a time: each object is asked about separately.
    for (let i = 0; i < wanted.length; i += 6) {
      const described = await Promise.all(
        wanted.slice(i, i + 6).map(async (o) => {
          const r = await safeFetch(ctx, `${s.base}/services/data/${API_VERSION}/sobjects/${o.name}/describe`, { headers });
          const fields = r.status === 200 ? ((r.json as { fields?: DescribedField[] }).fields ?? []) : [];
          return {
            key: o.name,
            label: o.label || o.name,
            keyField: 'Id',
            fields: fields.filter((f) => /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(f.name)).map((f) => ({ name: f.name, type: TYPES[f.type] ?? ('unknown' as const), ...(f.nillable ? { nullable: true } : f.nillable === false && f.createable ? { nullable: false } : {}), ...limitsOf(f) })),
          };
        }),
      );
      out.push(...described.filter((d) => d.fields.length));
    }
    return out;
  },

  async run(ctx, req) {
    const start = now();
    const s = settingsOf(ctx);
    const headers = { Accept: 'application/json', ...(await bearer(ctx, s)) };
    const data = `${s.base}/services/data/${API_VERSION}`;
    const object = name(req.entity.key);
    const keyField = req.entity.keyField ?? 'Id';
    const query = async (soql: string) => {
      const r = await safeFetch(ctx, `${data}/query?${new URLSearchParams({ q: soql }).toString()}`, { headers });
      if (r.status >= 400) throw failed(r.status);
      return (((r.json as { records?: unknown[] } | undefined)?.records ?? []) as unknown[]).map(plain);
    };
    switch (req.kind) {
      case 'list':
        return { rows: await query(buildSoql(req.entity, filtersFrom(req.entity, req.params), req.limits.maxRows)), durationMs: elapsed(start) };
      case 'get':
      case 'lookup': {
        const key = req.params[keyField];
        if (typeof key !== 'string' && typeof key !== 'number') throw new ConnectorError('UNSUPPORTED', `${keyField} is required`);
        const rows = await query(buildSoql(req.entity, [[name(keyField, req.entity.fields), key]], 1));
        return { rows: req.kind === 'lookup' ? (rows.length ? [{ exists: true }] : []) : rows, durationMs: elapsed(start) };
      }
      case 'insert': {
        const r = await safeFetch(ctx, `${data}/sobjects/${object}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(rowFrom(req.entity, req.params)) });
        if (r.status >= 400) throw failed(r.status);
        const id = (r.json as { id?: unknown } | undefined)?.id;
        // The new record's ID, for later steps (an email with a link to it, an update).
        return { rows: typeof id === 'string' ? [{ Id: id }] : [], affected: 1, durationMs: elapsed(start) };
      }
      case 'update': {
        const { [keyField]: key, ...rest } = req.params;
        name(keyField, req.entity.fields);
        if (typeof key !== 'string' || !key) throw new ConnectorError('UNSUPPORTED', `${keyField} is required`);
        // By Salesforce's own ID, or by a field the organisation marked as an external ID.
        if (keyField === 'Id' && !RECORD_ID.test(key)) throw new ConnectorError('UNSUPPORTED', 'That is not a Salesforce record ID');
        const target = keyField === 'Id' ? `${data}/sobjects/${object}/${key}` : `${data}/sobjects/${object}/${keyField}/${encodeURIComponent(key)}`;
        const r = await safeFetch(ctx, target, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(rowFrom(req.entity, rest)) });
        if (r.status >= 400) throw failed(r.status);
        return { rows: [], affected: 1, durationMs: elapsed(start) };
      }
      default:
        throw new ConnectorError('UNSUPPORTED', `Salesforce connectors can't ${req.kind}`);
    }
  },
};

interface DescribedField {
  name: string;
  type: string;
  /** Said outright as false, on a field a person may set, it must be given. */
  nillable?: boolean;
  createable?: boolean;
  /** Salesforce fills it in when a record is made without it. */
  defaultedOnCreate?: boolean;
  /** Longest text. */
  length?: number;
  /** Digits in all, and those after the point. */
  precision?: number;
  scale?: number;
  /** Digits of a whole number. */
  digits?: number;
}

/** What Salesforce says a field accepts: the longest text and the room a number has. */
function limitsOf(f: DescribedField): Pick<EntityField, 'maxLength' | 'min' | 'max' | 'hasDefault'> {
  const out: Pick<EntityField, 'maxLength' | 'min' | 'max' | 'hasDefault'> = {};
  const kind = TYPES[f.type];
  if (f.defaultedOnCreate) out.hasDefault = true;
  if (kind === 'string' && typeof f.length === 'number' && f.length > 0 && f.length <= 100_000) out.maxLength = f.length;
  if (kind === 'number') {
    const whole = f.type === 'int' ? f.digits : undefined;
    const digits = whole ?? f.precision;
    const places = whole ? 0 : (f.scale ?? 0);
    if (typeof digits === 'number' && digits > 0 && digits <= 15 && places >= 0 && places < digits) {
      out.max = Number((10 ** (digits - places) - 10 ** -places).toFixed(places));
      out.min = -out.max;
    }
  }
  return out;
}
