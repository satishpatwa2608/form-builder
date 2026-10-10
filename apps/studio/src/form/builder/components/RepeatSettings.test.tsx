import { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FormDefinition, FormField } from '../../types';
import { FieldConfigPanel } from './FieldConfigPanel';

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
  submission: { method: 'POST', endpointId: 'x' },
  fields: [
    { id: 'c', type: 'TEXT', name: 'customer', label: 'Customer' },
    { id: 'r', type: 'REPEAT', name: 'lines', label: 'Lines', validation: { min: 1 }, props: { layout: 'cards' } },
    { id: 'i', type: 'TEXT', name: 'item', label: 'Item', parentId: 'r' },
    { id: 'q', type: 'NUMBER', name: 'qty', label: 'Qty', parentId: 'r' },
    { id: 'p', type: 'NUMBER', name: 'price', label: 'Price', parentId: 'r' },
  ],
  createdBy: 'u',
  updatedBy: 'u',
};

function Panel({ fieldId, spy }: { fieldId: string; spy: (f: FormField) => void }) {
  const [def, setDef] = useState(form);
  const field = def.fields.find((f) => f.id === fieldId)!;
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FieldConfigPanel
        field={field}
        form={def}
        readOnly={false}
        onChange={(changes) =>
          setDef((d) => {
            const next = { ...field, ...changes };
            spy(next);
            return { ...d, fields: d.fields.map((f) => (f.id === fieldId ? next : f)) };
          })
        }
        onFormChange={() => {}}
        onSetColumns={() => {}}
      />
    </QueryClientProvider>
  );
}

const last = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.at(-1)![0] as FormField;

describe('repeating section settings', () => {
  it('sets the title, limits, add text and totals', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    render(<Panel fieldId="r" spy={spy} />);
    expect(screen.getByText('Repeating section block')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Title'));
    await user.type(screen.getByLabelText('Title'), 'Order lines');
    await user.type(screen.getByLabelText('Add button text'), 'Add a line');
    await user.type(screen.getByLabelText('Rows at most'), '999');
    expect(last(spy)).toMatchObject({ label: 'Order lines', props: { addLabel: 'Add a line' }, validation: { min: 1, max: 200 } });

    // Only the number fields inside can be totalled.
    expect(screen.queryByRole('switch', { name: 'Item' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Price' }));
    await user.click(screen.getByRole('switch', { name: 'Qty' }));
    expect(last(spy).props?.totals).toEqual(['qty', 'price']);
  });

  it('a field inside a section is not offered what cannot work there', async () => {
    const user = userEvent.setup();
    render(<Panel fieldId="i" spy={vi.fn()} />);
    expect(screen.queryByText('Fill from signed-in user')).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Logic' }));
    expect(screen.queryByText('Clear this field when these change')).not.toBeInTheDocument();
    expect(screen.getByText('Show only when…')).toBeInTheDocument();
  });

  it('a field outside is still offered them', async () => {
    const user = userEvent.setup();
    render(<Panel fieldId="c" spy={vi.fn()} />);
    expect(screen.getByText('Fill from signed-in user')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Logic' }));
    expect(screen.getByText('Clear this field when these change')).toBeInTheDocument();
  });

  it('a question can be marked Sensitive; a repeating section itself cannot (its questions can)', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    const first = render(<Panel fieldId="c" spy={spy} />);
    await user.click(screen.getByRole('switch', { name: 'Sensitive' }));
    expect(last(spy).sensitive).toBe(true);
    expect(screen.getByText(/stored encrypted/)).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Sensitive' }));
    expect(last(spy).sensitive).toBeUndefined();
    first.unmount();
    render(<Panel fieldId="r" spy={spy} />);
    expect(screen.queryByRole('switch', { name: 'Sensitive' })).not.toBeInTheDocument();
  });

  it('the number of rows can follow a number question outside the section, and only such a question', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    render(<Panel fieldId="r" spy={spy} />);
    await user.click(screen.getByRole('combobox', { name: 'How many rows' }));
    // Numbers inside the rows (Qty, Price) are not a count of rows; with no number outside, there is nothing to follow.
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['People add and remove rows']);
    expect(screen.getByText(/add a number question outside this section first/)).toBeInTheDocument();
  });
});
