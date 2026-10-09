import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPrivateAddress } from '@fb/connectors';
import { createTransport } from 'nodemailer';
import { withName, type Mail } from '../common/mailer';

/** Why sending failed, in words an admin can act on. Never the server's own text. */
export class MailSendError extends Error {
  constructor(
    readonly reason: 'ADDRESS' | 'CONNECT' | 'SECURITY' | 'SIGN_IN' | 'REFUSED' | 'SETTINGS',
    message: string,
  ) {
    super(message);
  }
}

export interface SmtpSettings {
  host: string;
  port: number;
  security: 'STARTTLS' | 'TLS';
  username: string;
  password: string;
}
export interface MicrosoftSettings {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}
export interface Sender {
  from: string;
  fromName: string;
}

/** The ports mail is handed in on. Anything else is some other service. */
export const SMTP_PORTS = [25, 465, 587, 2525];
const TIMEOUT_MS = 20_000;

const fromHeader = (sender: Sender, mail: Mail) => withName(sender.from, mail.fromName || sender.fromName);

/**
 * Sends through the organisation's SMTP server. The server's name is looked
 * up here and the connection made to that address, so a name that points
 * inside our own network is refused and cannot be swapped between the check
 * and the connection. The connection is always encrypted and the server's
 * certificate always checked.
 */
export async function sendSmtp(smtp: SmtpSettings, sender: Sender, mail: Mail, opts: { insecure?: boolean } = {}): Promise<void> {
  const host = smtp.host.trim().toLowerCase();
  if (!opts.insecure && !SMTP_PORTS.includes(smtp.port)) throw new MailSendError('SETTINGS', `Port ${smtp.port} is not a mail port. Use 587, 465, 25 or 2525.`);
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new MailSendError('ADDRESS', `The mail server ${host} could not be found. Check its name.`);
  if (!opts.insecure && addresses.some(isPrivateAddress)) throw new MailSendError('ADDRESS', `${host} is a private address, which we cannot reach.`);
  const transport = createTransport({
    host: addresses[0],
    port: smtp.port,
    // TLS from the first byte, or upgraded before anything else is said.
    secure: smtp.security === 'TLS',
    requireTLS: smtp.security !== 'TLS',
    tls: { servername: isIP(host) ? undefined : host, rejectUnauthorized: !opts.insecure, minVersion: 'TLSv1.2' },
    auth: smtp.username ? { user: smtp.username, pass: smtp.password } : undefined,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
    // Nothing from a message may be read from our disk or fetched from the network.
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  try {
    await transport.sendMail({
      from: fromHeader(sender, mail),
      to: mail.to,
      subject: mail.subject.replace(/[\r\n]+/g, ' '),
      text: mail.text,
      ...(mail.html ? { html: mail.html } : {}),
      attachments: (mail.attachments ?? []).map((a) => ({ filename: a.fileName, contentType: a.contentType, content: a.content })),
    });
  } catch (e) {
    throw smtpError(e as { code?: string; responseCode?: number });
  } finally {
    transport.close();
  }
}

function smtpError(e: { code?: string; responseCode?: number }): MailSendError {
  if (e.code === 'EAUTH') return new MailSendError('SIGN_IN', 'The mail server refused the user name or password.');
  if (e.code === 'ETLS' || e.code === 'ESOCKET' || /CERT|TLS|SSL/.test(e.code ?? '')) return new MailSendError('SECURITY', "A secure connection to the mail server could not be made. Check the port and the kind of security, and that the server's certificate is valid.");
  if (e.code === 'ECONNECTION' || e.code === 'ETIMEDOUT' || e.code === 'ECONNREFUSED' || e.code === 'EDNS') return new MailSendError('CONNECT', 'The mail server did not answer. Check its name and port, and that it accepts connections from the internet.');
  if (e.code === 'EENVELOPE' || (e.responseCode ?? 0) >= 500) return new MailSendError('REFUSED', 'The mail server refused the message. Check that it allows sending from the address you gave.');
  return new MailSendError('REFUSED', 'The mail server did not accept the message.');
}

const tokens = new Map<string, { token: string; until: number }>();

/**
 * Sends through Microsoft 365 as an application (no person's password): it
 * signs in to the organisation's own Microsoft tenant with the application's
 * secret and sends from the mailbox given. Only Microsoft's addresses are called.
 */
export async function sendMicrosoft(ms: MicrosoftSettings, sender: Sender, mail: Mail, urls: { login: string; graph: string }): Promise<void> {
  const call = async (url: string, init: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' }).catch(() => null);
  const key = `${ms.tenantId}:${ms.clientId}:${ms.clientSecret.length}:${urls.login}`;
  let token = tokens.get(key);
  if (!token || token.until < Date.now()) {
    const res = await call(`${urls.login}/${encodeURIComponent(ms.tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: ms.clientId, client_secret: ms.clientSecret, scope: 'https://graph.microsoft.com/.default' }).toString(),
    });
    if (!res) throw new MailSendError('CONNECT', 'Microsoft 365 did not answer. Try again in a moment.');
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!res.ok || !body.access_token) throw new MailSendError('SIGN_IN', 'Microsoft 365 refused the directory (tenant) ID, application ID or secret.');
    token = { token: body.access_token, until: Date.now() + Math.max(60, (body.expires_in ?? 300) - 60) * 1000 };
    if (tokens.size > 500) tokens.clear();
    tokens.set(key, token);
  }
  const res = await call(`${urls.graph}/v1.0/users/${encodeURIComponent(sender.from)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: mail.subject.replace(/[\r\n]+/g, ' '),
        body: mail.html ? { contentType: 'HTML', content: mail.html } : { contentType: 'Text', content: mail.text },
        toRecipients: [{ emailAddress: { address: mail.to } }],
        attachments: (mail.attachments ?? []).map((a) => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.fileName, contentType: a.contentType, contentBytes: a.content.toString('base64') })),
      },
      saveToSentItems: true,
    }),
  });
  if (!res) throw new MailSendError('CONNECT', 'Microsoft 365 did not answer. Try again in a moment.');
  if (res.status === 401) tokens.delete(key);
  if (res.status === 401 || res.status === 403) throw new MailSendError('REFUSED', `Microsoft 365 did not let the application send from ${sender.from}. Give it the Mail.Send application permission, with admin consent.`);
  if (res.status === 404) throw new MailSendError('REFUSED', `Microsoft 365 has no mailbox ${sender.from}.`);
  if (res.status !== 202 && !res.ok) throw new MailSendError('REFUSED', 'Microsoft 365 did not accept the message.');
}
