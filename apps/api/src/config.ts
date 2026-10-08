import { z } from 'zod';

/** Every setting the API reads, validated once at start-up. A bad or missing value stops the process. */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4100),
  MONGODB_URL: z.string().min(1),
  /** HS256 signing key for access tokens. */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  /** base64 of 32 random bytes: encrypts TOTP secrets now, connector credentials until KMS is wired. */
  SECRET_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'SECRET_KEY must be base64 of 32 bytes'),
  /** Studio URL, used in email links. */
  APP_URL: z.string().url().default('http://localhost:5173'),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:5174'),
  /** Where email goes: the log (development) or Amazon SES. */
  MAIL_PROVIDER: z.enum(['console', 'ses']).default('console'),
  /** Verified SES sender, e.g. "Form Builder <no-reply@example.com>". */
  MAIL_FROM: z.string().default(''),
  /** SES / KMS / S3 region. Credentials come from the IAM role (never keys in env). */
  AWS_REGION: z.string().default('ap-south-1'),
  /** Where form attachments live: local disk (development) or a private S3 bucket. */
  STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  UPLOADS_BUCKET: z.string().default(''),
  LOCAL_STORAGE_DIR: z.string().default('.local-uploads'),
  /** This API's public URL (local storage links). */
  API_URL: z.string().url().default('http://localhost:4100'),
  /** AWS KMS key that wraps each connector's data key. Required in production. */
  KMS_KEY_ID: z.string().default(''),
  /**
   * Background jobs (automations, webhooks, SLA sweeps): `all` stores and runs
   * them in this process (development, one server); `enqueue` only stores them
   * (the API beside a worker); `run` is the worker.
   */
  JOBS_ROLE: z.enum(['all', 'enqueue', 'run']).default('all'),
  /** Plan for organisations billing hasn't set one on (see src/plans/plans.ts). */
  DEFAULT_PLAN: z.enum(['FREE', 'TEAM', 'BUSINESS', 'ENTERPRISE']).default('FREE'),
  /** Secure cookies (https only). Must be true outside local development. */
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type AppConfig = z.infer<typeof schema>;
export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration - ${problems}`);
  }
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.COOKIE_SECURE) throw new Error('Invalid configuration - COOKIE_SECURE must be true in production');
  if (parsed.data.NODE_ENV === 'production' && parsed.data.MAIL_PROVIDER !== 'ses') throw new Error('Invalid configuration - production must send mail through SES');
  if (parsed.data.MAIL_PROVIDER === 'ses' && !parsed.data.MAIL_FROM) throw new Error('Invalid configuration - MAIL_FROM is required for SES');
  if (parsed.data.NODE_ENV === 'production' && parsed.data.STORAGE_PROVIDER !== 's3') throw new Error('Invalid configuration - production must store files in S3');
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.KMS_KEY_ID) throw new Error('Invalid configuration - production needs KMS_KEY_ID for connector credentials');
  if (parsed.data.STORAGE_PROVIDER === 's3' && !parsed.data.UPLOADS_BUCKET) throw new Error('Invalid configuration - UPLOADS_BUCKET is required for S3');
  return parsed.data;
}
