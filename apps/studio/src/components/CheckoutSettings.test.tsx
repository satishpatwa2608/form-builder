import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentsCard, SmsCard } from './CheckoutSettings';

const PROVIDERS = [
  { id: 'NONE', name: 'None' },
  { id: 'TEST', name: 'Practice payments (no money moves)' },
  { id: 'RAZORPAY', name: 'Razorpay' },
  { id: 'STRIPE', name: 'Stripe' },
];
const state = vi.hoisted(() => ({ payments: {} as Record<string, any>, sms: {} as Record<string, any>, calls: [] as { path: string; method?: string; body?: any }[], smsWorks: true }));
vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {
    fields: Record<string, string> = {};
  },
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : 'That did not work'),
  api: async (path: string, init?: { method?: string; body?: any }) => {
    state.calls.push({ path, method: init?.method, body: init?.body });
    if (path === '/org/payments') {
      if (init?.method === 'PUT') state.payments = { ...state.payments, provider: init.body.provider, keyId: init.body.keyId ?? '', secretSet: !!init.body.secret || (state.payments.secretSet && init.body.provider === state.payments.provider) };
      return state.payments;
    }
    if (path === '/org/sms/test') state.sms = state.smsWorks ? { ...state.sms, enabled: true, lastError: '' } : { ...state.sms, enabled: false, lastError: 'Your SMS service answered 401: bad token' };
    else if (init?.method === 'PUT') state.sms = { ...state.sms, ...init.body, headers: init.body.headers.map((h: { name: string; value?: string }) => ({ name: h.name, valueSet: !!h.value || state.sms.headers.some((o: { name: string; valueSet: boolean }) => o.name === h.name && o.valueSet) })), enabled: false };
    return state.sms;
  },
}));

beforeEach(() => {
  state.payments = { provider: 'NONE', keyId: '', secretSet: false, providers: PROVIDERS };
  state.sms = { url: '', method: 'POST', format: 'JSON', body: '{"to":"{{to}}","message":"{{message}}"}', headers: [], enabled: false, testedAt: null, lastError: '' };
  state.calls = [];
  state.smsWorks = true;
});
const show = (card: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{card}</QueryClientProvider>);
const sent = (path: string, method: string) => state.calls.filter((c) => c.path === path && c.method === method).pop()?.body;

describe('Payments', () => {
  it('starts with nothing chosen, and practice payments need nothing but saving', async () => {
    show(<PaymentsCard />);
    const service = await screen.findByLabelText('Take payments through');
    expect(service).toHaveValue('NONE');
    expect(screen.queryByLabelText('Key ID')).not.toBeInTheDocument();
    fireEvent.change(service, { target: { value: 'TEST' } });
    expect(screen.getByText(/The person sees a practice page/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved. Forms that take a payment now show a practice page: no money moves.')).toBeInTheDocument();
    expect(sent('/org/payments', 'PUT')).toEqual({ provider: 'TEST' });
    expect(screen.getByText('Practice')).toBeInTheDocument();
  });

  it('Razorpay asks for its two keys and says where to find them; the secret is sent only when typed', async () => {
    show(<PaymentsCard />);
    fireEvent.change(await screen.findByLabelText('Take payments through'), { target: { value: 'RAZORPAY' } });
    expect(screen.getByText(/Account & Settings → API keys/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Key ID'), { target: { value: ' rzp_test_abc ' } });
    fireEvent.change(screen.getByLabelText('Key secret'), { target: { value: 'the-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved. Forms that take a payment now send people to Razorpay.')).toBeInTheDocument();
    expect(sent('/org/payments', 'PUT')).toEqual({ provider: 'RAZORPAY', keyId: 'rzp_test_abc', secret: 'the-secret' });
    // Saved secrets are never shown again; the box says one is there.
    await waitFor(() => expect(screen.getByLabelText('Key secret')).toHaveValue(''));
    expect(screen.getByLabelText('Key secret')).toHaveAttribute('placeholder', 'Saved - type to replace');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('/org/payments', 'PUT')).toEqual({ provider: 'RAZORPAY', keyId: 'rzp_test_abc' }));
  });

  it('Stripe asks for one key', async () => {
    show(<PaymentsCard />);
    fireEvent.change(await screen.findByLabelText('Take payments through'), { target: { value: 'STRIPE' } });
    expect(screen.queryByLabelText('Key ID')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Secret key'), { target: { value: 'sk_test_1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('/org/payments', 'PUT')).toEqual({ provider: 'STRIPE', secret: 'sk_test_1' }));
  });
});

describe('Text messages', () => {
  it('is saved, then tested with a message to the admin\'s own phone, and only then on', async () => {
    show(<SmsCard />);
    fireEvent.change(await screen.findByLabelText('Where your SMS service is called'), { target: { value: ' https://sms.example.com/send ' } });
    fireEvent.change(screen.getByLabelText('Header your service asks for'), { target: { value: 'Authorization' } });
    fireEvent.change(screen.getByLabelText('Its value'), { target: { value: 'Bearer abc' } });
    expect(screen.queryByLabelText('Send a test message to')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved. Now send a test message to your own phone.')).toBeInTheDocument();
    expect(sent('/org/sms', 'PUT')).toEqual({ url: 'https://sms.example.com/send', method: 'POST', format: 'JSON', body: '{"to":"{{to}}","message":"{{message}}"}', headers: [{ name: 'Authorization', value: 'Bearer abc' }] });
    expect(screen.getByText('Not tested')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Its value')).toHaveAttribute('placeholder', 'Saved - type to replace'));

    const test = screen.getByRole('button', { name: 'Send the test' });
    expect(test).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Send a test message to'), { target: { value: '+919812345678' } });
    await waitFor(() => expect(test).toBeEnabled());
    fireEvent.click(test);
    expect(await screen.findByText('The test message went through. Forms can now send codes by text message.')).toBeInTheDocument();
    expect(sent('/org/sms/test', 'POST')).toEqual({ to: '+919812345678' });
    expect(screen.getByText('On')).toBeInTheDocument();
  });

  it('a test that fails says what the service answered, and it stays off', async () => {
    state.sms = { ...state.sms, url: 'https://sms.example.com/send' };
    state.smsWorks = false;
    show(<SmsCard />);
    fireEvent.change(await screen.findByLabelText('Send a test message to'), { target: { value: '+919812345678' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send the test' }));
    expect(await screen.findByText('The last text message did not go: Your SMS service answered 401: bad token')).toBeInTheDocument();
    expect(screen.getByText('Not tested')).toBeInTheDocument();
  });

  it('a service called by GET has nothing to write: everything is in its address', async () => {
    show(<SmsCard />);
    expect(await screen.findByLabelText('What is sent')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('How it is called'), { target: { value: 'GET' } });
    expect(screen.queryByLabelText('What is sent')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('What is sent is written as')).not.toBeInTheDocument();
  });
});

describe('WhatsApp', () => {
  it('is set up like text messages, at its own address, and says WhatsApp needs approved templates', async () => {
    show(<SmsCard channel="whatsapp" />);
    expect(await screen.findByText('WhatsApp messages')).toBeTruthy();
    expect(screen.getByText(/delivers only messages made from a template it has approved/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Where your WhatsApp service is called'), { target: { value: 'https://wa.example/messages' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('/org/whatsapp', 'PUT')).toMatchObject({ url: 'https://wa.example/messages' }));
    expect(state.calls.some((c) => c.path === '/org/sms' && c.method === 'PUT')).toBe(false);
  });
});
