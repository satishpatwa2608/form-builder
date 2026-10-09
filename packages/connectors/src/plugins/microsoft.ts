import { z } from 'zod';
import { ConnectorError } from '../registry';
import type { ConnectorContext, ConnectorPlugin, Entity } from '../types';
import { elapsed, filtersFrom, now, safeFetch } from './shared';
import { columnNames, rowFor, rowsFrom } from './sheets-shared';

/**
 * Microsoft 365 through its Graph API, as an application registered in the
 * customer's own directory: an Excel workbook kept in OneDrive or SharePoint
 * (each response a row of one of its tables), and a OneDrive or SharePoint
 * folder (each response a file). The workbook or folder is named by the
 * sharing link copied from Microsoft's own "Copy link", so nobody has to
 * find drive or item identifiers.
 */
let endpoints = { login: 'https://login.microsoftonline.com', graph: 'https://graph.microsoft.com' };
/** Tests stand in for Microsoft. */
export const setMicrosoftEndpoints = (e: Partial<typeof endpoints>) => {
  endpoints = { ...endpoints, ...e };
};

const base = {
  tenantId: z.string().regex(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|([a-z0-9-]+\.)+[a-z]{2,63})$/i),
  clientId: z.string().min(1).max(100),
  /** The link from "Copy link" on the workbook or folder. */
  link: z.string().url().max(2000),
};
const secretsSchema = z.object({ clientSecret: z.string().min(1).max(1000) });

const tokens = new Map<string, { token: string; until: number }>();

