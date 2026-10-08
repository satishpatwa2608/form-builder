import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FormContainer } from './FormContainer';
import { createMockSubmissionAdapter } from '../../adapters/submission/submission-adapter';
import { createMockDataSourceAdapter } from '../../adapters/data-source/data-source-adapter';
import type { FormDefinition, FormRule, SubmissionResult } from '../../types';

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

const sizes = ['Small', 'Medium', 'Large'].map((label) => ({ label, value: label.toUpperCase() }));

const claim = (rules: FormRule[]): FormDefinition => ({
  id: 'expense-v1',
  orgId: 'org',
  businessId: '',
  name: 'Expense claim',
  code: 'EXPENSE',
  version: 1,
  status: 'PUBLISHED',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [
    { id: 'f1', type: 'NUMBER', name: 'quantity', label: 'Quantity' },
    { id: 'f2', type: 'NUMBER', name: 'unitPrice', label: 'Unit price' },
    { id: 'f3', type: 'NUMBER', name: 'total', label: 'Total' },
    { id: 'f4', type: 'TEXTAREA', name: 'justification', label: 'Justification' },
    { id: 'f5', type: 'TEXT', name: 'approver', label: 'Approver' },
    { id: 'f6', type: 'DATE', name: 'spentOn', label: 'Spent on' },
    { id: 'f7', type: 'CHECKBOX', name: 'kids', label: 'Kids range' },
    { id: 'f8', type: 'RADIO', name: 'size', label: 'Size', dataSource: { type: 'STATIC', options: sizes } },
  ],
  rules,
  createdBy: 'u',
  updatedBy: 'u',
});

const rules: FormRule[] = [
  { id: 'total', then: [{ type: 'SET_VALUE', target: 'total', value: 'quantity * unitPrice' }] },
  {
    id: 'big',
    when: { expr: 'total > 5000' },
    then: [
      { type: 'SHOW', target: 'approver' },
      { type: 'REQUIRE', target: 'justification' },
    ],
  },
  { id: 'date', when: { expr: 'spentOn > today()' }, then: [{ type: 'ERROR', target: 'spentOn', message: 'Cannot be in the future' }] },
  { id: 'kids', when: { field: 'kids', operator: 'equals', value: true }, then: [{ type: 'SET_OPTIONS', target: 'size', values: ['SMALL'] }] },
  { id: 'lock', when: { expr: 'quantity > 100' }, then: [{ type: 'DISABLE', target: 'unitPrice' }] },
];

function renderForm(definition = claim(rules)) {
  const onSubmitted = vi.fn<(r: SubmissionResult) => void>();
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FormContainer
        definition={definition}
        systemContext={{ now: new Date('2026-10-08T08:00:00.000Z'), timeZone: 'UTC' }}
        submissionAdapter={createMockSubmissionAdapter({ delayMs: 0 })}
        dataSourceAdapter={createMockDataSourceAdapter({ delayMs: 0 })}
        onSubmitted={onSubmitted}
      />
    </QueryClientProvider>,
  );
  return { user, onSubmitted };
}

const submit = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: /submit/i }));

describe('FormContainer — form rules', () => {
  it('shows a calculated value as the person types, in a field they cannot edit', async () => {
    const { user } = renderForm();
    const total = screen.getByLabelText(/^Total/) as HTMLInputElement;
    expect(total).toBeDisabled();
    await user.type(screen.getByLabelText(/^Quantity/), '3');
    await user.type(screen.getByLabelText(/^Unit price/), '25');
    await waitFor(() => expect(total.value).toBe('75'));
    await user.clear(screen.getByLabelText(/^Quantity/));
    await user.type(screen.getByLabelText(/^Quantity/), '4');
    await waitFor(() => expect(total.value).toBe('100'));
  });

  it('shows, requires and disables fields from the calculated value', async () => {
    const { user, onSubmitted } = renderForm();
    expect(screen.queryByLabelText(/^Approver/)).not.toBeInTheDocument();
    // Price first: over 100 units the price locks.
    await user.type(screen.getByLabelText(/^Unit price/), '100');
    await user.type(screen.getByLabelText(/^Quantity/), '101');
    expect(await screen.findByLabelText(/^Approver/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/^Unit price/)).toBeDisabled());

    await submit(user);
    expect((await screen.findAllByText('Justification is required')).length).toBeGreaterThan(0);
    expect(onSubmitted).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/^Justification/), 'Team offsite');
    await submit(user);
    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
    expect(onSubmitted.mock.calls[0][0].payload).toMatchObject({ quantity: 101, unitPrice: 100, total: 10100, justification: 'Team offsite' });
  });

  it("shows a rule's error next to its field and blocks the submit", async () => {
    const { user, onSubmitted } = renderForm();
    await user.type(screen.getByLabelText(/^Spent on/), '2026-12-25');
    await submit(user);
    expect((await screen.findAllByText('Cannot be in the future')).length).toBeGreaterThan(0);
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('narrows an option list and drops a choice that is no longer offered', async () => {
    const { user, onSubmitted } = renderForm();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    await user.click(screen.getByRole('radio', { name: 'Large' }));
    await user.click(screen.getByRole('checkbox', { name: /Kids range/ }));
    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(1));
    expect(screen.getByRole('radio', { name: 'Small' })).not.toBeChecked();

    await submit(user);
    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
    expect(onSubmitted.mock.calls[0][0].payload).not.toHaveProperty('size');
  });

  it('a form without rules is unchanged', async () => {
    const { user, onSubmitted } = renderForm(claim([]));
    expect(screen.getByLabelText(/^Total/)).not.toBeDisabled();
    await user.type(screen.getByLabelText(/^Total/), '9');
    await submit(user);
    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
    expect(onSubmitted.mock.calls[0][0].payload).toMatchObject({ total: 9 });
  });
});
