import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TryIt, TryWrite } from './ConnectorsPage';

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

describe('trying a write on a connector', () => {
  const writable = { ...(connector as object), entities: [entity('customers', 'Customers', ['id', 'city']), entity('leads', 'Leads', ['email', 'name'], ['insert'])] } as never;

  it('offers only tables that take new rows, and adds nothing until values are typed and the box is ticked', async () => {
    state.rows = { added: 1, row: { id: 31, email: 'a@b.test' } } as never;
    render(<TryWrite c={writable} />);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Leads']);
    const add = screen.getByRole('button', { name: 'Add the row' });
    expect(add).toBeDisabled();
    fireEvent.change(screen.getByLabelText('email'), { target: { value: 'a@b.test' } });
    expect(add).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /adds a real row to CRM/ }));
    fireEvent.click(add);
    expect(await screen.findByText(/One row was added\. It came back as: \{"id":31/)).toBeInTheDocument();
    expect(state.calls.at(-1)).toEqual({ path: '/connectors/c1/try-insert', body: { entity: 'leads', values: { email: 'a@b.test' } } });
    // The tick does not stay on for the next one.
    expect(screen.getByRole('checkbox', { name: /adds a real row to CRM/ })).not.toBeChecked();
  });

  it('what the other system refuses is said in its words', async () => {
    state.fail = 'The CRM said: email is already taken';
    render(<TryWrite c={writable} />);
    fireEvent.change(screen.getByLabelText('email'), { target: { value: 'a@b.test' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /adds a real row to CRM/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add the row' }));
    expect(await screen.findByText('The CRM said: email is already taken')).toBeInTheDocument();
  });
});
