import { beforeAll, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FormDefinition } from '../../types';
import { exampleAnswers } from '../../engine';
import { PreviewDialog } from './PreviewDialog';

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

const form: FormDefinition = {
  id: 'f',
  orgId: 'o',
  businessId: '',
  name: 'Order',
  code: 'ORDER',
  version: 1,
  status: 'DRAFT',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [
    { id: 'n', type: 'TEXT', name: 'customer', label: 'Customer', required: true },
    { id: 'e', type: 'EMAIL', name: 'email', label: 'Email' },
    { id: 'q', type: 'NUMBER', name: 'quantity', label: 'Quantity', validation: { min: 2, max: 9 } },
    { id: 'p', type: 'NUMBER', name: 'price', label: 'Price' },
    { id: 't', type: 'NUMBER', name: 'total', label: 'Total' },
    { id: 'u', type: 'FILE', name: 'receipt', label: 'Receipt' },
  ],
  rules: [{ id: 'r', then: [{ type: 'SET_VALUE', target: 'total', value: 'quantity * price' }] }],
  createdBy: 'u',
  updatedBy: 'u',
};
const value = (label: RegExp) => (screen.getByLabelText(label) as HTMLInputElement).value;
const open = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PreviewDialog form={form} open onOpenChange={() => undefined} />
    </QueryClientProvider>,
  );

describe('previewing a form with example answers', () => {
  it('the answers fit each question, optional ones too when asked, and what a rule works out follows from them', async () => {
    const least = await exampleAnswers(form);
    expect(least.values).toMatchObject({ customer: expect.any(String) });
    expect(least.values.email).toBeUndefined();
    const full = await exampleAnswers(form, { everything: true });
    expect(full.problems).toEqual({});
    expect(full.values).toMatchObject({ email: 'tester@example.test', quantity: 2 });
    expect(full.values.total).toBe((full.values.quantity as number) * (full.values.price as number));
    // No way was given to add a file, so the file question is left alone.
    expect(full.values.receipt).toBeUndefined();
  });

  it('one press fills the preview; another empties it', async () => {
    const user = userEvent.setup();
    open();
    expect(value(/^Customer/)).toBe('');
    await user.click(screen.getByRole('button', { name: 'Fill with example answers' }));
    await waitFor(() => expect(value(/^Customer/)).not.toBe(''));
    expect(value(/^Email/)).toBe('tester@example.test');
    expect(value(/^Quantity/)).toBe('2');
    await user.click(screen.getByRole('button', { name: 'Empty it again' }));
    await waitFor(() => expect(value(/^Customer/)).toBe(''));
  });
});
