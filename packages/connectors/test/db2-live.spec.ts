import { afterAll, describe, expect, it } from 'vitest';
import { closeSqlConnections, defaultRegistry, type ConnectorRecord, type OperationRequest } from '../src';

/**
 * The Db2 connector against a real Db2 database, when one is to hand: DB2_TEST=host:port:password (user
 * "db2inst1", database "testdb", as IBM's community image sets up), with IBM's driver installed and
 * DB2_DRIVER_PATH saying where. Skipped otherwise: Db2 and its driver run only on some kinds of machine.
 */
const reg = defaultRegistry();
const limits = { timeoutMs: 20_000, maxRows: 50 };
const at = /^([^:]+):(\d+):(.+)$/.exec(process.env.DB2_TEST ?? '');
const connector: ConnectorRecord = { id: 'c-db2', orgId: 'o1', type: 'db2', name: 'Db2', settings: { host: at?.[1] ?? '', port: Number(at?.[2] ?? 50000), database: 'testdb' }, secretRef: 'x', writable: true };
const secrets = { user: 'db2inst1', password: at?.[3] ?? '' };
const ctx = { connector, secrets, allowPrivateNetwork: true };
const signal = () => new AbortController().signal;
const BYTES = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256));

describe('a Db2 password the driver cannot be given', () => {
  it('is refused in words, before anything is sent anywhere', async () => {
    const withSemicolon = { connector: { ...connector, id: 'c-db2-semi', settings: { host: 'db2.example.com', database: 'x' } }, secrets: { user: 'u', password: 'pass;DATABASE=other' } };
    await expect(reg.get('db2').test({ ...withSemicolon, allowPrivateNetwork: true, signal: signal() })).rejects.toThrow('cannot be given a password with a semicolon');
  });
});

describe('Db2 without its driver', () => {
  it.skipIf(!!process.env.DB2_DRIVER_PATH)('says how Db2 is reached instead of failing in a way nobody can read', async () => {
    const before = process.env.DB2_DRIVER_PATH;
    process.env.DB2_DRIVER_PATH = '/nowhere/ibm_db';
    try {
      await expect(reg.run({ connector: { ...connector, id: 'c-db2-none', settings: { host: 'db2.example.com', database: 'x' } }, secrets }, { entity: { key: 'T', fields: ['A'] }, kind: 'list', params: {}, limits })).rejects.toThrow();
    } finally {
      if (before === undefined) delete process.env.DB2_DRIVER_PATH;
      else process.env.DB2_DRIVER_PATH = before;
    }
  });
});

