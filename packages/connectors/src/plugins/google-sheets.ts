import { createSign } from 'node:crypto';
import { z } from 'zod';
import { ConnectorError } from '../registry';
import type { ConnectorContext, ConnectorPlugin, Entity } from '../types';
import { elapsed, filtersFrom, now, safeFetch } from './shared';
import { columnNames, rowFor, rowsFrom } from './sheets-shared';

/**
 * A Google Sheet: each response becomes a row, and a sheet can feed a
 * dropdown. It signs in as a service account (a robot user the customer
 * creates and shares the sheet with), so nobody's own Google password or
 * consent is involved. Each tab is a table; its first row names the columns.
 */
let endpoints = { token: 'https://oauth2.googleapis.com/token', sheets: 'https://sheets.googleapis.com' };
/** Tests stand in for Google. */
export const setGoogleEndpoints = (e: Partial<typeof endpoints>) => {
  endpoints = { ...endpoints, ...e };
};

const settingsSchema = z.object({
  /** The sheet's address as copied from the browser, or just its ID. */
  spreadsheet: z.string().min(10).max(300),
});

/** The ID inside a sheet's address (or the ID itself). */
export function spreadsheetId(input: string): string {
  const id = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,100})/.exec(input)?.[1] ?? input.trim();
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(id)) throw new ConnectorError('UNSUPPORTED', "That is not a Google Sheet's address. Copy it from the browser while the sheet is open.");
  return id;
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
}
function account(ctx: ConnectorContext): ServiceAccount {
  try {
    const key = JSON.parse(ctx.secrets.serviceAccount ?? '') as Partial<ServiceAccount>;
    if (typeof key.client_email === 'string' && typeof key.private_key === 'string' && key.private_key.includes('PRIVATE KEY')) return key as ServiceAccount;
  } catch {
    /* refused below */
  }
  throw new ConnectorError('UNSUPPORTED', 'Paste the whole key file (JSON) of the service account');
}

const b64 = (v: string | Buffer) => Buffer.from(v).toString('base64url');
const tokens = new Map<string, { token: string; until: number }>();

async function bearer(ctx: ConnectorContext): Promise<Record<string, string>> {
  const sa = account(ctx);
  const key = `${ctx.connector.id}:${sa.client_email}:${sa.private_key.length}:${endpoints.token}`;
  const hit = tokens.get(key);
  if (hit && hit.until > Date.now()) return { Authorization: `Bearer ${hit.token}` };
  const at = Math.floor(Date.now() / 1000);
  // A short-lived statement of who is asking, signed with the account's key; Google trades it for a token.
  const unsigned = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', iat: at, exp: at + 3600 }))}`;
  let signature: string;
  try {
    signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
  } catch {
    throw new ConnectorError('UNSUPPORTED', 'The key in the service account file could not be used');
  }
  const r = await safeFetch(ctx, endpoints.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }).toString(),
  });
  const body = (r.json ?? {}) as { access_token?: string; expires_in?: number };
  if (r.status !== 200 || !body.access_token) throw new ConnectorError('FAILED', 'Google refused the service account: check that its key is current and the Sheets API is switched on');
  if (tokens.size > 200) tokens.clear();
  tokens.set(key, { token: body.access_token, until: Date.now() + Math.max(60, (body.expires_in ?? 3600) - 120) * 1000 });
  return { Authorization: `Bearer ${body.access_token}` };
}

interface Tab {
  sheetId: number;
  title: string;
}
const tabKey = (t: Tab) => `tab_${t.sheetId}`;
/** A tab's name inside a range: quoted, with its quotes doubled. */
const inRange = (title: string, cells: string) => `'${title.replace(/'/g, "''")}'!${cells}`;

async function call(ctx: ConnectorContext, path: string, init: RequestInit = {}) {
  const r = await safeFetch(ctx, `${endpoints.sheets}${path}`, { ...init, headers: { Accept: 'application/json', ...(await bearer(ctx)), ...(init.headers as Record<string, string> | undefined) } });
  if (r.status === 403 || r.status === 404) throw new ConnectorError('FAILED', `Google would not open the sheet: share it with ${account(ctx).client_email} as an editor`);
  if (r.status >= 400) throw new ConnectorError('FAILED', `Google Sheets answered ${r.status}`);
  return r.json as Record<string, unknown>;
}

