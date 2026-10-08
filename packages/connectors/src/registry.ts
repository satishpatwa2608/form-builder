import { WRITE_OPERATIONS, type ConnectorContext, type ConnectorPlugin, type ConnectorType, type OperationRequest, type OperationResult } from './types';

/** Upper bounds no request can exceed, whatever the caller asks for. */
export const HARD_LIMITS = { timeoutMs: 30_000, maxRows: 5_000 } as const;

export class ConnectorError extends Error {
  constructor(
    readonly code: 'UNKNOWN_TYPE' | 'UNSUPPORTED' | 'READ_ONLY' | 'TIMEOUT' | 'FAILED',
    message: string,
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
      return { ...result, rows: result.rows.slice(0, limits.maxRows) };
    } catch (e) {
      if (e instanceof ConnectorError) throw e;
      // Never pass the plugin's message through: drivers echo connection strings and SQL.
      throw new ConnectorError('FAILED', `"${ctx.connector.name}" failed to ${request.kind} ${request.entity.key}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
