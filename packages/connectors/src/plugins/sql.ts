import mssql from 'mssql';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { z } from 'zod';
import { ConnectorError } from '../registry';
import type { ConnectorContext, ConnectorPlugin, ConnectorType, Entity, EntityField, OperationRequest } from '../types';
import { ConnectionPool } from './pool';
import { limitsFromCheck, limitsFromType } from './source-limits';
import { assertIdentifier, assertPublicHost, elapsed, filtersFrom, now, rowFrom, type Primitive } from './shared';

type Dialect = 'postgres' | 'mysql' | 'mssql' | 'oracle' | 'db2';

/** Identifiers are whitelisted (assertIdentifier) and then quoted; values are always parameters. */
const quote = (d: Dialect, name: string) => (d === 'mssql' ? `[${name}]` : d === 'mysql' ? `\`${name}\`` : `"${name}"`);
const param = (d: Dialect, i: number) => (d === 'postgres' ? `$${i}` : d === 'mssql' ? `@p${i}` : d === 'oracle' ? `:${i}` : '?');
/** "At most n rows": SQL Server says it before the columns, the others after everything else (Oracle and Db2 in the standard's own words). */
const first = (d: Dialect, n: number) =>
  d === 'mssql' ? { top: `TOP (${Math.floor(n)}) `, limit: '' } : d === 'oracle' || d === 'db2' ? { top: '', limit: ` FETCH FIRST ${Math.floor(n)} ROWS ONLY` } : { top: '', limit: ` LIMIT ${Math.floor(n)}` };

export interface SqlStatement {
  text: string;
  values: unknown[];
}

/** Builds the statement for an operation. Pure, so it's tested without a database. */
export function buildSql(d: Dialect, schema: string | undefined, req: OperationRequest): SqlStatement {
  const table = `${schema ? `${quote(d, assertIdentifier(schema))}.` : ''}${quote(d, assertIdentifier(req.entity.key))}`;
  const cols = req.entity.fields.map((f) => quote(d, assertIdentifier(f)));
  const keyField = req.entity.keyField ?? 'id';
  const values: unknown[] = [];
  const next = (v: unknown) => {
    values.push(v);
    return param(d, values.length);
  };
  switch (req.kind) {
    case 'list': {
      const where = filtersFrom(req.entity, req.params).map(([k, v]) => `${quote(d, k)} = ${next(v)}`);
      const { top, limit } = first(d, req.limits.maxRows);
      return { text: `SELECT ${top}${cols.join(', ')} FROM ${table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}${limit}`, values };
    }
    case 'get':
    case 'lookup': {
      const key = req.params[keyField];
      if (key === undefined) throw new ConnectorError('UNSUPPORTED', `${keyField} is required`);
      const k = quote(d, assertIdentifier(keyField, req.entity.fields));
      const { top, limit } = first(d, 1);
      return { text: `SELECT ${top}${req.kind === 'lookup' ? (d === 'mssql' ? '1 AS found' : '1') : cols.join(', ')} FROM ${table} WHERE ${k} = ${next(key)}${limit}`, values };
    }
    case 'insert': {
      const row = rowFrom(req.entity, req.params, 'bytes');
      const keys = Object.keys(row);
      const placeholders = keys.map((k) => next(row[k]));
      return { text: `INSERT INTO ${table} (${keys.map((k) => quote(d, k)).join(', ')}) VALUES (${placeholders.join(', ')})`, values };
    }
    case 'update': {
      const { [keyField]: key, ...rest } = req.params;
      if (key === undefined) throw new ConnectorError('UNSUPPORTED', `${keyField} is required`);
      const row = rowFrom(req.entity, rest, 'bytes');
      const sets = Object.keys(row).map((k) => `${quote(d, k)} = ${next(row[k])}`);
      const k = quote(d, assertIdentifier(keyField, req.entity.fields));
      return { text: `UPDATE ${table} SET ${sets.join(', ')} WHERE ${k} = ${next(key)}`, values };
    }
    default:
      throw new ConnectorError('UNSUPPORTED', `SQL connectors can't ${req.kind}`);
  }
}

interface SqlDriver {
  query(text: string, values: unknown[], timeoutMs: number): Promise<{ rows: Record<string, unknown>[]; affected: number }>;
  close(): Promise<void>;
}

