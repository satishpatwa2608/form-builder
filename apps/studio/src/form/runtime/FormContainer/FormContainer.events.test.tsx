import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FormContainer } from './FormContainer';
import { createMockSubmissionAdapter, type SubmissionAdapter } from '../../adapters/submission/submission-adapter';
import type { DataSourceAdapter } from '../../adapters/data-source/data-source-adapter';
import type { FormDefinition, FormEvent, FormField } from '../../types';

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

const flat: FormField[] = [
  { id: 'f1', type: 'EMAIL', name: 'email', label: 'Email' },
  { id: 'f2', type: 'BUTTON', name: 'find', label: 'Find me' },
  { id: 'f3', type: 'TEXT', name: 'fullName', label: 'Full name' },
  { id: 'f4', type: 'PHONE', name: 'phone', label: 'Phone' },
  { id: 'f5', type: 'DATE', name: 'visitOn', label: 'Visit on' },
  { id: 'f6', type: 'NUMBER', name: 'amount', label: 'Amount' },
  { id: 'f7', type: 'BUTTON', name: 'idle', label: 'Does nothing' },
];

const form = (events: FormEvent[], extra: Partial<FormDefinition> = {}): FormDefinition => ({
  id: 'visit-v1',
  orgId: 'org',
  businessId: '',
  name: 'Visit',
  code: 'VISIT',
  version: 1,
  status: 'PUBLISHED',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit', success: { type: 'MESSAGE', message: 'Thanks, all done.' } },
  fields: flat,
  events,
  createdBy: 'u',
  updatedBy: 'u',
  ...extra,
});

const lookup: FormEvent = {
  id: 'find',
  on: { type: 'CLICK', field: 'find' },
  do: [{ type: 'FETCH', source: { url: 'customers', method: 'GET', params: { email: '{{email}}' } }, set: { fullName: 'name', phone: 'contact.phone' } }],
};

function renderForm(definition: FormDefinition, opts: { rows?: Record<string, unknown>[] | Error; submission?: SubmissionAdapter } = {}) {
  const fetchRows = vi.fn<DataSourceAdapter['fetchRows']>(async () => {
    if (opts.rows instanceof Error) throw opts.rows;
    return opts.rows ?? [];
  });
  const onNavigate = vi.fn();
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FormContainer
        definition={definition}
        systemContext={{ now: new Date('2026-10-08T08:00:00.000Z'), timeZone: 'UTC' }}
        submissionAdapter={opts.submission ?? createMockSubmissionAdapter({ delayMs: 0 })}
        dataSourceAdapter={{ fetchRows }}
        onNavigate={onNavigate}
      />
    </QueryClientProvider>,
  );
  return { user, fetchRows, onNavigate };
}

const value = (label: RegExp) => (screen.getByLabelText(label) as HTMLInputElement).value;

