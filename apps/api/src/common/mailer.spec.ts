import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { loadConfig } from '../config';
import { ConsoleMailer, mailerFor, SesMailer } from './mailer';

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
});
