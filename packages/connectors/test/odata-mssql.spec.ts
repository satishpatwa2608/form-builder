import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSql, closeSqlConnections, defaultRegistry, odataLiteral, parseMetadata, type ConnectorRecord, type OperationRequest } from '../src';

const limits = { timeoutMs: 5000, maxRows: 100 };
const record = (type: ConnectorRecord['type'], settings: ConnectorRecord['settings'], writable = true): ConnectorRecord => ({ id: `c-${type}`, orgId: 'o1', type, name: type, settings, secretRef: 'x', writable });
const reg = defaultRegistry();
/** Testing and discovering are the plugin's own; the registry only runs operations. */
const signal = () => new AbortController().signal;
const testOf = (ctx: { connector: ConnectorRecord; secrets: Record<string, string>; allowPrivateNetwork?: boolean }) => reg.get(ctx.connector.type).test({ ...ctx, signal: signal() });
const discoverOf = (ctx: { connector: ConnectorRecord; secrets: Record<string, string>; allowPrivateNetwork?: boolean }) => reg.get(ctx.connector.type).discover({ ...ctx, signal: signal() });

describe('SQL statements (SQL Server)', () => {
  const entity = { key: 'orders', fields: ['id', 'status', 'total'], keyField: 'id' };
  const req = (kind: OperationRequest['kind'], params: Record<string, unknown>): OperationRequest => ({ entity, kind, params, limits });

  it('uses its own quoting, named parameters and TOP, and still binds every value', () => {
    expect(buildSql('mssql', 'sales', req('list', { status: "open' OR 1=1 --" }))).toEqual({
      text: 'SELECT TOP (100) [id], [status], [total] FROM [sales].[orders] WHERE [status] = @p1',
      values: ["open' OR 1=1 --"],
    });
    expect(buildSql('mssql', undefined, req('get', { id: 7 }))).toEqual({ text: 'SELECT TOP (1) [id], [status], [total] FROM [orders] WHERE [id] = @p1', values: [7] });
    expect(buildSql('mssql', undefined, req('lookup', { id: 7 })).text).toBe('SELECT TOP (1) 1 AS found FROM [orders] WHERE [id] = @p1');
    expect(buildSql('mssql', undefined, req('insert', { status: 'new', total: 10, hacked: 'x' }))).toEqual({ text: 'INSERT INTO [orders] ([status], [total]) VALUES (@p1, @p2)', values: ['new', 10] });
    expect(buildSql('mssql', undefined, req('update', { id: 7, status: 'paid' }))).toEqual({ text: 'UPDATE [orders] SET [status] = @p1 WHERE [id] = @p2', values: ['paid', 7] });
  });

  it('refuses names that are not exposed, or that could close the brackets', () => {
    expect(() => buildSql('mssql', undefined, req('list', { 'status]; DROP TABLE x; --': 1 }))).toThrow();
    expect(() => buildSql('mssql', 'dbo]', req('list', {}))).toThrow();
    expect(() => buildSql('mssql', undefined, { ...req('list', {}), entity: { ...entity, key: 'orders] --' } })).toThrow();
  });

  it('the other databases\' statements are as they were', () => {
    expect(buildSql('postgres', undefined, req('lookup', { id: 7 })).text).toBe('SELECT 1 FROM "orders" WHERE "id" = $1 LIMIT 1');
    expect(buildSql('mysql', undefined, req('list', {})).text).toBe('SELECT `id`, `status`, `total` FROM `orders` LIMIT 100');
  });
});

