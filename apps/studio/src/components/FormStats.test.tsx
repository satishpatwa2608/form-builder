import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FormStats, speedLine, whereTheyStop } from './FormStats';

const state = vi.hoisted(() => ({ speed: null as null | { loads: number; averageMs: number; under1s: number; under2s: number; under4s: number }, fields: [] as { name: string; label: string; answered: number; mistakes: number; leftAt: number }[] }));
vi.mock('../lib/api', () => ({
  api: async (path: string) =>
    path.includes('/field-stats')
      ? { days: 30, starts: 10, submissions: 6, fields: state.fields }
      : { days: 30, series: [], totals: { views: 20, starts: 10, submissions: 6 }, startRate: 50, completionRate: 60, speed: state.speed },
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
beforeEach(() => {
  state.fields = [];
});
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FormStats formId="f1" />
    </QueryClientProvider>,
  );

describe('form analytics', () => {
  it('shows the funnel, and no question table until a visit has been counted', async () => {
    state.fields = [{ name: 'name', label: 'Your name', answered: 0, mistakes: 0, leftAt: 0 }];
    show();
    expect(await screen.findByText('Completed after starting')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Question by question' })).toBeNull();
  });

  it('lists each question in the form\'s order with how many answered, tripped and left', async () => {
    state.fields = [
      { name: 'name', label: 'Your name', answered: 10, mistakes: 0, leftAt: 1 },
      { name: 'pan', label: 'PAN number', answered: 7, mistakes: 5, leftAt: 3 },
      { name: 'notes', label: 'Notes', answered: 2, mistakes: 0, leftAt: 0 },
    ];
    show();
    const table = await screen.findByRole('table', { name: 'Question by question' });
    const rows = within(table).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell').map((c) => c.textContent));
    expect(within(table).getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['Your name', 'PAN number', 'Notes']);
    expect(rows).toEqual([
      ['10 (100%)', '0', '1'],
      ['7 (70%)', '5', '3'],
      ['2 (20%)', '0', '0'],
    ]);
    expect(screen.getByText('Of 4 people who started and left, 3 stopped at "PAN number".')).toBeInTheDocument();
    expect(screen.getByText(/Counts only: nothing about who answered/)).toBeInTheDocument();
  });

  it('says how fast the form appears for real visitors, once any have reported', async () => {
    show();
    expect(await screen.findByText('Completed after starting')).toBeInTheDocument();
    expect(screen.queryByLabelText('Loading speed')).toBeNull();
    expect(speedLine({ loads: 240, averageMs: 1380, under1s: 40, under2s: 87.5, under4s: 97.5 })).toBe('The form appears in 1.4 seconds on average; 87.5% of visits have it within 2 seconds, and 2.5% wait more than 4. From 240 visits.');
    expect(speedLine({ loads: 1, averageMs: 600, under1s: 100, under2s: 100, under4s: 100 })).toBe('The form appears in 0.6 seconds on average; 100% of visits have it within 2 seconds. From 1 visit.');
  });

  it('says where people stop only when someone has', () => {
    const f = (leftAt: number, label = 'Q') => ({ name: label, label, answered: 1, mistakes: 0, leftAt });
    expect(whereTheyStop({ days: 7, starts: 3, submissions: 3, fields: [f(0)] })).toBeNull();
    expect(whereTheyStop({ days: 7, starts: 3, submissions: 2, fields: [f(1, 'Email')] })).toBe('Of 1 person who started and left, they stopped at "Email".');
    expect(whereTheyStop({ days: 7, starts: 3, submissions: 0, fields: [f(3, 'Email'), f(0, 'Phone')] })).toBe('Of 3 people who started and left, all stopped at "Email".');
  });
});