const pools = new ConnectionPool<SqlDriver>((c) => c.close());

async function connect(d: Dialect, ctx: ConnectorContext): Promise<SqlDriver> {
  const s = ctx.connector.settings;
  await assertPublicHost(ctx, String(s.host));
  const secret = { user: ctx.secrets.user, password: ctx.secrets.password };
  return pools.get(ConnectionPool.key(ctx.connector.id, secret), async () => {
    const tls = s.ssl === false ? undefined : { rejectUnauthorized: s.verifyCertificate !== false, ...(ctx.secrets.caCert ? { ca: ctx.secrets.caCert } : {}) };
    if (d === 'postgres') {
      const p = new pg.Pool({ host: String(s.host), port: Number(s.port ?? 5432), database: String(s.database), user: secret.user, password: secret.password, ssl: tls, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 60_000 });
      return {
        async query(text, values, timeoutMs) {
          const c = await p.connect();
          try {
            await c.query(`SET statement_timeout = ${Math.floor(timeoutMs)}`);
            const r = await c.query(text, values);
            return { rows: r.rows as Record<string, unknown>[], affected: r.rowCount ?? 0 };
          } finally {
            c.release();
          }
        },
        close: () => p.end(),
      };
    }
    if (d === 'mssql') {
      // Always encrypted unless TLS is switched off; the certificate is checked unless that is switched off too.
      const p = await new mssql.ConnectionPool({
        server: String(s.host),
        port: Number(s.port ?? 1433),
        database: String(s.database),
        user: secret.user,
        password: secret.password,
        options: { encrypt: s.ssl !== false, trustServerCertificate: s.verifyCertificate === false },
        pool: { max: 5, idleTimeoutMillis: 60_000 },
        connectionTimeout: 5000,
        requestTimeout: 30_000,
      }).connect();
      return {
        async query(text, values) {
          const request = p.request();
          values.forEach((v, i) => request.input(`p${i + 1}`, v));
          const r = await request.query(text);
          return { rows: (r.recordset ?? []) as Record<string, unknown>[], affected: r.rowsAffected.reduce((a, b) => a + b, 0) };
        },
        close: () => p.close(),
      };
    }
    if (d === 'oracle') return oracleDriver({ host: String(s.host), port: Number(s.port ?? 1521), service: String(s.database), user: secret.user, password: secret.password, tls: s.ssl === true });
    if (d === 'db2') return db2Driver({ host: String(s.host), port: Number(s.port ?? 50000), database: String(s.database), user: secret.user, password: secret.password, tls: s.ssl === true });
    const p = mysql.createPool({ host: String(s.host), port: Number(s.port ?? 3306), database: String(s.database), user: secret.user, password: secret.password, ssl: tls, connectionLimit: 5, connectTimeout: 5000 });
    return {
      async query(text, values, timeoutMs) {
        const [result] = await p.query({ sql: text, values, timeout: timeoutMs });
        if (Array.isArray(result)) return { rows: result as Record<string, unknown>[], affected: 0 };
        return { rows: [], affected: (result as { affectedRows?: number }).affectedRows ?? 0 };
      },
      close: () => p.end(),
    };
  });
}

/**
 * Oracle, through its own driver in "thin" mode: plain JavaScript, with nothing of Oracle's to install beside it.
 * Large text comes back as text and large binary as bytes, like any other column.
 */
async function oracleDriver(o: { host: string; port: number; service: string; user: string; password: string; tls: boolean }): Promise<SqlDriver> {
  const oracledb = (await import('oracledb')).default;
  oracledb.fetchAsString = [oracledb.CLOB, oracledb.NCLOB];
  oracledb.fetchAsBuffer = [oracledb.BLOB];
  const pool = await oracledb.createPool({ user: o.user, password: o.password, connectString: `${o.tls ? 'tcps' : 'tcp'}://${o.host}:${o.port}/${o.service}`, poolMin: 0, poolMax: 5, poolTimeout: 60, connectTimeout: 5 });
  return {
    async query(text, values, timeoutMs) {
      const c = await pool.getConnection();
      try {
        c.callTimeout = Math.floor(timeoutMs);
        // Its own "is there a database" query has a table of its own to ask.
        const r = await c.execute(text === 'SELECT 1' ? 'SELECT 1 FROM DUAL' : text, values as never[], { outFormat: oracledb.OUT_FORMAT_OBJECT, autoCommit: true });
        return { rows: (r.rows ?? []) as Record<string, unknown>[], affected: r.rowsAffected ?? 0 };
      } finally {
        await c.close();
      }
    },
    close: () => pool.close(0),
  };
}

