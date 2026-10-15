import type { ConnectorRegistry } from './registry';
import { ConnectorError } from './registry';
import type { ConnectorRecord, OperationRequest } from './types';

/**
 * The gateway agent protocol. The agent runs inside the customer's network,
 * connects OUT to the API over TLS (WebSocket), and runs connector operations
 * there with credentials that never leave that network.
 */
export const GATEWAY_WS_PATH = '/gateway/connect';

export interface GatewayRequest {
  id: string;
  op: 'test' | 'discover' | 'run';
  /** Non-secret connector settings; `ref` names the credentials in the agent's local config. */
  connector: ConnectorRecord & { ref: string };
  request?: OperationRequest;
  /** The API request (or job) this call is part of: the agent names it when the call fails, to follow it end to end. */
  requestId?: string;
}

export type GatewayResponse = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string; code?: string };

/** Settings that decide where a connection goes; on a gateway they come only from the local credentials file. */
export const TARGET_KEYS = ['host', 'port', 'ssl', 'verifyCertificate', 'url', 'baseUrl', 'auth', 'apiKeyHeader', 'tokenUrl', 'instanceUrl', 'containerUrl', 'tenantId', 'link', 'spreadsheet'];

/** Agent side: run one request with local credentials. Errors keep only their kind (drivers echo secrets). */
export async function handleGatewayRequest(
  registry: ConnectorRegistry,
  secretsFor: (ref: string) => Record<string, string> | undefined,
  msg: GatewayRequest,
): Promise<GatewayResponse> {
  try {
    const local = secretsFor(msg.connector.ref);
    if (!local) return { id: msg.id, ok: false, error: `No credentials for connector ${msg.connector.ref} on this gateway`, code: 'UNKNOWN_CONNECTOR' };
    if (msg.connector.type.startsWith('aws-')) return { id: msg.id, ok: false, error: 'AWS connectors do not run through a gateway', code: 'UNSUPPORTED' };
    // Where the credentials go is decided here, never by the cloud: otherwise anyone who can edit the
    // connector could point it at their own server and receive the password (or probe the internal network).
    const settings: Record<string, unknown> = { ...msg.connector.settings };
    const secrets: Record<string, string> = {};
    for (const [k, v] of Object.entries(local)) (TARGET_KEYS.includes(k) ? settings : secrets)[k] = v;
    const unset = TARGET_KEYS.find((k) => msg.connector.settings[k] !== undefined && local[k] === undefined);
    if (unset) return { id: msg.id, ok: false, error: `Set "${unset}" for connector ${msg.connector.ref} in the gateway's connectors.json (connection targets come from the gateway)`, code: 'UNSUPPORTED' };
    // Inside the customer's network private addresses are the point.
    const base = { connector: { ...msg.connector, settings, allowedHosts: local.allowedHosts ? local.allowedHosts.split(',').map((h) => h.trim().toLowerCase()) : [] } as typeof msg.connector, secrets, allowPrivateNetwork: true };
    const plugin = registry.get(msg.connector.type);
    if (msg.op === 'test') return { id: msg.id, ok: true, result: await plugin.test({ ...base, signal: AbortSignal.timeout(15_000) }) };
    if (msg.op === 'discover') return { id: msg.id, ok: true, result: await plugin.discover({ ...base, signal: AbortSignal.timeout(30_000) }) };
    if (msg.op === 'run' && msg.request) return { id: msg.id, ok: true, result: await registry.run(base, msg.request) };
    return { id: msg.id, ok: false, error: 'Unknown operation' };
  } catch (e) {
    return e instanceof ConnectorError ? { id: msg.id, ok: false, error: e.message, code: e.code } : { id: msg.id, ok: false, error: 'The operation failed on the gateway', code: 'FAILED' };
  }
}
