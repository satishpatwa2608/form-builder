import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AwayCard, awayLine } from './AwayCard';

const here = { set: false, now: false, from: null, until: null, toUserId: '' };
const state = vi.hoisted(() => ({ away: {} as Record<string, unknown>, calls: [] as { path: string; method?: string; body?: any }[], fail: '' }));
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
        { userId: 'old', name: 'Left Long Ago', status: 'DISABLED' },
      ];
    if (init?.method === 'PATCH') {
      if (state.fail) throw new Error(state.fail);
      state.away = init.body.off ? here : { set: true, now: !init.body.from, from: init.body.from ?? '2026-10-10T08:00:00.000Z', until: init.body.until ?? null, toUserId: init.body.toUserId };
    }
    return state.away;
  },
}));

beforeEach(() => {
  state.away = here;
  state.calls = [];
  state.fail = '';
});

describe('saying I am away', () => {
  it('offers my colleagues (not me, not people who have left) and needs one chosen', async () => {
    render(<AwayCard />);
    const who = await screen.findByLabelText('Give my new work to');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Sam' })).toBeInTheDocument());
    expect(screen.queryByRole('option', { name: 'Nia' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Left Long Ago' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Set as away' })).toBeDisabled();
    fireEvent.change(who, { target: { value: 'sam' } });
    expect(screen.getByRole('button', { name: 'Set as away' })).toBeEnabled();
  });

  it('from now until I say I am back: one choice and one press; then "I\'m back" ends it', async () => {
    render(<AwayCard />);
    fireEvent.change(await screen.findByLabelText('Give my new work to'), { target: { value: 'sam' } });
    await waitFor(() => expect(screen.getByRole('option', { name: 'Sam' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Give my new work to'), { target: { value: 'sam' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set as away' }));
    expect(await screen.findByText('Away now')).toBeInTheDocument();
    expect(screen.getByText(/until you are back · new work goes to Sam/)).toBeInTheDocument();
    expect(state.calls.at(-1)).toMatchObject({ path: '/away', method: 'PATCH', body: { toUserId: 'sam', from: undefined, until: undefined } });

    fireEvent.click(screen.getByRole('button', { name: "I'm back" }));
    expect(await screen.findByText('Here')).toBeInTheDocument();
    expect(state.calls.at(-1)!.body).toEqual({ off: true });
  });

  it('what the server refuses is said in its words', async () => {
    state.fail = 'The person standing in must be an active member';
    render(<AwayCard />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Sam' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Give my new work to'), { target: { value: 'sam' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set as away' }));
    expect(await screen.findByText('The person standing in must be an active member')).toBeInTheDocument();
  });

  it('a planned absence, and one with nobody standing in, are told apart', async () => {
    state.away = { set: true, now: false, from: '2026-12-20T00:00:00.000Z', until: '2026-12-27T00:00:00.000Z', toUserId: '' };
    render(<AwayCard />);
    expect(await screen.findByText('Planned')).toBeInTheDocument();
    expect(screen.getByText(/Nobody is standing in/)).toBeInTheDocument();
    expect(awayLine({ set: true, now: true, from: '2026-10-01T00:00:00.000Z', until: null, toUserId: 'sam' }, 'Sam')).toBe('Away until they are back · new work goes to Sam');
  });
});