async function tabs(ctx: ConnectorContext, id: string): Promise<Tab[]> {
  const doc = await call(ctx, `/v4/spreadsheets/${id}?${new URLSearchParams({ fields: 'sheets.properties(sheetId,title)' }).toString()}`);
  return ((doc.sheets ?? []) as { properties: Tab }[]).map((s) => s.properties).filter((p) => typeof p?.title === 'string' && typeof p.sheetId === 'number');
}

export const googleSheetsPlugin: ConnectorPlugin = {
  type: 'google-sheets',
  label: 'Google Sheets',
  settingsSchema,
  secretsSchema: z.object({ serviceAccount: z.string().min(50).max(10_000) }),
  operations: ['list', 'get', 'lookup', 'insert'],

  async test(ctx) {
    const start = now();
    const found = await tabs(ctx, spreadsheetId(String(ctx.connector.settings.spreadsheet)));
    return { ok: true, message: `Opened the sheet: ${found.length} ${found.length === 1 ? 'tab' : 'tabs'}`, latencyMs: elapsed(start) };
  },

  async discover(ctx): Promise<Entity[]> {
    const id = spreadsheetId(String(ctx.connector.settings.spreadsheet));
    const found = (await tabs(ctx, id)).slice(0, 50);
    if (!found.length) return [];
    const query = new URLSearchParams();
    for (const t of found) query.append('ranges', inRange(t.title, '1:1'));
    const headers = ((await call(ctx, `/v4/spreadsheets/${id}/values:batchGet?${query.toString()}`)).valueRanges ?? []) as { values?: unknown[][] }[];
    return found.map((t, i) => ({
      // The tab's own number, which stays the same when someone renames the tab.
      key: tabKey(t),
      label: t.title,
      fields: columnNames(headers[i]?.values?.[0] ?? []).filter(Boolean).map((name) => ({ name, type: 'string' as const })),
    }));
  },

  async run(ctx, req) {
    const start = now();
    const id = spreadsheetId(String(ctx.connector.settings.spreadsheet));
    const tab = (await tabs(ctx, id)).find((t) => tabKey(t) === req.entity.key);
    if (!tab) throw new ConnectorError('FAILED', 'That tab is no longer in the sheet');
    if (req.kind === 'insert') {
      const head = ((await call(ctx, `/v4/spreadsheets/${id}/values/${encodeURIComponent(inRange(tab.title, '1:1'))}`)).values ?? []) as unknown[][];
      const row = rowFor(columnNames(head[0] ?? []), req.entity, req.params);
      // RAW: every cell is stored exactly as given and never worked out as a formula.
      await call(ctx, `/v4/spreadsheets/${id}/values/${encodeURIComponent(inRange(tab.title, 'A1'))}:append?${new URLSearchParams({ valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' }).toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [row] }),
      });
      return { rows: [], affected: 1, durationMs: elapsed(start) };
    }
    if (req.kind === 'list' || req.kind === 'get' || req.kind === 'lookup') {
      const keyField = req.entity.keyField ?? '';
      const filters = req.kind === 'list' ? filtersFrom(req.entity, req.params) : filtersFrom(req.entity, { [keyField]: req.params[keyField] });
      if (req.kind !== 'list' && (!keyField || req.params[keyField] === undefined)) throw new ConnectorError('UNSUPPORTED', 'Choose the column that identifies a row');
      // A sheet is read from the top; a very long one is read as far as the limit of rows allows.
      const values = ((await call(ctx, `/v4/spreadsheets/${id}/values/${encodeURIComponent(inRange(tab.title, 'A1:ZZ5001'))}`)).values ?? []) as unknown[][];
      const rows = rowsFrom(columnNames(values[0] ?? []), values.slice(1), filters, req.kind === 'list' ? req.limits.maxRows : 1);
      return { rows: req.kind === 'lookup' ? (rows.length ? [{ exists: true }] : []) : rows, durationMs: elapsed(start) };
    }
    throw new ConnectorError('UNSUPPORTED', `A sheet can't ${req.kind}`);
  },
};
