import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSql, closeMongoConnections, defaultRegistry, isPrivateAddress, safeFetch, setAwsFactories, setStsFactory, type ConnectorRecord, type OperationRequest } from '../src';

const limits = { timeoutMs: 5000, maxRows: 100 };
const record = (type: ConnectorRecord['type'], settings: ConnectorRecord['settings'], writable = true): ConnectorRecord => ({ id: `c-${type}`, orgId: 'o1', type, name: type, settings, secretRef: 'x', writable });
const reg = defaultRegistry();

describe('MongoDB connector (real database)', () => {
  let mongo: MongoMemoryServer;
  let uri: string;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    uri = mongo.getUri();
    const c = await MongoClient.connect(uri);
    await c.db('shop').collection('customers').insertMany([
      { email: 'a@x.test', name: 'Asha', city: 'Pune', secretNote: 'vip' },
      { email: 'b@x.test', name: 'Bala', city: 'Delhi', secretNote: 'late payer' },
    ]);
    await c.close();
  });
  afterAll(async () => {
    await closeMongoConnections();
    await mongo.stop();
  });
  const ctx = (writable = true) => ({ connector: record('mongodb', { database: 'shop' }, writable), secrets: { uri }, allowPrivateNetwork: true });
  const entity = { key: 'customers', fields: ['email', 'name', 'city'], keyField: 'email' };

  it('refuses a private database host unless development allows it', async () => {
    await expect(reg.run({ connector: record('mongodb', { database: 'shop' }), secrets: { uri } }, { entity, kind: 'list', params: {}, limits })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('tests, discovers collections and fields', async () => {
    const plugin = reg.get('mongodb');
    expect((await plugin.test({ ...ctx(), signal: new AbortController().signal })).ok).toBe(true);
    const found = await plugin.discover({ ...ctx(), signal: new AbortController().signal });
    expect(found.find((e) => e.key === 'customers')!.fields.map((f) => f.name)).toEqual(expect.arrayContaining(['email', 'name', 'city', 'secretNote']));
  });

  it('reads only exposed fields, filters by exact match, refuses unexposed filters and operators', async () => {
    const list = await reg.run(ctx(), { entity, kind: 'list', params: { city: 'Pune' }, limits });
    expect(list.rows).toEqual([expect.objectContaining({ email: 'a@x.test', name: 'Asha' })]);
    expect(list.rows[0]).not.toHaveProperty('secretNote');
    expect(list.rows[0]).not.toHaveProperty('_id');
    await expect(reg.run(ctx(), { entity, kind: 'list', params: { secretNote: 'vip' }, limits })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(reg.run(ctx(), { entity, kind: 'list', params: { city: { $ne: 'x' } }, limits })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    const got = await reg.run(ctx(), { entity, kind: 'get', params: { email: 'b@x.test' }, limits });
    expect(got.rows[0]).toMatchObject({ name: 'Bala' });
  });

  it('writes only exposed fields, and only when the connector allows writes', async () => {
    await expect(reg.run(ctx(false), { entity, kind: 'insert', params: { email: 'c@x.test' }, limits })).rejects.toMatchObject({ code: 'READ_ONLY' });
    await reg.run(ctx(), { entity, kind: 'insert', params: { email: 'c@x.test', name: 'Chen', city: 'Goa', isAdmin: true }, limits });
    const c = await MongoClient.connect(uri);
    const doc = await c.db('shop').collection('customers').findOne({ email: 'c@x.test' });
    expect(doc).toMatchObject({ name: 'Chen', city: 'Goa' });
    expect(doc).not.toHaveProperty('isAdmin');
    await reg.run(ctx(), { entity, kind: 'update', params: { email: 'c@x.test', city: 'Mumbai' }, limits });
    expect((await c.db('shop').collection('customers').findOne({ email: 'c@x.test' }))!.city).toBe('Mumbai');
    await c.close();
  });
});

describe('SQL statements (Postgres / MySQL)', () => {
  const entity = { key: 'orders', fields: ['id', 'status', 'total'], keyField: 'id' };
  const req = (kind: OperationRequest['kind'], params: Record<string, unknown>): OperationRequest => ({ entity, kind, params, limits });

  it('quote whitelisted identifiers and bind every value as a parameter', () => {
    expect(buildSql('postgres', 'sales', req('list', { status: "open' OR 1=1 --" }))).toEqual({
      text: 'SELECT "id", "status", "total" FROM "sales"."orders" WHERE "status" = $1 LIMIT 100',
      values: ["open' OR 1=1 --"],
    });
    expect(buildSql('mysql', undefined, req('insert', { status: 'new', total: 10, hacked: 'x' }))).toEqual({
      text: 'INSERT INTO `orders` (`status`, `total`) VALUES (?, ?)',
      values: ['new', 10],
    });
    expect(buildSql('postgres', undefined, req('update', { id: 7, status: 'paid' }))).toEqual({ text: 'UPDATE "orders" SET "status" = $1 WHERE "id" = $2', values: ['paid', 7] });
  });

  it('refuse identifiers that are not exposed or not plain names', () => {
    expect(() => buildSql('postgres', undefined, req('list', { 'status"; DROP TABLE x; --': 1 }))).toThrow();
    expect(() => buildSql('postgres', undefined, { ...req('list', {}), entity: { ...entity, key: 'orders; DROP' } })).toThrow();
    expect(() => buildSql('postgres', 'public"', req('list', {}))).toThrow();
  });
});

describe('network safety (REST, Supabase, webhooks-style calls)', () => {
  let server: Server;
  let base: string;
  const seen: { method: string; url: string; auth?: string; body?: string }[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization ?? (req.headers.apikey as string | undefined), body });
        if (req.url === '/redirect') return res.writeHead(302, { Location: 'http://169.254.169.254/' }).end();
        if (req.url === '/big') return res.end('x'.repeat(3 * 1024 * 1024));
        if (req.url?.startsWith('/api/customers')) return res.setHeader('Content-Type', 'application/json').end(JSON.stringify({ data: [{ id: 1, name: 'Asha', hidden: 'no' }] }));
        if (req.url?.startsWith('/rest/v1/customers')) return res.setHeader('Content-Type', 'application/json').end(JSON.stringify([{ id: 1, name: 'Asha' }]));
        res.statusCode = 201;
        res.end('{}');
      });
    }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  it('private and metadata addresses are refused; so is plain http, unless development allows it', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) expect(isPrivateAddress(ip)).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    const ctx = { connector: record('rest', {}), secrets: {}, signal: new AbortController().signal };
    await expect(safeFetch(ctx, `${base}/x`)).rejects.toThrow('https');
    await expect(safeFetch(ctx, 'https://169.254.169.254/latest/meta-data')).rejects.toThrow('private');
    await expect(safeFetch(ctx, 'https://localhost/x')).rejects.toThrow('private');
    await expect(safeFetch({ ...ctx, connector: { ...ctx.connector, allowedHosts: ['api.example.com'] } }, 'https://evil.example.org/')).rejects.toThrow('allowed hosts');
    const dev = { ...ctx, allowPrivateNetwork: true };
    await expect(safeFetch(dev, `${base}/redirect`)).rejects.toThrow();
    await expect(safeFetch(dev, `${base}/big`)).rejects.toThrow('too large');
  });

  it('REST: exposed filters as query parameters, auth header, rows from dataPath, writes only exposed fields', async () => {
    const resources = JSON.stringify([{ key: 'customers', path: '/api/customers', fields: ['id', 'name'], dataPath: 'data' }]);
    const ctx = { connector: record('rest', { baseUrl: base, auth: 'bearer', resources }), secrets: { token: 't0k' }, allowPrivateNetwork: true };
    const entity = { key: 'customers', fields: ['id', 'name'] };
    const res = await reg.run(ctx, { entity, kind: 'list', params: { name: 'Asha' }, limits });
    expect(res.rows).toEqual([{ id: 1, name: 'Asha', hidden: 'no' }]);
    expect(seen.at(-1)).toMatchObject({ method: 'GET', url: '/api/customers?name=Asha', auth: 'Bearer t0k' });
    await reg.run(ctx, { entity, kind: 'insert', params: { name: 'Bala', role: 'admin' }, limits });
    expect(JSON.parse(seen.at(-1)!.body!)).toEqual({ name: 'Bala' });
  });

  it('Supabase: PostgREST exact-match filters with the key in apikey/Authorization', async () => {
    const ctx = { connector: record('supabase', { url: base }), secrets: { apiKey: 'k'.repeat(30) }, allowPrivateNetwork: true };
    const res = await reg.run(ctx, { entity: { key: 'customers', fields: ['id', 'name'] }, kind: 'list', params: { name: 'Asha&x=1' }, limits });
    expect(res.rows).toEqual([{ id: 1, name: 'Asha' }]);
    expect(seen.at(-1)!.url).toBe('/rest/v1/customers?select=id%2Cname&name=eq.Asha%26x%3D1&limit=100');
    expect(seen.at(-1)!.auth).toBe(`Bearer ${'k'.repeat(30)}`);
  });
});

