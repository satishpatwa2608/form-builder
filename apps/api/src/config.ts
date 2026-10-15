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
  /**
   * Malware check on uploaded files before they can be attached: `none`, or
   * `clamav` (a clamd daemon at CLAMAV_HOST:CLAMAV_PORT). With a scanner set,
   * a file it cannot check is refused.
   */
  FILE_SCANNER: z.enum(['none', 'clamav']).default('none'),
  CLAMAV_HOST: z.string().default('127.0.0.1'),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
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
  /**
   * Whether a process that runs jobs also looks for due ones every second
   * (retries, scheduled publishing). On, except under NODE_ENV=test where
   * tests drive the queue themselves; set it to force either way.
   */
  JOBS_POLL: z.enum(['true', 'false']).optional(),
  /**
   * How long a worker holds a job it took before another may assume it died. A worker renews it every third of
   * this while the job runs, so a long job is never taken twice; a short value only makes a dead worker's job
   * come back sooner.
   */
  /**
   * The AI service that drafts a form from a description: none (the default: the box is not shown), or
   * anthropic (Claude, with ANTHROPIC_API_KEY). Only the description is ever sent.
   */
  AI_DRAFT_PROVIDER: z.enum(['none', 'anthropic']).default('none'),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_DRAFT_MODEL: z.string().default('claude-opus-5-5'),
  /** json: one JSON line per log entry, request IDs included (the default in production); text: Nest's own. */
  LOG_FORMAT: z.enum(['json', 'text']).optional(),
  /** Bearer token for GET /metrics. Unset, there is no metrics page. */
  METRICS_TOKEN: z.string().min(16, 'METRICS_TOKEN must be at least 16 characters').optional(),
  JOBS_LEASE_MS: z.coerce.number().int().min(50).default(5 * 60_000),
  /** Plan for organisations billing hasn't set one on (see src/plans/plans.ts). */
  DEFAULT_PLAN: z.enum(['FREE', 'TEAM', 'BUSINESS', 'ENTERPRISE']).default('FREE'),
  /**
   * Who may start a new organisation. `open`: anyone, by signing up. `closed`: only the operators below;
   * everyone else joins an organisation by invitation or single sign-on.
   */
  SIGNUP: z.enum(['open', 'closed']).default('open'),
  /** Email addresses of the people who run this installation (comma-separated): they may add organisations and choose their plan. */
  OPERATOR_EMAILS: z.string().default(''),
  /**
   * Customers deploying their own extensions by themselves (see extensions/extension-deploy.service.ts). All
   * three are set together, by an installation whose server runs the deploy service: the image store's address
   * (<account>.dkr.ecr.<region>.amazonaws.com), the role whose sessions hand out push passwords, and the kind
   * of machine the code runs on.
   */
  EXT_REGISTRY: z.string().regex(/^(\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com)?$/).default(''),
  EXT_PUSH_ROLE_ARN: z.string().default(''),
  EXT_PLATFORM: z.string().default('linux/arm64'),
  /** The build project (AWS CodeBuild) that builds customers' extensions from their own repositories; empty: not offered. */
  EXT_BUILD_PROJECT: z.string().regex(/^[A-Za-z0-9_-]{0,150}$/).default(''),
  /** Secure cookies (https only). Must be true outside local development. */
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type AppConfig = z.infer<typeof schema>;

/** Is this address one of the people who run the installation? */
export const isOperator = (config: Pick<AppConfig, 'OPERATOR_EMAILS'>, email: string | undefined) =>
  !!email && config.OPERATOR_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean).includes(email.trim().toLowerCase());
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