describe.skipIf(!at)('Db2 connector (real database)', () => {
  const run = (req: Omit<OperationRequest, 'limits'>) => reg.run(ctx, { ...req, limits });
  const orders = { key: 'FB_ORDERS', fields: ['ID', 'STATUS', 'TOTAL'], keyField: 'ID' };
  afterAll(() => closeSqlConnections());

  it('connects, and says what each table holds and the limits it keeps to', async () => {
    const loaded = (await import(process.env.DB2_DRIVER_PATH || 'ibm_db')) as { default?: unknown };
    const ibm = (loaded.default ?? loaded) as { open(c: string): Promise<{ query(sql: string): Promise<unknown>; close(): Promise<void> }> };
    const c = await ibm.open(`DATABASE=testdb;HOSTNAME=${at![1]};PORT=${at![2]};PROTOCOL=TCPIP;UID=db2inst1;PWD=${at![3]};`);
    for (const table of ['FB_ORDERS', 'FB_RULES', 'FB_FILES']) await c.query(`DROP TABLE ${table}`).catch(() => undefined);
    await c.query("CREATE TABLE fb_orders (id INTEGER NOT NULL PRIMARY KEY, status VARCHAR(50), total DECIMAL(10,2), secret VARCHAR(50) DEFAULT 'x')");
    await c.query("INSERT INTO fb_orders (id, status, total) VALUES (1, 'open', 10.5), (2, 'paid', 20)");
    await c.query(
      "CREATE TABLE fb_rules (id INTEGER NOT NULL PRIMARY KEY, qty SMALLINT NOT NULL CHECK (qty BETWEEN 1 AND 100), price DECIMAL(7,2) CHECK (price > 0), code VARCHAR(10) CHECK (REGEXP_LIKE(code, '^[A-Z]{3}$')), name VARCHAR(40) CHECK (LENGTH(name) >= 2), starts INTEGER, ends INTEGER, CHECK (ends > starts))",
    );
    await c.query('CREATE TABLE fb_files (id INTEGER NOT NULL PRIMARY KEY, name VARCHAR(100), body BLOB(1M))');
    await c.close();

    expect(await reg.get('db2').test({ ...ctx, signal: signal() })).toMatchObject({ ok: true });
    const found = await reg.get('db2').discover({ ...ctx, signal: signal() });
    expect(found.map((e) => e.key)).toEqual(expect.arrayContaining(['FB_ORDERS', 'FB_RULES', 'FB_FILES']));
    expect(found.find((e) => e.key === 'FB_ORDERS')!.fields).toEqual([
      { name: 'ID', type: 'number', nullable: false },
      { name: 'STATUS', type: 'string', nullable: true, maxLength: 50 },
      { name: 'TOTAL', type: 'number', nullable: true, min: -99999999.99, max: 99999999.99 },
      expect.objectContaining({ name: 'SECRET', type: 'string', hasDefault: true }),
    ]);
    const by = Object.fromEntries(found.find((e) => e.key === 'FB_RULES')!.fields.map((f) => [f.name, f]));
    expect(by.QTY).toMatchObject({ type: 'number', nullable: false, min: 1, max: 100 });
    expect(by.PRICE).toMatchObject({ type: 'number', min: 0, max: 99999.99 });
    expect(by.CODE).toMatchObject({ type: 'string', maxLength: 10, pattern: '^[A-Z]{3}$' });
    expect(by.NAME).toMatchObject({ type: 'string', minLength: 2, maxLength: 40 });
    expect(by.STARTS).not.toHaveProperty('min');
  }, 60_000);

  it('reads only what is exposed, by filter and by key, and treats what looks like SQL as a value', async () => {
    const rows = (await run({ entity: orders, kind: 'list', params: { STATUS: 'open' } })).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ID: 1, STATUS: 'open' });
    expect(Number(rows[0]!.TOTAL)).toBe(10.5);
    expect(rows[0]).not.toHaveProperty('SECRET');
    expect((await run({ entity: orders, kind: 'list', params: { STATUS: "open' OR '1'='1" } })).rows).toEqual([]);
    expect((await run({ entity: orders, kind: 'get', params: { ID: 2 } })).rows[0]).toMatchObject({ ID: 2, STATUS: 'paid' });
    expect((await run({ entity: orders, kind: 'lookup', params: { ID: 2 } })).rows).toEqual([{ exists: true }]);
    expect((await run({ entity: orders, kind: 'lookup', params: { ID: 99 } })).rows).toEqual([]);
  }, 60_000);

  it('writes a row, changes it, and keeps a file byte for byte', async () => {
    expect((await run({ entity: orders, kind: 'insert', params: { ID: 3, STATUS: 'new', TOTAL: 5.25, SECRET: 'not exposed, so not written' } })).affected).toBe(1);
    expect((await run({ entity: orders, kind: 'update', params: { ID: 3, STATUS: 'done' } })).affected).toBe(1);
    expect((await run({ entity: orders, kind: 'get', params: { ID: 3 } })).rows[0]).toMatchObject({ ID: 3, STATUS: 'done' });

    const files = { key: 'FB_FILES', fields: ['ID', 'NAME', 'BODY'], keyField: 'ID' };
    await run({ entity: files, kind: 'insert', params: { ID: 1, NAME: 'all-bytes.bin', BODY: { $file: BYTES.toString('base64') } } });
    const loaded = (await import(process.env.DB2_DRIVER_PATH || 'ibm_db')) as { default?: unknown };
    const ibm = (loaded.default ?? loaded) as { open(c: string): Promise<{ query(sql: string): Promise<Record<string, unknown>[]>; close(): Promise<void> }> };
    const c = await ibm.open(`DATABASE=testdb;HOSTNAME=${at![1]};PORT=${at![2]};PROTOCOL=TCPIP;UID=db2inst1;PWD=${at![3]};`);
    // Its length and a fingerprint of it, worked out by the database itself.
    const [stored] = await c.query('SELECT LENGTH(body) AS "n", HEX(CAST(body AS VARCHAR(512) FOR BIT DATA)) AS "h" FROM fb_files WHERE id = 1');
    await c.close();
    expect(Number(stored!.n)).toBe(512);
    expect(String(stored!.h).toLowerCase()).toBe(BYTES.toString('hex'));
    // Read back through the connector, the file is a note of its size, never its bytes.
    expect((await run({ entity: files, kind: 'list', params: { ID: 1 } })).rows).toEqual([{ ID: 1, NAME: 'all-bytes.bin', BODY: '(file, 512 bytes)' }]);
  }, 60_000);

  it('a read-only connector refuses to write', async () => {
    await expect(reg.run({ ...ctx, connector: { ...connector, writable: false } }, { entity: orders, kind: 'insert', params: { ID: 9, STATUS: 'x' }, limits })).rejects.toThrow('read-only');
  });
});
