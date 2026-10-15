import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkReport } from '../adapters/workflow';
import WorkReportsPage, { duration, reportCsv } from './WorkReportsPage';

const REPORT: WorkReport = {
  days: 30,
  from: '2026-09-16T00:00:00.000Z',
  to: '2026-10-16T00:00:00.000Z',
  by: 'field:property',
  choices: [
    { value: 'field:property', label: 'Which property?' },
    { value: 'team', label: 'Team' },
    { value: 'priority', label: 'Priority' },
  ],
  teams: ['Electrical', 'Plumbing'],
  groups: [
    { key: 'A', label: 'Tower A', opened: 3, resolved: 3, openNow: 0, overdueNow: 0, medianResolveHours: 4 },
    { key: 'B', label: 'Tower B', opened: 2, resolved: 0, openNow: 2, overdueNow: 1, medianResolveHours: null },
  ],
  total: { opened: 5, resolved: 3, openNow: 2, overdueNow: 1, medianResolveHours: 4 },
  partial: false,
};

const asked = vi.hoisted(() => ({ calls: [] as unknown[], report: null as unknown }));
vi.mock('../adapters/workflow', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../adapters/workflow')>()),
  recordsAvailable: true,
  useWorkReport: (params: unknown) => {
    asked.calls.push(params);
    return { data: asked.report, isLoading: false, error: null };
  },
}));
vi.mock('../adapters/registry/useFormRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../adapters/registry/useFormRegistry')>()),
  useFormDefinitions: () => ({ data: [{ code: 'MAINT', name: 'Maintenance complaint', workflow: { enabled: true, statuses: [] } }], isLoading: false }),
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});
beforeEach(() => {
  asked.calls = [];
  asked.report = REPORT;
});

describe('reports', () => {
  it('shows each group side by side with a total, and the times as a person reads them', () => {
    render(<WorkReportsPage />);
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Which property?' })).toBeInTheDocument();
    const a = within(table).getByRole('row', { name: /Tower A/ });
    expect(within(a).getAllByRole('cell').map((c) => c.textContent)).toEqual(['3', '3', '4 h', '0', '0']);
    const b = within(table).getByRole('row', { name: /Tower B/ });
    expect(within(b).getAllByRole('cell').map((c) => c.textContent)).toEqual(['2', '0', '—', '2', '1']);
    expect(within(table).getByRole('row', { name: /Total/ })).toHaveTextContent('5');
    expect(screen.getByRole('combobox', { name: 'Team' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('asks again for what is chosen', async () => {
    const user = userEvent.setup();
    render(<WorkReportsPage />);
    await user.click(screen.getByRole('combobox', { name: 'Team' }));
    await user.click(await screen.findByRole('option', { name: 'Plumbing' }));
    expect(asked.calls.at(-1)).toMatchObject({ team: 'Plumbing', days: 30 });
    await user.click(screen.getByRole('combobox', { name: 'Compare by' }));
    await user.click(await screen.findByRole('option', { name: 'Priority' }));
    expect(asked.calls.at(-1)).toMatchObject({ by: 'priority' });
    await user.click(screen.getByRole('combobox', { name: 'Form' }));
    await user.click(await screen.findByRole('option', { name: 'Maintenance complaint' }));
    // Another form: its own questions, so the choice starts again.
    expect(asked.calls.at(-1)).toMatchObject({ formCode: 'MAINT', by: undefined });
  });

  it('says when the numbers are of part of the records only, and when there is nothing', () => {
    asked.report = { ...REPORT, partial: true };
    const { unmount } = render(<WorkReportsPage />);
    expect(screen.getByRole('status')).toHaveTextContent('these numbers are of the first 50,000');
    unmount();
    asked.report = { ...REPORT, groups: [], total: { opened: 0, resolved: 0, openNow: 0, overdueNow: 0, medianResolveHours: null } };
    render(<WorkReportsPage />);
    expect(screen.getByText('Nothing was opened or resolved in this period, and nothing is open.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download CSV/ })).toBeDisabled();
  });

  it('times: minutes when short, hours, days when long', () => {
    expect([null, 0, 0.25, 4, 47.5, 72].map(duration)).toEqual(['—', '< 5 min', '15 min', '4 h', '47.5 h', '3 days']);
  });

  it('the CSV is what is shown, and a name a spreadsheet would run as a formula is made harmless', () => {
    const csv = reportCsv({ ...REPORT, groups: [...REPORT.groups, { key: 'x', label: '=HYPERLINK("http://evil")', opened: 1, resolved: 0, openNow: 1, overdueNow: 0, medianResolveHours: null }] }, { form: 'Maintenance complaint', team: 'All teams' });
    expect(csv.split('\n')).toEqual([
      'Report: Maintenance complaint,16 Sep 2026 to 16 Oct 2026,All teams',
      'Which property?,Opened,Resolved,Median hours to resolve,Open now,Overdue now',
      'Tower A,3,3,4,0,0',
      'Tower B,2,0,,2,1',
      `"'=HYPERLINK(""http://evil"")",1,0,,1,0`,
      'Total,5,3,4,2,1',
      '',
    ]);
  });
});
