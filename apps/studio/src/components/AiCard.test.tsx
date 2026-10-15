import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiCard } from './AiCard';

const state = vi.hoisted(() => ({ status: { available: true, enabled: false, used: 2, limit: 50 } as { available: boolean; enabled: boolean; used: number; limit: number | null }, patched: [] as unknown[] }));
vi.mock('../lib/api', () => ({
  api: async (path: string, init?: { method?: string; body?: { ai: { drafting: boolean } } }) => {
    if (init?.method === 'PATCH') {
      state.patched.push(init.body);
      state.status = { ...state.status, enabled: init.body!.ai.drafting };
      return {};
    }
    return state.status;
  },
}));

const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AiCard />
    </QueryClientProvider>,
  );

beforeEach(() => {
  state.status = { available: true, enabled: false, used: 2, limit: 50 };
  state.patched = [];
});

describe('the AI drafting setting', () => {
  it('is off to begin with; an admin turns it on, told what is sent', async () => {
    const user = userEvent.setup();
    show();
    const box = await screen.findByRole('checkbox', { name: 'Let people draft forms from a description' });
    expect(box).not.toBeChecked();
    expect(screen.getByText(/Only the description they type is sent to the AI service/)).toBeInTheDocument();
    expect(screen.getByText(/2 of 50 drafts used this month/)).toBeInTheDocument();
    await user.click(box);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(state.patched).toEqual([{ ai: { drafting: true } }]);
    expect(await screen.findByText(/"Describe it \(AI\)" is now offered under New form/)).toBeInTheDocument();
  });

  it('is not shown where the installation has no AI service', async () => {
    state.status = { available: false, enabled: false, used: 0, limit: 50 };
    const { container } = show();
    await waitFor(() => expect(container.textContent).toBe(''));
  });
});