/**
 * Db2, through IBM's own driver. That driver is a piece of IBM's software built for particular kinds of machine
 * (it exists for Intel/AMD Linux, Windows and macOS, not for ARM Linux), so it is loaded only when a Db2 connector
 * is used, and where it is absent the connector says how Db2 is reached instead: through a gateway on a machine
 * that has it.
 */
async function db2Driver(o: { host: string; port: number; database: string; user: string; password: string; tls: boolean }): Promise<SqlDriver> {
  interface Db2Connection {
    query(sql: string, values: unknown[]): Promise<Record<string, unknown>[]>;
    prepare(sql: string): Promise<{ executeNonQuery(values: unknown[]): Promise<number>; closeSync(): void }>;
    close(): Promise<void>;
  }
  let ibm: { open(connection: string): Promise<Db2Connection> };
  try {
    // Named in a variable so that building the product does not need IBM's driver to be there. DB2_DRIVER_PATH says
    // where it was installed, when that is not beside the product (a gateway's own folder, say).
    const name = process.env.DB2_DRIVER_PATH || 'ibm_db';
    const loaded = (await import(name)) as { default?: unknown };
    ibm = (loaded.default ?? loaded) as never;
  } catch {
    throw new ConnectorError('UNSUPPORTED', "Db2 needs IBM's own driver, which is not on this server. Connect to Db2 through a gateway installed on a machine near the database (Connectors, Gateways).");
  }
  const text = (v: string) => v.replace(/[;{}]/g, '');
  const connection = `DATABASE=${text(o.database)};HOSTNAME=${text(o.host)};PORT=${o.port};PROTOCOL=TCPIP;UID=${text(o.user)};PWD={${o.password.replace(/}/g, '}}')}};${o.tls ? 'SECURITY=SSL;' : ''}CONNECTTIMEOUT=5;`;
  // One connection, used for one statement at a time: IBM's driver does not share a connection between statements.
  let open: Promise<Db2Connection> | undefined;
  let turn: Promise<unknown> = Promise.resolve();
  const run = <T>(work: (c: Db2Connection) => Promise<T>): Promise<T> => {
    const next = turn.then(async () => work(await (open ??= ibm.open(connection))));
    turn = next.catch(() => {
      // A broken connection is dropped, so the next statement opens a new one.
      open = undefined;
    });
    return next;
  };
  return {
    query: (sql, values) =>
      run(async (c) => {
        const statement = sql === 'SELECT 1' ? 'SELECT 1 FROM SYSIBM.SYSDUMMY1' : sql;
        if (/^\s*select/i.test(statement)) return { rows: await c.query(statement, values), affected: 0 };
        const prepared = await c.prepare(statement);
        try {
          // A file goes in as the bytes it is, said to be a BLOB; everything else as itself.
          return { rows: [], affected: await prepared.executeNonQuery(values.map((v) => (v instanceof Uint8Array ? { ParamType: 'INPUT', DataType: 'BLOB', Data: v } : v))) };
        } finally {
          prepared.closeSync();
        }
      }),
    close: async () => {
      await (await open?.catch(() => undefined))?.close();
    },
  };
}

const TYPE: Record<string, EntityField['type']> = {
  integer: 'number', bigint: 'number', smallint: 'number', numeric: 'number', decimal: 'number', real: 'number', 'double precision': 'number', int: 'number', tinyint: 'number', float: 'number', double: 'number',
  boolean: 'boolean', bool: 'boolean',
  date: 'date', timestamp: 'date', 'timestamp without time zone': 'date', 'timestamp with time zone': 'date', datetime: 'date',
  json: 'object', jsonb: 'object',
  // SQL Server's own names.
  bit: 'boolean', money: 'number', smallmoney: 'number', datetime2: 'date', smalldatetime: 'date', datetimeoffset: 'date',
  // Oracle's and Db2's own names (as their catalogues give them, lower-cased; Oracle's "timestamp(6)" is matched without its precision).
  number: 'number', binary_float: 'number', binary_double: 'number', decfloat: 'number',
};

