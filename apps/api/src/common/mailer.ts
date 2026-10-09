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
  /** Files sent with it (the PDF of a response). */
  attachments?: MailAttachment[];
}

export interface MailAttachment {
  fileName: string;
  contentType: string;
  content: Buffer;
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
    const files = mail.attachments?.length ? ` attachments=${mail.attachments.map((a) => `${a.fileName} (${a.content.length} bytes)`).join(', ')}` : '';
    this.logger.log(`to=${mail.to} subject="${mail.subject}"${files}\n${mail.text}`);
  }
}

/** "Form Builder <no-reply@x>" + "Asha Rao" -> "Asha Rao <no-reply@x>" (quotes and angle brackets stripped from the name). */
export function withName(from: string, name: string): string {
  const address = from.match(/<([^>]+)>/)?.[1] ?? from.trim();
  const clean = name.replace(/["<>\r\n]/g, '').trim().slice(0, 60);
  return clean ? `"${clean}" <${address}>` : from;
}

/** A header value that is not plain ASCII, in the form mail programs decode (RFC 2047). */
const encodedWord = (value: string) => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`);
/** Base64 in lines of 76 characters, as mail requires. */
const wrapped = (data: Buffer) => data.toString('base64').replace(/(.{76})/g, '$1\r\n');
/** A file name that cannot break out of its header. */
const safeName = (name: string) => name.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 100) || 'file';

/**
 * A whole message, written out by hand, for mail that carries files (the
 * simple way of sending cannot). Text first, HTML beside it when there is
 * some, then each file. Nothing typed by anyone can add a header: values are
 * stripped of line breaks, and the body is base64.
 */
export function rawMessage(from: string, mail: Mail, boundary = `fb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`): Buffer {
  const oneLine = (v: string) => v.replace(/[\r\n]+/g, ' ');
  const part = (type: string, body: Buffer, extra: string[] = []) => [`Content-Type: ${type}`, 'Content-Transfer-Encoding: base64', ...extra, '', wrapped(body)].join('\r\n');
  const alt = `${boundary}-alt`;
  const textAndHtml = mail.html
    ? [`Content-Type: multipart/alternative; boundary="${alt}"`, '', `--${alt}`, part('text/plain; charset=UTF-8', Buffer.from(mail.text, 'utf8')), `--${alt}`, part('text/html; charset=UTF-8', Buffer.from(mail.html, 'utf8')), `--${alt}--`].join('\r\n')
    : part('text/plain; charset=UTF-8', Buffer.from(mail.text, 'utf8'));
  const lines = [
    `From: ${oneLine(mail.fromName ? withName(from, mail.fromName) : from)}`,
    `To: ${oneLine(mail.to)}`,
    `Subject: ${encodedWord(oneLine(mail.subject))}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    textAndHtml,
    ...(mail.attachments ?? []).flatMap((a) => [
      `--${boundary}`,
      part(`${/^[a-z]+\/[a-z0-9.+-]+$/i.test(a.contentType) ? a.contentType : 'application/octet-stream'}; name="${safeName(a.fileName)}"`, a.content, [`Content-Disposition: attachment; filename="${safeName(a.fileName)}"`]),
    ]),
    `--${boundary}--`,
    '',
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8');
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
          Content: mail.attachments?.length
            ? { Raw: { Data: rawMessage(this.from, mail) } }
            : {
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
