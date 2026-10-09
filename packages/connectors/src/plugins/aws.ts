import { filesFor } from './microsoft';
import { CloudWatchLogsClient, CreateLogStreamCommand, PutLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { z } from 'zod';
import { ConnectorError } from '../registry';
import type { ConnectorContext, ConnectorPlugin } from '../types';
import { elapsed, now } from './shared';

/**
 * AWS connectors reach the customer's account through a role they create for
 * us, with an external ID (the confused-deputy guard) - never access keys.
 */
const roleSettings = {
  region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/),
  roleArn: z.string().regex(/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]{1,128}$/, 'An IAM role ARN'),
  externalId: z.string().min(8).max(128),
};

export interface AwsClients {
  sts: () => STSClient;
}

let makeSts = (region: string) => new STSClient({ region });
/** Tests swap the STS client. */
export const setStsFactory = (f: (region: string) => STSClient) => {
  makeSts = f;
};

async function credentials(ctx: ConnectorContext) {
  const s = ctx.connector.settings;
  const out = await makeSts(String(s.region)).send(
    new AssumeRoleCommand({ RoleArn: String(s.roleArn), ExternalId: String(s.externalId), RoleSessionName: `form-builder-${ctx.connector.id}`.slice(0, 64), DurationSeconds: 900 }),
    { abortSignal: ctx.signal },
  );
  const c = out.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey) throw new ConnectorError('FAILED', 'Could not assume the role');
  return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken };
}

let makeS3 = (region: string, creds: Awaited<ReturnType<typeof credentials>>) => new S3Client({ region, credentials: creds });
let makeLogs = (region: string, creds: Awaited<ReturnType<typeof credentials>>) => new CloudWatchLogsClient({ region, credentials: creds });
export const setAwsFactories = (f: { s3?: typeof makeS3; logs?: typeof makeLogs }) => {
  if (f.s3) makeS3 = f.s3;
  if (f.logs) makeLogs = f.logs;
};

/** Object keys: safe characters only, and no empty, "." or ".." path segments. */
const safeKey = (s: string) =>
  s
    .replace(/[^A-Za-z0-9._/-]+/g, '_')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/')
    .slice(0, 300);

/** Save form data as JSON objects in the customer's bucket (e.g. an archive of submissions). */
export const s3Plugin: ConnectorPlugin = {
  type: 'aws-s3',
  label: 'Amazon S3',
  settingsSchema: z.object({ ...roleSettings, bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/), prefix: z.string().max(200).optional() }),
  secretsSchema: z.object({}),
  operations: ['list', 'upload'],

  async test(ctx) {
    const start = now();
    const s = ctx.connector.settings;
    await makeS3(String(s.region), await credentials(ctx)).send(new ListObjectsV2Command({ Bucket: String(s.bucket), Prefix: String(s.prefix ?? ''), MaxKeys: 1 }), { abortSignal: ctx.signal });
    return { ok: true, message: `Reached ${String(s.bucket)}`, latencyMs: elapsed(start) };
  },

  async discover(ctx) {
    return [{ key: 'objects', label: `Objects in ${String(ctx.connector.settings.bucket)}`, fields: [{ name: 'key', type: 'string' }, { name: 'size', type: 'number' }] }];
  },

  async run(ctx, req) {
    const start = now();
    const s = ctx.connector.settings;
    const client = makeS3(String(s.region), await credentials(ctx));
    const prefix = s.prefix ? `${safeKey(String(s.prefix))}/` : '';
    if (req.kind === 'list') {
      const out = await client.send(new ListObjectsV2Command({ Bucket: String(s.bucket), Prefix: prefix, MaxKeys: Math.min(req.limits.maxRows, 1000) }), { abortSignal: ctx.signal });
      return { rows: (out.Contents ?? []).map((o) => ({ key: o.Key, size: o.Size })), durationMs: elapsed(start) };
    }
    if (req.kind === 'upload') {
      // The same files, under the same names, as every other place a response can be saved:
      // its answers, its PDF, and what the respondent uploaded.
      const saved: string[] = [];
      for (const f of filesFor(req.params)) {
        const key = `${prefix}${safeKey(f.name)}`;
        await client.send(new PutObjectCommand({ Bucket: String(s.bucket), Key: key, Body: f.body, ContentType: f.type, ServerSideEncryption: 'AES256' }), { abortSignal: ctx.signal });
        saved.push(key);
      }
      return { rows: [{ key: saved[0], id: saved[0], files: saved.join(', ') }], affected: saved.length, durationMs: elapsed(start) };
    }
    throw new ConnectorError('UNSUPPORTED', `S3 can't ${req.kind}`);
  },
};

/** Send form events into the customer's log group (one stream per day). */
export const cloudWatchPlugin: ConnectorPlugin = {
  type: 'aws-cloudwatch',
  label: 'Amazon CloudWatch Logs',
  settingsSchema: z.object({ ...roleSettings, logGroup: z.string().regex(/^[\w#/.-]{1,512}$/) }),
  secretsSchema: z.object({}),
  operations: ['log'],

  async test(ctx) {
    const start = now();
    await credentials(ctx);
    return { ok: true, message: 'Role assumed', latencyMs: elapsed(start) };
  },

  async discover(ctx) {
    return [{ key: 'events', label: `Log group ${String(ctx.connector.settings.logGroup)}`, fields: [{ name: 'message', type: 'string' }] }];
  },

  async run(ctx, req) {
    const start = now();
    if (req.kind !== 'log') throw new ConnectorError('UNSUPPORTED', `CloudWatch can't ${req.kind}`);
    const s = ctx.connector.settings;
    const client = makeLogs(String(s.region), await credentials(ctx));
    const stream = `form-builder-${new Date().toISOString().slice(0, 10)}`;
    await client.send(new CreateLogStreamCommand({ logGroupName: String(s.logGroup), logStreamName: stream }), { abortSignal: ctx.signal }).catch((e: Error) => {
      if (e.name !== 'ResourceAlreadyExistsException') throw e;
    });
    await client.send(
      new PutLogEventsCommand({ logGroupName: String(s.logGroup), logStreamName: stream, logEvents: [{ timestamp: Date.now(), message: JSON.stringify(req.params).slice(0, 200_000) }] }),
      { abortSignal: ctx.signal },
    );
    return { rows: [], affected: 1, durationMs: elapsed(start) };
  },
};
