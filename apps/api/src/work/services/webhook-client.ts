import { createHmac } from 'crypto';
import { WORKFLOW } from '../constants';

/** Hosts webhooks may call (https only). */
export function webhookAllowed(url: string): { ok: true; target: URL } | { ok: false; error: string } {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { ok: false, error: 'invalid URL' };
  }
  const allow = (process.env.FORM_WEBHOOK_ALLOWLIST ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (target.protocol !== 'https:') return { ok: false, error: 'webhooks must use https' };
  if (!allow.includes(target.hostname.toLowerCase())) return { ok: false, error: `${target.hostname} is not in FORM_WEBHOOK_ALLOWLIST` };
  return { ok: true, target };
}

/**
 * POST JSON to an allow-listed https URL. No redirects (they could point
 * anywhere), a short timeout, and an HMAC signature (`x-fb-signature:
 * sha256=...`) when a secret is given, so the receiver can trust the body.
 * Returns the reply as an object when it is a JSON object.
 */
export async function postWebhook(url: string, payload: unknown, secret?: string, key?: string): Promise<{ host: string; status: number; reply: Record<string, unknown> }> {
  const allowed = webhookAllowed(url);
  // `in` narrows under the API's non-strict config too.
  if ('error' in allowed) throw new Error(allowed.error);
  return postJson(allowed.target, payload, secret, key);
}

/**
 * The posting itself, to an address someone has already decided may be called.
 * An error names the host and the status only: the rest of the address can be a secret.
 *
 * `key` goes as the Idempotency-Key header: the same on every retry of one delivery, so a receiver that saw it
 * already can answer without doing the work twice.
 */
export async function postJson(target: URL, payload: unknown, secret?: string, key?: string): Promise<{ host: string; status: number; reply: Record<string, unknown> }> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'form-builder-webhook' };
  if (key) headers['idempotency-key'] = key;
  if (secret) headers['x-fb-signature'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const res = await fetch(target, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(WORKFLOW.webhookTimeoutMs) }).catch(() => {
    throw new Error(`${target.hostname} did not answer`);
  });
  if (!res.ok) throw new Error(`${target.hostname} answered ${res.status}`);
  const text = (await res.text()).slice(0, 64 * 1024);
  let reply: unknown;
  try {
    reply = text ? JSON.parse(text) : undefined;
  } catch {
    reply = undefined;
  }
  return {
    host: target.hostname,
    status: res.status,
    reply: reply && typeof reply === 'object' && !Array.isArray(reply) ? (reply as Record<string, unknown>) : {},
  };
}