// A real SQL Server, when one is to hand: MSSQL_TEST=host:port:password (user sa). Skipped otherwise.
const live = /^([^:]+):(\d+):(.+)$/.exec(process.env.MSSQL_TEST ?? '');
describe.skipIf(!live)('SQL Server connector (real database)', () => {
  const ctx = () => ({ connector: record('mssql', { host: live![1]!, port: Number(live![2]), database: 'master', schema: 'dbo', ssl: true, verifyCertificate: false }), secrets: { user: 'sa', password: live![3]! }, allowPrivateNetwork: true });
  const entity = { key: 'fb_orders', fields: ['id', 'status', 'total'], keyField: 'id' };
  afterAll(() => closeSqlConnections());

  it('connects, discovers tables and columns, reads, writes and looks up', async () => {
    const mssql = (await import('mssql')).default;
    const pool = await new mssql.ConnectionPool({ server: live![1]!, port: Number(live![2]), user: 'sa', password: live![3]!, database: 'master', options: { encrypt: true, trustServerCertificate: true } }).connect();
    await pool.request().query("IF OBJECT_ID('dbo.fb_orders') IS NOT NULL DROP TABLE dbo.fb_orders; CREATE TABLE dbo.fb_orders (id INT PRIMARY KEY, status NVARCHAR(50), total DECIMAL(10,2), secret NVARCHAR(50)); INSERT INTO dbo.fb_orders VALUES (1, N'open', 10.5, N'hidden'), (2, N'paid', 20, N'hidden');");
    await pool.close();

    expect(await testOf(ctx())).toMatchObject({ ok: true });
    const found = (await discoverOf(ctx())).find((e) => e.key === 'fb_orders')!;
    // With each column: whether the table lets it be empty, and the longest text it takes.
    expect(found.fields).toEqual([
      { name: 'id', type: 'number', nullable: false },
      { name: 'status', type: 'string', nullable: true, maxLength: 50 },
      { name: 'total', type: 'number', nullable: true },
      expect.objectContaining({ name: 'secret', type: 'string', nullable: true }),
    ]);

    // Only what is exposed comes back; a value that looks like SQL is just a value.
    expect((await reg.run(ctx(), { entity, kind: 'list', params: { status: 'open' }, limits })).rows).toEqual([{ id: 1, status: 'open', total: 10.5 }]);
    expect((await reg.run(ctx(), { entity, kind: 'list', params: { status: "open' OR 1=1 --" }, limits })).rows).toEqual([]);
    expect((await reg.run(ctx(), { entity, kind: 'list', params: {}, limits: { ...limits, maxRows: 1 } })).rows).toHaveLength(1);
    expect((await reg.run(ctx(), { entity, kind: 'get', params: { id: 2 }, limits })).rows).toEqual([{ id: 2, status: 'paid', total: 20 }]);
    expect((await reg.run(ctx(), { entity, kind: 'lookup', params: { id: 2 }, limits })).rows).toEqual([{ exists: true }]);
    expect((await reg.run(ctx(), { entity, kind: 'lookup', params: { id: 99 }, limits })).rows).toEqual([]);

    expect((await reg.run(ctx(), { entity, kind: 'insert', params: { id: 3, status: 'new', total: 5, secret: 'x' }, limits })).affected).toBe(1);
    expect((await reg.run(ctx(), { entity, kind: 'update', params: { id: 3, status: 'sent' }, limits })).affected).toBe(1);
    expect((await reg.run(ctx(), { entity, kind: 'get', params: { id: 3 }, limits })).rows).toEqual([{ id: 3, status: 'sent', total: 5 }]);
    // Switched to read-only, the same write is refused before it reaches the database.
    await expect(reg.run({ ...ctx(), connector: { ...ctx().connector, writable: false } }, { entity, kind: 'insert', params: { id: 4, status: 'no' }, limits })).rejects.toThrow();
  }, 60_000);
});

const METADATA = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Shop.Model" Alias="mscrm" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="account">
        <Key><PropertyRef Name="accountid"/></Key>
        <Property Name="accountid" Type="Edm.Guid" Nullable="false"/>
        <Property Name="name" Type="Edm.String"/>
        <Property Name="revenue" Type="Edm.Decimal"/>
        <Property Name="active" Type="Edm.Boolean"/>
        <Property Name="createdon" Type="Edm.DateTimeOffset"/>
        <Property Name="odd name!" Type="Edm.String"/>
        <NavigationProperty Name="contacts" Type="Collection(Shop.Model.contact)"/>
      </EntityType>
      <EntityType Name="contact">
        <Key><PropertyRef Name="first"/><PropertyRef Name="last"/></Key>
        <Property Name="first" Type="Edm.String" Nullable="false"/>
        <Property Name="last" Type="Edm.String" Nullable="false"/>
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="accounts" EntityType="mscrm.account"/>
        <EntitySet Name="contacts" EntityType="Shop.Model.contact"/>
        <EntitySet Name="bad set" EntityType="Shop.Model.contact"/>
        <EntitySet Name="orphans" EntityType="Shop.Model.missing"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

