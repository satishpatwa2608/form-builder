import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FormContainer } from './FormContainer';
import { createMockSubmissionAdapter, type SubmissionAdapter } from '../../adapters/submission/submission-adapter';
import { createMockDataSourceAdapter } from '../../adapters/data-source/data-source-adapter';
import type { FormDefinition, FormField, FormRule, SubmissionResult } from '../../types';

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

const kinds = [{ label: 'Goods', value: 'GOODS' }, { label: 'Service', value: 'SERVICE' }];
const lineFields = (parentId: string): FormField[] => [
  { id: 'i', type: 'TEXT', name: 'item', label: 'Item', required: true, parentId },
  { id: 'k', type: 'RADIO', name: 'kind', label: 'Kind', parentId, dataSource: { type: 'STATIC', options: kinds } },
  { id: 'q', type: 'NUMBER', name: 'qty', label: 'Qty', parentId },
  { id: 'p', type: 'NUMBER', name: 'price', label: 'Price', parentId },
  { id: 'l', type: 'NUMBER', name: 'lineTotal', label: 'Line total', parentId },
  { id: 's', type: 'TEXT', name: 'serial', label: 'Serial', parentId },
];
const rules: FormRule[] = [
  { id: 'line', then: [{ type: 'SET_VALUE', target: 'lineTotal', value: 'qty * price' }] },
  { id: 'tot', then: [{ type: 'SET_VALUE', target: 'total', value: 'sum(lineTotal)' }] },
  { id: 'serial', when: { expr: 'kind == "GOODS"' }, then: [{ type: 'SHOW', target: 'serial' }, { type: 'REQUIRE', target: 'serial' }] },
];

const order = (extra: Partial<FormDefinition> = {}, repeat: Partial<FormField> = {}): FormDefinition => ({
  id: 'order-v1',
  orgId: 'org',
  businessId: '',
  name: 'Order',
  code: 'ORDER',
  version: 1,
  status: 'PUBLISHED',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [
    { id: 'c', type: 'TEXT', name: 'customer', label: 'Customer' },
    { id: 'r', type: 'REPEAT', name: 'lines', label: 'Lines', validation: { min: 1, max: 3 }, props: { addLabel: 'Add a line', totals: ['lineTotal'] }, ...repeat },
    ...lineFields('r'),
    { id: 't', type: 'NUMBER', name: 'total', label: 'Total' },
  ],
  rules,
  createdBy: 'u',
  updatedBy: 'u',
  ...extra,
});

function renderForm(definition = order(), submission: SubmissionAdapter = createMockSubmissionAdapter({ delayMs: 0 })) {
  const onSubmitted = vi.fn<(r: SubmissionResult) => void>();
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FormContainer definition={definition} submissionAdapter={submission} dataSourceAdapter={createMockDataSourceAdapter({ delayMs: 0 })} onSubmitted={onSubmitted} />
    </QueryClientProvider>,
  );
  return { user, onSubmitted };
}

const row = (n: number) => screen.getByRole('group', { name: `Lines row ${n}` });
const input = (n: number, label: RegExp) => within(row(n)).getByLabelText(label) as HTMLInputElement;
const submit = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: /submit/i }));

