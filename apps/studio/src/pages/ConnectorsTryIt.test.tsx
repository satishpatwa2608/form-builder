import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TryIt } from './ConnectorsPage';

const state = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], fail: '', calls: [] as { path: string; body?: any }[] }));
vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {
    fields: Record<string, string> = {};
  },
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : 'That did not work'),
  api: async (path: string, init?: { body?: any }) => {
    state.calls.push({ path, body: init?.body });
    if (state.fail) throw new Error(state.fail);
    return state.rows;
  },
}));

const entity = (key: string, label: string, fields: string[], operations = ['list']) => ({ key, label, fields, keyField: fields[0]!, operations, valueField: '', labelField: '' });
const connector = { id: 'c1', ref: 'crm', name: 'CRM', entities: [entity('customers', 'Customers', ['id', 'city']), entity('orders', 'Orders', ['id']), entity('audit', 'Audit log', ['id'], ['insert'])] } as never;

beforeEach(() => {
  state.rows = [];
  state.fail = '';
  state.calls = [];
});

describe('trying a connector', () => {
  it('reads the chosen table with the filters typed, and shows what a form would get', async () => {
    state.rows = [
      { id: 7, city: 'Pune', owner: { name: 'Asha' } },
      { id: 9, city: 'Pune', owner: null },
    ];
    render(<TryIt c={connector} />);
    // Only tables that can be read are offered.
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Customers', 'Orders']);
    fireEvent.change(screen.getByLabelText('Only where city is'), { target: { value: 'Pune' } });
    fireEvent.click(screen.getByRole('button', { name: 'Read now' }));
    const table = await screen.findByRole('table', { name: 'Rows that came back' });
    expect(state.calls.at(-1)).toEqual({ path: '/connectors/query', body: { key: '/connectors/crm/customers', params: { city: 'Pune' } } });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['id', 'city', 'owner']);
    expect(within(table).getByText('{"name":"Asha"}')).toBeInTheDocument();
    expect(screen.getByText(/2 rows\. This is what a form gets\./)).toBeInTheDocument();
  });

  it('no rows, and a failure, are each said plainly', async () => {
    render(<TryIt c={connector} />);
    fireEvent.click(screen.getByRole('button', { name: 'Read now' }));
    expect(await screen.findByText(/It answered, with no rows/)).toBeInTheDocument();
    state.fail = 'The CRM did not answer in time';
    fireEvent.click(screen.getByRole('button', { name: 'Read now' }));
    expect(await screen.findByText('The CRM did not answer in time')).toBeInTheDocument();
  });

  it('a long answer shows its first twenty rows and says how many there were', async () => {
    state.rows = Array.from({ length: 45 }, (_, i) => ({ id: i }));
    render(<TryIt c={connector} />);
    fireEvent.click(screen.getByRole('button', { name: 'Read now' }));
    expect(await screen.findByText(/The first 20 of 45 rows\./)).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(21);
  });
});
