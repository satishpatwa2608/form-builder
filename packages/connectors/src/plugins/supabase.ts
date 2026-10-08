import { z } from 'zod';
import { ConnectorError } from '../registry';
import type { ConnectorContext, ConnectorPlugin, Entity, EntityField } from '../types';
import { assertIdentifier, elapsed, filtersFrom, now, rowFrom, safeFetch } from './shared';

/**
 * Supabase through its REST API (PostgREST). Use a key with only the rights
 * the forms need (a restricted role or the anon key with RLS), not service_role.
 */
const headers = (ctx: ConnectorContext, extra: Record<string, string> = {}) => ({
  apikey: ctx.secrets.apiKey!,
  Authorization: `Bearer ${ctx.secrets.apiKey}`,
  Accept: 'application/json',
  ...extra,
});
const base = (ctx: ConnectorContext) => `${String(ctx.connector.settings.url).replace(/\/+$/, '')}/rest/v1`;

/** PostgREST exact-match filter: col=eq.value (the value is URL-encoded, never parsed as an operator). */
const eq = (v: unknown) => `eq.${v === null ? 'null' : String(v)}`;

const TYPE: Record<string, EntityField['type']> = { integer: 'number', number: 'number', boolean: 'boolean', string: 'string', array: 'array', object: 'object' };

export const supabasePlugin: ConnectorPlugin = {
  type: 'supabase',
  label: 'Supabase',
  settingsSchema: z.object({ url: z.string().url().regex(/^https:\/\//, 'Use the https project URL') }),
  secretsSchema: z.object({ apiKey: z.string().min(20).max(2000) }),
  operations: ['list', 'get', 'lookup', 'insert', 'update'],

  async test(ctx) {
    const start = now();
    const r = await safeFetch(ctx, `${base(ctx)}/`, { headers: headers(ctx) });
    if (r.status >= 400) return { ok: false, message: `Supabase answered ${r.status}` };
    return { ok: true, message: 'Connected', latencyMs: elapsed(start) };
  },

  async discover(ctx): Promise<Entity[]> {
    const r = await safeFetch(ctx, `${base(ctx)}/`, { headers: headers(ctx, { Accept: 'application/openapi+json' }) });
    const defs = ((r.json as { definitions?: Record<string, { properties?: Record<string, { type?: string; format?: string }> }> })?.definitions ?? {}) as Record<
      string,
      { properties?: Record<string, { type?: string; format?: string }> }
    >;
    return Object.entries(defs)
      .slice(0, 300)
      .map(([key, d]) => ({
        key,
        label: key,
        fields: Object.entries(d.properties ?? {}).map(([name, p]) => ({ name, type: p.format?.includes('timestamp') || p.format === 'date' ? 'date' : (TYPE[p.type ?? ''] ?? 'string') })),
      }));
  },

  async run(ctx, req) {
    const start = now();
    const table = assertIdentifier(req.entity.key);
    const select = req.entity.fields.map((f) => assertIdentifier(f)).join(',');
    const keyField = req.entity.keyField ?? 'id';
    const q = new URLSearchParams();
    switch (req.kind) {
      case 'list': {
        q.set('select', select);
        for (const [k, v] of filtersFrom(req.entity, req.params)) q.append(k, eq(v));
        q.set('limit', String(req.limits.maxRows));
        const r = await safeFetch(ctx, `${base(ctx)}/${table}?${q}`, { headers: headers(ctx) });
        if (r.status >= 400) throw new ConnectorError('FAILED', `Supabase answered ${r.status}`);
        return { rows: (Array.isArray(r.json) ? r.json : []) as Record<string, unknown>[], durationMs: elapsed(start) };
      }
      case 'get':
      case 'lookup': {
        const key = req.params[keyField];
        if (key === undefined) throw new ConnectorError('UNSUPPORTED', `${keyField} is required`);
        q.set('select', req.kind === 'lookup' ? assertIdentifier(keyField, req.entity.fields) : select);
        q.set(assertIdentifier(keyField, req.entity.fields), eq(key));
        q.set('limit', '1');
        const r = await safeFetch(ctx, `${base(ctx)}/${table}?${q}`, { headers: headers(ctx) });
        if (r.status >= 400) throw new ConnectorError('FAILED', `Supabase answered ${r.status}`);
        const rows = (Array.isArray(r.json) ? r.json : []) as Record<string, unknown>[];
        return { rows: req.kind === 'lookup' ? (rows.length ? [{ exists: true }] : []) : rows, durationMs: elapsed(start) };
      }
      case 'insert': {
        const r = await safeFetch(ctx, `${base(ctx)}/${table}`, {
          method: 'POST',
          headers: headers(ctx, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
          body: JSON.stringify(rowFrom(req.entity, req.params)),
        });
        if (r.status >= 400) throw new ConnectorError('FAILED', `Supabase answered ${r.status}`);
        return { rows: [], affected: 1, durationMs: elapsed(start) };
      }
      case 'update': {
        const { [keyField]: key, ...rest } = req.params;
        if (key === undefined) throw new ConnectorError('UNSUPPORTED', `${keyField} is required`);
        q.set(assertIdentifier(keyField, req.entity.fields), eq(key));
        const r = await safeFetch(ctx, `${base(ctx)}/${table}?${q}`, {
          method: 'PATCH',
          headers: headers(ctx, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
          body: JSON.stringify(rowFrom(req.entity, rest)),
        });
        if (r.status >= 400) throw new ConnectorError('FAILED', `Supabase answered ${r.status}`);
        return { rows: [], affected: 1, durationMs: elapsed(start) };
      }
      default:
        throw new ConnectorError('UNSUPPORTED', `Supabase can't ${req.kind}`);
    }
  },
};
