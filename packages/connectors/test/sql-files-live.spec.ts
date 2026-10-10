import { afterAll, describe, expect, it } from 'vitest';
import { buildSql, closeSqlConnections, defaultRegistry, type ConnectorRecord, type OperationRequest } from '../src';

/**
 * A file written into a database column, against real databases when they are to hand (PG_TEST, MYSQL_TEST,
 * MSSQL_TEST: host:port:password). The file travels as base64 text and is stored as bytes.
 */
const reg = defaultRegistry();
const at = (name: string) => /^([^:]+):(\d+):(.+)$/.exec(process.env[name] ?? '');
const limits = { timeoutMs: 8000, maxRows: 10 };
const record = (type: ConnectorRecord['type'], settings: ConnectorRecord['settings']): ConnectorRecord => ({ id: `c-${type}`, orgId: 'o1', type, name: type, settings, secretRef: 'x', writable: true });
const entity = { key: 'fb_files', fields: ['id', 'name', 'body'], keyField: 'id' };
// Every byte value, so nothing that mangles text (an encoding, a trimmed zero) goes unnoticed.
const BYTES = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256));
const file = { $file: BYTES.toString('base64'), name: 'all-bytes.bin', type: 'application/octet-stream' };

afterAll(() => closeSqlConnections());

describe('a file in a SQL statement', () => {
  it('is bound as bytes, like any other value, never written into the statement', () => {
    const req: OperationRequest = { entity, kind: 'insert', params: { id: 1, name: 'a', body: file }, limits };
    const made = buildSql('postgres', 'public', req);
    expect(made.text).toBe('INSERT INTO "public"."fb_files" ("id", "name", "body") VALUES ($1, $2, $3)');
    expect(Buffer.isBuffer(made.values[2])).toBe(true);
    expect((made.values[2] as Buffer).equals(BYTES)).toBe(true);
    // Something that only looks like a file (no bytes) is not written at all.
    expect(buildSql('postgres', 'public', { ...req, params: { id: 1, body: { name: 'x' } } }).text).toBe('INSERT INTO "public"."fb_files" ("id") VALUES ($1)');
  });
});

const run = (connector: ConnectorRecord, secrets: Record<string, string>, req: Omit<OperationRequest, 'limits' | 'entity'>) => reg.run({ connector, secrets, allowPrivateNetwork: true }, { ...req, entity, limits });

const pgAt = at('PG_TEST');
describe.skipIf(!pgAt)('a file into a real PostgreSQL column', () => {
  it('is stored byte for byte, and read back as a note of its size', async () => {
    const pg = (await import('pg')).default;
    const client = new pg.Client({ host: pgAt![1], port: Number(pgAt![2]), user: 'postgres', password: pgAt![3], database: 'postgres' });
    await client.connect();
    await client.query('DROP TABLE IF EXISTS fb_files; CREATE TABLE fb_files (id INT PRIMARY KEY, name TEXT, body BYTEA)');
    const c = record('postgres', { host: pgAt![1]!, port: Number(pgAt![2]), database: 'postgres', ssl: false });
    const s = { user: 'postgres', password: pgAt![3]! };
    await run(c, s, { kind: 'insert', params: { id: 1, name: file.name, body: file } });
    expect(((await client.query('SELECT body FROM fb_files WHERE id = 1')).rows[0].body as Buffer).equals(BYTES)).toBe(true);
    expect((await run(c, s, { kind: 'list', params: { id: 1 } })).rows).toEqual([{ id: 1, name: 'all-bytes.bin', body: '(file, 512 bytes)' }]);
    await client.end();
  });
});

const myAt = at('MYSQL_TEST');
describe.skipIf(!myAt)('a file into a real MySQL column', () => {
  it('is stored byte for byte, and read back as a note of its size', async () => {
    const mysql = (await import('mysql2/promise')).default;
    const conn = await mysql.createConnection({ host: myAt![1], port: Number(myAt![2]), user: 'root', password: myAt![3], database: 'fb' });
    await conn.query('DROP TABLE IF EXISTS fb_files');
    await conn.query('CREATE TABLE fb_files (id INT PRIMARY KEY, name VARCHAR(100), body LONGBLOB)');
    const c = record('mysql', { host: myAt![1]!, port: Number(myAt![2]), database: 'fb', ssl: false });
    const s = { user: 'root', password: myAt![3]! };
    await run(c, s, { kind: 'insert', params: { id: 1, name: file.name, body: file } });
    const [rows] = await conn.query('SELECT body FROM fb_files WHERE id = 1');
    expect(((rows as { body: Buffer }[])[0]!.body).equals(BYTES)).toBe(true);
    expect((await run(c, s, { kind: 'list', params: { id: 1 } })).rows).toEqual([{ id: 1, name: 'all-bytes.bin', body: '(file, 512 bytes)' }]);
    await conn.end();
  });
});

const msAt = at('MSSQL_TEST');
describe.skipIf(!msAt)('a file into a real SQL Server column', () => {
  it('is stored byte for byte, and read back as a note of its size', async () => {
    const mssql = (await import('mssql')).default;
    const pool = await new mssql.ConnectionPool({ server: msAt![1]!, port: Number(msAt![2]), user: 'sa', password: msAt![3]!, database: 'master', options: { encrypt: true, trustServerCertificate: true } }).connect();
    await pool.request().query("IF OBJECT_ID('dbo.fb_files') IS NOT NULL DROP TABLE dbo.fb_files; CREATE TABLE dbo.fb_files (id INT PRIMARY KEY, name NVARCHAR(100), body VARBINARY(MAX))");
    const c = record('mssql', { host: msAt![1]!, port: Number(msAt![2]), database: 'master', schema: 'dbo', ssl: true, verifyCertificate: false });
    const s = { user: 'sa', password: msAt![3]! };
    await run(c, s, { kind: 'insert', params: { id: 1, name: file.name, body: file } });
    expect(((await pool.request().query('SELECT body FROM dbo.fb_files WHERE id = 1')).recordset[0].body as Buffer).equals(BYTES)).toBe(true);
    expect((await run(c, s, { kind: 'list', params: { id: 1 } })).rows).toEqual([{ id: 1, name: 'all-bytes.bin', body: '(file, 512 bytes)' }]);
    await pool.close();
  });
});