describe('FormContainer — form events', () => {
  it('fills a field when the form opens, and leaves it for the person to change', async () => {
    const { user } = renderForm(form([{ id: 'open', on: { type: 'LOAD' }, do: [{ type: 'SET_VALUE', target: 'visitOn', value: 'dateAdd(today(), 7)' }] }]));
    await waitFor(() => expect(value(/^Visit on/)).toBe('2026-10-15'));
    const date = screen.getByLabelText(/^Visit on/);
    expect(date).not.toBeDisabled();
    await user.clear(date);
    await user.type(date, '2026-11-01');
    expect(value(/^Visit on/)).toBe('2026-11-01');
  });

  it('a button looks a row up and fills fields from it', async () => {
    const { user, fetchRows } = renderForm(form([lookup]), { rows: [{ name: 'Asha Rao', contact: { phone: '+91 98765 43210' }, secret: 'x' }] });
    expect(screen.getByRole('button', { name: 'Does nothing' })).toBeDisabled();
    await user.type(screen.getByLabelText(/^Email/), 'asha@example.com');
    await user.click(screen.getByRole('button', { name: 'Find me' }));
    await waitFor(() => expect(value(/^Full name/)).toBe('Asha Rao'));
    expect(value(/^Phone/)).toBe('+91 98765 43210');
    expect(fetchRows).toHaveBeenCalledWith(expect.objectContaining({ url: 'customers', method: 'GET' }), { email: 'asha@example.com' });
  });

  it('says so when the look-up has nothing to go on, finds nothing, or fails', async () => {
    const empty = renderForm(form([lookup]), { rows: [] });
    await empty.user.click(screen.getByRole('button', { name: 'Find me' }));
    expect(await screen.findByText('Fill in the fields this looks up by first.')).toBeInTheDocument();
    expect(empty.fetchRows).not.toHaveBeenCalled();
    await empty.user.type(screen.getByLabelText(/^Email/), 'who@example.com');
    await empty.user.click(screen.getByRole('button', { name: 'Find me' }));
    expect(await screen.findByText('Nothing was found.')).toBeInTheDocument();
    expect(value(/^Full name/)).toBe('');
  });

  it('a failed look-up leaves the form usable', async () => {
    const { user } = renderForm(form([lookup]), { rows: new Error('boom') });
    await user.type(screen.getByLabelText(/^Email/), 'who@example.com');
    await user.click(screen.getByRole('button', { name: 'Find me' }));
    expect(await screen.findByText('That could not be looked up. Please try again.')).toBeInTheDocument();
  });

  it('only runs when its condition holds, and never reads outside the row', async () => {
    const guarded: FormEvent = { ...lookup, when: { expr: 'amount > 10' }, do: [{ type: 'FETCH', source: { url: 'customers', method: 'GET' }, set: { fullName: 'constructor.name', phone: '__proto__.x' } }] };
    const { user, fetchRows } = renderForm(form([guarded]), { rows: [{ name: 'Asha' }] });
    await user.click(screen.getByRole('button', { name: 'Find me' }));
    expect(fetchRows).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText(/^Amount/), '11');
    await user.click(screen.getByRole('button', { name: 'Find me' }));
    await waitFor(() => expect(fetchRows).toHaveBeenCalled());
    expect(value(/^Full name/)).toBe('');
  });

  it('when an answer changes: one look-up after the typing stops, not one per key, and nothing said while it is empty', async () => {
    const onChange: FormEvent = { ...lookup, id: 'auto', on: { type: 'CHANGE', field: 'email' } };
    const { user, fetchRows } = renderForm(form([onChange]), { rows: [{ name: 'Asha Rao', contact: { phone: '98200 00000' } }] });
    // Opening the form with nothing typed looks nothing up.
    await new Promise((r) => setTimeout(r, 700));
    expect(fetchRows).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/^Email/), 'asha@acme.test');
    await waitFor(() => expect(value(/^Full name/)).toBe('Asha Rao'), { timeout: 3000 });
    expect(value(/^Phone/)).toBe('98200 00000');
    expect(fetchRows).toHaveBeenCalledTimes(1);
    expect(fetchRows.mock.calls[0]![1]).toEqual({ email: 'asha@acme.test' });

    // Emptied again: no look-up, and no complaint about it.
    await user.clear(screen.getByLabelText(/^Email/));
    await new Promise((r) => setTimeout(r, 700));
    expect(fetchRows).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('when an answer changes: an answer an event fills in does not set off the event that waits on it', async () => {
    const chain: FormEvent[] = [
      { id: 'a', on: { type: 'CHANGE', field: 'email' }, do: [{ type: 'SET_VALUE', target: 'fullName', value: '"From email"' }] },
      { id: 'b', on: { type: 'CHANGE', field: 'fullName' }, do: [{ type: 'SET_VALUE', target: 'phone', value: '"Typed by a person"' }] },
    ];
    const { user } = renderForm(form(chain));
    await user.type(screen.getByLabelText(/^Email/), 'a@b.test');
    await waitFor(() => expect(value(/^Full name/)).toBe('From email'), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 800));
    expect(value(/^Phone/)).toBe('');
    // The person changing it themselves does.
    await user.type(screen.getByLabelText(/^Full name/), '!');
    await waitFor(() => expect(value(/^Phone/)).toBe('Typed by a person'), { timeout: 3000 });
  });

  it('a button opens another step', async () => {
    const steps: FormField[] = [
      { id: 's1', type: 'SECTION', name: 'about', label: 'About you' },
      { id: 'a1', type: 'TEXT', name: 'who', label: 'Who', parentId: 's1' },
      { id: 'a2', type: 'BUTTON', name: 'skip', label: 'Skip to the end', parentId: 's1' },
      { id: 's2', type: 'SECTION', name: 'middle', label: 'Details' },
      { id: 'b1', type: 'TEXT', name: 'what', label: 'What', parentId: 's2' },
      { id: 's3', type: 'SECTION', name: 'last', label: 'Finish' },
      { id: 'c1', type: 'TEXT', name: 'note', label: 'Note', parentId: 's3' },
    ];
    const { user } = renderForm(form([{ id: 'skip', on: { type: 'CLICK', field: 'skip' }, do: [{ type: 'GO_TO_STEP', step: 'last' }] }], { fields: steps, layout: { mode: 'steps' } }));
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Skip to the end' }));
    expect(await screen.findByText('Step 3 of 3')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Note/)).toBeInTheDocument();
  });

  const afterSubmit: FormEvent[] = [
    { id: 'big', on: { type: 'SUBMIT_SUCCESS' }, when: { expr: 'amount > 5000' }, do: [{ type: 'SHOW_MESSAGE', message: 'A manager will call you.' }] },
    { id: 'vip', on: { type: 'SUBMIT_SUCCESS' }, when: { expr: 'amount > 90000' }, do: [{ type: 'REDIRECT', url: '/vip' }] },
    { id: 'down', on: { type: 'SUBMIT_ERROR' }, do: [{ type: 'SHOW_MESSAGE', message: 'Please call 1800 000 000 instead.' }] },
  ];
  const submitWith = async (amount: string, submission?: SubmissionAdapter) => {
    const r = renderForm(form(afterSubmit), { submission });
    await r.user.type(screen.getByLabelText(/^Amount/), amount);
    await r.user.click(screen.getByRole('button', { name: /submit/i }));
    return r;
  };

  it('ends with the standard message when no event applies', async () => {
    await submitWith('10');
    expect(await screen.findByText('Thanks, all done.')).toBeInTheDocument();
  });

  it('ends with the message of the event that applies', async () => {
    await submitWith('6000');
    expect(await screen.findByText('A manager will call you.')).toBeInTheDocument();
    expect(screen.queryByText('Thanks, all done.')).not.toBeInTheDocument();
  });

  it('a redirect wins over a message', async () => {
    const { onNavigate } = await submitWith('95000');
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('/vip'));
  });

  it("shows the form's own text when the submit fails", async () => {
    await submitWith('10', { submit: async ({ payload }) => ({ ok: false, payload, error: 'Internal server error' }) });
    expect(await screen.findByText('Please call 1800 000 000 instead.')).toBeInTheDocument();
    expect(screen.queryByText('Internal server error')).not.toBeInTheDocument();
  });
});
