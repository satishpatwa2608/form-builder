import { z } from 'zod';
import { ConnectorError } from '../registry';
import type { ConnectorContext, ConnectorPlugin, Entity } from '../types';
import { elapsed, now, safeFetch } from './shared';
import { filesFor } from './microsoft';

/**
 * An Azure Blob Storage container: each response is saved into it as a file.
 * Access is a shared access signature the customer makes for that one
 * container (write, and list for the test), which they can limit in time and
 * take away without touching anything else.
 */
const settingsSchema = z.object({
  /** https://<account>.blob.core.windows.net/<container> */
  containerUrl: z.string().url().max(500),
  prefix: z.string().max(200).optional(),
});

function target(ctx: ConnectorContext): { container: string; sas: string; prefix: string } {
  const parsed = settingsSchema.safeParse(ctx.connector.settings);
  if (!parsed.success) throw new ConnectorError('UNSUPPORTED', 'The container address is not valid');
  let url: URL;
  try {
    url = new URL(parsed.data.containerUrl);
  } catch {
    throw new ConnectorError('UNSUPPORTED', 'The container address is not valid');
  }
  // The signature is sent there, so it must be Azure's own storage address and a container in it.
  if (!ctx.allowPrivateNetwork && !/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(url.hostname.toLowerCase())) throw new ConnectorError('UNSUPPORTED', 'Use the container address, for example https://youraccount.blob.core.windows.net/responses');
  if (!/^\/[a-z0-9$][a-z0-9-]{1,62}\/?$/.test(url.pathname)) throw new ConnectorError('UNSUPPORTED', 'The address must end with the name of the container');
  const sas = (ctx.secrets.sasToken ?? '').trim().replace(/^\?/, '');
  if (!/^[A-Za-z0-9%&=._~:+/-]{20,2000}$/.test(sas) || !/(^|&)sig=/.test(sas)) throw new ConnectorError('UNSUPPORTED', 'Paste the shared access signature (SAS token) for the container');
  const prefix = (parsed.data.prefix ?? '').split('/').map((p) => p.replace(/[^A-Za-z0-9._-]/g, '_')).filter(Boolean).join('/');
  return { container: `${url.origin}${url.pathname.replace(/\/$/, '')}`, sas, prefix: prefix ? `${prefix}/` : '' };
}

const refused = (status: number) => (status === 403 || status === 401 ? new ConnectorError('FAILED', 'Azure refused the shared access signature: check that it has not run out and allows writing to this container') : new ConnectorError('FAILED', `Azure Blob Storage answered ${status}`));

export const azureBlobPlugin: ConnectorPlugin = {
  type: 'azure-blob',
  label: 'Azure Blob Storage',
  settingsSchema,
  secretsSchema: z.object({ sasToken: z.string().min(20).max(2000) }),
  operations: ['upload'],

  async test(ctx) {
    const start = now();
    const t = target(ctx);
    const r = await safeFetch(ctx, `${t.container}?restype=container&comp=list&maxresults=1&${t.sas}`, { headers: { 'x-ms-version': '2021-08-06' } });
    if (r.status >= 400) return { ok: false, message: refused(r.status).message };
    return { ok: true, message: 'Reached the container', latencyMs: elapsed(start) };
  },

  async discover(ctx): Promise<Entity[]> {
    target(ctx);
    return [{ key: 'files', label: 'Files in the container', fields: [{ name: 'name', type: 'string' }] }];
  },

  async run(ctx, req) {
    const start = now();
    if (req.kind !== 'upload') throw new ConnectorError('UNSUPPORTED', `A container can't ${req.kind}`);
    const t = target(ctx);
    const saved: string[] = [];
    for (const f of filesFor(req.params)) {
      const name = `${t.prefix}${f.name}`;
      const r = await safeFetch(ctx, `${t.container}/${name.split('/').map(encodeURIComponent).join('/')}?${t.sas}`, {
        method: 'PUT',
        // If-None-Match: a second response with the same name is refused rather than written over the first.
        headers: { 'x-ms-blob-type': 'BlockBlob', 'x-ms-version': '2021-08-06', 'Content-Type': f.type, 'If-None-Match': '*' },
        body: new Uint8Array(f.body),
      });
      if (r.status === 409 || r.status === 412) throw new ConnectorError('FAILED', `A file called ${f.name} is already in the container`);
      if (r.status >= 400) throw refused(r.status);
      saved.push(name);
    }
    return { rows: [{ id: saved[0], files: saved.join(', ') }], affected: saved.length, durationMs: elapsed(start) };
  },
};