/** Types that hold whole numbers only. */
const WHOLE = new Set(['integer', 'bigint', 'smallint', 'int', 'tinyint', 'mediumint']);

/** Where each database keeps the list of its columns, and of its tables' own rules, for one schema. Column names are lower-cased so every database reads the same. */
const CATALOG: Record<Dialect, { columns: (p: string) => string; checks: (p: string) => string }> = {
  postgres: {
    columns: (p) => `SELECT table_name AS t, column_name AS c, data_type AS dt, is_nullable AS n, character_maximum_length AS ml, column_default AS df, numeric_precision AS np, numeric_scale AS ns FROM information_schema.columns WHERE table_schema = ${p} ORDER BY table_name, ordinal_position`,
    checks: (p) => `SELECT tc.table_name AS t, cc.check_clause AS cl FROM information_schema.table_constraints tc JOIN information_schema.check_constraints cc ON cc.constraint_schema = tc.constraint_schema AND cc.constraint_name = tc.constraint_name WHERE tc.table_schema = ${p} AND tc.constraint_type = 'CHECK'`,
  },
  get mysql() {
    return this.postgres;
  },
  get mssql() {
    return this.postgres;
  },
  oracle: {
    columns: (p) => `SELECT table_name AS "t", column_name AS "c", data_type AS "dt", nullable AS "n", char_length AS "ml", data_default AS "df", data_precision AS "np", data_scale AS "ns" FROM all_tab_columns WHERE owner = ${p} ORDER BY table_name, column_id`,
    checks: (p) => `SELECT table_name AS "t", search_condition_vc AS "cl" FROM all_constraints WHERE owner = ${p} AND constraint_type = 'C'`,
  },
  db2: {
    columns: (p) => `SELECT tabname AS "t", colname AS "c", typename AS "dt", nulls AS "n", length AS "ml", "DEFAULT" AS "df", length AS "np", scale AS "ns" FROM syscat.columns WHERE tabschema = ${p} ORDER BY tabname, colno`,
    checks: (p) => `SELECT tabname AS "t", text AS "cl" FROM syscat.checks WHERE tabschema = ${p} AND type = 'C'`,
  },
};

