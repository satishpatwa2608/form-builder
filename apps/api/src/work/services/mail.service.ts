import { Injectable } from '@nestjs/common';
import type { MailAttachment } from '../../common/mailer';
import { OrgMailService } from '../../mail/org-mail.service';
import { MailSendError } from '../../mail/transports';

/**
 * Sangam's MailService call shape (`template` is HTML) over this product's mail. These are emails to the people
 * who fill in forms, so they go through the organisation's own mail server when it has one in use.
 */
@Injectable()
export class MailService {
  constructor(private readonly mail: OrgMailService) {}

  async sendMail(mail: { to: string; subject: string; template: string; orgId?: string; fromName?: string; attachments?: MailAttachment[]; [key: string]: unknown }): Promise<{ success: boolean; message?: string }> {
    const text = mail.template
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
    try {
      await this.mail.send(mail.orgId, { to: mail.to, subject: mail.subject, text, html: mail.template, fromName: mail.fromName, ...(mail.attachments?.length ? { attachments: mail.attachments } : {}) });
      return { success: true };
    } catch (e) {
      return { success: false, message: e instanceof MailSendError ? e.message : (e as Error).name };
    }
  }
}
