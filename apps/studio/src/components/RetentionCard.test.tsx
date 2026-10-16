import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RetentionCard } from './RetentionCard';

const state = vi.hoisted(() => ({ retention: { days: 7 as number | null, keptHereOnly: [] as string[], due: 0 }, calls: [] as { path: string; method?: string; body?: unknown }[] }));
vi.mock('../lib/api', () => ({
  api: async (path: string, init?: { method?: string; body?: { retention: { days: number | null } } }) => {
    state.calls.push({ path, method: init?.method, body: init?.body });
    if (path === '/org') state.retention = { ...state.retention, days: init!.body!.retention.days };
    return state.retention;
  },
}));

const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RetentionCard />
    </QueryClientProvider>,
  );

beforeEach(() => {
  state.retention = { days: 7, keptHereOnly: ['Maintenance complaint'], due: 3 };
  state.calls = [];
});

describe('the keeping data setting', () => {
  it('shows the length, the forms whose answers live only here, and what goes next', async () => {
    show();
    expect(await screen.findByLabelText('Delete closed records after')).toHaveValue('7');
    expect(screen.getByText(/keep their answers only here.*Maintenance complaint/)).toBeInTheDocument();
    expect(screen.getByText('3 records go at the next run, within the hour.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('an admin picks another length, or keeps everything', async () => {
    const user = userEvent.setup();
    show();
    await user.selectOptions(await screen.findByLabelText('Delete closed records after'), '90');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(state.calls.find((c) => c.path === '/org')).toMatchObject({ method: 'PATCH', body: { retention: { days: 90 } } });
    expect(await screen.findByText(/Closed records go 90 days after/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Delete closed records after'), 'keep');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(state.calls.filter((c) => c.path === '/org').at(-1)!.body).toEqual({ retention: { days: null } });
    expect(await screen.findByText('Saved. Nothing is deleted by the retention.')).toBeInTheDocument();
    expect(screen.queryByText(/next run/)).not.toBeInTheDocument();
  });
});
