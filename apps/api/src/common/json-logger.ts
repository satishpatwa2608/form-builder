import type { LoggerService, LogLevel } from '@nestjs/common';
import { currentRequest } from './request-context';

/**
 * One JSON object per line, for a log collector: when, how serious, which part of the product, the message, and
 * the request it belongs to. Used instead of Nest's coloured text when LOG_FORMAT=json (the default in
 * production), by the API and the worker alike.
 */
export class JsonLogger implements LoggerService {
  constructor(
    private readonly service: 'api' | 'worker',
    private readonly out: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  ) {}

  log(message: unknown, ...rest: unknown[]) {
    this.write('info', message, rest);
  }
  error(message: unknown, ...rest: unknown[]) {
    this.write('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]) {
    this.write('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]) {
    this.write('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]) {
    this.write('verbose', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]) {
    this.write('fatal', message, rest);
  }
  setLogLevels(_levels: LogLevel[]) {
    // Every level is written; the collector filters.
  }

  /** A line of facts rather than a sentence (the access log, for one). */
  event(level: 'info' | 'warn' | 'error', message: string, facts: Record<string, unknown>) {
    this.emit(level, message, undefined, facts);
  }

  private write(level: string, message: unknown, rest: unknown[]) {
    // Nest passes (message, context) or (message, stack, context): the context is always last.
    const context = typeof rest.at(-1) === 'string' ? (rest.at(-1) as string) : undefined;
    const stack = level === 'error' && rest.length > 1 && typeof rest[0] === 'string' ? rest[0] : undefined;
    const text = message instanceof Error ? message.message : typeof message === 'string' ? message : JSON.stringify(message);
    this.emit(level, text, context, stack ? { stack } : undefined);
  }

  private emit(level: string, message: string, context?: string, facts?: Record<string, unknown>) {
    const request = currentRequest();
    this.out(
      JSON.stringify({
        at: new Date().toISOString(),
        level,
        service: this.service,
        ...(context ? { context } : {}),
        message,
        ...(request?.requestId ? { requestId: request.requestId } : {}),
        ...(request?.orgId ? { orgId: request.orgId } : {}),
        ...facts,
      }),
    );
  }
}
