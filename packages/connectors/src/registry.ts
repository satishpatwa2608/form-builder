import { WRITE_OPERATIONS, type ConnectorContext, type ConnectorPlugin, type ConnectorType, type OperationRequest, type OperationResult } from './types';

/** Upper bounds no request can exceed, whatever the caller asks for. */
export const HARD_LIMITS = { timeoutMs: 30_000, maxRows: 5_000 } as const;

export class ConnectorError extends Error {
  constructor(
    readonly code: 'UNKNOWN_TYPE' | 'UNSUPPORTED' | 'READ_ONLY' | 'TIMEOUT' | 'FAILED',
    message: string,
    /** When the other system answered over the web: the status it gave (401 means it did not accept who we said we were). */
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}

/**
 * The only way the api/worker call a connector. It enforces the rules every
 * plugin relies on: known type, supported operation, writes only when the
 * connector allows them, clamped limits, a timeout, and errors that never
 * carry the plugin's raw message (which could echo credentials or queries).
 */
export class ConnectorRegistry {
  private readonly plugins = new Map<ConnectorType, ConnectorPlugin>();

  register(plugin: ConnectorPlugin): this {
    if (this.plugins.has(plugin.type)) throw new Error(`Connector type ${plugin.type} is already registered`);
    this.plugins.set(plugin.type, plugin);
    return this;
  }

  get(type: ConnectorType): ConnectorPlugin {
    const plugin = this.plugins.get(type);
    if (!plugin) throw new ConnectorError('UNKNOWN_TYPE', `No connector of type ${type} is available`);
    return plugin;
  }

  types(): ConnectorType[] {
    return [...this.plugins.keys()];
  }

  async run(ctx: Omit<ConnectorContext, 'signal'>, request: OperationRequest): Promise<OperationResult> {
    const plugin = this.get(ctx.connector.type);
    if (!plugin.operations.includes(request.kind)) {
      throw new ConnectorError('UNSUPPORTED', `${plugin.label} connectors can't ${request.kind}`);
    }
    if (WRITE_OPERATIONS.includes(request.kind) && !ctx.connector.writable) {
      throw new ConnectorError('READ_ONLY', `"${ctx.connector.name}" is read-only`);
    }
    const limits = {
      timeoutMs: Math.min(Math.max(request.limits.timeoutMs, 1), HARD_LIMITS.timeoutMs),
      maxRows: Math.min(Math.max(request.limits.maxRows, 1), HARD_LIMITS.maxRows),
    };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Reject first: a plugin that settles synchronously on abort must not win the race.
        reject(new ConnectorError('TIMEOUT', `"${ctx.connector.name}" took longer than ${limits.timeoutMs} ms`));
        controller.abort();
      }, limits.timeoutMs);
    });
    try {
      const result = await Promise.race([plugin.run({ ...ctx, signal: controller.signal }, { ...request, limits }), timeout]);
      // What comes back is cut down to the exposed fields here, whatever the other side chose to send: a database
      // returns the columns asked for, but an API is free to ignore "only these" and send everything it has.
      const exposed = request.entity.fields;
      const reads = request.kind === 'list' || request.kind === 'get';
      // A column that holds a file comes back as a note of its size, never as its bytes: rows are for showing and
      // matching, and a file read into a dropdown or a look-up would be megabytes nobody asked for.
      const rows = result.rows.slice(0, limits.maxRows).map((row) => (Object.values(row).some(isBytes) ? Object.fromEntries(Object.entries(row).map(([k, v]) => [k, isBytes(v) ? `(file, ${sizeOf(v)} bytes)` : v])) : row));
      return { ...result, rows: reads && exposed.length ? rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => exposed.includes(k)))) : rows };
    } catch (e) {
      if (e instanceof ConnectorError) throw e;
      // Never pass the plugin's message through: drivers echo connection strings and SQL.
      throw new ConnectorError('FAILED', `"${ctx.connector.name}" failed to ${request.kind} ${request.entity.key}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Bytes as a driver hands them back: a Buffer, or MongoDB's own wrapper around one. */
const isBytes = (v: unknown): boolean => v instanceof Uint8Array || (!!v && typeof v === 'object' && (v as { _bsontype?: unknown })._bsontype === 'Binary');
const sizeOf = (v: unknown): number => (v instanceof Uint8Array ? v.byteLength : Number((v as { length?: () => number; position?: number }).position ?? (v as { length?: () => number }).length?.() ?? 0));
