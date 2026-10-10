import { afterAll, describe, expect, it } from 'vitest';
import { closeSqlConnections, defaultRegistry, type ConnectorRecord } from '../src';

/**
 * A table's own rules, read from real databases, when they are to hand:
 * PG_TEST, MYSQL_TEST and MSSQL_TEST, each host:port:password (users postgres, root and sa). Skipped otherwise.
 * Each database writes a rule back in its own words, so only the real thing shows that they are understood.
 */
const reg = defaultRegistry();
const at = (name: string) => /^([^:]+):(\d+):(.+)$/.exec(process.env[name] ?? '');
const record = (type: ConnectorRecord['type'], settings: ConnectorRecord['settings']): ConnectorRecord => ({ id: `c-${type}`, orgId: 'o1', type, name: type, settings, secretRef: 'x', writable: false });
const discover = (connector: ConnectorRecord, secrets: Record<string, string>) => reg.get(connector.type).discover({ connector, secrets, allowPrivateNetwork: true, signal: new AbortController().signal });

const COLUMNS = (pattern: string, length: string, text: string) =>
  `id INT PRIMARY KEY, qty SMALLINT NOT NULL CHECK (qty BETWEEN 1 AND 100), price DECIMAL(7,2) CHECK (price > 0), code ${text}(10) CHECK (${pattern}), name ${text}(40) CHECK (${length}(name) >= 2), starts INT, ends INT, CHECK (ends > starts)`;

function expectRules(fields: { name: string }[], pattern: string) {
  const by = Object.fromEntries(fields.map((f) => [f.name, f]));
  expect(by.qty).toMatchObject({ type: 'number', nullable: false, min: 1, max: 100 });
  // "More than 0" on money: 0 is the nearest a form can say; the room comes from the column's type.
  expect(by.price).toMatchObject({ type: 'number', min: 0, max: 99999.99 });
  expect(by.code).toMatchObject({ type: 'string', maxLength: 10, pattern });
  expect(by.name).toMatchObject({ type: 'string', minLength: 2, maxLength: 40 });
  // A rule that compares two columns limits neither on its own.
  expect(by.starts).not.toHaveProperty('min');
  expect(by.ends).not.toHaveProperty('min');
  expect(by.id).not.toHaveProperty('max');
}

afterAll(() => closeSqlConnections());

const pgAt = at('PG_TEST');
describe.skipIf(!pgAt)('limits from a real PostgreSQL table', () => {
  it('reads ranges, lengths and a pattern from the table\'s rules', async () => {
    const pg = (await import('pg')).default;
    const client = new pg.Client({ host: pgAt![1], port: Number(pgAt![2]), user: 'postgres', password: pgAt![3], database: 'postgres' });
    await client.connect();
    await client.query(`DROP TABLE IF EXISTS fb_rules; CREATE TABLE fb_rules (${COLUMNS("code ~ '^[A-Z]{3}$'", 'char_length', 'VARCHAR')})`);
    await client.end();
    const found = (await discover(record('postgres', { host: pgAt![1]!, port: Number(pgAt![2]), database: 'postgres', ssl: false }), { user: 'postgres', password: pgAt![3]! })).find((e) => e.key === 'fb_rules')!;
    expectRules(found.fields, '^[A-Z]{3}$');
  });
});

const myAt = at('MYSQL_TEST');
describe.skipIf(!myAt)('limits from a real MySQL table', () => {
  it('reads ranges, lengths and a pattern from the table\'s rules', async () => {
    const mysql = (await import('mysql2/promise')).default;
    const conn = await mysql.createConnection({ host: myAt![1], port: Number(myAt![2]), user: 'root', password: myAt![3], database: 'fb' });
    await conn.query('DROP TABLE IF EXISTS fb_rules');
    await conn.query(`CREATE TABLE fb_rules (${COLUMNS("regexp_like(code, '^[A-Z]{3}$')", 'char_length', 'VARCHAR')})`);
    await conn.end();
    const found = (await discover(record('mysql', { host: myAt![1]!, port: Number(myAt![2]), database: 'fb', ssl: false }), { user: 'root', password: myAt![3]! })).find((e) => e.key === 'fb_rules')!;
    expectRules(found.fields, '^[A-Z]{3}$');
  });
});

const msAt = at('MSSQL_TEST');
describe.skipIf(!msAt)('limits from a real SQL Server table', () => {
  it('reads ranges, lengths and a pattern from the table\'s rules', async () => {
    const mssql = (await import('mssql')).default;
    const pool = await new mssql.ConnectionPool({ server: msAt![1]!, port: Number(msAt![2]), user: 'sa', password: msAt![3]!, database: 'master', options: { encrypt: true, trustServerCertificate: true } }).connect();
    await pool.request().query(`IF OBJECT_ID('dbo.fb_rules') IS NOT NULL DROP TABLE dbo.fb_rules; CREATE TABLE dbo.fb_rules (${COLUMNS("code LIKE '[A-Z][A-Z][A-Z]'", 'len', 'NVARCHAR')})`);
    await pool.close();
    const found = (await discover(record('mssql', { host: msAt![1]!, port: Number(msAt![2]), database: 'master', schema: 'dbo', ssl: true, verifyCertificate: false }), { user: 'sa', password: msAt![3]! })).find((e) => e.key === 'fb_rules')!;
    expectRules(found.fields, '^[A-Z][A-Z][A-Z]$');
  });
});
