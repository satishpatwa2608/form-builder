import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import { ConnectorError } from '../registry';
import type { ConnectorContext, ConnectorPlugin, Entity, EntityField } from '../types';
import { applicationToken, assertIdentifier, elapsed, filtersFrom, now, rowFrom, safeFetch, savedRow, type Primitive } from './shared';

/**
 * An OData v4 service: Microsoft Dynamics 365 / Dataverse, SAP, and anything
 * else that publishes one. The service describes itself ($metadata), so its
 * entity sets and fields are discovered, not typed in. Reads are exact-match
 * filters on exposed fields; writes are POST and PATCH with only exposed fields.
 */
const settingsSchema = z.object({
  /** The service root, e.g. https://org.crm.dynamics.com/api/data/v9.2 */
  baseUrl: z.string().url(),
  auth: z.enum(['none', 'bearer', 'apiKey', 'basic', 'oauth']).default('none'),
  apiKeyHeader: z.string().regex(/^[A-Za-z0-9-]{1,60}$/).optional(),
  /** oauth (an application signing in as itself): where it gets its token, who it is, and what for. */
  tokenUrl: z.string().url().optional(),
  clientId: z.string().max(200).optional(),
  scope: z.string().max(500).optional(),
});
type Settings = z.infer<typeof settingsSchema>;

function settingsOf(ctx: ConnectorContext): Settings {
  const parsed = settingsSchema.safeParse(ctx.connector.settings);
  if (!parsed.success) throw new ConnectorError('UNSUPPORTED', 'The OData connector settings are not valid');
  return parsed.data;
}
const root = (s: Settings) => s.baseUrl.replace(/\/+$/, '');

