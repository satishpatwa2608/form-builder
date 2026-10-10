import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SealCard } from './SealSettings';

const made = { subject: 'Acme Trading', issuer: 'Acme Trading', validFrom: '2026-10-10T00:00:00.000Z', validTo: '2036-10-08T00:00:00.000Z', fingerprint: 'AA:BB:CC', selfIssued: true, own: false };
const theirs = { subject: 'Acme Trading Pvt Ltd', issuer: 'A Certificate Authority', validFrom: '2026-01-01T00:00:00.000Z', validTo: '2028-01-01T00:00:00.000Z', fingerprint: '11:22:33', selfIssued: false, own: true };
const state = vi.hoisted(() => ({ seal: {} as Record<string, unknown>, calls: [] as { path: string; method?: string; body?: any }[], refuse: '' }));
vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {
    fields: Record<string, string> = {};
  },
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : 'That did not work'),
  api: async (path: string, init?: { method?: string; body?: any }) => {
    state.calls.push({ path, method: init?.method, body: init?.body });
    if (init?.method === 'PUT') {
      if (state.refuse) throw new Error(state.refuse);
      state.seal = theirs;
    }
    if (init?.method === 'DELETE') state.seal = made;
    return state.seal;
  },
}));

beforeEach(() => {
  state.seal = made;
  state.calls = [];
  state.refuse = '';
});
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SealCard />
    </QueryClientProvider>,
  );
const choose = (name: string, bytes: number[]) => {
  const file = new File([new Uint8Array(bytes)], name);
  // jsdom's File has no arrayBuffer of its own in every version.
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array(bytes).buffer });
  fireEvent.change(screen.getByLabelText('Certificate file'), { target: { files: [file] } });
};

describe('the certificate that seals PDFs', () => {
  it('says whose certificate is in use and what a certificate made here does and does not prove', async () => {
    show();
    const inUse = await screen.findByRole('group', { name: 'The certificate in use' });
    expect(inUse.textContent).toContain('Acme Trading');
    expect(inUse.textContent).toContain('Made for you by Form Builder');
    expect(inUse.textContent).toContain('Issued by itself');
    expect(screen.getByText(/A PDF reader will say it does not know who issued it/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Go back to the one made for us' })).toBeNull();
  });

  it('adds the organisation\'s own certificate from a file and its password, and can go back', async () => {
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Add our own certificate' }));
    choose('acme.pfx', [1, 2, 3, 250]);
    fireEvent.change(screen.getByLabelText('Its password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this certificate' }));
    await screen.findByText('Saved. PDFs are sealed with your certificate from now on.');
    // The file's bytes, exactly, and the password; nothing is kept on the page afterwards.
    expect(state.calls.find((c) => c.method === 'PUT')!.body).toEqual({ file: btoa(String.fromCharCode(1, 2, 3, 250)), password: 'secret' });
    const inUse = screen.getByRole('group', { name: 'The certificate in use' });
    expect(inUse.textContent).toContain('Acme Trading Pvt Ltd');
    expect(inUse.textContent).toContain('Your own certificate');
    expect(inUse.textContent).toContain('Issued by A Certificate Authority');
    expect(screen.queryByLabelText('Its password')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Go back to the one made for us' }));
    await waitFor(() => expect(screen.getByRole('group', { name: 'The certificate in use' }).textContent).toContain('Made for you by Form Builder'));
  });

  it('shows the server\'s reason when a file cannot be used, and keeps the form open', async () => {
    state.refuse = 'The private key could not be opened. Check the password.';
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Add our own certificate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use this certificate' }));
    await screen.findByText('Choose the certificate file first.');
    choose('acme.pem', [45, 45]);
    fireEvent.click(screen.getByRole('button', { name: 'Use this certificate' }));
    await screen.findByText('The private key could not be opened. Check the password.');
    expect(screen.getByLabelText('Its password')).toBeInTheDocument();
  });

  it('says so when the organisation\'s own certificate has run out', async () => {
    state.seal = { ...made, ownRanOut: '2026-09-01T00:00:00.000Z' };
    show();
    expect((await screen.findByText(/Your own certificate ran out on/)).textContent).toContain('until you add a new one');
  });
});
