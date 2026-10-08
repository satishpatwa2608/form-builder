import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConnectorRegistry, handleGatewayRequest, HARD_LIMITS, type ConnectorPlugin, type ConnectorRecord } from '../src';

const connector: ConnectorRecord = { id: 'c1', orgId: 'o1', type: 'postgres', name: 'Sales DB', settings: {}, secretRef: 'kms:1', writable: false };
const secrets = { password: 's3cret-pass' };

function plugin(run: ConnectorPlugin['run']): ConnectorPlugin {
  return {
    type: 'postgres',
    label: 'PostgreSQL',
    settingsSchema: z.object({}),
    secretsSchema: z.object({}),
    operations: ['list', 'insert'],
    test: async () => ({ ok: true, message: 'ok' }),
    discover: async () => [],
    run,
  };
}
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));

describe('ConnectorRegistry', () => {
  it('runs a read and clamps limits to the hard caps', async () => {
    let seen = 0;
    const reg = new ConnectorRegistry().register(
      plugin(async (_ctx, req) => {
        seen = req.limits.maxRows;
        return { rows: rows(10_000), durationMs: 1 };
      }),
    );
    const res = await reg.run({ connector, secrets }, { entity: { key: 'customers', fields: [] }, kind: 'list', params: {}, limits: { timeoutMs: 999_999, maxRows: 999_999 } });
    expect(seen).toBe(HARD_LIMITS.maxRows);
    expect(res.rows).toHaveLength(HARD_LIMITS.maxRows);
  });

  it('refuses writes on a read-only connector and unsupported operations', async () => {
    const reg = new ConnectorRegistry().register(plugin(async () => ({ rows: [], durationMs: 1 })));
    await expect(reg.run({ connector, secrets }, { entity: { key: 't', fields: [] }, kind: 'insert', params: {}, limits: { timeoutMs: 100, maxRows: 1 } })).rejects.toMatchObject({ code: 'READ_ONLY' });
    await expect(reg.run({ connector, secrets }, { entity: { key: 't', fields: [] }, kind: 'update', params: {}, limits: { timeoutMs: 100, maxRows: 1 } })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('never leaks the driver error (it may contain credentials)', async () => {
    const reg = new ConnectorRegistry().register(
      plugin(async (ctx) => {
        throw new Error(`connect failed: postgres://app:${ctx.secrets.password}@db`);
      }),
    );
    const err = await reg.run({ connector, secrets }, { entity: { key: 'customers', fields: [] }, kind: 'list', params: {}, limits: { timeoutMs: 100, maxRows: 1 } }).catch((e) => e);
    expect(err.code).toBe('FAILED');
    expect(String(err.message)).not.toContain('s3cret-pass');
  });

  it('times out slow calls and aborts the plugin', async () => {
    let aborted = false;
    const reg = new ConnectorRegistry().register(
      plugin(
        (ctx) =>
          new Promise((resolve) => {
            ctx.signal.addEventListener('abort', () => {
              aborted = true;
              resolve({ rows: [], durationMs: 0 });
            });
          }),
      ),
    );
    await expect(reg.run({ connector, secrets }, { entity: { key: 't', fields: [] }, kind: 'list', params: {}, limits: { timeoutMs: 20, maxRows: 1 } })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(aborted).toBe(true);
  });
});

describe('gateway agent', () => {
  const seen: { settings?: Record<string, unknown>; secrets?: Record<string, string> } = {};
  const reg = new ConnectorRegistry().register({
    ...plugin(async () => ({ rows: [], durationMs: 1 })),
    test: async (ctx) => {
      seen.settings = ctx.connector.settings;
      seen.secrets = ctx.secrets;
      return { ok: true, message: 'ok' };
    },
  });
  const msg = (settings: Record<string, string | number | boolean>) => ({ id: 'm1', op: 'test' as const, connector: { ...connector, ref: 'abc123', settings } });

  it('takes the connection target from its own file, never from the cloud', async () => {
    // Someone edited the connector in the cloud to point at their server: refused, the password is never used.
    const refused = await handleGatewayRequest(reg, () => ({ password: 'p' }), msg({ host: 'attacker.example', database: 'erp' }));
    expect(refused).toMatchObject({ ok: false, code: 'UNSUPPORTED' });
    expect(seen.secrets).toBeUndefined();

    const ok = await handleGatewayRequest(reg, () => ({ host: 'db.internal', port: '5432', password: 'p' }), msg({ host: 'attacker.example', database: 'erp' }));
    expect(ok).toMatchObject({ ok: true });
    expect(seen.settings).toMatchObject({ host: 'db.internal', port: '5432', database: 'erp' });
    expect(seen.secrets).toEqual({ password: 'p' });
  });
});