async function bearer(ctx: ConnectorContext): Promise<Record<string, string>> {
  const s = ctx.connector.settings;
  const secret = ctx.secrets.clientSecret;
  if (!secret) throw new ConnectorError('UNSUPPORTED', 'The client secret is missing');
  const key = `${ctx.connector.id}:${String(s.tenantId)}:${String(s.clientId)}:${secret.length}:${endpoints.login}`;
  const hit = tokens.get(key);
  if (hit && hit.until > Date.now()) return { Authorization: `Bearer ${hit.token}` };
  const r = await safeFetch(ctx, `${endpoints.login}/${encodeURIComponent(String(s.tenantId))}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: String(s.clientId), client_secret: secret, scope: 'https://graph.microsoft.com/.default' }).toString(),
  });
  const body = (r.json ?? {}) as { access_token?: string; expires_in?: number };
  if (r.status !== 200 || !body.access_token) throw new ConnectorError('FAILED', 'Microsoft 365 refused the directory (tenant) ID, application ID or secret');
  if (tokens.size > 200) tokens.clear();
  tokens.set(key, { token: body.access_token, until: Date.now() + Math.max(60, (body.expires_in ?? 300) - 60) * 1000 });
  return { Authorization: `Bearer ${body.access_token}` };
}

async function graph(ctx: ConnectorContext, path: string, init: RequestInit = {}) {
  const r = await safeFetch(ctx, `${endpoints.graph}/v1.0${path}`, { ...init, headers: { Accept: 'application/json', ...(await bearer(ctx)), ...(init.headers as Record<string, string> | undefined) } });
  if (r.status === 401 || r.status === 403) throw new ConnectorError('FAILED', 'Microsoft 365 did not let the application in: give it the Files.ReadWrite.All application permission (Sites.ReadWrite.All for SharePoint), with admin consent');
  if (r.status === 404) throw new ConnectorError('FAILED', 'Microsoft 365 could not find that: check the link, and that the file or folder still exists');
  if (r.status >= 400) throw new ConnectorError('FAILED', `Microsoft 365 answered ${r.status}`);
  return (r.json ?? {}) as Record<string, unknown>;
}

/** How Graph wants a sharing link written when it is used as an address. */
export const shareToken = (link: string) => `u!${Buffer.from(link, 'utf8').toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`;

interface Item {
  drive: string;
  id: string;
  name: string;
  folder: boolean;
}
const items = new Map<string, { item: Item; until: number }>();

/** The workbook or folder a sharing link points at. Looked up once, then remembered for a while. */
async function itemOf(ctx: ConnectorContext): Promise<Item> {
  const link = String(ctx.connector.settings.link);
  const key = `${ctx.connector.id}:${link}:${endpoints.graph}`;
  const hit = items.get(key);
  if (hit && hit.until > Date.now()) return hit.item;
  const doc = (await graph(ctx, `/shares/${shareToken(link)}/driveItem?$select=id,name,folder,file,parentReference`)) as { id?: string; name?: string; folder?: unknown; parentReference?: { driveId?: string } };
  if (!doc.id || !doc.parentReference?.driveId) throw new ConnectorError('FAILED', 'Microsoft 365 could not open that link');
  const item = { drive: doc.parentReference.driveId, id: doc.id, name: doc.name ?? '', folder: !!doc.folder };
  if (items.size > 200) items.clear();
  items.set(key, { item, until: Date.now() + 10 * 60_000 });
  return item;
}

const TABLE = /^[A-Za-z_][A-Za-z0-9_.]{0,254}$/;

/** An Excel workbook in OneDrive or SharePoint: each of its tables takes rows. */
export const excelPlugin: ConnectorPlugin = {
  type: 'excel',
  label: 'Excel (Microsoft 365)',
  settingsSchema: z.object(base),
  secretsSchema,
  operations: ['list', 'get', 'lookup', 'insert'],

  async test(ctx) {
    const start = now();
    const item = await itemOf(ctx);
    if (item.folder) return { ok: false, message: 'That link is to a folder. Copy the link of the Excel workbook itself.' };
    const tables = ((await graph(ctx, `/drives/${item.drive}/items/${item.id}/workbook/tables?$select=name`)).value ?? []) as unknown[];
    return tables.length ? { ok: true, message: `Opened ${item.name}: ${tables.length} ${tables.length === 1 ? 'table' : 'tables'}`, latencyMs: elapsed(start) } : { ok: false, message: `${item.name} has no tables yet. In Excel, select the headings and choose Insert → Table.` };
  },

  async discover(ctx): Promise<Entity[]> {
    const item = await itemOf(ctx);
    const tables = (((await graph(ctx, `/drives/${item.drive}/items/${item.id}/workbook/tables?$select=name`)).value ?? []) as { name?: string }[]).filter((t) => t.name && TABLE.test(t.name)).slice(0, 50);
    const out: Entity[] = [];
    for (const t of tables) {
      const columns = ((await graph(ctx, `/drives/${item.drive}/items/${item.id}/workbook/tables/${encodeURIComponent(t.name!)}/columns?$select=name`)).value ?? []) as { name?: string }[];
      out.push({ key: t.name!.replace(/\./g, '_'), label: t.name!, fields: columnNames(columns.map((c) => c.name)).filter(Boolean).map((name) => ({ name, type: 'string' as const })) });
    }
    return out;
  },

  async run(ctx, req) {
    const start = now();
    const item = await itemOf(ctx);
    const book = `/drives/${item.drive}/items/${item.id}/workbook`;
    // The table as Excel names it (a name with a dot was offered with an underscore).
    const names = (((await graph(ctx, `${book}/tables?$select=name`)).value ?? []) as { name?: string }[]).map((t) => t.name ?? '');
    const table = names.find((n) => n.replace(/\./g, '_') === req.entity.key && TABLE.test(n));
    if (!table) throw new ConnectorError('FAILED', 'That table is no longer in the workbook');
    const at = `${book}/tables/${encodeURIComponent(table)}`;
    const columns = columnNames((((await graph(ctx, `${at}/columns?$select=name`)).value ?? []) as { name?: string }[]).map((c) => c.name));
    if (req.kind === 'insert') {
      await graph(ctx, `${at}/rows`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [rowFor(columns, req.entity, req.params)] }) });
      return { rows: [], affected: 1, durationMs: elapsed(start) };
    }
    if (req.kind === 'list' || req.kind === 'get' || req.kind === 'lookup') {
      const keyField = req.entity.keyField ?? '';
      if (req.kind !== 'list' && (!keyField || req.params[keyField] === undefined)) throw new ConnectorError('UNSUPPORTED', 'Choose the column that identifies a row');
      const filters = req.kind === 'list' ? filtersFrom(req.entity, req.params) : filtersFrom(req.entity, { [keyField]: req.params[keyField] });
      const found = ((await graph(ctx, `${at}/rows?$top=5000`)).value ?? []) as { values?: unknown[][] }[];
      const rows = rowsFrom(columns, found.map((r) => r.values?.[0] ?? []), filters, req.kind === 'list' ? req.limits.maxRows : 1);
      return { rows: req.kind === 'lookup' ? (rows.length ? [{ exists: true }] : []) : rows, durationMs: elapsed(start) };
    }
    throw new ConnectorError('UNSUPPORTED', `A workbook can't ${req.kind}`);
  },
};

/** A file name that is only ever a name inside the chosen folder: no way up or out of it. */
export function safeFileName(input: unknown, fallback: string): string {
  const parts = String(input ?? '')
    .split('/')
    .map((p) => p.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '').trim().slice(0, 100))
    .filter(Boolean)
    .slice(0, 4);
  return parts.length ? parts.join('/') : fallback;
}

