import mssql from 'mssql';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { z } from 'zod';
import { ConnectorError } from '../registry';
import type { ConnectorContext, ConnectorPlugin, ConnectorType, Entity, EntityField, OperationRequest } from '../types';
import { ConnectionPool } from './pool';
import { assertIdentifier, assertPublicHost, elapsed, filtersFrom, now, rowFrom, type Primitive } from './shared';

type Dialect = 'postgres' | 'mysql' | 'mssql';

/** Identifiers are whitelisted (assertIdentifier) and then quoted; values are always parameters. */
const quote = (d: Dialect, name: string) => (d === 'postgres' ? `"${name}"` : d === 'mssql' ? `[${name}]` : `\`${name}\``);
const param = (d: Dialect, i: number) => (d === 'postgres' ? `$${i}` : d === 'mssql' ? `@p${i}` : '?');
/** "At most n rows": SQL Server says it before the columns, the others after everything else. */
const first = (d: Dialect, n: number) => (d === 'mssql' ? { top: `TOP (${Math.floor(n)}) `, limit: '' } : { top: '', limit: ` LIMIT ${Math.floor(n)}` });

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
      const row = rowFrom(req.entity, req.params);
      const keys = Object.keys(row);
      const placeholders = keys.map((k) => next(row[k]));
      return { text: `INSERT INTO ${table} (${keys.map((k) => quote(d, k)).join(', ')}) VALUES (${placeholders.join(', ')})`, values };
    }
    case 'update': {
      const { [keyField]: key, ...rest } = req.params;
      if (key === undefined) throw new ConnectorError('UNSUPPORTED', `${keyField} is required`);
      const row = rowFrom(req.entity, rest);
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

const TYPE: Record<string, EntityField['type']> = {
  integer: 'number', bigint: 'number', smallint: 'number', numeric: 'number', decimal: 'number', real: 'number', 'double precision': 'number', int: 'number', tinyint: 'number', float: 'number', double: 'number',
  boolean: 'boolean', bool: 'boolean',
  date: 'date', timestamp: 'date', 'timestamp without time zone': 'date', 'timestamp with time zone': 'date', datetime: 'date',
  json: 'object', jsonb: 'object',
  // SQL Server's own names.
  bit: 'boolean', money: 'number', smallmoney: 'number', datetime2: 'date', smalldatetime: 'date', datetimeoffset: 'date',
};

function sqlPlugin(type: Extract<ConnectorType, 'postgres' | 'mysql' | 'mssql'>, label: string): ConnectorPlugin {
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
      const schema = String(ctx.connector.settings.schema ?? (d === 'postgres' ? 'public' : d === 'mssql' ? 'dbo' : ctx.connector.settings.database));
      const rows = (
        await (
          await connect(d, ctx)
        ).query(
          `SELECT table_name AS t, column_name AS c, data_type AS dt, is_nullable AS n, character_maximum_length AS ml, column_default AS df FROM information_schema.columns WHERE table_schema = ${param(d, 1)} ORDER BY table_name, ordinal_position`,
          [schema],
          10_000,
        )
      ).rows;
      const tables = new Map<string, EntityField[]>();
      for (const r of rows) {
        const t = String(r.t ?? r.T ?? r.TABLE_NAME);
        if (!tables.has(t)) tables.set(t, []);
        // What the table itself insists on: a column that may not be empty, and the longest text it takes.
        const nullable = String(r.n ?? r.N ?? r.IS_NULLABLE ?? 'YES').toUpperCase() !== 'NO';
        const length = Number(r.ml ?? r.ML ?? r.CHARACTER_MAXIMUM_LENGTH);
        const fallback = r.df ?? r.DF ?? r.COLUMN_DEFAULT;
        tables.get(t)!.push({
          name: String(r.c ?? r.C ?? r.COLUMN_NAME),
          type: TYPE[String(r.dt ?? r.DT ?? r.DATA_TYPE).toLowerCase()] ?? 'string',
          nullable,
          ...(Number.isFinite(length) && length > 0 && length <= 100_000 ? { maxLength: length } : {}),
          ...(fallback !== null && fallback !== undefined && fallback !== '' ? { hasDefault: true } : {}),
        });
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
export const closeSqlConnections = () => pools.closeAll();
