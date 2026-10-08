import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import WorkDashboardPage from './WorkDashboardPage';

vi.mock('../../lib/auth', () => ({ useAuth: () => ({ me: { user: { id: 'u1', name: 'Asha Rao', email: 'a@x.test' } }, can: () => false }) }));

vi.mock('../adapters/workflow', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../adapters/workflow')>()),
  recordsAvailable: true,
  useWorkSettings: () => ({ data: { inboxTheme: 'ocean' } }),
  useWorkDashboard: () => ({
    isLoading: false,
    data: {
      days: 30,
      me: { open: 4, overdue: 1, dueToday: 2, waitingMyApproval: 3, resolvedToday: 5 },
      team: {
        open: 12,
        unassigned: 2,
        overdue: 3,
        escalated: 1,
        byAssignee: [
          { userId: 'u1', name: 'Asha', open: 8, overdue: 2 },
          { userId: '', name: 'Unassigned', open: 2, overdue: 0 },
        ],
        byForm: [{ formCode: 'CUSTOMER_COMPLAINT', open: 12 }],
        byPriority: [{ priority: 'CRITICAL', open: 3 }],
      },
      performance: {
        created: 20,
        resolved: 10,
        slaCompliance: 70,
        avgResolutionHours: 30.5,
        avgFirstResponseHours: 1.2,
        reopenRate: 10,
        trend: [
          { date: '2026-09-29', raised: 12, resolved: 4 },
          { date: '2026-09-30', raised: 8, resolved: 6 },
        ],
      },
    },
  }),
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.scrollIntoView ??= () => {};
});

describe('Work dashboard', () => {
  it('shows my cards, team workload and SLA performance; cards open the matching Inbox view', async () => {
    const open = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <WorkDashboardPage onOpenView={open} />
      </QueryClientProvider>,
    );
    const mine = screen.getByLabelText('My work');
    await user.click(within(mine).getByRole('button', { name: /Waiting for my approval/ }));
    expect(open).toHaveBeenCalledWith('approvals');
    await user.click(within(screen.getByLabelText('Team')).getByRole('button', { name: /Unassigned/ }));
    expect(open).toHaveBeenLastCalledWith('unassigned');

    // Greeting, and the org's theme.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/, Asha$/);
    expect(container.querySelector('.wi')).toHaveAttribute('data-theme', 'ocean');
    // Overdue work stands out.
    expect(within(mine).getByRole('button', { name: /Overdue/ })).toHaveClass('wd-kpi--bad');

    const perf = screen.getByLabelText('Performance');
    expect(within(perf).getByText('70%')).toHaveClass('wd-bad'); // under 80% within SLA
    expect(within(perf).getByText('30.5 h')).toBeInTheDocument();
    expect(within(perf).getByText('Raised 20')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Open by person')).getByText('Asha')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Open by priority')).getByText('Critical')).toBeInTheDocument();
  });
});