/** What a response is saved as: its answers as JSON and, when the caller sends one, its PDF. */
export function filesFor(params: Record<string, unknown>): { name: string; type: string; body: Buffer }[] {
  const baseName = safeFileName(params.name, `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}`);
  const files = [{ name: `${baseName}.json`, type: 'application/json', body: Buffer.from(JSON.stringify(params.data ?? {}, null, 2), 'utf8') }];
  if (typeof params.pdf === 'string' && params.pdf.length) {
    const pdf = Buffer.from(params.pdf, 'base64');
    if (pdf.subarray(0, 5).toString() === '%PDF-') files.push({ name: `${baseName}.pdf`, type: 'application/pdf', body: pdf });
  }
  return files;
}

/** A OneDrive or SharePoint folder: each response is saved into it as a file. */
export const microsoftFilesPlugin: ConnectorPlugin = {
  type: 'microsoft-files',
  label: 'SharePoint or OneDrive folder',
  settingsSchema: z.object(base),
  secretsSchema,
  operations: ['upload'],

  async test(ctx) {
    const start = now();
    const item = await itemOf(ctx);
    return item.folder ? { ok: true, message: `Opened the folder ${item.name}`, latencyMs: elapsed(start) } : { ok: false, message: 'That link is to a file. Copy the link of the folder responses should be saved in.' };
  },

  async discover(ctx): Promise<Entity[]> {
    const item = await itemOf(ctx);
    return [{ key: 'files', label: `Files in ${item.name}`, fields: [{ name: 'name', type: 'string' }] }];
  },

  async run(ctx, req) {
    const start = now();
    if (req.kind !== 'upload') throw new ConnectorError('UNSUPPORTED', `A folder can't ${req.kind}`);
    const item = await itemOf(ctx);
    if (!item.folder) throw new ConnectorError('FAILED', 'That link is to a file, not a folder');
    const saved: string[] = [];
    for (const f of filesFor(req.params)) {
      const path = f.name.split('/').map(encodeURIComponent).join('/');
      // A second response with the same name is kept beside the first, never written over it.
      await graph(ctx, `/drives/${item.drive}/items/${item.id}:/${path}:/content?@microsoft.graph.conflictBehavior=rename`, { method: 'PUT', headers: { 'Content-Type': f.type }, body: new Uint8Array(f.body) });
      saved.push(f.name);
    }
    return { rows: [{ id: saved[0], files: saved.join(', ') }], affected: saved.length, durationMs: elapsed(start) };
  },
};
