import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiCard } from './AiCard';

type Status = { available: boolean; enabled: boolean; ownKey: { hint: string; setAt: string | null } | null; used: number; limit: number | null };
const state = vi.hoisted(() => ({ status: {} as Status, calls: [] as { path: string; method?: string; body?: unknown }[] }));
vi.mock('../lib/api', () => ({
  api: async (path: string, init?: { method?: string; body?: { key?: string; ai?: { drafting: boolean } } }) => {
    state.calls.push({ path, method: init?.method, body: init?.body });
    if (path === '/ai/key' && init?.method === 'PUT') state.status = { ...state.status, available: true, ownKey: { hint: init.body!.key!.slice(-4), setAt: null }, limit: null };
    if (path === '/ai/key' && init?.method === 'DELETE') state.status = { ...state.status, available: false, enabled: false, ownKey: null };
    if (path === '/org') state.status = { ...state.status, enabled: init!.body!.ai!.drafting };
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
  state.status = { available: false, enabled: false, ownKey: null, used: 0, limit: 5 };
  state.calls = [];
});

describe('the AI drafting setting', () => {
  it("is set up with the organisation's own key, then switched on; it says what is sent and who pays", async () => {
    const user = userEvent.setup();
    show();
    expect(await screen.findByText(/each draft is charged to that account/)).toBeInTheDocument();
    expect(screen.getByText(/Only the description someone types is sent/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Let people draft forms from a description' })).toBeDisabled();
    await user.type(screen.getByLabelText('Your Anthropic API key'), 'sk-ant-abcdefghijklmnopqrstuvwxyz1234');
    await user.click(screen.getByRole('button', { name: 'Save the key' }));
    expect(state.calls.find((c) => c.path === '/ai/key')!.body).toEqual({ key: 'sk-ant-abcdefghijklmnopqrstuvwxyz1234' });
    expect(await screen.findByText('…1234')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Let people draft forms from a description' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(state.calls.find((c) => c.path === '/org')).toMatchObject({ method: 'PATCH', body: { ai: { drafting: true } } });
    expect(await screen.findByText(/"Describe it \(AI\)" is now offered under New form/)).toBeInTheDocument();
  });

  it('the key can be taken away', async () => {
    state.status = { available: true, enabled: true, ownKey: { hint: 'wxyz', setAt: null }, used: 0, limit: null };
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Remove the key' }));
    expect(state.calls).toContainEqual({ path: '/ai/key', method: 'DELETE', body: undefined });
    expect(await screen.findByLabelText('Your Anthropic API key')).toBeInTheDocument();
  });
});
