import { useState } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FormDefinition } from '../../types';
import { validateFormDefinition } from '../../engine';
import { seedLocalOwnPdfs } from '../../adapters/pdf-templates';
import { OwnPdfSetting } from './OwnPdfSetting';

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
  name: 'Claim',
  code: 'CLAIM',
  version: 1,
  status: 'DRAFT',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [
    { id: 'a', type: 'TEXT', name: 'fullName', label: 'Your name' },
    { id: 'b', type: 'TEXT', name: 'policy', label: 'Policy number' },
    { id: 'c', type: 'FILE', name: 'photo', label: 'Photo' },
  ],
  createdBy: 'u',
  updatedBy: 'u',
};

function Setting({ spy }: { spy: (d: FormDefinition) => void }) {
  const [def, setDef] = useState(form);
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <OwnPdfSetting
        form={def}
        onChange={(document) => {
          const next = { ...def, document };
          spy(next);
          setDef(next);
        }}
      />
    </QueryClientProvider>
  );
}

beforeEach(() =>
  seedLocalOwnPdfs([
    {
      id: 'p1',
      name: 'Claim form 7B',
      size: 2000,
      boxes: [
        { name: 'Full Name', kind: 'text' },
        { name: 'Ref', kind: 'text' },
      ],
    },
  ]),
);

describe('using your own PDF for a response', () => {
  it('choose one from the library; a box named like a question needs no choosing, any other is pointed at a question', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    render(<Setting spy={spy} />);
    const last = () => (spy.mock.calls.at(-1)![0] as FormDefinition).document?.ownPdf;
    await user.click(await screen.findByRole('combobox', { name: 'The PDF of a response is' }));
    await user.click(await screen.findByRole('option', { name: 'Our PDF: Claim form 7B' }));
    expect(last()).toEqual({ id: 'p1', name: 'Claim form 7B' });

    const boxes = screen.getByRole('group', { name: 'What goes into each box' });
    // "Full Name" is fullName by itself; "Ref" matches nothing until it is told.
    expect(within(boxes).getByRole('combobox', { name: 'Question for the box Full Name' })).toHaveTextContent('Your name (same name)');
    expect(within(boxes).getByRole('combobox', { name: 'Question for the box Ref' })).toHaveTextContent('Nothing (no question has this name)');
    await user.click(within(boxes).getByRole('combobox', { name: 'Question for the box Ref' }));
    // A file is not something to write into a box.
    expect(screen.queryByRole('option', { name: 'Photo' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('option', { name: 'Policy number' }));
    expect(last()).toEqual({ id: 'p1', name: 'Claim form 7B', map: { Ref: 'policy' } });
    expect(validateFormDefinition(spy.mock.calls.at(-1)![0]).success).toBe(true);

    // A box that would have matched can be told to stay empty.
    await user.click(within(boxes).getByRole('combobox', { name: 'Question for the box Full Name' }));
    await user.click(await screen.findByRole('option', { name: 'Nothing' }));
    expect(last()!.map).toEqual({ Ref: 'policy', 'Full Name': '' });
  });

  it("going back to the product's own layout takes the choice away", async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    render(<Setting spy={spy} />);
    await user.click(await screen.findByRole('combobox', { name: 'The PDF of a response is' }));
    await user.click(await screen.findByRole('option', { name: 'Our PDF: Claim form 7B' }));
    await user.click(screen.getByRole('combobox', { name: 'The PDF of a response is' }));
    await user.click(await screen.findByRole('option', { name: "Form Builder's own layout" }));
    expect((spy.mock.calls.at(-1)![0] as FormDefinition).document?.ownPdf).toBeUndefined();
    expect(screen.queryByRole('group', { name: 'What goes into each box' })).not.toBeInTheDocument();
  });
});
