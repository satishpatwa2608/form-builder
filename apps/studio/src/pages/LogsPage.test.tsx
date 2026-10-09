import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { actionLabel, fromLabel } from './AuditPage';
import LogsPage, { factsOf, lineTime } from './LogsPage';

const AREAS = [
  { area: 'submissions', label: 'Responses coming in', level: 'INFO', recording: 'INFO' },
  { area: 'workflow', label: 'Workflow and automations', level: 'INFO', recording: 'INFO' },
  { area: 'mail', label: 'Email', level: 'INFO', recording: 'INFO' },
];
const LINES = [
  { id: '3', at: '2026-10-09T10:00:03.250Z', level: 'ERROR', area: 'workflow', message: 'To CRM: WEBHOOK failed - host answered 502', context: { form: 'LOAN', step: 'hook' } },
  { id: '2', at: '2026-10-09T10:00:02.000Z', level: 'INFO', area: 'mail', message: 'Email sent', context: { to: 'r***@x.test', through: 'Form Builder' } },
  { id: '1', at: '2026-10-09T10:00:01.000Z', level: 'DEBUG', area: 'submissions', message: 'Response sent back with mistakes', context: { form: 'LOAN', fields: 'email, phone' } },
];
const state = vi.hoisted(() => ({ calls: [] as { path: string; method?: string; body?: any }[], can: true, settings: {} as any, files: [] as string[] }));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ can: () => state.can }) }));
vi.mock('../lib/api', () => ({
  ApiError: class extends Error {
    fields: Record<string, string> = {};
  },
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : 'That did not work'),
  apiFile: async (path: string) => {
    state.files.push(path);
    return new Blob(['x']);
  },
  api: async (path: string, init?: { method?: string; body?: any }) => {
    state.calls.push({ path, method: init?.method, body: init?.body });
    if (path === '/org/logs/settings') {
      if (init?.method === 'PUT') state.settings = { ...state.settings, areas: state.settings.areas.map((a: any) => ({ ...a, level: init.body.levels[a.area], recording: init.body.levels[a.area] })), keepDays: init.body.keepDays, debugUntil: init.body.debugHours ? '2026-10-09T12:00:00.000Z' : null };
      return state.settings;
    }
    const q = new URLSearchParams(path.split('?')[1]);
    const rank = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 } as Record<string, number>;
    const min = rank[q.get('level') ?? 'DEBUG']!;
    return { lines: LINES.filter((l) => rank[l.level]! >= min && (!q.get('area') || l.area === q.get('area')) && (!q.get('q') || l.message.includes(q.get('q')!))), next: null };
  },
}));