describe('repeating section in the live form', () => {
  it('starts with the rows it must have, and adds and removes within its limits', async () => {
    const { user } = renderForm();
    expect(screen.getAllByRole('group', { name: /Lines row/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Remove row 1 of Lines' })).toBeDisabled();

    const add = screen.getByRole('button', { name: /Add a line/ });
    await user.click(add);
    await user.click(add);
    expect(screen.getAllByRole('group', { name: /Lines row/ })).toHaveLength(3);
    expect(add).toBeDisabled();
    expect(screen.getByText(/No more than 3/)).toBeInTheDocument();

    await user.type(input(1, /^Item/), 'first');
    await user.type(input(2, /^Item/), 'second');
    await user.type(input(3, /^Item/), 'third');
    await user.click(screen.getByRole('button', { name: 'Remove row 2 of Lines' }));
    expect(screen.getAllByRole('group', { name: /Lines row/ })).toHaveLength(2);
    expect([input(1, /^Item/).value, input(2, /^Item/).value]).toEqual(['first', 'third']);
  });

  it('calculates each row and the totals as the person types', async () => {
    const { user } = renderForm();
    await user.type(input(1, /^Qty/), '3');
    await user.type(input(1, /^Price/), '10');
    await waitFor(() => expect(input(1, /^Line total/).value).toBe('30'));
    expect(input(1, /^Line total/)).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /Add a line/ }));
    await user.type(input(2, /^Qty/), '2');
    await user.type(input(2, /^Price/), '0.1');
    await waitFor(() => expect(input(2, /^Line total/).value).toBe('0.2'));
    await waitFor(() => expect((screen.getByLabelText(/^Total/) as HTMLInputElement).value).toBe('30.2'));
    expect(screen.getByText('Total line total').nextSibling).toHaveTextContent('30.2');

    // Removing a row takes it out of the totals.
    await user.click(screen.getByRole('button', { name: 'Remove row 1 of Lines' }));
    await waitFor(() => expect((screen.getByLabelText(/^Total/) as HTMLInputElement).value).toBe('0.2'));
  });

  it('shows and requires a field in the row it applies to only', async () => {
    const { user, onSubmitted } = renderForm();
    await user.click(screen.getByRole('button', { name: /Add a line/ }));
    expect(within(row(1)).queryByLabelText(/^Serial/)).not.toBeInTheDocument();
    await user.click(within(row(2)).getByRole('radio', { name: 'Goods' }));
    expect(within(row(2)).getByLabelText(/^Serial/)).toBeInTheDocument();
    expect(within(row(1)).queryByLabelText(/^Serial/)).not.toBeInTheDocument();

    await user.type(input(1, /^Item/), 'Setup');
    await user.type(input(2, /^Item/), 'Pen');
    await submit(user);
    expect(onSubmitted).not.toHaveBeenCalled();
    const summary = (await screen.findByText(/Please fix this field/)).closest('[role="alert"]') as HTMLElement;
    const link = within(summary).getByRole('button', { name: /Lines, row 2: Serial.*Serial is required/ });
    await user.click(link);
    await waitFor(() => expect(input(2, /^Serial/)).toHaveFocus());
  });

  it('submits rows of computed answers', async () => {
    const { user, onSubmitted } = renderForm();
    await user.type(screen.getByLabelText(/^Customer/), 'Acme');
    await user.type(input(1, /^Item/), 'Pen');
    await user.click(within(row(1)).getByRole('radio', { name: 'Goods' }));
    await user.type(input(1, /^Qty/), '3');
    await user.type(input(1, /^Price/), '10');
    await user.type(input(1, /^Serial/), 'S1');
    await user.click(screen.getByRole('button', { name: /Add a line/ }));
    await user.type(input(2, /^Item/), 'Setup');
    await user.type(input(2, /^Qty/), '1');
    await user.type(input(2, /^Price/), '250');
    await submit(user);
    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
    expect(onSubmitted.mock.calls[0][0].payload).toEqual({
      customer: 'Acme',
      lines: [
        { item: 'Pen', kind: 'GOODS', qty: 3, price: 10, lineTotal: 30, serial: 'S1' },
        { item: 'Setup', qty: 1, price: 250, lineTotal: 250 },
      ],
      total: 280,
    });
  });

  it('says so when there are too few rows', async () => {
    const { user, onSubmitted } = renderForm(order({ rules: [] }, { validation: { min: 0, max: 3 }, required: true }));
    // Required: one row to start with. Remove is off, so the section can never be emptied by hand.
    expect(screen.getAllByRole('group', { name: /Lines row/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Remove row 1 of Lines' })).toBeDisabled();
    await submit(user);
    expect(onSubmitted).not.toHaveBeenCalled();
    expect((await screen.findAllByText('Item is required')).length).toBeGreaterThan(0);
  });

  it('an optional section starts empty and can stay that way', async () => {
    const { user, onSubmitted } = renderForm(order({ rules: [] }, { validation: undefined }));
    expect(screen.queryByRole('group', { name: /Lines row/ })).not.toBeInTheDocument();
    expect(screen.getByText('Nothing added yet.')).toBeInTheDocument();
    await submit(user);
    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
    expect(onSubmitted.mock.calls[0][0].payload).toEqual({ lines: [] });
  });

  it("shows the server's finding next to the row it is about", async () => {
    const refusing: SubmissionAdapter = { submit: async ({ payload }) => ({ ok: false, payload, error: 'Please check the fields', fieldErrors: [{ field: 'lines.0.qty', message: 'Out of stock' }] }) };
    const { user } = renderForm(order({ rules: [] }), refusing);
    await user.type(input(1, /^Item/), 'Pen');
    await submit(user);
    expect((await within(row(1)).findAllByText('Out of stock')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Lines, row 1: Qty.*Out of stock/ })).toBeInTheDocument();

    // It stays while other answers change, and goes when the answer it is about does.
    await user.type(input(1, /^Item/), 's');
    expect(within(row(1)).getAllByText('Out of stock').length).toBeGreaterThan(0);
    await user.type(input(1, /^Qty/), '2');
    await waitFor(() => expect(within(row(1)).queryByText('Out of stock')).not.toBeInTheDocument());
  });

  it('as a table it names the columns once and keeps each field labelled for screen readers', async () => {
    renderForm(order({}, { props: { layout: 'table', totals: [] } }));
    expect(document.querySelector('.fp-repeat--table .fp-repeat__cols')).toHaveTextContent('ItemKindQtyPriceLine totalSerial');
    expect(input(1, /^Qty/)).toBeInTheDocument();
  });

  it('in steps, a mistake in a row stops the move to the next step', async () => {
    const definition = order({
      rules: [],
      layout: { mode: 'steps' },
      fields: [
        { id: 's1', type: 'SECTION', name: 'first', label: 'Lines' },
        { id: 'r', type: 'REPEAT', name: 'lines', label: 'Lines', parentId: 's1', validation: { min: 1 } },
        ...lineFields('r'),
        { id: 's2', type: 'SECTION', name: 'second', label: 'Done' },
        { id: 'n', type: 'TEXT', name: 'note', label: 'Note', parentId: 's2' },
      ],
    });
    const { user } = renderForm(definition);
    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(screen.getByText('Step 1 of 2')).toBeInTheDocument();
    expect((await screen.findAllByText('Item is required')).length).toBeGreaterThan(0);
    await user.type(input(1, /^Item/), 'Pen');
    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(await screen.findByText('Step 2 of 2')).toBeInTheDocument();
  });
});
