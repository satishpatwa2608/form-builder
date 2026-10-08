import { z } from 'zod';
import { ConnectorError } from '../registry';
import type { ConnectorContext, ConnectorPlugin, Entity } from '../types';
import { elapsed, filtersFrom, now, rowFrom, safeFetch } from './shared';

/**
 * A REST API. Each entity is a resource the connector manager defines:
 * settings.resources = [{ key, path, fields, listPath?, dataPath? }].
 * Reads send exposed filters as query parameters; writes POST/PATCH JSON.
 */
const resourceSchema = z.object({
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/),
  /** Relative to the base URL, e.g. /customers. `{id}` is replaced for get/update. */
  path: z.string().regex(/^\/[A-Za-z0-9_\-/.{}]*$/).max(300),
  fields: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/)).max(100),
  /** Where the rows are in a list response, e.g. "data.items" ('' = the body is the list). */
  dataPath: z.string().max(100).optional(),
});

const settingsSchema = z.object({
  baseUrl: z.string().url(),
  auth: z.enum(['none', 'bearer', 'apiKey', 'basic']).default('none'),
  /** Header for apiKey auth, e.g. X-API-Key. */
  apiKeyHeader: z.string().regex(/^[A-Za-z0-9-]{1,60}$/).optional(),
  resources: z.array(resourceSchema).max(50).default([]),
});

function authHeaders(ctx: ConnectorContext): Record<string, string> {
  const s = ctx.connector.settings as unknown as z.infer<typeof settingsSchema>;
  switch (s.auth) {
    case 'bearer':
      return { Authorization: `Bearer ${ctx.secrets.token}` };
    case 'apiKey':
      return { [s.apiKeyHeader ?? 'X-API-Key']: ctx.secrets.token! };
    case 'basic':
      return { Authorization: `Basic ${Buffer.from(`${ctx.secrets.username}:${ctx.secrets.password}`).toString('base64')}` };
    default:
      return {};
  }
}

function resources(ctx: ConnectorContext) {
  const parsed = settingsSchema.safeParse({ ...ctx.connector.settings, resources: parseResources(ctx.connector.settings.resources) });
  if (!parsed.success) throw new ConnectorError('UNSUPPORTED', 'The REST connector settings are not valid');
  return parsed.data;
}

/** Settings are flat primitives when stored; resources are kept as a JSON string. */
export function parseResources(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const read = (body: unknown, path?: string) => (path ? path.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), body) : body);

export const restPlugin: ConnectorPlugin = {
  type: 'rest',
  label: 'REST API',
  settingsSchema: settingsSchema.extend({ resources: z.string().max(50_000).optional() }),
  secretsSchema: z.object({ token: z.string().max(4000).optional(), username: z.string().max(200).optional(), password: z.string().max(500).optional() }),
  operations: ['list', 'get', 'lookup', 'insert', 'update'],

  async test(ctx) {
    const start = now();
    const s = resources(ctx);
    const r = await safeFetch(ctx, s.baseUrl, { headers: authHeaders(ctx) });
    return r.status < 500 ? { ok: true, message: `Reached ${new URL(s.baseUrl).hostname} (${r.status})`, latencyMs: elapsed(start) } : { ok: false, message: `The API answered ${r.status}` };
  },

  async discover(ctx): Promise<Entity[]> {
    return resources(ctx).resources.map((r) => ({ key: r.key, label: `${r.key} (${r.path})`, fields: r.fields.map((name) => ({ name, type: 'unknown' as const })) }));
  },

  async run(ctx, req) {
    const start = now();
    const s = resources(ctx);
    const res = s.resources.find((r) => r.key === req.entity.key);
    if (!res) throw new ConnectorError('UNSUPPORTED', 'Unknown resource');
    const keyField = req.entity.keyField ?? 'id';
    const url = (key?: unknown) => new URL(`${s.baseUrl.replace(/\/+$/, '')}${res.path.replace('{id}', key === undefined ? '' : encodeURIComponent(String(key)))}`);
    const headers = { Accept: 'application/json', ...authHeaders(ctx) };
    switch (req.kind) {
      case 'list': {
        const u = url();
        for (const [k, v] of filtersFrom(req.entity, req.params)) u.searchParams.set(k, String(v));
        const r = await safeFetch(ctx, u.toString(), { headers });
        if (r.status >= 400) throw new ConnectorError('FAILED', `The API answered ${r.status}`);
        const rows = read(r.json, res.dataPath);
        return { rows: (Array.isArray(rows) ? rows : []).slice(0, req.limits.maxRows) as Record<string, unknown>[], durationMs: elapsed(start) };
      }
      case 'get':
      case 'lookup': {
        const key = req.params[keyField];
        if (key === undefined) throw new ConnectorError('UNSUPPORTED', `${keyField} is required`);
        const r = await safeFetch(ctx, url(key).toString(), { headers });
        if (r.status === 404) return { rows: [], durationMs: elapsed(start) };
        if (r.status >= 400) throw new ConnectorError('FAILED', `The API answered ${r.status}`);
        const row = r.json && typeof r.json === 'object' && !Array.isArray(r.json) ? (r.json as Record<string, unknown>) : null;
        return { rows: row ? [req.kind === 'lookup' ? { exists: true } : row] : [], durationMs: elapsed(start) };
      }
      case 'insert':
      case 'update': {
        const { [keyField]: key, ...rest } = req.params;
        const target = req.kind === 'update' ? url(key) : url();
        const r = await safeFetch(ctx, target.toString(), {
          method: req.kind === 'insert' ? 'POST' : 'PATCH',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(rowFrom(req.entity, req.kind === 'insert' ? req.params : rest)),
        });
        if (r.status >= 400) throw new ConnectorError('FAILED', `The API answered ${r.status}`);
        return { rows: r.json && typeof r.json === 'object' && !Array.isArray(r.json) ? [r.json as Record<string, unknown>] : [], affected: 1, durationMs: elapsed(start) };
      }
      default:
        throw new ConnectorError('UNSUPPORTED', `REST connectors can't ${req.kind}`);
    }
  },
};
