import type { NestExpressApplication } from '@nestjs/platform-express';
import { raw } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import type { Request } from 'express';
import type { AppConfig } from './config';
import { SiteService } from './site/site.service';

/** HTTP hardening shared by main.ts and the e2e tests. */
export function configureApp(app: NestExpressApplication, config: AppConfig) {
  // Behind one load balancer: take the client IP from it (for rate limits and the audit log).
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cookieParser());
  // Local file storage (development) receives the file body itself.
  if (config.STORAGE_PROVIDER === 'local') app.use('/public/local-store', raw({ type: () => true, limit: '26mb' }));
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
