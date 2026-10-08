import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Rate limits for the public form endpoints, counted per client IP and form
 * code (so one busy form doesn't starve another). `req.ip` honours Express's
 * `trust proxy` setting: behind nginx / a load balancer that must be enabled in
 * main.ts, or every visitor shares the proxy's IP (see the module wiki).
 */
@Injectable()
export class FormThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const code = typeof req.params?.code === 'string' ? req.params.code : '';
    return `${req.ip ?? 'unknown'}:${code}`;
  }
}