function sqlPlugin(type: Extract<ConnectorType, Dialect>, label: string): ConnectorPlugin {
  const d: Dialect = type;
  return {
    type,
    label,
    settingsSchema: z.object({
      host: z.string().min(1).max(255),
      port: z.coerce.number().int().min(1).max(65535).optional(),
      database: z.string().min(1).max(64),
      schema: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/).optional(),
      ssl: z.boolean().optional(),
      verifyCertificate: z.boolean().optional(),
    }),
    secretsSchema: z.object({ user: z.string().min(1).max(128), password: z.string().max(512), caCert: z.string().max(20_000).optional() }),
    operations: ['list', 'get', 'lookup', 'insert', 'update'],

    async test(ctx) {
      const start = now();
      await (await connect(d, ctx)).query('SELECT 1', [], 5000);
      return { ok: true, message: 'Connected', latencyMs: elapsed(start) };
    },

    async discover(ctx): Promise<Entity[]> {
      // Oracle and Db2 keep each user's tables under the user's own name, in capitals, unless told otherwise.
      const own = String(ctx.secrets.user ?? '').toUpperCase();
      const schema = String(ctx.connector.settings.schema ?? (d === 'postgres' ? 'public' : d === 'mssql' ? 'dbo' : d === 'oracle' || d === 'db2' ? own : ctx.connector.settings.database));
      const db = await connect(d, ctx);
      const rows = (await db.query(CATALOG[d].columns(param(d, 1)), [schema], 10_000)).rows;
      const tables = new Map<string, EntityField[]>();
      const whole = new Map<string, Set<string>>();
      for (const r of rows) {
        const t = String(r.t ?? r.T ?? r.TABLE_NAME);
        if (!tables.has(t)) tables.set(t, []);
        // What the table itself insists on: a column that may not be empty, the longest text it takes, and the
        // numbers its type has room for.
        const nullable = !['NO', 'N'].includes(String(r.n ?? r.N ?? r.IS_NULLABLE ?? 'YES').toUpperCase());
        const length = Number(r.ml ?? r.ML ?? r.CHARACTER_MAXIMUM_LENGTH);
        const fallback = r.df ?? r.DF ?? r.COLUMN_DEFAULT;
        // As the catalogue names it, without a precision in brackets ("timestamp(6)") or a note about time zones.
        const named = String(r.dt ?? r.DT ?? r.DATA_TYPE).toLowerCase().replace(/\(.*$/, '').replace(/ with .*$/, '').trim();
        const name = String(r.c ?? r.C ?? r.COLUMN_NAME);
        const digits = r.np ?? r.NP ?? r.NUMERIC_PRECISION;
        const places = Number(r.ns ?? r.NS ?? r.NUMERIC_SCALE);
        // Oracle's one kind of number is a decimal when it is given a number of digits.
        const dataType = named === 'number' && digits !== null && digits !== undefined ? 'numeric' : named;
        const kind = TYPE[dataType] ?? 'string';
        if (WHOLE.has(dataType) || ((dataType === 'numeric' || dataType === 'decimal') && places === 0)) whole.set(t, (whole.get(t) ?? new Set()).add(name));
        const given = typeof fallback === 'string' ? fallback.trim().toUpperCase() : fallback;
        tables.get(t)!.push({
          name,
          type: kind,
          nullable,
          ...(kind === 'string' && Number.isFinite(length) && length > 0 && length <= 100_000 ? { maxLength: length } : {}),
          ...(given !== null && given !== undefined && given !== '' && given !== 'NULL' ? { hasDefault: true } : {}),
          ...limitsFromType(dataType, Number(digits), places, d),
        });
      }
      // The table's own rules (CHECK constraints): a range, a shortest length, a pattern. A database that will not
      // show them (an old version, a login without the right) simply gives none.
      const checks = await db.query(CATALOG[d].checks(param(d, 1)), [schema], 10_000).then((r) => r.rows, () => []);
      for (const r of checks) {
        const fields = tables.get(String(r.t ?? r.T ?? r.TABLE_NAME));
        const clause = r.cl ?? r.CL ?? r.CHECK_CLAUSE;
        if (!fields || typeof clause !== 'string' || clause.length > 2000) continue;
        const table = String(r.t ?? r.T ?? r.TABLE_NAME);
        const found = limitsFromCheck(clause, fields.map((f) => ({ name: f.name, whole: whole.get(table)?.has(f.name) })), d);
        const field = found && fields.find((f) => f.name === found.column);
        if (!found || !field) continue;
        const { min, max, minLength, maxLength, pattern } = found.limits;
        // Where the type and a rule both say something, the tighter of the two holds.
        if (min !== undefined && field.type === 'number') field.min = Math.max(field.min ?? -Infinity, min);
        if (max !== undefined && field.type === 'number') field.max = Math.min(field.max ?? Infinity, max);
        if (field.type === 'string') {
          if (minLength !== undefined) field.minLength = Math.max(field.minLength ?? 0, minLength);
          if (maxLength !== undefined) field.maxLength = Math.min(field.maxLength ?? Infinity, maxLength);
          if (pattern !== undefined && field.pattern === undefined) field.pattern = pattern;
        }
      }
      return [...tables.entries()].slice(0, 300).map(([key, fields]) => ({ key, label: key, fields }));
    },

    async run(ctx, req) {
      const start = now();
      const stmt = buildSql(d, ctx.connector.settings.schema ? String(ctx.connector.settings.schema) : undefined, req);
      const r = await (await connect(d, ctx)).query(stmt.text, stmt.values as Primitive[], req.limits.timeoutMs);
      const rows = req.kind === 'lookup' ? (r.rows.length ? [{ exists: true }] : []) : r.rows;
      return { rows, affected: r.affected, durationMs: elapsed(start) };
    },
  };
}

export const postgresPlugin = sqlPlugin('postgres', 'PostgreSQL');
export const mysqlPlugin = sqlPlugin('mysql', 'MySQL');
export const mssqlPlugin = sqlPlugin('mssql', 'SQL Server');
export const oraclePlugin = sqlPlugin('oracle', 'Oracle Database');
export const db2Plugin = sqlPlugin('db2', 'IBM Db2');
export const closeSqlConnections = () => pools.closeAll();
