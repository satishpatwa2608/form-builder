import { Inject, Injectable } from '@nestjs/common';
import { MAILER, type Mailer, type MailAttachment } from '../../common/mailer';

/** Sangam's MailService call shape (`template` is HTML) over this product's mailer. */
@Injectable()
export class MailService {
  constructor(@Inject(MAILER) private readonly mailer: Mailer) {}

  async sendMail(mail: { to: string; subject: string; template: string; fromName?: string; attachments?: MailAttachment[]; [key: string]: unknown }): Promise<{ success: boolean; message?: string }> {
    const text = mail.template
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
    try {
      await this.mailer.send({ to: mail.to, subject: mail.subject, text, html: mail.template, fromName: mail.fromName, ...(mail.attachments?.length ? { attachments: mail.attachments } : {}) });
      return { success: true };
    } catch (e) {
      return { success: false, message: (e as Error).name };
    }
  }
}
