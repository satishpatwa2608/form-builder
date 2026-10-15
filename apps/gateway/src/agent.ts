import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { defaultRegistry, GATEWAY_WS_PATH, handleGatewayRequest, type GatewayRequest } from '@fb/connectors';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import WebSocket from 'ws';

export const AGENT_VERSION = '0.1.0';

export interface AgentOptions {
  /** e.g. https://api.formbuilder.example */
  apiUrl: string;
  /** Where the gateway secret is kept (created on first registration, mode 0600). */
  secretFile: string;
  /** JSON: { "<connector ref>": { "uri": "...", "user": "...", ... } } - never sent anywhere. */
  credentialsFile: string;
  /** One-time registration token (first run only). */
  registrationToken?: string;
  /** Development only: allow http:// / ws://. */
  allowInsecure?: boolean;
  log?: (msg: string) => void;
  /** Called once the cloud has revoked this gateway and the agent has stopped for good. */
  onRevoked?: () => void;
}

export interface Agent {
  close(): void;
  /** Resolves when the first connection is open. */
  ready: Promise<void>;
}

function assertSecureUrl(url: string, allowInsecure?: boolean) {
  const u = new URL(url);
  if (u.protocol !== 'https:' && !allowInsecure) throw new Error('The API URL must use https (set FB_GATEWAY_ALLOW_INSECURE=true only for local development)');
  return u;
}

/** Plain node http(s), so the agent runs on any supported Node without fetch. */
function postJson(url: URL, payload: unknown): Promise<{ status: number; body: string }> {
  const data = JSON.stringify(payload);
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 15_000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c.length + body.length > 65_536 ? '' : c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('timeout', () => req.destroy(new Error('Registration timed out')));
    req.on('error', reject);
    req.end(data);
  });
}

/** First run: trade the one-time token for a secret, stored owner-only. */
async function ensureSecret(opts: AgentOptions): Promise<string> {
  if (existsSync(opts.secretFile)) return readFileSync(opts.secretFile, 'utf8').trim();
  if (!opts.registrationToken) throw new Error(`No gateway secret at ${opts.secretFile} and no registration token given`);
  const { status, body } = await postJson(new URL('/gateways/register', opts.apiUrl), { token: opts.registrationToken });
  if (status !== 200) throw new Error(`Registration failed (${status}) - ask for a new token`);
  const { secret } = JSON.parse(body) as { secret: string };
  writeFileSync(opts.secretFile, secret, { mode: 0o600 });
  chmodSync(opts.secretFile, 0o600);
  return secret;
}

function loadCredentials(file: string, log: (m: string) => void): Record<string, Record<string, string>> {
  if (!existsSync(file)) {
    log(`No credentials file at ${file}: every request will be refused`);
    return {};
  }
  if (process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0) log(`Warning: ${file} is readable by other users - chmod 600 it`);
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, string>>;
}

export async function startAgent(opts: AgentOptions): Promise<Agent> {
  const log = opts.log ?? ((m: string) => console.log(`[gateway] ${m}`));
  const base = assertSecureUrl(opts.apiUrl, opts.allowInsecure);
  const secret = await ensureSecret(opts);
  const registry = defaultRegistry();
  let stopped = false;
  let socket: WebSocket | undefined;
  let attempt = 0;
  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((r) => (markReady = r));

  const connect = () => {
    if (stopped) return;
    const wsUrl = new URL(GATEWAY_WS_PATH, base);
    wsUrl.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${secret}`, 'x-gateway-version': AGENT_VERSION }, maxPayload: 8 * 1024 * 1024 });
    socket = ws;
    ws.on('open', () => {
      attempt = 0;
      log('connected');
      markReady();
    });
    ws.on('message', (data) => {
      void (async () => {
        let msg: GatewayRequest;
        try {
          msg = JSON.parse(String(data)) as GatewayRequest;
        } catch {
          return;
        }
        // Re-read each time so credentials can be changed without a restart.
        const creds = loadCredentials(opts.credentialsFile, () => undefined);
        const reply = await handleGatewayRequest(registry, (ref) => creds[ref], msg);
        // Named by the API request it was part of, so it can be followed from the API's log to here.
        if (!reply.ok) log(`${msg.op} for ${msg.connector?.ref ?? '?'} failed: ${reply.error}${msg.requestId ? ` (request ${msg.requestId})` : ''}`);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
      })();
    });
    ws.on('close', (code) => {
      if (stopped) return;
      if (code === 4001) {
        log('this gateway was revoked - stopping');
        stopped = true;
        opts.onRevoked?.();
        return;
      }
      const wait = Math.min(30_000, 1000 * 2 ** attempt++);
      log(`disconnected (${code}); retrying in ${Math.round(wait / 1000)}s`);
      setTimeout(connect, wait);
    });
    ws.on('error', (e) => log(`connection error: ${e.message}`));
  };
  loadCredentials(opts.credentialsFile, log);
  connect();
  return {
    ready,
    close() {
      stopped = true;
      socket?.close(1000, 'Agent stopped');
    },
  };
}
