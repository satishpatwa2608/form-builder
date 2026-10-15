import { BadRequestException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { safeFetch } from '@fb/connectors';
import type { Model } from 'mongoose';
import { actorOf, AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import { SecretBox } from '../common/crypto';
import { APP_CONFIG, type AppConfig } from '../config';
import { orgLog } from '../logs/org-log';
import { Organization, type OrganizationDocument } from '../orgs/org.schemas';

export interface SmsSettings {
  /** Where the organisation's text-message service is called. May itself contain {{to}} and {{message}}. */
  url?: string;
  method?: 'POST' | 'GET';
  /** How the body is sent. */
  format?: 'JSON' | 'FORM';
  /** What is sent, with {{to}} and {{message}} where the number and the text go. */
  body?: string;
  /** Up to three headers; values are kept sealed and never shown again. */
  headers?: { name: string; value?: string }[];
  enabled?: boolean;
  testedAt?: Date | null;
  lastError?: string;
}
export interface SmsInput {
  url?: string;
  method?: 'POST' | 'GET';
  format?: 'JSON' | 'FORM';
  body?: string;
  headers?: { name: string; value?: string }[];
}

const HEADER = /^[A-Za-z0-9-]{1,60}$/;
const FORBIDDEN = new Set(['host', 'content-length', 'transfer-encoding', 'connection']);
const PHONE = /^\+?[0-9]{7,15}$/;
const fault = (field: string, message: string) => new BadRequestException({ message, errors: [{ field, message }] });

/** The organisation's text-message service, or its WhatsApp one: the same kind of settings, kept apart. */
export type MessageChannel = 'sms' | 'whatsapp';
const SERVICE: Record<MessageChannel, string> = { sms: 'SMS service', whatsapp: 'WhatsApp service' };
export const DEFAULT_SMS_BODY = '{"to":"{{to}}","message":"{{message}}"}';

/** {{to}} and {{message}} put into a template, each written the way the surrounding text needs (inside JSON, or in an address). */
export function fillSms(template: string, to: string, message: string, as: 'JSON' | 'URL'): string {
  const write = (v: string) => (as === 'JSON' ? JSON.stringify(v).slice(1, -1) : encodeURIComponent(v));
  return template.replace(/\{\{\s*to\s*\}\}/g, write(to)).replace(/\{\{\s*message\s*\}\}/g, write(message));
}

/**
 * Text messages through the organisation's own SMS service, whichever it is: the organisation says where to
 * call it and what to send, the way that service's own documentation describes. We send nothing by SMS ourselves.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger('Sms');
  private readonly box: SecretBox;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
    @InjectModel(Organization.name) private readonly orgs: Model<OrganizationDocument>,
  ) {
    this.box = new SecretBox(Buffer.from(config.SECRET_KEY, 'base64'));
  }

  private view(s: SmsSettings | undefined) {
    return {
      url: s?.url ?? '',
      method: s?.method ?? 'POST',
      format: s?.format ?? 'JSON',
      body: s?.body ?? DEFAULT_SMS_BODY,
      headers: (s?.headers ?? []).map((h) => ({ name: h.name, valueSet: !!h.value })),
      enabled: !!s?.enabled,
      testedAt: s?.testedAt ?? null,
      lastError: s?.lastError ?? '',
    };
  }

  private async stored(orgId: string, channel: MessageChannel): Promise<SmsSettings | undefined> {
    return ((await this.orgs.findOne({ id: orgId }).select(channel).lean()) as Record<string, unknown> | null)?.[channel] as SmsSettings | undefined;
  }

  async settings(auth: AuthContext, channel: MessageChannel = 'sms') {
    return this.view(await this.stored(auth.orgId, channel));
  }

  /** Whether forms of this organisation can send a code to a phone. */
  async ready(orgId: string, channel: MessageChannel = 'sms') {
    return !!(await this.stored(orgId, channel))?.enabled;
  }

  /** Saves the settings. Any change means they are untested again, so they stop being used until a test passes. */
  async update(auth: AuthContext, input: SmsInput, channel: MessageChannel = 'sms') {
    const org = await this.orgs.findOne({ id: auth.orgId });
    if (!org) throw new NotFoundException('Organisation not found');
    const now = ((org.get(channel) as SmsSettings | undefined) ?? {}) as SmsSettings;
    const next: SmsSettings = { ...now };
    if (input.url !== undefined) {
      const url = input.url.trim();
      if (url) {
        let parsed: URL | undefined;
        try {
          parsed = new URL(url.replace(/\{\{\s*(to|message)\s*\}\}/g, 'x'));
        } catch {
          parsed = undefined;
        }
        if (!parsed || !(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && this.privateAllowed)) || parsed.username || parsed.password) throw fault('url', `Enter the https:// address your ${SERVICE[channel]} is called at`);
      }
      next.url = url.slice(0, 1000);
    }
    if (input.method !== undefined) next.method = input.method;
    if (input.format !== undefined) next.format = input.format;
    if (input.body !== undefined) next.body = input.body.slice(0, 4000);
    if (input.headers !== undefined) {
      if (input.headers.length > 3) throw fault('headers', 'Up to three headers');
      next.headers = input.headers
        .filter((h) => h.name.trim())
        .map((h) => {
          const name = h.name.trim();
          if (!HEADER.test(name) || FORBIDDEN.has(name.toLowerCase())) throw fault('headers', `"${name}" cannot be used as a header`);
          // A value left empty keeps the one already saved under that name.
          const kept = (now.headers ?? []).find((o) => o.name.toLowerCase() === name.toLowerCase())?.value;
          const value = h.value ? this.box.seal(h.value.replace(/[\r\n]/g, '').slice(0, 2000)) : kept;
          return { name, value };
        });
    }
    Object.assign(next, { enabled: false, testedAt: null, lastError: '' });
    org.set(channel, next);
    org.markModified(channel);
    await org.save();
    await this.audit.record(actorOf(auth), { action: `org.${channel}_updated`, targetType: 'organization', targetId: auth.orgId, after: { url: (next.url ?? '').split('?')[0], method: next.method ?? 'POST', headers: (next.headers ?? []).map((h) => h.name) } });
    return this.view(next);
  }

  private get privateAllowed() {
    return this.config.NODE_ENV !== 'production' && process.env.SMS_ALLOW_PRIVATE === 'true';
  }

  private async deliver(s: SmsSettings, to: string, message: string, channel: MessageChannel = 'sms') {
    if (!s.url) throw new BadRequestException(`Enter the address your ${SERVICE[channel]} is called at first`);
    const method = s.method ?? 'POST';
    const format = s.format ?? 'JSON';
    const headers: Record<string, string> = {};
    for (const h of s.headers ?? []) if (h.value) headers[h.name] = this.box.open(h.value);
    const init: RequestInit = { method, headers };
    if (method === 'POST') {
      headers['Content-Type'] ??= format === 'JSON' ? 'application/json' : 'application/x-www-form-urlencoded';
      init.body = fillSms(s.body ?? DEFAULT_SMS_BODY, to, message, format === 'JSON' ? 'JSON' : 'URL');
    }
    const res = await safeFetch({ connector: { allowedHosts: [] } as never, secrets: {}, signal: AbortSignal.timeout(10_000), allowPrivateNetwork: this.privateAllowed }, fillSms(s.url, to, message, 'URL'), init);
    if (res.status < 200 || res.status >= 300) throw new Error(`Your ${SERVICE[channel]} answered ${res.status}${res.text ? `: ${res.text.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
  }

  /** Sends a test message with the settings as they stand; when it goes through, the settings start being used. */
  async test(auth: AuthContext, to: string, channel: MessageChannel = 'sms') {
    const number = to.replace(/[\s()-]/g, '');
    if (!PHONE.test(number)) throw fault('to', 'Enter a mobile number with its country code, for example +919812345678');
    const org = await this.orgs.findOne({ id: auth.orgId });
    if (!org) throw new NotFoundException('Organisation not found');
    const s = ((org.get(channel) as SmsSettings | undefined) ?? {}) as SmsSettings;
    try {
      await this.deliver(s, number, `This is a test message from Form Builder. Your ${channel === 'sms' ? 'SMS' : 'WhatsApp'} settings work.`, channel);
      org.set(channel, { ...s, enabled: true, testedAt: new Date(), lastError: '' });
    } catch (e) {
      const message = e instanceof BadRequestException ? e.message : (e as Error).message.slice(0, 300);
      org.set(channel, { ...s, enabled: false, testedAt: null, lastError: message });
    }
    org.markModified(channel);
    await org.save();
    await this.audit.record(actorOf(auth), { action: `org.${channel}_tested`, targetType: 'organization', targetId: auth.orgId, after: { ok: !!(org.get(channel) as SmsSettings).enabled } });
    return this.view(org.get(channel) as SmsSettings);
  }

  /**
   * A message from an automation step. Throws with the reason, in words for the record's timeline: not set up,
   * or what the service answered.
   */
  async sendFromStep(orgId: string, to: string, message: string, channel: MessageChannel) {
    const number = to.replace(/[\s()-]/g, '');
    if (!PHONE.test(number)) throw new Error(`"${to.slice(0, 30)}" is not a phone number with its country code`);
    const s = await this.stored(orgId, channel);
    if (!s?.enabled) throw new Error(`the organisation's ${SERVICE[channel]} is not set up and tested yet (Organisation settings)`);
    try {
      await this.deliver(s, number, message.slice(0, 1000), channel);
      orgLog.info(orgId, 'mail', channel === 'sms' ? 'Text message sent' : 'WhatsApp message sent', { to: `…${number.slice(-4)}` });
    } catch (e) {
      const why = (e as Error).message.slice(0, 300);
      orgLog.error(orgId, 'mail', `${channel === 'sms' ? 'Text' : 'WhatsApp'} message not sent: ${why}`, { to: `…${number.slice(-4)}` });
      await this.orgs.updateOne({ id: orgId }, { $set: { [`${channel}.lastError`]: why } });
      throw new Error(why);
    }
  }

  /** A message to someone filling in a form. Fails loudly: a code that did not go out must not look as if it did. */
  async send(orgId: string, to: string, message: string) {
    const s = (await this.orgs.findOne({ id: orgId }).select('sms').lean())?.sms as SmsSettings | undefined;
    if (!s?.enabled) throw new ServiceUnavailableException('This form cannot send text messages yet. Please tell the organisation that sent you here.');
    try {
      await this.deliver(s, to, message);
      orgLog.info(orgId, 'mail', 'Text message sent', { to: `…${to.slice(-4)}` });
    } catch (e) {
      const why = (e as Error).message.slice(0, 300);
      this.logger.warn(`sms for ${orgId} failed: ${why}`);
      orgLog.error(orgId, 'mail', `Text message not sent: ${why}`, { to: `…${to.slice(-4)}` });
      await this.orgs.updateOne({ id: orgId }, { $set: { 'sms.lastError': why } });
      throw new ServiceUnavailableException('The text message could not be sent. Try again in a moment.');
    }
  }
}
