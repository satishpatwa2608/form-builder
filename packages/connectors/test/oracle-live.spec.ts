import { afterAll, describe, expect, it } from 'vitest';
import { buildSql, closeSqlConnections, defaultRegistry, type ConnectorRecord, type OperationRequest } from '../src';

/**
 * The Oracle connector against a real Oracle database, when one is to hand: ORACLE_TEST=host:port:password
 * (user "fb" in the pluggable database FREEPDB1, as the gvenzl/oracle-free image sets up). Skipped otherwise.
 */
const reg = defaultRegistry();
const limits = { timeoutMs: 10_000, maxRows: 50 };
const at = /^([^:]+):(\d+):(.+)$/.exec(process.env.ORACLE_TEST ?? '');
const connector: ConnectorRecord = { id: 'c-oracle', orgId: 'o1', type: 'oracle', name: 'Oracle', settings: { host: at?.[1] ?? '', port: Number(at?.[2] ?? 1521), database: 'FREEPDB1' }, secretRef: 'x', writable: true };
const secrets = { user: 'fb', password: at?.[3] ?? '' };
const ctx = { connector, secrets, allowPrivateNetwork: true };
const signal = () => new AbortController().signal;
const BYTES = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256));

describe('Oracle statements', () => {
  it('quote names, number the parameters, and limit rows in the standard words', () => {
    const entity = { key: 'ORDERS', fields: ['ID', 'STATUS'], keyField: 'ID' };
    expect(buildSql('oracle', 'FB', { entity, kind: 'list', params: { STATUS: 'open' }, limits })).toEqual({ text: 'SELECT "ID", "STATUS" FROM "FB"."ORDERS" WHERE "STATUS" = :1 FETCH FIRST 50 ROWS ONLY', values: ['open'] });
    expect(buildSql('oracle', undefined, { entity, kind: 'insert', params: { ID: 7, STATUS: "x'); DROP TABLE ORDERS; --" }, limits }).text).toBe('INSERT INTO "ORDERS" ("ID", "STATUS") VALUES (:1, :2)');
    expect(buildSql('oracle', undefined, { entity, kind: 'update', params: { ID: 7, STATUS: 'paid' }, limits })).toEqual({ text: 'UPDATE "ORDERS" SET "STATUS" = :1 WHERE "ID" = :2', values: ['paid', 7] });
    expect(buildSql('db2', 'APP', { entity, kind: 'get', params: { ID: 7 }, limits }).text).toBe('SELECT "ID", "STATUS" FROM "APP"."ORDERS" WHERE "ID" = ? FETCH FIRST 1 ROWS ONLY');
    expect(() => buildSql('oracle', undefined, { entity, kind: 'list', params: { 'STATUS" OR 1=1 --': 'x' }, limits })).toThrow();
  });
});

