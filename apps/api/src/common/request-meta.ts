import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** "::ffff:1.2.3.4" (an IPv4 client on a dual-stack socket) -> "1.2.3.4". */
export const clientIp = (ip: string | undefined) => (ip ?? '').replace(/^::ffff:/, '');

export interface RequestMeta {
  ip: string;
  userAgent: string;
}

/** Client IP and user agent for sessions and the audit log. */
export const Meta = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestMeta => {
  const req = ctx.switchToHttp().getRequest<Request>();
  return { ip: clientIp(req.ip), userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300) };
});