describe('OData: what a service says about itself', () => {
  it('gives its entity sets, their fields with types, and the key when there is one', () => {
    const sets = parseMetadata(METADATA);
    expect(sets.map((s) => s.key)).toEqual(['accounts', 'contacts']);
    expect(sets[0]).toEqual({
      key: 'accounts',
      label: 'accounts',
      keyField: 'accountid',
      fields: [
        { name: 'accountid', type: 'string' },
        { name: 'name', type: 'string', nullable: true },
        { name: 'revenue', type: 'number', nullable: true },
        { name: 'active', type: 'boolean', nullable: true },
        { name: 'createdon', type: 'date', nullable: true },
      ],
    });
    // Two fields make the key: there is no single one to fetch a row by.
    expect(sets[1]).not.toHaveProperty('keyField');
  });

  it('reads nothing from something that is not such a document, and expands nothing', () => {
    expect(parseMetadata('<html><body>Sign in</body></html>')).toEqual([]);
    expect(parseMetadata('')).toEqual([]);
    const bomb = `<!DOCTYPE x [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]>${METADATA.replace('Name="name"', 'Name="&b;"')}`;
    expect(parseMetadata(bomb).flatMap((s) => s.fields.map((f) => f.name)).some((n) => n.includes('aaaa'))).toBe(false);
  });

  it('writes values so that nothing typed can end them', () => {
    expect(odataLiteral("O'Brien")).toBe("'O''Brien'");
    expect(odataLiteral("x' or 1 eq 1 or name eq '")).toBe("'x'' or 1 eq 1 or name eq '''");
    expect(odataLiteral(42)).toBe('42');
    expect(odataLiteral(true)).toBe('true');
    expect(odataLiteral(null)).toBe('null');
    expect(odataLiteral('7b0c1f8e-6f1b-4d0a-9a63-0f7f2f1f9c11')).toBe('7b0c1f8e-6f1b-4d0a-9a63-0f7f2f1f9c11');
    expect(() => odataLiteral(Infinity)).toThrow();
  });
});

