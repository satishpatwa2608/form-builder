import { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FormDefinition } from '../../types';
import { FormSettingsPanel } from './FormSettingsPanel';

vi.mock('../../../lib/auth', () => ({ useAuth: () => ({ me: { user: { id: 'u1', name: 'Asha', email: 'a@x.test' } }, can: () => true }) }));
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

const form = (over: Partial<FormDefinition> = {}): FormDefinition => ({
  id: 'f1',
  orgId: 'o1',
  businessId: '',
  name: 'Workshop',
  code: 'WORKSHOP',
  version: 1,
  status: 'DRAFT',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [
    { id: 'n', type: 'TEXT', name: 'name', label: 'Name' },
    { id: 's', type: 'NUMBER', name: 'seats', label: 'Seats' },
    { id: 'f', type: 'NUMBER', name: 'fee', label: 'Fee to pay' },
    { id: 'r', type: 'REPEAT', name: 'lines', label: 'Lines' },
    { id: 'a', type: 'NUMBER', name: 'lineAmount', label: 'Line amount', parentId: 'r' },
  ],
  createdBy: 'u1',
  updatedBy: 'u1',
  ...over,
});
function show(initial: FormDefinition) {
  const spy = vi.fn<(f: FormDefinition) => void>();
  function Panel() {
    const [current, setCurrent] = useState(initial);
    return (
      <FormSettingsPanel
        form={current}
        readOnly={false}
        codeLocked={false}
        onChange={(changes) =>
          setCurrent((f) => {
            const next = { ...f, ...changes };
            spy(next);
            return next;
          })
        }
      />
    );
  }
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Panel />
    </QueryClientProvider>,
  );
  return () => spy.mock.calls.at(-1)![0].payment;
}

describe('Taking a payment, in a form\'s settings', () => {
  it('switched on, it asks which number is the amount (not one inside rows) and the currency', async () => {
    const payment = show(form());
    expect(screen.queryByLabelText('Amount to pay')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('switch', { name: 'Take a payment with each response' }));
    expect(payment()).toEqual({ enabled: true, amountField: 'seats', currency: 'INR' });
    await userEvent.click(screen.getByRole('combobox', { name: 'Amount to pay' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Seats', 'Fee to pay']);
    await userEvent.click(screen.getByRole('option', { name: 'Fee to pay' }));
    await userEvent.click(screen.getByRole('combobox', { name: 'Currency' }));
    await userEvent.click(screen.getByRole('option', { name: 'Canadian dollar (CAD)' }));
    await userEvent.type(screen.getByLabelText('What the payment is for'), 'Seats');
    expect(payment()).toEqual({ enabled: true, amountField: 'fee', currency: 'CAD', description: 'Seats' });
  });

  it('switched off, the choices are kept for when it is switched on again', async () => {
    const payment = show(form({ payment: { enabled: true, amountField: 'fee', currency: 'USD' } }));
    await userEvent.click(screen.getByRole('switch', { name: 'Take a payment with each response' }));
    expect(payment()).toEqual({ enabled: false, amountField: 'fee', currency: 'USD' });
    expect(screen.queryByLabelText('Amount to pay')).not.toBeInTheDocument();
  });

  it('a form with no number to charge says to add one', async () => {
    show(form({ fields: [{ id: 'n', type: 'TEXT', name: 'name', label: 'Name' }] }));
    await userEvent.click(screen.getByRole('switch', { name: 'Take a payment with each response' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Add a number field for the amount first.');
  });
});