beforeEach(() => {
  state.calls = [];
  state.files = [];
  state.can = true;
  state.settings = { areas: structuredClone(AREAS), debugUntil: null, keepDays: 14, limits: { maxKeepDays: 30, maxDebugHours: 24 } };
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <LogsPage />
    </QueryClientProvider>,
  );
const lines = () => within(screen.getByRole('log', { name: 'Log lines' })).queryAllByRole('button');

describe('the log console', () => {
  it('shows lines as a log reads, info and above to begin with, each with its level and where it came from', async () => {
    show();
    await waitFor(() => expect(lines()).toHaveLength(2));
    expect(lines()[0]).toHaveTextContent('ERROR');
    expect(lines()[0]).toHaveTextContent('[workflow]');
    expect(lines()[0]).toHaveTextContent('To CRM: WEBHOOK failed - host answered 502');
    expect(lines()[0]).toHaveTextContent('form=LOAN step=hook');
    expect(lines()[1]).toHaveTextContent('Email sent');
    // Debug lines are not shown until asked for.
    expect(screen.queryByText('Response sent back with mistakes')).toBeNull();
  });

  it('narrows by level, by part of the product and by words', async () => {
    show();
    await waitFor(() => expect(lines()).toHaveLength(2));
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'DEBUG' } });
    await waitFor(() => expect(lines()).toHaveLength(3));
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'ERROR' } });
    await waitFor(() => expect(lines()).toHaveLength(1));
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'INFO' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: 'mail' } });
    await waitFor(() => expect(lines().map((l) => l.textContent)).toEqual([expect.stringContaining('Email sent')]));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Find'), { target: { value: 'WEBHOOK' } });
    await waitFor(() => expect(state.calls.some((c) => c.path.includes('q=WEBHOOK'))).toBe(true));
    await waitFor(() => expect(lines()).toHaveLength(1));
  });

  it('a line opens to show its facts one by one', async () => {
    show();
    await waitFor(() => expect(lines()).toHaveLength(2));
    fireEvent.click(lines()[1]!);
    const open = lines()[1]!;
    expect(open).toHaveAttribute('aria-expanded', 'true');
    expect(within(open).getByText('through')).toBeInTheDocument();
    expect(within(open).getByText('Form Builder')).toBeInTheDocument();
    expect(within(open).getByText('Email')).toBeInTheDocument();
  });

  it('downloads what is being shown, and stops and starts following', async () => {
    show();
    await waitFor(() => expect(lines()).toHaveLength(2));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: 'workflow' } });
    fireEvent.click(screen.getByRole('button', { name: /Download/ }));
    await waitFor(() => expect(state.files).toEqual(['/org/logs/download?level=INFO&area=workflow']));
    const follow = screen.getByRole('button', { name: /Following/ });
    expect(follow).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(follow);
    expect(screen.getByRole('button', { name: /Follow/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('what is recorded: a level for each part; debug asks for how long and says it will switch itself back', async () => {
    show();
    fireEvent.click(await screen.findByRole('button', { name: /What is recorded/ }));
    const group = await screen.findByRole('group', { name: 'Level for each part' });
    expect(within(group).getByLabelText('Email')).toHaveValue('INFO');
    expect(screen.queryByLabelText('Keep debug on for')).toBeNull();
    fireEvent.change(within(group).getByLabelText('Workflow and automations'), { target: { value: 'DEBUG' } });
    fireEvent.change(within(group).getByLabelText('Email'), { target: { value: 'ERROR' } });
    fireEvent.change(screen.getByLabelText('Keep debug on for'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Keep lines for'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(state.calls.find((c) => c.method === 'PUT')?.body).toEqual({ levels: { submissions: 'INFO', workflow: 'DEBUG', mail: 'ERROR' }, keepDays: 7, debugHours: 4 }));
    expect(await screen.findByText('Saved. Debug runs for 4 hours, then goes back to Info by itself.')).toBeInTheDocument();
    expect(screen.getByText(/Debug is on for Workflow and automations until/)).toBeInTheDocument();
  });

  it('someone who may read the log but not manage the organisation sees the levels and cannot change them', async () => {
    state.can = false;
    show();
    fireEvent.click(await screen.findByRole('button', { name: /What is recorded/ }));
    expect(await screen.findByText(/Only someone who manages the organisation/)).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('times and facts are written the way a log writes them', () => {
    expect(lineTime('2026-10-09T10:00:03.250Z')).toMatch(/^2026-10-0\d \d{2}:\d{2}:03\.250$/);
    expect(factsOf({ form: 'LOAN', reason: 'two words', n: 3, ok: true })).toBe('form=LOAN  reason="two words"  n=3  ok=true');
  });
});

describe('the audit trail', () => {
  it('names every action in words, written or not, and says where from in words where it can', () => {
    expect(actionLabel('form.published')).toBe('Published a form');
    expect(actionLabel('extension.refreshed')).toBe('Refreshed an extension');
    expect(actionLabel('workflow.shared_saved')).toBe('Workflow: shared saved');
    expect(actionLabel('odd')).toBe('odd');
    expect(fromLabel('::1')).toBe('This computer');
    expect(fromLabel('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(fromLabel('')).toBe('');
  });
});