async function authHeaders(ctx: ConnectorContext, s: Settings): Promise<Record<string, string>> {
  switch (s.auth) {
    case 'bearer':
      return { Authorization: `Bearer ${ctx.secrets.token}` };
    case 'apiKey':
      return { [s.apiKeyHeader ?? 'X-API-Key']: ctx.secrets.token! };
    case 'basic':
      return { Authorization: `Basic ${Buffer.from(`${ctx.secrets.username}:${ctx.secrets.password}`).toString('base64')}` };
    case 'oauth':
      return { Authorization: `Bearer ${await applicationToken(ctx, s)}` };
    default:
      return {};
  }
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A value as OData writes it in an address. Text is quoted with its quotes
 * doubled, which is the whole of OData's escaping, so nothing typed into a
 * form can end the value and add to the query. Identifiers (GUIDs) go bare.
 */
export function odataLiteral(v: Primitive): string {
  if (v === null) return 'null';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new ConnectorError('UNSUPPORTED', 'That number cannot be used in a filter');
    return String(v);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return GUID.test(v) ? v : `'${v.replace(/'/g, "''")}'`;
}

const EDM: Record<string, EntityField['type']> = {
  'Edm.String': 'string', 'Edm.Guid': 'string',
  'Edm.Int16': 'number', 'Edm.Int32': 'number', 'Edm.Int64': 'number', 'Edm.Decimal': 'number', 'Edm.Double': 'number', 'Edm.Single': 'number', 'Edm.Byte': 'number',
  'Edm.Boolean': 'boolean',
  'Edm.Date': 'date', 'Edm.DateTimeOffset': 'date',
};
const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Entity sets and their fields from a service's $metadata document. Pure, so it is tested without a service. */
export function parseMetadata(xml: string): (Entity & { keyField?: string })[] {
  // Entities in the XML sense are not expanded: nothing in the document can make it grow or reach out.
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', removeNSPrefix: true, processEntities: false }).parse(xml) as { Edmx?: { DataServices?: { Schema?: unknown } } };
  type Schema = { Namespace?: string; Alias?: string; EntityType?: unknown; EntityContainer?: unknown };
  type Type = { Name?: string; Property?: unknown; Key?: { PropertyRef?: unknown } };
  const schemas = list(doc.Edmx?.DataServices?.Schema as Schema | Schema[] | undefined);
  const types = new Map<string, Type>();
  for (const s of schemas) {
    for (const t of list(s.EntityType as Type | Type[] | undefined)) {
      if (!t.Name) continue;
      for (const prefix of [s.Namespace, s.Alias]) if (prefix) types.set(`${prefix}.${t.Name}`, t);
    }
  }
  const out: (Entity & { keyField?: string })[] = [];
  for (const s of schemas) {
    for (const container of list(s.EntityContainer as { EntitySet?: unknown } | { EntitySet?: unknown }[] | undefined)) {
      for (const set of list(container.EntitySet as { Name?: string; EntityType?: string } | { Name?: string; EntityType?: string }[] | undefined)) {
        const type = set.EntityType ? types.get(set.EntityType) : undefined;
        // Only names we could put in an address safely.
        if (!set.Name || !type || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(set.Name)) continue;
        const fields = list(type.Property as { Name?: string; Type?: string; Nullable?: string } | { Name?: string; Type?: string; Nullable?: string }[] | undefined)
          .filter((p) => p.Name && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(p.Name))
          .map((p) => ({ name: p.Name!, type: EDM[p.Type ?? ''] ?? ('unknown' as const), ...(p.Nullable === 'false' ? {} : { nullable: true }) }));
        const keys = list(type.Key?.PropertyRef as { Name?: string } | { Name?: string }[] | undefined).map((k) => k.Name);
        out.push({ key: set.Name, label: set.Name, fields, ...(keys.length === 1 && keys[0] ? { keyField: keys[0] } : {}) });
      }
    }
  }
  return out.slice(0, 500);
}

/** What the service sent, without its own bookkeeping (@odata.etag and the like). */
const plain = (row: unknown): Record<string, unknown> => Object.fromEntries(Object.entries(row && typeof row === 'object' ? (row as Record<string, unknown>) : {}).filter(([k]) => !k.includes('@')));

export const odataPlugin: ConnectorPlugin = {
  type: 'odata',
  label: 'OData (Dynamics 365, SAP and others)',
  settingsSchema,
  secretsSchema: z.object({ token: z.string().max(4000).optional(), username: z.string().max(200).optional(), password: z.string().max(500).optional(), clientSecret: z.string().max(1000).optional() }),
  operations: ['list', 'get', 'lookup', 'insert', 'update'],

  async test(ctx) {
    const start = now();
    const s = settingsOf(ctx);
    const r = await safeFetch(ctx, `${root(s)}/`, { headers: { Accept: 'application/json', ...(await authHeaders(ctx, s)) } });
    if (r.status === 401 || r.status === 403) return { ok: false, message: 'The service refused the sign-in' };
    const sets = (r.json as { value?: unknown[] } | undefined)?.value;
    return r.status === 200 && Array.isArray(sets) ? { ok: true, message: `Connected: ${sets.length} entity sets`, latencyMs: elapsed(start) } : { ok: false, message: `That address did not answer as an OData service (${r.status})` };
  },

  async discover(ctx): Promise<Entity[]> {
    const s = settingsOf(ctx);
    const r = await safeFetch(ctx, `${root(s)}/$metadata`, { headers: { Accept: 'application/xml', ...(await authHeaders(ctx, s)) } });
    if (r.status >= 400) throw new ConnectorError('FAILED', `The service answered ${r.status}`);
    return parseMetadata(r.text);
  },

  async run(ctx, req) {
    const start = now();
    const s = settingsOf(ctx);
    const set = `${root(s)}/${assertIdentifier(req.entity.key)}`;
    const select = req.entity.fields.map((f) => assertIdentifier(f)).join(',');
    const headers = { Accept: 'application/json', ...(await authHeaders(ctx, s)) };
    const keyField = req.entity.keyField ?? 'id';
    const one = (key: unknown) => {
      assertIdentifier(keyField, req.entity.fields);
      if (key === undefined || key === null || (typeof key !== 'string' && typeof key !== 'number')) throw new ConnectorError('UNSUPPORTED', `${keyField} is required`);
      return `${set}(${encodeURIComponent(odataLiteral(key))})`;
    };
    const failed = (status: number) => new ConnectorError('FAILED', `The service answered ${status}`);
    switch (req.kind) {
      case 'list': {
        const where = filtersFrom(req.entity, req.params).map(([k, v]) => `${k} eq ${odataLiteral(v)}`);
        const query = new URLSearchParams({ $select: select, $top: String(Math.floor(req.limits.maxRows)), ...(where.length ? { $filter: where.join(' and ') } : {}) });
        const r = await safeFetch(ctx, `${set}?${query.toString()}`, { headers });
        if (r.status >= 400) throw failed(r.status);
        const rows = (r.json as { value?: unknown[] } | undefined)?.value;
        return { rows: (Array.isArray(rows) ? rows : []).slice(0, req.limits.maxRows).map(plain), durationMs: elapsed(start) };
      }
      case 'get':
      case 'lookup': {
        const r = await safeFetch(ctx, `${one(req.params[keyField])}?${new URLSearchParams({ $select: select }).toString()}`, { headers });
        if (r.status === 404) return { rows: [], durationMs: elapsed(start) };
        if (r.status >= 400) throw failed(r.status);
        return { rows: r.json && typeof r.json === 'object' ? [req.kind === 'lookup' ? { exists: true } : plain(r.json)] : [], durationMs: elapsed(start) };
      }
      case 'insert':
      case 'update': {
        const { [keyField]: key, ...rest } = req.params;
        const r = await safeFetch(ctx, req.kind === 'update' ? one(key) : set, {
          method: req.kind === 'insert' ? 'POST' : 'PATCH',
          // Ask for the saved row back, so what the service filled in (its ID) can be used by later steps.
          headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=representation' },
          body: JSON.stringify(rowFrom(req.entity, req.kind === 'insert' ? req.params : rest)),
        });
        if (r.status >= 400) throw failed(r.status);
        return { rows: savedRow(req.entity, r.json, keyField), affected: 1, durationMs: elapsed(start) };
      }
      default:
        throw new ConnectorError('UNSUPPORTED', `OData connectors can't ${req.kind}`);
    }
  },
};
