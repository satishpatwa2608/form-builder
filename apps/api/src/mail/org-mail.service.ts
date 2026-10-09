import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { actorOf, AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import { User, type UserDocument } from '../auth/auth.schemas';
import { SecretBox } from '../common/crypto';
import { MAILER, type Mail, type Mailer } from '../common/mailer';
import { APP_CONFIG, type AppConfig } from '../config';
import { Organization, type OrganizationDocument } from '../orgs/org.schemas';
import { MailSendError, sendMicrosoft, sendSmtp, SMTP_PORTS, type MicrosoftSettings, type SmtpSettings } from './transports';

export interface OrgMailInput {
  provider?: 'DEFAULT' | 'SMTP' | 'MICROSOFT';
  from?: string;
  fromName?: string;
  smtp?: { host?: string; port?: number; security?: 'STARTTLS' | 'TLS'; username?: string; password?: string };
  microsoft?: { tenantId?: string; clientId?: string; clientSecret?: string };
}

const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[^\s@<>"]{2,}$/;
const HOST = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const GUID_OR_DOMAIN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|([a-z0-9-]+\.)+[a-z]{2,63})$/i;
const fault = (field: string, message: string) => new BadRequestException({ message, errors: [{ field, message }] });

/**
 * An organisation's own mail server for the emails that go to the people who
 * fill in its forms: workflow emails, messages to a requester, signing
 * invitations and portal links. Our own emails to its staff (invitations,
 * password resets, notifications) keep going out from us.
 *
 * It is used only after a test email has gone through with the settings as
 * they stand, and a failure is reported, never papered over by sending from
 * our address instead: the sender would not be the one people expect.
 */
@Injectable()
export class OrgMailService {
  private readonly logger = new Logger('OrgMail');
  private readonly box: SecretBox;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MAILER) private readonly ours: Mailer,
    private readonly audit: AuditService,
    @InjectModel(Organization.name) private readonly orgs: Model<OrganizationDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
  ) {
    this.box = new SecretBox(Buffer.from(config.SECRET_KEY, 'base64'));
  }

  /** Development and tests only: a mail server on this machine, with a certificate nobody vouches for. */
  private get insecure() {
    return this.config.NODE_ENV !== 'production' && process.env.MAIL_ALLOW_INSECURE === 'true';
  }

  private get microsoftUrls() {
    const test = this.config.NODE_ENV !== 'production';
    return { login: (test && process.env.MAIL_MICROSOFT_LOGIN_URL) || 'https://login.microsoftonline.com', graph: (test && process.env.MAIL_MICROSOFT_GRAPH_URL) || 'https://graph.microsoft.com' };
  }

  async settings(auth: AuthContext) {
    const m = (await this.orgs.findOne({ id: auth.orgId }).select('mail').lean())?.mail;
    return {
      provider: m?.provider ?? 'DEFAULT',
      enabled: !!m?.enabled,
      from: m?.from ?? '',
      fromName: m?.fromName ?? '',
      smtp: { host: m?.smtp?.host ?? '', port: m?.smtp?.port ?? 587, security: m?.smtp?.security ?? 'STARTTLS', username: m?.smtp?.username ?? '', passwordSet: !!m?.smtp?.password },
      microsoft: { tenantId: m?.microsoft?.tenantId ?? '', clientId: m?.microsoft?.clientId ?? '', clientSecretSet: !!m?.microsoft?.clientSecret },
      testedAt: m?.testedAt ?? null,
      lastError: m?.lastError ?? '',
      lastErrorAt: m?.lastErrorAt ?? null,
    };
  }

  /** Saves the settings. Any change means they are untested again, so they stop being used until a test passes. */
  async update(auth: AuthContext, body: OrgMailInput) {
    const org = await this.orgs.findOne({ id: auth.orgId });
    if (!org) throw new NotFoundException('Organisation not found');
    const m = org.mail ?? ({} as OrganizationDocument['mail']);
    if (body.provider !== undefined) org.set('mail.provider', body.provider);
    if (body.from !== undefined) {
      const from = body.from.trim().toLowerCase();
      if (from && !EMAIL.test(from)) throw fault('from', 'Enter the address the emails are sent from');
      org.set('mail.from', from);
    }
    if (body.fromName !== undefined) org.set('mail.fromName', body.fromName.replace(/["<>\r\n]/g, '').trim().slice(0, 60));
    if (body.smtp) {
      const smtp = { ...(m.smtp ?? {}) };
      if (body.smtp.host !== undefined) {
        const host = body.smtp.host.trim().toLowerCase();
        if (host && !HOST.test(host) && !this.insecure) throw fault('smtp.host', "Enter the mail server's name, for example smtp.yourcompany.com");
        smtp.host = host;
      }
      if (body.smtp.port !== undefined) {
        if (!this.insecure && !SMTP_PORTS.includes(body.smtp.port)) throw fault('smtp.port', 'Use 587, 465, 25 or 2525');
        smtp.port = body.smtp.port;
      }
      if (body.smtp.security !== undefined) smtp.security = body.smtp.security;
      if (body.smtp.username !== undefined) smtp.username = body.smtp.username.trim().slice(0, 320);
      if (body.smtp.password) smtp.password = this.box.seal(body.smtp.password);
      org.set('mail.smtp', smtp);
    }
    if (body.microsoft) {
      const ms = { ...(m.microsoft ?? {}) };
      if (body.microsoft.tenantId !== undefined) {
        const tenantId = body.microsoft.tenantId.trim();
        if (tenantId && !GUID_OR_DOMAIN.test(tenantId)) throw fault('microsoft.tenantId', 'Enter the directory (tenant) ID from Microsoft Entra');
        ms.tenantId = tenantId;
      }
      if (body.microsoft.clientId !== undefined) ms.clientId = body.microsoft.clientId.trim().slice(0, 100);
      if (body.microsoft.clientSecret) ms.clientSecret = this.box.seal(body.microsoft.clientSecret);
      org.set('mail.microsoft', ms);
    }
    org.set({ 'mail.enabled': false, 'mail.testedAt': null, 'mail.lastError': '', 'mail.lastErrorAt': null });
    await org.save();
    await this.audit.record(actorOf(auth), {
      action: 'org.mail_updated',
      targetType: 'organization',
      targetId: auth.orgId,
      after: { provider: org.mail.provider, from: org.mail.from, host: org.mail.smtp?.host ?? '', secretChanged: !!(body.smtp?.password || body.microsoft?.clientSecret) },
    });
    return this.settings(auth);
  }

  private ready(m: OrganizationDocument['mail'] | undefined): { smtp?: SmtpSettings; microsoft?: MicrosoftSettings } {
    if (!m || m.provider === 'DEFAULT') throw new BadRequestException('Choose your mail server first');
    if (!m.from) throw fault('from', 'Enter the address the emails are sent from');
    if (m.provider === 'SMTP') {
      if (!m.smtp?.host) throw fault('smtp.host', "Enter the mail server's name");
      return { smtp: { host: m.smtp.host, port: m.smtp.port ?? 587, security: m.smtp.security ?? 'STARTTLS', username: m.smtp.username ?? '', password: m.smtp.password ? this.box.open(m.smtp.password) : '' } };
    }
    if (!m.microsoft?.tenantId || !m.microsoft.clientId || !m.microsoft.clientSecret) throw new BadRequestException('Enter the directory (tenant) ID, application ID and secret first');
    return { microsoft: { tenantId: m.microsoft.tenantId, clientId: m.microsoft.clientId, clientSecret: this.box.open(m.microsoft.clientSecret) } };
  }

  private async through(m: OrganizationDocument['mail'], orgName: string, mail: Mail) {
    const how = this.ready(m);
    const sender = { from: m.from, fromName: m.fromName || orgName };
    if (how.smtp) await sendSmtp(how.smtp, sender, mail, { insecure: this.insecure });
    else await sendMicrosoft(how.microsoft!, sender, mail, this.microsoftUrls);
  }

  /** Sends a test to the admin's own address through the saved settings; only a pass lets them be switched on. */
  async test(auth: AuthContext) {
    const org = await this.orgs.findOne({ id: auth.orgId });
    if (!org) throw new NotFoundException('Organisation not found');
    const me = await this.users.findOne({ id: auth.userId }).select('email').lean();
    if (!me?.email) throw new BadRequestException('Your account has no email address to send the test to');
    try {
      await this.through(org.mail, org.name, {
        to: me.email,
        subject: `Test email from ${org.name}`,
        text: `This is a test from Form Builder, sent through ${org.name}'s own mail server.\n\nIf you are reading it, the settings work. Go back to Organisation settings and switch it on.`,
      });
    } catch (e) {
      if (!(e instanceof MailSendError)) throw e;
      org.set({ 'mail.testedAt': null, 'mail.enabled': false, 'mail.lastError': e.message, 'mail.lastErrorAt': new Date() });
      await org.save();
      throw new BadRequestException(e.message);
    }
    org.set({ 'mail.testedAt': new Date(), 'mail.lastError': '', 'mail.lastErrorAt': null });
    await org.save();
    return { ...(await this.settings(auth)), sentTo: me.email };
  }

  async use(auth: AuthContext, on: boolean) {
    const org = await this.orgs.findOne({ id: auth.orgId });
    if (!org) throw new NotFoundException('Organisation not found');
    if (on) {
      this.ready(org.mail);
      if (!org.mail.testedAt) throw new BadRequestException('Send yourself a test email first, so a mistake in the settings cannot stop your emails');
    }
    org.set('mail.enabled', on);
    await org.save();
    await this.audit.record(actorOf(auth), { action: on ? 'org.mail_enabled' : 'org.mail_disabled', targetType: 'organization', targetId: auth.orgId });
    return this.settings(auth);
  }

  /**
   * An email to someone outside, on this organisation's behalf: through its
   * own mail server when it has one in use, otherwise from us.
   */
  async send(orgId: string | undefined, mail: Mail): Promise<void> {
    const org = orgId ? await this.orgs.findOne({ id: orgId }).select('name mail').lean() : null;
    if (!org?.mail?.enabled || org.mail.provider === 'DEFAULT') return this.ours.send(mail);
    try {
      await this.through(org.mail as OrganizationDocument['mail'], org.name, mail);
    } catch (e) {
      const message = e instanceof MailSendError ? e.message : 'The mail server could not be used.';
      // Shown to the admin on the settings card. Never the message itself, which carries single-use links.
      await this.orgs.updateOne({ id: orgId }, { $set: { 'mail.lastError': message, 'mail.lastErrorAt': new Date() } }).catch(() => undefined);
      this.logger.warn(`own mail failed for org ${orgId}: ${e instanceof MailSendError ? e.reason : (e as Error).name}`);
      throw e instanceof MailSendError ? e : new Error('own mail failed');
    }
  }
}
