import type { LogArea, LogLevel } from './log.schema';

type Writer = (orgId: string | undefined, level: LogLevel, area: LogArea, message: string, context?: Record<string, unknown>) => void;

let writer: Writer | undefined;
/** Set once the log service exists; cleared when the app closes. */
export const setOrgLogWriter = (w: Writer | undefined) => {
  writer = w;
};

/**
 * Writes a line to an organisation's own log from anywhere in the product,
 * the way a logger is used: no waiting, no failing, and nothing happens if
 * the area is not listening at that level.
 */
export const orgLog = {
  debug: (orgId: string | undefined, area: LogArea, message: string, context?: Record<string, unknown>) => writer?.(orgId, 'DEBUG', area, message, context),
  info: (orgId: string | undefined, area: LogArea, message: string, context?: Record<string, unknown>) => writer?.(orgId, 'INFO', area, message, context),
  warn: (orgId: string | undefined, area: LogArea, message: string, context?: Record<string, unknown>) => writer?.(orgId, 'WARN', area, message, context),
  error: (orgId: string | undefined, area: LogArea, message: string, context?: Record<string, unknown>) => writer?.(orgId, 'ERROR', area, message, context),
};
