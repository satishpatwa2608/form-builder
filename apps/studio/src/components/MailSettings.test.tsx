import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { choiceOf, mailBody, MailCard } from './MailSettings';

const blank = { provider: 'DEFAULT', enabled: false, from: '', fromName: '', smtp: { host: '', port: 587, security: 'STARTTLS', username: '', passwordSet: false }, microsoft: { tenantId: '', clientId: '', clientSecretSet: false }, testedAt: null, lastError: '', lastErrorAt: null };
const state = vi.hoisted(() => ({ settings: {} as Record<string, any>, calls: [] as { path: string; method?: string; body?: any }[], failTest: '' }));
vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {
    fields: Record<string, string> = {};
  },
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : 'That did not work'),
  api: async (path: string, init?: { method?: string; body?: any }) => {
    state.calls.push({ path, method: init?.method, body: init?.body });
    if (init?.method === 'PUT') {
      const b = init.body;
      state.settings = { ...state.settings, provider: b.provider, from: b.from ?? '', fromName: b.fromName ?? '', enabled: false, testedAt: null, smtp: b.smtp ? { host: b.smtp.host, port: b.smtp.port, security: b.smtp.security, username: b.smtp.username, passwordSet: !!b.smtp.password || state.settings.smtp.passwordSet } : state.settings.smtp };
    }
    if (path === '/org/mail/test') {
      if (state.failTest) throw new Error(state.failTest);
      state.settings = { ...state.settings, testedAt: '2026-10-09T10:00:00.000Z' };
      return { ...state.settings, sentTo: 'asha@acme.test' };
    }
    if (path === '/org/mail/use') state.settings = { ...state.settings, enabled: init!.body.enabled };
    return state.settings;
  },
}));

beforeEach(() => {
  state.settings = structuredClone(blank);
  state.calls = [];
  state.failTest = '';
});
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MailCard />
    </QueryClientProvider>,
  );
const form = { from: ' help@acme.com ', fromName: 'Acme', host: 'smtp.acme.com', port: 465, username: 'mailer', password: 'pw', tenantId: 't', clientId: 'c', clientSecret: '' };

describe('what is saved for each kind of mail server', () => {
  it('Google is the one known server, signed in to as the address itself', () => {
    expect(mailBody('GOOGLE', form)).toEqual({ provider: 'SMTP', from: 'help@acme.com', fromName: 'Acme', smtp: { host: 'smtp.gmail.com', port: 587, security: 'STARTTLS', username: 'help@acme.com', password: 'pw' } });
    expect(choiceOf({ provider: 'SMTP', smtp: { ...blank.smtp, host: 'smtp.gmail.com' } } as never)).toBe('GOOGLE');
    expect(choiceOf({ provider: 'SMTP', smtp: { ...blank.smtp, host: 'smtp.acme.com' } } as never)).toBe('SMTP');
  });

  it('another server: the port decides the kind of security; a secret is sent only when typed', () => {
    expect(mailBody('SMTP', form)).toMatchObject({ smtp: { host: 'smtp.acme.com', port: 465, security: 'TLS', username: 'mailer', password: 'pw' } });
    expect((mailBody('SMTP', { ...form, port: 587, password: '' }) as { smtp: unknown }).smtp).toEqual({ host: 'smtp.acme.com', port: 587, security: 'STARTTLS', username: 'mailer' });
    expect(mailBody('MICROSOFT', form)).toEqual({ provider: 'MICROSOFT', from: 'help@acme.com', fromName: 'Acme', microsoft: { tenantId: 't', clientId: 'c' } });
    expect(mailBody('DEFAULT', form)).toEqual({ provider: 'DEFAULT' });
  });
});

describe('the email sending card', () => {
  it('starts on Form Builder with nothing to fill in', async () => {
    show();
    expect(await screen.findByLabelText('Send them through')).toHaveValue('DEFAULT');
    expect(screen.queryByLabelText('Address to send from')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send me a test email' })).toBeNull();
  });

  it('save, then test, then switch on: each only once the one before is done', async () => {
    show();
    fireEvent.change(await screen.findByLabelText('Send them through'), { target: { value: 'SMTP' } });
    fireEvent.change(screen.getByLabelText('Address to send from'), { target: { value: 'help@acme.com' } });
    fireEvent.change(screen.getByLabelText('Mail server'), { target: { value: 'smtp.acme.com' } });
    fireEvent.change(screen.getByLabelText('User name'), { target: { value: 'mailer' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved. Now send yourself a test email.')).toBeInTheDocument();
    expect(state.calls.find((c) => c.method === 'PUT')!.body).toEqual({ provider: 'SMTP', from: 'help@acme.com', fromName: '', smtp: { host: 'smtp.acme.com', port: 587, security: 'STARTTLS', username: 'mailer', password: 'pw' } });
    expect(screen.getByText('Not tested')).toBeInTheDocument();
    // The password box is empty again, and nothing offers to switch on yet.
    await waitFor(() => expect(screen.getByLabelText('Password')).toHaveValue(''));
    expect(screen.queryByRole('button', { name: 'Switch it on' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Send me a test email' }));
    expect(await screen.findByText(/A test email is on its way to asha@acme.test/)).toBeInTheDocument();
    expect(screen.getByText('Tested, not on')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Switch it on' }));
    expect(await screen.findByText(/now come from your address/)).toBeInTheDocument();
    expect(screen.getByText('On')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop using it' })).toBeInTheDocument();
  });

  it('a failed test shows the server\'s plain reason and offers nothing to switch on', async () => {
    state.settings = { ...structuredClone(blank), provider: 'SMTP', from: 'help@acme.com', smtp: { ...blank.smtp, host: 'smtp.acme.com', passwordSet: true } };
    state.failTest = 'The mail server refused the user name or password.';
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Send me a test email' }));
    expect(await screen.findByText('The mail server refused the user name or password.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Switch it on' })).toBeNull();
  });

  it('with unsaved changes, testing waits for a save', async () => {
    state.settings = { ...structuredClone(blank), provider: 'SMTP', from: 'help@acme.com', testedAt: '2026-10-09T10:00:00.000Z', smtp: { ...blank.smtp, host: 'smtp.acme.com', passwordSet: true } };
    show();
    expect(await screen.findByRole('button', { name: 'Send me a test email' })).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Mail server'), { target: { value: 'smtp.other.com' } });
    expect(screen.getByRole('button', { name: 'Send me a test email' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Switch it on' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('says when the last email through their server did not go', async () => {
    state.settings = { ...structuredClone(blank), provider: 'MICROSOFT', enabled: true, from: 'help@acme.com', lastError: 'Microsoft 365 has no mailbox help@acme.com.', lastErrorAt: '2026-10-09T10:00:00.000Z', testedAt: '2026-10-08T10:00:00.000Z' };
    show();
    expect(await screen.findByText(/The last email through your mail server did not go/)).toHaveTextContent('Microsoft 365 has no mailbox help@acme.com.');
    expect(screen.getByLabelText('Mailbox to send from')).toHaveValue('help@acme.com');
  });
});
