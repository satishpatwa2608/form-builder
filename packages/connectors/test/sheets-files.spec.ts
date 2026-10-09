import { createVerify, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { columnNames, defaultRegistry, filesFor, rowFor, rowsFrom, safeCell, safeFileName, setGoogleEndpoints, setMicrosoftEndpoints, shareToken, spreadsheetId, type ConnectorRecord } from '../src';

const limits = { timeoutMs: 5000, maxRows: 100 };
const reg = defaultRegistry();
const signal = () => new AbortController().signal;
const record = (type: ConnectorRecord['type'], settings: ConnectorRecord['settings'], over: Partial<ConnectorRecord> = {}): ConnectorRecord => ({ id: `c-${type}`, orgId: 'o1', type, name: type, settings, secretRef: 'x', writable: true, ...over });

interface Seen {
  method: string;
  url: string;
  auth?: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}
/** One stand-in server for Google, Microsoft and Azure, told apart by path. */
function standIn(handle: (req: Seen, json: (status: number, data?: unknown) => void) => void) {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const entry = { method: req.method!, url: decodeURIComponent(req.url!.replace(/\+/g, ' ')), auth: req.headers.authorization, headers: req.headers, body: Buffer.concat(chunks) };
      seen.push(entry);
      handle(entry, (status, data) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(data === undefined ? '' : JSON.stringify(data)));
    });
  });
  return { server, seen, url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('spreadsheet rows', () => {
  it('headings become plain field names; blank and repeated ones are never written to', () => {
    expect(columnNames(['First name', 'E-mail', '', 'E mail', '2nd phone', '  Notes  ', 'नाम'])).toEqual(['First_name', 'E_mail', '', '', 'c_2nd_phone', 'Notes', '']);
  });

  it('a value that a spreadsheet would run as a formula is kept as text', () => {
    for (const bad of ['=HYPERLINK("http://evil","x")', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1']) expect(safeCell(bad)).toBe(`'${bad}`);
    expect(safeCell('Asha = Rao')).toBe('Asha = Rao');
    expect(safeCell(-5)).toBe(-5);
    expect(safeCell(true)).toBe(true);
    expect(safeCell(['a', 'b'])).toBe('a, b');
    expect(safeCell(null)).toBe('');
  });

  it('a row keeps the sheet\'s column order and fills only exposed columns', () => {
    const entity = { key: 't', fields: ['Email', 'Name'] };
    expect(rowFor(['Name', 'Internal', 'Email', ''], entity, { Email: 'a@b.test', Name: '=cmd', Internal: 'x' })).toEqual(["'=cmd", '', 'a@b.test', '']);
    expect(() => rowFor(['Name', 'Email'], entity, { Other: 1 })).toThrow('Nothing to write');
  });

  it('rows are read by column name and filtered by exact match', () => {
    const rows = rowsFrom(['Code', 'Name', ''], [['P1', 'Pune', 'x'], ['P2', 'Goa'], ['P1', 'Pune 2']], [['Code', 'P1']], 10);
    expect(rows).toEqual([{ Code: 'P1', Name: 'Pune' }, { Code: 'P1', Name: 'Pune 2' }]);
    expect(rowsFrom(['Code'], [['1'], ['1'], ['1']], [], 2)).toHaveLength(2);
  });
});

describe('Google Sheets connector (against a stand-in)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd';
  const state = { tokens: 0, shared: true, appended: [] as unknown[][] };
  const google = standIn((req, json) => {
    if (req.url === '/token') {
      state.tokens++;
      const assertion = new URLSearchParams(req.body.toString()).get('assertion') ?? '';
      const [h, c, sig] = assertion.split('.');
      const claims = JSON.parse(Buffer.from(c ?? '', 'base64url').toString() || '{}');
      const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig ?? '', 'base64url')) && claims.iss === 'robot@proj.iam.gserviceaccount.com' && claims.scope.includes('spreadsheets') && claims.exp > Date.now() / 1000;
      return ok ? json(200, { access_token: 'g-token', expires_in: 3600 }) : json(400, { error: 'invalid_grant' });
    }
    if (req.auth !== 'Bearer g-token') return json(401, {});
    if (!state.shared) return json(403, { error: { message: 'The caller does not have permission' } });
    const sheet = `/v4/spreadsheets/${ID}`;
    if (req.url.startsWith(`${sheet}?fields=`)) return json(200, { sheets: [{ properties: { sheetId: 0, title: 'Leads' } }, { properties: { sheetId: 77, title: "Q3 'plan'" } }] });
    if (req.url.startsWith(`${sheet}/values:batchGet`)) return json(200, { valueRanges: [{ values: [['Name', 'E-mail', 'Internal note']] }, {}] });
    if (req.method === 'GET' && req.url === `${sheet}/values/'Leads'!1:1`) return json(200, { values: [['Name', 'E-mail', 'Internal note']] });
    if (req.method === 'POST' && req.url.startsWith(`${sheet}/values/'Leads'!A1:append`)) {
      state.appended.push(JSON.parse(req.body.toString()).values[0]);
      return json(200, { updates: { updatedRows: 1 } });
    }
    if (req.method === 'GET' && req.url === `${sheet}/values/'Leads'!A1:ZZ5001`) return json(200, { values: [['Name', 'E-mail', 'Internal note'], ['Asha', 'asha@x.test', 'vip'], ['Ravi', 'ravi@x.test']] });
    json(404, { error: { message: 'not found' } });
  });
  beforeAll(async () => {
    await new Promise<void>((r) => google.server.listen(0, '127.0.0.1', r));
    setGoogleEndpoints({ token: `${google.url()}/token`, sheets: google.url() });
  });
  afterAll(() => {
    setGoogleEndpoints({ token: 'https://oauth2.googleapis.com/token', sheets: 'https://sheets.googleapis.com' });
    return new Promise((r) => google.server.close(r));
  });

  const ctx = (over: Partial<ConnectorRecord> = {}) => ({
    connector: record('google-sheets', { spreadsheet: `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0` }, over),
    secrets: { serviceAccount: JSON.stringify({ type: 'service_account', client_email: 'robot@proj.iam.gserviceaccount.com', private_key: privateKey }) },
    allowPrivateNetwork: true,
  });
  const entity = { key: 'tab_0', fields: ['Name', 'E_mail'], keyField: 'E_mail' };

  it('takes the sheet\'s address as copied, or its ID, and nothing else', () => {
    expect(spreadsheetId(`https://docs.google.com/spreadsheets/d/${ID}/edit?usp=sharing`)).toBe(ID);
    expect(spreadsheetId(ID)).toBe(ID);
    expect(() => spreadsheetId('https://example.com/something')).toThrow("not a Google Sheet's address");
  });

  it('signs in with the service account\'s key, opens the sheet, and offers each tab with its columns', async () => {
    expect(await reg.get('google-sheets').test({ ...ctx(), signal: signal() })).toMatchObject({ ok: true, message: 'Opened the sheet: 2 tabs' });
    const found = await reg.get('google-sheets').discover({ ...ctx(), signal: signal() });
    expect(found).toEqual([
      { key: 'tab_0', label: 'Leads', fields: [{ name: 'Name', type: 'string' }, { name: 'E_mail', type: 'string' }, { name: 'Internal_note', type: 'string' }] },
      { key: 'tab_77', label: "Q3 'plan'", fields: [] },
    ]);
    expect(state.tokens).toBe(1);
  });

  it('a response becomes a row in the sheet\'s own column order, stored as plain values', async () => {
    const res = await reg.run(ctx(), { entity, kind: 'insert', params: { E_mail: 'meera@x.test', Name: '=IMPORTXML("http://evil","//a")', Internal_note: 'not exposed' }, limits });
    expect(res.affected).toBe(1);
    expect(state.appended).toEqual([["'=IMPORTXML(\"http://evil\",\"//a\")", 'meera@x.test', '']]);
    expect(google.seen.at(-1)!.url).toContain('valueInputOption=RAW');
    await expect(reg.run(ctx({ writable: false }), { entity, kind: 'insert', params: { Name: 'x' }, limits })).rejects.toThrow();
  });

  it('reads rows for a dropdown or a look-up, passing on only exposed columns', async () => {
    expect((await reg.run(ctx(), { entity, kind: 'list', params: {}, limits })).rows).toEqual([{ Name: 'Asha', E_mail: 'asha@x.test' }, { Name: 'Ravi', E_mail: 'ravi@x.test' }]);
    expect((await reg.run(ctx(), { entity, kind: 'get', params: { E_mail: 'ravi@x.test' }, limits })).rows).toEqual([{ Name: 'Ravi', E_mail: 'ravi@x.test' }]);
    expect((await reg.run(ctx(), { entity, kind: 'lookup', params: { E_mail: 'nobody@x.test' }, limits })).rows).toEqual([]);
    await expect(reg.run(ctx(), { entity, kind: 'list', params: { Internal_note: 'vip' }, limits })).rejects.toThrow('not exposed');
  });

  it('a sheet that is not shared with the robot says whom to share it with; a bad key file is said plainly', async () => {
    state.shared = false;
    const err = await reg.run(ctx(), { entity, kind: 'list', params: {}, limits }).catch((e: Error) => e);
    expect((err as Error).message).toBe('Google would not open the sheet: share it with robot@proj.iam.gserviceaccount.com as an editor');
    state.shared = true;
    const bad = await reg.run({ ...ctx(), secrets: { serviceAccount: '{"nope":true}' } }, { entity, kind: 'list', params: {}, limits }).catch((e: Error) => e);
    expect((bad as Error).message).toContain('Paste the whole key file');
    expect((bad as Error).message).not.toContain('nope');
  });
});

describe('Microsoft 365 and Azure (against a stand-in)', () => {
  const LINK = 'https://contoso.sharepoint.com/:x:/s/sales/EabcDEF123?e=xyz';
  const FOLDER = 'https://contoso.sharepoint.com/:f:/s/sales/Efolder456?e=abc';
  const state = { tokens: 0, rows: [] as unknown[][], files: [] as { path: string; type: string; body: Buffer }[], blobs: [] as { path: string; body: Buffer }[] };
  const ms = standIn((req, json) => {
    if (req.url === '/contoso.onmicrosoft.com/oauth2/v2.0/token') {
      state.tokens++;
      const p = new URLSearchParams(req.body.toString());
      return p.get('client_secret') === 'ms-secret' && p.get('scope') === 'https://graph.microsoft.com/.default' ? json(200, { access_token: 'ms-token', expires_in: 3600 }) : json(401, { error: 'invalid_client' });
    }
    // Azure Blob: the signature is in the address, not a header.
    if (req.url.startsWith('/responses')) {
      if (!req.url.includes('sig=goodsig')) return json(403, { Error: 'AuthenticationFailed: internal detail' });
      if (req.method === 'GET') return json(200, {});
      const path = req.url.slice(0, req.url.indexOf('?'));
      if (state.blobs.some((b) => b.path === path)) return json(409, {});
      state.blobs.push({ path, body: req.body });
      return json(201);
    }
    if (req.auth !== 'Bearer ms-token') return json(401, {});
    const v1 = '/v1.0';
    if (req.url.startsWith(`${v1}/shares/${shareToken(LINK)}/driveItem`)) return json(200, { id: 'ITEM1', name: 'Leads.xlsx', file: {}, parentReference: { driveId: 'DRIVE1' } });
    if (req.url.startsWith(`${v1}/shares/${shareToken(FOLDER)}/driveItem`)) return json(200, { id: 'FOLDER1', name: 'Responses', folder: { childCount: 2 }, parentReference: { driveId: 'DRIVE1' } });
    const book = `${v1}/drives/DRIVE1/items/ITEM1/workbook`;
    if (req.url.startsWith(`${book}/tables?`)) return json(200, { value: [{ name: 'Leads' }, { name: 'Old.Table' }] });
    if (req.url.startsWith(`${book}/tables/Leads/columns`)) return json(200, { value: [{ name: 'Name' }, { name: 'E-mail' }, { name: 'Internal note' }] });
    if (req.url.startsWith(`${book}/tables/Old.Table/columns`)) return json(200, { value: [{ name: 'A' }] });
    if (req.method === 'POST' && req.url === `${book}/tables/Leads/rows`) {
      state.rows.push(JSON.parse(req.body.toString()).values[0]);
      return json(201, { index: 5 });
    }
    if (req.method === 'GET' && req.url.startsWith(`${book}/tables/Leads/rows`)) return json(200, { value: [{ values: [['Asha', 'asha@x.test', 'vip']] }, { values: [['Ravi', 'ravi@x.test', '']] }] });
    const put = /^\/v1\.0\/drives\/DRIVE1\/items\/FOLDER1:\/(.+):\/content\?/.exec(req.url);
    if (req.method === 'PUT' && put) {
      state.files.push({ path: put[1]!, type: String(req.headers['content-type']), body: req.body });
      return json(201, { id: 'NEW', name: put[1] });
    }
    json(404, { error: { message: 'internal detail' } });
  });
  beforeAll(async () => {
    await new Promise<void>((r) => ms.server.listen(0, '127.0.0.1', r));
    setMicrosoftEndpoints({ login: ms.url(), graph: ms.url() });
  });
  afterAll(() => {
    setMicrosoftEndpoints({ login: 'https://login.microsoftonline.com', graph: 'https://graph.microsoft.com' });
    return new Promise((r) => ms.server.close(r));
  });

  const m365 = (type: 'excel' | 'microsoft-files', link: string, secret = 'ms-secret', over: Partial<ConnectorRecord> = {}) => ({
    connector: record(type, { tenantId: 'contoso.onmicrosoft.com', clientId: 'app-1', link }, over),
    secrets: { clientSecret: secret },
    allowPrivateNetwork: true,
  });
  const PDF = Buffer.from('%PDF-1.7 the document of record');

  it('Excel: the workbook is named by its sharing link; its tables and their columns are found', async () => {
    expect(await reg.get('excel').test({ ...m365('excel', LINK), signal: signal() })).toMatchObject({ ok: true, message: 'Opened Leads.xlsx: 2 tables' });
    expect(await reg.get('excel').discover({ ...m365('excel', LINK), signal: signal() })).toEqual([
      { key: 'Leads', label: 'Leads', fields: [{ name: 'Name', type: 'string' }, { name: 'E_mail', type: 'string' }, { name: 'Internal_note', type: 'string' }] },
      { key: 'Old_Table', label: 'Old.Table', fields: [{ name: 'A', type: 'string' }] },
    ]);
    // A link to a folder is not a workbook, and says so.
    expect(await reg.get('excel').test({ ...m365('excel', FOLDER, 'ms-secret', { id: 'c-wrong' }), signal: signal() })).toMatchObject({ ok: false, message: expect.stringContaining('That link is to a folder') });
  });

  it('Excel: a response is added as a row of the table, formulas kept as text; rows can be read back', async () => {
    const entity = { key: 'Leads', fields: ['Name', 'E_mail'], keyField: 'E_mail' };
    await reg.run(m365('excel', LINK), { entity, kind: 'insert', params: { Name: '=1+1', E_mail: 'meera@x.test', Internal_note: 'no' }, limits });
    expect(state.rows).toEqual([["'=1+1", 'meera@x.test', '']]);
    expect((await reg.run(m365('excel', LINK), { entity, kind: 'list', params: { Name: 'Ravi' }, limits })).rows).toEqual([{ Name: 'Ravi', E_mail: 'ravi@x.test' }]);
    expect((await reg.run(m365('excel', LINK), { entity, kind: 'lookup', params: { E_mail: 'asha@x.test' }, limits })).rows).toEqual([{ exists: true }]);
  });

  it('a wrong secret is said plainly, with none of Microsoft\'s own text or the secret', async () => {
    const err = await reg.run(m365('excel', LINK, 'wrong', { id: 'c-bad' }), { entity: { key: 'Leads', fields: ['Name'] }, kind: 'list', params: {}, limits }).catch((e: Error) => e);
    expect((err as Error).message).toBe('Microsoft 365 refused the directory (tenant) ID, application ID or secret');
  });

  it('a file name can never leave the chosen folder', () => {
    expect(safeFileName('LOAN/LN-000001', 'x')).toBe('LOAN/LN-000001');
    expect(safeFileName('../../etc/passwd', 'x')).toBe('etc/passwd');
    expect(safeFileName('a/..//b/.hidden/c\\d', 'x')).toBe('a/b/hidden/c_d');
    expect(safeFileName('', 'fallback')).toBe('fallback');
    expect(filesFor({ name: 'A/B', data: { q: 1 }, pdf: PDF.toString('base64') }).map((f) => [f.name, f.type])).toEqual([['A/B.json', 'application/json'], ['A/B.pdf', 'application/pdf']]);
    // Something that is not a PDF is not saved as one.
    expect(filesFor({ name: 'A', data: {}, pdf: Buffer.from('<html>').toString('base64') })).toHaveLength(1);
  });

  it('SharePoint / OneDrive: a response is saved in the folder as JSON and, when there is one, its PDF', async () => {
    expect(await reg.get('microsoft-files').test({ ...m365('microsoft-files', FOLDER), signal: signal() })).toMatchObject({ ok: true, message: 'Opened the folder Responses' });
    const res = await reg.run(m365('microsoft-files', FOLDER), { entity: { key: 'files', fields: ['name'] }, kind: 'upload', params: { name: 'LOAN/LN-000001', data: { name: 'Ravi' }, pdf: PDF.toString('base64') }, limits });
    expect(res).toMatchObject({ affected: 2, rows: [{ id: 'LOAN/LN-000001.json', files: 'LOAN/LN-000001.json, LOAN/LN-000001.pdf' }] });
    expect(state.files.map((f) => [f.path, f.type])).toEqual([['LOAN/LN-000001.json', 'application/json'], ['LOAN/LN-000001.pdf', 'application/pdf']]);
    expect(JSON.parse(state.files[0]!.body.toString())).toEqual({ name: 'Ravi' });
    expect(Buffer.compare(state.files[1]!.body, PDF)).toBe(0);
    // A second response with the same name is kept beside the first.
    expect(ms.seen.at(-1)!.url).toContain('conflictBehavior=rename');
    await expect(reg.run(m365('microsoft-files', FOLDER, 'ms-secret', { writable: false }), { entity: { key: 'files', fields: ['name'] }, kind: 'upload', params: { data: {} }, limits })).rejects.toThrow();
  });

  const blob = (sas = 'sv=2022-11-02&sp=cwl&sig=goodsig%3D', settings: Record<string, string> = {}) => ({ connector: record('azure-blob', { containerUrl: `${ms.url()}/responses`, prefix: 'forms', ...settings }), secrets: { sasToken: sas }, allowPrivateNetwork: true });

  it('Azure Blob: a response is saved in the container, under the prefix, and never over an earlier one', async () => {
    expect(await reg.get('azure-blob').test({ ...blob(), signal: signal() })).toMatchObject({ ok: true });
    const params = { name: 'LOAN/LN-000002', data: { name: 'Meera' }, pdf: PDF.toString('base64') };
    const res = await reg.run(blob('?sv=2022-11-02&sp=cwl&sig=goodsig%3D'), { entity: { key: 'files', fields: ['name'] }, kind: 'upload', params, limits });
    expect(res.rows[0]).toMatchObject({ id: 'forms/LOAN/LN-000002.json' });
    expect(state.blobs.map((b) => b.path)).toEqual(['/responses/forms/LOAN/LN-000002.json', '/responses/forms/LOAN/LN-000002.pdf']);
    expect(ms.seen.at(-1)!.headers).toMatchObject({ 'x-ms-blob-type': 'BlockBlob', 'if-none-match': '*' });
    await expect(reg.run(blob(), { entity: { key: 'files', fields: ['name'] }, kind: 'upload', params, limits })).rejects.toThrow('already in the container');
  });

  it('Azure Blob: a refused signature is said plainly; only Azure\'s own storage addresses are accepted outside development', async () => {
    const bad = await reg.get('azure-blob').test({ ...blob('sv=2022-11-02&sp=cwl&sig=expired%3D%3D'), signal: signal() });
    expect(bad).toMatchObject({ ok: false, message: expect.stringContaining('Azure refused the shared access signature') });
    expect(JSON.stringify(bad)).not.toMatch(/internal detail|expired/);
    const strict = (containerUrl: string) => reg.run({ connector: record('azure-blob', { containerUrl }), secrets: { sasToken: 'sv=2022-11-02&sp=cwl&sig=goodsig%3D' } }, { entity: { key: 'files', fields: ['name'] }, kind: 'upload', params: { data: {} }, limits });
    for (const url of ['https://evil.example/responses', 'https://acct.blob.core.windows.net.evil.example/responses', `${ms.url()}/responses`]) await expect(strict(url)).rejects.toThrow('Use the container address');
    await expect(strict('https://acct.blob.core.windows.net/')).rejects.toThrow('must end with the name of the container');
    await expect(reg.run(blob('not a signature'), { entity: { key: 'files', fields: ['name'] }, kind: 'upload', params: { data: {} }, limits })).rejects.toThrow('Paste the shared access signature');
  });
});
