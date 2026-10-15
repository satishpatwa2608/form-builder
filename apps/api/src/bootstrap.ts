import type { NestExpressApplication } from '@nestjs/platform-express';
import { raw } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import type { NextFunction, Request, Response } from 'express';
import type { AppConfig } from './config';
import { JsonLogger } from './common/json-logger';
import { metrics } from './common/metrics';
import { newRequestId, withRequest } from './common/request-context';
import { SiteService } from './site/site.service';

/** HTTP hardening shared by main.ts and the e2e tests. */
export function configureApp(app: NestExpressApplication, config: AppConfig) {
  // Behind one load balancer: take the client IP from it (for rate limits and the audit log).
  app.set('trust proxy', 1);
  // Every request gets an ID (the caller's, when it sent one), answered in a header and carried into everything it does.
  const access = logsAsJson(config) ? new JsonLogger('api') : undefined;
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = newRequestId(req.headers['x-request-id']);
    res.setHeader('x-request-id', requestId);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      // The route as written in the code, never the address itself: some carry a token.
      const route = req.route?.path ? `${req.baseUrl ?? ''}${String(req.route.path)}` : 'unmatched';
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      metrics.requests.observe({ method: req.method, route, status: res.statusCode }, seconds);
      if (access && route !== '/health') withRequest({ requestId, orgId: (req as Request & { auth?: { orgId?: string } }).auth?.orgId }, () => access.event(res.statusCode >= 500 ? 'error' : 'info', 'request', { method: req.method, route, status: res.statusCode, ms: Math.round(seconds * 1000) }));
    });
    withRequest({ requestId }, next);
  });
  app.use(helmet());
  app.use(cookieParser());
  // Local file storage (development) receives the file body itself.
  if (config.STORAGE_PROVIDER === 'local') app.use('/public/local-store', raw({ type: () => true, limit: '26mb' }));
  // An organisation's own fillable PDF arrives as the file itself, not as JSON.
  app.use('/pdf-templates', raw({ type: 'application/pdf', limit: '5mb' }));
  app.useBodyParser('json', { limit: '1mb' });
  const studio = new Set(config.CORS_ORIGINS.split(',').map((o) => o.trim()));
  const site = app.get(SiteService);
  // Studio origins get credentials; a customer's verified form domain may call the public form API only, without cookies.
  app.enableCors((req: Request, cb: (err: Error | null, options: CorsOptions) => void) => {
    const origin = req.headers.origin;
    if (!origin || studio.has(origin)) return cb(null, { origin: !!origin, credentials: true });
    let host = '';
    try {
      const u = new URL(origin);
      host = u.protocol === 'https:' ? u.hostname : '';
    } catch {
      /* not a URL */
    }
    if (!host || !req.url.startsWith('/public/')) return cb(null, { origin: false });
    site.orgForHost(host).then(
      () => cb(null, { origin: true, credentials: false }),
      () => cb(null, { origin: false }),
    );
  });
}

/** JSON log lines unless told otherwise; Nest's coloured text by default outside production. */
export const logsAsJson = (config: Pick<AppConfig, 'LOG_FORMAT' | 'NODE_ENV'>) => (config.LOG_FORMAT ?? (config.NODE_ENV === 'production' ? 'json' : 'text')) === 'json';
