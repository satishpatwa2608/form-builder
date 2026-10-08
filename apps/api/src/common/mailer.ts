import { Injectable, Logger } from '@nestjs/common';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  /** Optional HTML version (always built from escaped text by the caller). */
  html?: string;
  /** Display name for the sender, e.g. the colleague writing to a requester. */
  fromName?: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}
export const MAILER = Symbol('MAILER');

/** Development only: prints mail to the log. SES replaces it (Phase 1a infra). */
@Injectable()
export class ConsoleMailer implements Mailer {
  private readonly logger = new Logger('Mail');
  async send(mail: Mail) {
    this.logger.log(`to=${mail.to} subject="${mail.subject}"\n${mail.text}`);
  }
}

/** "Form Builder <no-reply@x>" + "Asha Rao" -> "Asha Rao <no-reply@x>" (quotes and angle brackets stripped from the name). */
export function withName(from: string, name: string): string {
  const address = from.match(/<([^>]+)>/)?.[1] ?? from.trim();
  const clean = name.replace(/["<>\r\n]/g, '').trim().slice(0, 60);
  return clean ? `"${clean}" <${address}>` : from;
}

/** Amazon SES (v2). Plain-text mail for now; HTML templates come with branding (Phase 3). */
export class SesMailer implements Mailer {
  private readonly logger = new Logger('Mail');

  constructor(
    private readonly from: string,
    private readonly client: Pick<SESv2Client, 'send'>,
  ) {}

  async send(mail: Mail) {
    try {
      await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: mail.fromName ? withName(this.from, mail.fromName) : this.from,
          Destination: { ToAddresses: [mail.to] },
          Content: {
            Simple: {
              Subject: { Data: mail.subject, Charset: 'UTF-8' },
              Body: { Text: { Data: mail.text, Charset: 'UTF-8' }, ...(mail.html ? { Html: { Data: mail.html, Charset: 'UTF-8' } } : {}) },
            },
          },
        }),
      );
    } catch (e) {
      // Never log the body: it carries single-use links.
      this.logger.error(`SES send failed to=${mail.to} subject="${mail.subject}": ${(e as Error).name}`);
      throw e;
    }
  }
}

export function mailerFor(config: { MAIL_PROVIDER: 'console' | 'ses'; MAIL_FROM: string; AWS_REGION: string }): Mailer {
  return config.MAIL_PROVIDER === 'ses' ? new SesMailer(config.MAIL_FROM, new SESv2Client({ region: config.AWS_REGION })) : new ConsoleMailer();
}