describe('AWS connectors (assumed role, no keys)', () => {
  it('S3 upload and CloudWatch log go through the customer role with its external ID', async () => {
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    const fake = (name: string) => ({ send: async (cmd: { input: Record<string, unknown>; constructor: { name: string } }) => (calls.push({ name: `${name}:${cmd.constructor.name}`, input: cmd.input }), cmd.constructor.name === 'AssumeRoleCommand' ? { Credentials: { AccessKeyId: 'A', SecretAccessKey: 'S', SessionToken: 'T' } } : {}) });
    setStsFactory(() => fake('sts') as never);
    setAwsFactories({ s3: () => fake('s3') as never, logs: () => fake('logs') as never });
    const role = { region: 'ap-south-1', roleArn: 'arn:aws:iam::123456789012:role/form-builder', externalId: 'ext-12345678' };
    await reg.run({ connector: record('aws-s3', { ...role, bucket: 'acme-archive', prefix: 'forms/' }), secrets: {} }, { entity: { key: 'objects', fields: [] }, kind: 'upload', params: { name: '../../etc/passwd', data: { a: 1 } }, limits });
    await reg.run({ connector: record('aws-cloudwatch', { ...role, logGroup: '/acme/forms' }), secrets: {} }, { entity: { key: 'events', fields: [] }, kind: 'log', params: { event: 'submitted' }, limits });
    const assume = calls.filter((c) => c.name === 'sts:AssumeRoleCommand');
    expect(assume).toHaveLength(2);
    expect(assume[0]!.input).toMatchObject({ RoleArn: role.roleArn, ExternalId: role.externalId });
    const put = calls.find((c) => c.name === 's3:PutObjectCommand')!.input;
    expect(put).toMatchObject({ Bucket: 'acme-archive', ServerSideEncryption: 'AES256' });
    expect(put.Key).toBe('forms/etc/passwd'); // no path climbing
    expect(calls.some((c) => c.name === 'logs:PutLogEventsCommand')).toBe(true);
  });
});
