import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { loadConfig } from '../config';
import { ConsoleMailer, mailerFor, rawMessage, SesMailer } from './mailer';

const base = { MONGODB_URL: 'mongodb://x', JWT_SECRET: 'x'.repeat(40), SECRET_KEY: Buffer.alloc(32).toString('base64') };

describe('mail', () => {
  it('SES gets a plain-text message from the configured sender', async () => {
    const sent: SendEmailCommand[] = [];
    const mailer = new SesMailer('Form Builder <no-reply@example.com>', { send: async (c: unknown) => (sent.push(c as SendEmailCommand), {}) } as never);
    await mailer.send({ to: 'a@b.test', subject: 'Confirm your email', text: 'Open https://x/verify-email?token=abc' });
    expect(sent[0]!.input).toMatchObject({
      FromEmailAddress: 'Form Builder <no-reply@example.com>',
      Destination: { ToAddresses: ['a@b.test'] },
      Content: { Simple: { Subject: { Data: 'Confirm your email' }, Body: { Text: { Data: 'Open https://x/verify-email?token=abc' } } } },
    });
  });

  it('picks the provider from config; production must use SES with a sender', () => {
    expect(mailerFor(loadConfig({ ...base }))).toBeInstanceOf(ConsoleMailer);
    expect(mailerFor(loadConfig({ ...base, MAIL_PROVIDER: 'ses', MAIL_FROM: 'no-reply@example.com' }))).toBeInstanceOf(SesMailer);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'true' })).toThrow('SES');
    expect(() => loadConfig({ ...base, MAIL_PROVIDER: 'ses' })).toThrow('MAIL_FROM');
  });

  describe('a message that carries files', () => {
    const pdf = Buffer.from('%PDF-1.3 not really a pdf '.repeat(10));
    const mail = { to: 'ravi@customer.test', subject: 'Your claim CMP-000042', text: 'Dear Ravi,\nattached.', html: '<div>Dear Ravi,<br>attached.</div>', attachments: [{ fileName: 'CMP-000042.pdf', contentType: 'application/pdf', content: pdf }] };

    it('is written out with the text, the HTML beside it, and each file whole', () => {
      const raw = rawMessage('Form Builder <no-reply@acme.test>', mail, 'B').toString('utf8');
      const [head, ...rest] = raw.split('\r\n\r\n');
      expect(head.split('\r\n')).toEqual(['From: Form Builder <no-reply@acme.test>', 'To: ravi@customer.test', 'Subject: Your claim CMP-000042', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="B"']);
      const body = rest.join('\r\n\r\n');
      expect(body).toContain('Content-Type: multipart/alternative; boundary="B-alt"');
      expect(body).toContain(Buffer.from(mail.text).toString('base64'));
      expect(body).toContain(Buffer.from(mail.html).toString('base64'));
      expect(body).toContain('Content-Type: application/pdf; name="CMP-000042.pdf"');
      expect(body).toContain('Content-Disposition: attachment; filename="CMP-000042.pdf"');
      // The file comes back out exactly as it went in, from lines no longer than mail allows.
      const encoded = body.slice(body.indexOf('filename="CMP-000042.pdf"')).split('\r\n\r\n')[1]!.split('\r\n--B--')[0]!;
      expect(encoded.split('\r\n').every((line) => line.length <= 76)).toBe(true);
      expect(Buffer.from(encoded.replace(/\r\n/g, ''), 'base64').equals(pdf)).toBe(true);
      expect(raw.trimEnd().endsWith('--B--')).toBe(true);
    });

    it('lets nothing anyone typed add a header or break out of one', () => {
      const raw = rawMessage('no-reply@acme.test', { ...mail, subject: 'Hello\r\nBcc: thief@evil.test', fromName: 'Asha"\r\nX-Injected: 1', attachments: [{ fileName: 'a"\r\nContent-Type: text/html', contentType: 'text/html\r\nX: y', content: pdf }] }, 'B').toString('utf8');
      const head = raw.split('\r\n\r\n')[0]!;
      expect(head).toContain('Subject: Hello Bcc: thief@evil.test');
      expect(head.split('\r\n').filter((l) => /^(Bcc|X-Injected):/i.test(l))).toEqual([]);
      expect(raw).toContain('Content-Type: application/octet-stream; name="a___Content-Type_ text_html"');
      expect(raw).not.toMatch(/\r\nX: y/);
    });

    it('writes a subject in another script so mail programs can read it', () => {
      const raw = rawMessage('no-reply@acme.test', { ...mail, subject: 'आपका दावा' }, 'B').toString('utf8');
      expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from('आपका दावा').toString('base64')}?=`);
    });

    it('goes to SES as a raw message; mail without files goes the simple way', async () => {
      const sent: { input: { Content: { Raw?: { Data: Uint8Array }; Simple?: unknown } } }[] = [];
      const ses = new SesMailer('no-reply@acme.test', { send: async (c: unknown) => void sent.push(c as (typeof sent)[number]) } as never);
      await ses.send(mail);
      await ses.send({ ...mail, attachments: undefined });
      expect(Buffer.from(sent[0]!.input.Content.Raw!.Data).toString()).toContain('filename="CMP-000042.pdf"');
      expect(sent[1]!.input.Content.Simple).toBeDefined();
      expect(sent[1]!.input.Content.Raw).toBeUndefined();
    });
  });
});