describe.skipIf(!at)('Oracle connector (real database)', () => {
  const run = (req: Omit<OperationRequest, 'limits'>) => reg.run(ctx, { ...req, limits });
  const orders = { key: 'FB_ORDERS', fields: ['ID', 'STATUS', 'TOTAL', 'NOTE'], keyField: 'ID' };
  afterAll(() => closeSqlConnections());

  it('connects, and says what each table holds and the limits it keeps to', async () => {
    const oracledb = (await import('oracledb')).default;
    const c = await oracledb.getConnection({ user: 'fb', password: at![3], connectString: `${at![1]}:${at![2]}/FREEPDB1` });
    for (const table of ['FB_ORDERS', 'FB_RULES', 'FB_FILES']) await c.execute(`BEGIN EXECUTE IMMEDIATE 'DROP TABLE ${table}'; EXCEPTION WHEN OTHERS THEN NULL; END;`);
    await c.execute("CREATE TABLE fb_orders (id NUMBER(9) PRIMARY KEY, status VARCHAR2(50), total NUMBER(10,2), note CLOB, secret VARCHAR2(50) DEFAULT 'x')");
    await c.execute("INSERT INTO fb_orders (id, status, total, note) VALUES (1, 'open', 10.5, 'first')");
    await c.execute("INSERT INTO fb_orders (id, status, total, note) VALUES (2, 'paid', 20, 'second')");
    await c.execute(
      "CREATE TABLE fb_rules (id NUMBER(9) PRIMARY KEY, qty NUMBER(4) NOT NULL CHECK (qty BETWEEN 1 AND 100), price NUMBER(7,2) CHECK (price > 0), code VARCHAR2(10) CHECK (REGEXP_LIKE(code, '^[A-Z]{3}$')), name VARCHAR2(40) CHECK (LENGTH(name) >= 2), starts NUMBER, ends NUMBER, CHECK (ends > starts))",
    );
    await c.execute('CREATE TABLE fb_files (id NUMBER(9) PRIMARY KEY, name VARCHAR2(100), body BLOB)');
    await c.commit();
    await c.close();

    expect(await reg.get('oracle').test({ ...ctx, signal: signal() })).toMatchObject({ ok: true });
    const found = await reg.get('oracle').discover({ ...ctx, signal: signal() });
    // The user's own tables, under the names Oracle keeps them by.
    expect(found.map((e) => e.key)).toEqual(expect.arrayContaining(['FB_ORDERS', 'FB_RULES', 'FB_FILES']));
    expect(found.find((e) => e.key === 'FB_ORDERS')!.fields).toEqual([
      { name: 'ID', type: 'number', nullable: false, min: -999999999, max: 999999999 },
      { name: 'STATUS', type: 'string', nullable: true, maxLength: 50 },
      { name: 'TOTAL', type: 'number', nullable: true, min: -99999999.99, max: 99999999.99 },
      expect.objectContaining({ name: 'NOTE', type: 'string', nullable: true }),
      expect.objectContaining({ name: 'SECRET', type: 'string', hasDefault: true }),
    ]);
    const by = Object.fromEntries(found.find((e) => e.key === 'FB_RULES')!.fields.map((f) => [f.name, f]));
    expect(by.QTY).toMatchObject({ type: 'number', nullable: false, min: 1, max: 100 });
    expect(by.PRICE).toMatchObject({ type: 'number', min: 0, max: 99999.99 });
    expect(by.CODE).toMatchObject({ type: 'string', maxLength: 10, pattern: '^[A-Z]{3}$' });
    expect(by.NAME).toMatchObject({ type: 'string', minLength: 2, maxLength: 40 });
    expect(by.STARTS).not.toHaveProperty('min');
  });

  it('reads only what is exposed, by filter and by key, and treats what looks like SQL as a value', async () => {
    expect((await run({ entity: orders, kind: 'list', params: { STATUS: 'open' } })).rows).toEqual([{ ID: 1, STATUS: 'open', TOTAL: 10.5, NOTE: 'first' }]);
    expect((await run({ entity: orders, kind: 'list', params: { STATUS: "open' OR '1'='1" } })).rows).toEqual([]);
    expect((await run({ entity: orders, kind: 'get', params: { ID: 2 } })).rows).toEqual([{ ID: 2, STATUS: 'paid', TOTAL: 20, NOTE: 'second' }]);
    expect((await run({ entity: orders, kind: 'lookup', params: { ID: 2 } })).rows).toEqual([{ exists: true }]);
    expect((await run({ entity: orders, kind: 'lookup', params: { ID: 99 } })).rows).toEqual([]);
    await expect(run({ entity: { ...orders, fields: ['ID', 'SECRET" FROM DUAL --'] }, kind: 'list', params: {} })).rejects.toThrow();
  });

  it('writes a row, changes it, and keeps a file byte for byte', async () => {
    expect((await run({ entity: orders, kind: 'insert', params: { ID: 3, STATUS: 'new', TOTAL: 5.25, NOTE: 'x'.repeat(5000), SECRET: 'not exposed, so not written' } })).affected).toBe(1);
    expect((await run({ entity: orders, kind: 'update', params: { ID: 3, STATUS: 'done' } })).affected).toBe(1);
    const [row] = (await run({ entity: orders, kind: 'get', params: { ID: 3 } })).rows;
    expect(row).toMatchObject({ ID: 3, STATUS: 'done', TOTAL: 5.25 });
    expect(String(row!.NOTE)).toHaveLength(5000);

    const files = { key: 'FB_FILES', fields: ['ID', 'NAME', 'BODY'], keyField: 'ID' };
    await run({ entity: files, kind: 'insert', params: { ID: 1, NAME: 'all-bytes.bin', BODY: { $file: BYTES.toString('base64') } } });
    const oracledb = (await import('oracledb')).default;
    const c = await oracledb.getConnection({ user: 'fb', password: at![3], connectString: `${at![1]}:${at![2]}/FREEPDB1` });
    const stored = await c.execute<[Buffer]>('SELECT body FROM fb_files WHERE id = 1', [], { fetchInfo: { BODY: { type: oracledb.BUFFER } } });
    await c.close();
    expect(Buffer.from(stored.rows![0]![0]).equals(BYTES)).toBe(true);
    expect((await run({ entity: files, kind: 'list', params: { ID: 1 } })).rows).toEqual([{ ID: 1, NAME: 'all-bytes.bin', BODY: '(file, 512 bytes)' }]);
  });

  it('a read-only connector refuses to write', async () => {
    await expect(reg.run({ ...ctx, connector: { ...connector, writable: false } }, { entity: orders, kind: 'insert', params: { ID: 9, STATUS: 'x' }, limits })).rejects.toThrow('read-only');
  });
});
