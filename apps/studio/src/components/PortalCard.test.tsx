import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PortalCard } from './SiteSettings';

const state = vi.hoisted(() => ({ portal: { enabled: false, title: '', intro: '' }, saved: [] as unknown[] }));
vi.mock('../lib/api', () => ({
  errorMessage: (e: unknown) => String(e),
  api: async (path: string, init?: { method?: string; body?: { portal: typeof state.portal } }) => {
    if (init?.method === 'PATCH') {
      state.saved.push(init.body);
      state.portal = init.body!.portal;
    }
    return path === '/org' ? { id: 'org-1', portal: state.portal } : {};
  },
}));

beforeEach(() => {
  state.portal = { enabled: false, title: '', intro: '' };
  state.saved = [];
});
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PortalCard />
    </QueryClientProvider>,
  );

describe('the requests portal setting', () => {
  it('is off to begin with, and shows no address until it is on', async () => {
    show();
    expect(await screen.findByRole('checkbox', { name: 'Switch the portal on' })).not.toBeChecked();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/never the answers/)).toBeInTheDocument();
  });

  it('switching it on with a heading saves both and shows where the portal is', async () => {
    show();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Switch the portal on' }));
    fireEvent.change(screen.getByLabelText('Heading'), { target: { value: 'Acme help desk' } });
    fireEvent.change(screen.getByLabelText('Introduction (optional)'), { target: { value: 'Ask us.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save portal' }));
    await waitFor(() => expect(state.saved).toEqual([{ portal: { enabled: true, title: 'Acme help desk', intro: 'Ask us.' } }]));
    const link = await screen.findByRole('link');
    expect(link.getAttribute('href')).toMatch(/\/portal\/org-1$/);
    expect(screen.getByText('Portal saved. It is open at the address below.')).toBeInTheDocument();
  });
});
