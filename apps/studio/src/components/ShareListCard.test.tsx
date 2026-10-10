import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShareListCard } from './ShareListCard';

const state = vi.hoisted(() => ({ shared: [] as string[], calls: [] as { path: string; method?: string; body?: any }[] }));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ me: { user: { id: 'me', name: 'Nia' } } }) }));
vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {
    fields: Record<string, string> = {};
  },
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : 'That did not work'),
  api: async (path: string, init?: { method?: string; body?: any }) => {
    state.calls.push({ path, method: init?.method, body: init?.body });
    if (path === '/members')
      return [
        { userId: 'me', name: 'Nia', status: 'ACTIVE' },
        { userId: 'sam', name: 'Sam', status: 'ACTIVE' },
        { userId: 'zoe', name: 'Zoe', status: 'ACTIVE' },
      ];
    if (init?.method === 'PATCH') state.shared = init.body.userIds;
    return { sharedWith: state.shared };
  },
}));

beforeEach(() => {
  state.shared = [];
  state.calls = [];
});

describe('sharing my work list', () => {
  it('tick colleagues (never myself) and save; nothing to save until something changes', async () => {
    render(<ShareListCard />);
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Sam' })).toBeInTheDocument());
    expect(screen.queryByRole('checkbox', { name: 'Nia' })).toBeNull();
    expect(screen.getByText('Not shared')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Sam' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Shared with 1')).toBeInTheDocument();
    expect(state.calls.at(-1)).toMatchObject({ path: '/sharing', method: 'PATCH', body: { userIds: ['sam'] } });
    // Unticking and saving stops it.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Sam' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Not shared')).toBeInTheDocument();
  });
});
