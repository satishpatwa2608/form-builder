import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FailedWorkCard, type FailedWork } from './FailedWorkCard';

const state = vi.hoisted(() => ({ calls: [] as { path: string; method?: string }[], data: { jobs: [], flows: [] } as FailedWork, fail: '' }));
vi.mock('../lib/api', () => ({
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : 'That did not work'),
  api: async (path: string, init?: { method?: string }) => {
    state.calls.push({ path, method: init?.method });
    if (init?.method === 'POST') {
      if (state.fail) throw new Error(state.fail);
      state.data = { jobs: state.data.jobs.filter((j) => !path.includes(j.id)), flows: state.data.flows.filter((f) => !path.includes(f.runId)) };
      return {};
    }
    return state.data;
  },
}));

const FLOW = { recordId: 'rec-1', ref: 'REQ-000007', form: 'Request', runId: 'run-1', automation: 'Tell the CRM', step: 2, error: 'hooks.example.com answered 503', at: '2026-10-16T01:00:00.000Z' };
const JOB = { id: 'job-1', what: 'Webhook delivery', recordId: 'rec-2', ref: 'REQ-000008', error: 'hooks.example.com did not answer', attempts: 5, at: '2026-10-16T02:00:00.000Z' };

beforeEach(() => {
  state.calls = [];
  state.fail = '';
  state.data = { jobs: [JOB], flows: [FLOW] };
});
const show = () =>
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <FailedWorkCard />
      </QueryClientProvider>
    </MemoryRouter>,
  );

describe('work that failed', () => {
  it('lists each stopped flow and failed job with its reason and a link to the record', async () => {
    show();
    expect(await screen.findByText('Tell the CRM stopped at step 2')).toBeTruthy();
    expect(screen.getByText('hooks.example.com answered 503')).toBeTruthy();
    expect(screen.getByText('Webhook delivery')).toBeTruthy();
    expect(screen.getByText(/gave up after 5 tries/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'REQ-000007' }).getAttribute('href')).toBe('/work?record=rec-1');
    expect(screen.getByText(/2 things in the last 30 days/)).toBeTruthy();
  });

  it('runs a flow again from its step, and a job again, then shows what is left', async () => {
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Run again from step 2' }));
    await waitFor(() => expect(state.calls).toContainEqual({ path: '/records/rec-1/runs/run-1/again', method: 'POST' }));
    expect(await screen.findByText(/Tell the CRM is running again from step 2/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Tell the CRM stopped at step 2')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Run again' }));
    await waitFor(() => expect(state.calls).toContainEqual({ path: '/failed-work/jobs/job-1/retry', method: 'POST' }));
    // Nothing left: the card goes away.
    await waitFor(() => expect(screen.queryByText('Work that failed')).toBeNull());
  });

  it('says why when running again is refused, and keeps the item', async () => {
    state.fail = 'This flow is already running again';
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Run again from step 2' }));
    expect(await screen.findByText('This flow is already running again')).toBeTruthy();
    expect(screen.getByText('Tell the CRM stopped at step 2')).toBeTruthy();
  });

  it('shows nothing when nothing has failed', async () => {
    state.data = { jobs: [], flows: [] };
    const { container } = show();
    await waitFor(() => expect(state.calls).toHaveLength(1));
    expect(container.textContent).toBe('');
  });
});