describe('OData connector (against a stand-in service)', () => {
  let server: Server;
  let base: string;
  const seen: { method: string; url: string; auth?: string; prefer?: string; body?: string }[] = [];
  const state = { tokens: 0 };
  const ID = '7b0c1f8e-6f1b-4d0a-9a63-0f7f2f1f9c11';
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const url = decodeURIComponent(req.url!.replace(/\+/g, ' '));
        seen.push({ method: req.method!, url, auth: req.headers.authorization, prefer: req.headers.prefer as string | undefined, body });
        const json = (status: number, data: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
        if (url === '/token') {
          state.tokens++;
          const p = new URLSearchParams(body);
          return p.get('client_secret') === 's3cret' && p.get('scope') === 'https://org.crm/.default' ? json(200, { access_token: 'tok-1', expires_in: 3600 }) : json(401, { error: 'invalid_client' });
        }
        if (req.headers.authorization !== 'Bearer tok-1') return json(401, {});
        if (url === '/api/data/') return json(200, { value: [{ name: 'accounts', url: 'accounts' }] });
        if (url === '/api/data/$metadata') return res.writeHead(200, { 'Content-Type': 'application/xml' }).end(METADATA);
        if (req.method === 'GET' && url.startsWith('/api/data/accounts?')) return json(200, { '@odata.context': 'x', value: [{ '@odata.etag': 'W/"1"', accountid: ID, name: "O'Brien Ltd", secret: 'not asked for' }] });
        if (req.method === 'GET' && url.startsWith(`/api/data/accounts(${ID})`)) return json(200, { '@odata.etag': 'W/"1"', accountid: ID, name: "O'Brien Ltd" });
        if (req.method === 'GET' && url.startsWith('/api/data/accounts(')) return json(404, { error: { message: 'not found' } });
        if (req.method === 'POST' && url === '/api/data/accounts') return json(201, { '@odata.context': 'x', accountid: ID, ...JSON.parse(body) });
        if (req.method === 'PATCH' && url === `/api/data/accounts(${ID})`) return json(200, { accountid: ID, ...JSON.parse(body) });
        json(500, { error: { message: 'internal detail' } });
      });
    }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  const ctx = (secret = 's3cret', over: Partial<ConnectorRecord> = {}) => ({
    connector: { ...record('odata', { baseUrl: `${base}/api/data/`, auth: 'oauth', tokenUrl: `${base}/token`, clientId: 'app-1', scope: 'https://org.crm/.default' }), ...over },
    secrets: { clientSecret: secret },
    allowPrivateNetwork: true,
  });
  const entity = { key: 'accounts', fields: ['accountid', 'name', 'revenue'], keyField: 'accountid' };

  it('signs in as an application once, tests and discovers', async () => {
    expect(await testOf(ctx())).toMatchObject({ ok: true, message: 'Connected: 1 entity sets' });
    expect((await discoverOf(ctx())).map((e) => e.key)).toEqual(['accounts', 'contacts']);
    expect(state.tokens).toBe(1);
    // A wrong secret is said plainly and is never part of the message.
    const bad = await testOf(ctx('wrong', { id: 'c-other' })).catch((e: Error) => ({ ok: false, message: e.message }));
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain('wrong');
  });

  it('lists with only the exposed fields and exact-match filters, written so they cannot be broken out of', async () => {
    const res = await reg.run(ctx(), { entity, kind: 'list', params: { name: "O'Brien' or 1 eq 1 or name eq '" }, limits });
    // The service sent a field nobody asked for: it is not passed on.
    expect(res.rows).toEqual([{ accountid: ID, name: "O'Brien Ltd" }]);
    expect(seen.at(-1)).toMatchObject({ method: 'GET', url: "/api/data/accounts?$select=accountid,name,revenue&$top=100&$filter=name eq 'O''Brien'' or 1 eq 1 or name eq '''", auth: 'Bearer tok-1' });
    await expect(reg.run(ctx(), { entity, kind: 'list', params: { secret: 'x' }, limits })).rejects.toThrow('not exposed');
    await expect(reg.run(ctx(), { entity: { ...entity, key: 'accounts/$batch' }, kind: 'list', params: {}, limits })).rejects.toThrow();
  });

  it('fetches one row by its key, and says "not there" rather than failing', async () => {
    expect((await reg.run(ctx(), { entity, kind: 'get', params: { accountid: ID }, limits })).rows).toEqual([{ accountid: ID, name: "O'Brien Ltd" }]);
    expect(seen.at(-1)!.url).toBe(`/api/data/accounts(${ID})?$select=accountid,name,revenue`);
    expect((await reg.run(ctx(), { entity, kind: 'lookup', params: { accountid: ID }, limits })).rows).toEqual([{ exists: true }]);
    expect((await reg.run(ctx(), { entity, kind: 'get', params: { accountid: "x')/accounts('y" }, limits })).rows).toEqual([]);
    // The key that tried to add to the address went as one quoted value.
    expect(seen.at(-1)!.url).toContain("accounts('x'')/accounts(''y')");
  });

  it('writes only exposed fields, asks for the saved row back, and only when the connector allows writes', async () => {
    const made = await reg.run(ctx(), { entity: { ...entity, fields: ['name', 'revenue'] }, kind: 'insert', params: { name: 'New Co', revenue: 10, isAdmin: true }, limits });
    expect(JSON.parse(seen.at(-1)!.body!)).toEqual({ name: 'New Co', revenue: 10 });
    expect(seen.at(-1)).toMatchObject({ method: 'POST', url: '/api/data/accounts', prefer: 'return=representation' });
    expect(made.rows).toEqual([{ accountid: ID, name: 'New Co', revenue: 10 }]);
    await reg.run(ctx(), { entity, kind: 'update', params: { accountid: ID, name: 'Renamed' }, limits });
    expect(seen.at(-1)).toMatchObject({ method: 'PATCH', url: `/api/data/accounts(${ID})` });
    expect(JSON.parse(seen.at(-1)!.body!)).toEqual({ name: 'Renamed' });
    await expect(reg.run(ctx('s3cret', { writable: false }), { entity, kind: 'insert', params: { name: 'No' }, limits })).rejects.toThrow();
  });

  it('a failing service is reported by its status, never by what it said', async () => {
    const err = await reg.run(ctx(), { entity: { ...entity, key: 'contacts' }, kind: 'list', params: {}, limits }).catch((e: Error) => e);
    expect((err as Error).message).toContain('500');
    expect((err as Error).message).not.toContain('internal detail');
  });

  it('outside development the service and its sign-in address must be public and https', async () => {
    const strict = { ...ctx(), allowPrivateNetwork: false };
    await expect(reg.run(strict, { entity, kind: 'list', params: {}, limits })).rejects.toThrow(/https|private/);
  });
});
