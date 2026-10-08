import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FormContainer } from './FormContainer';
import { createMockSubmissionAdapter } from '../../adapters/submission/submission-adapter';
import { fixtureDefinitions } from '../../fixtures';
import type { FormDefinition, SubmissionResult } from '../../types';

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

const supplier = fixtureDefinitions.find((d) => d.code === 'SUPPLIER_REGISTRATION')!;

function renderForm(definition: FormDefinition) {
  const onSubmitted = vi.fn<(r: SubmissionResult) => void>();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={qc}>
      <FormContainer definition={definition} submissionAdapter={createMockSubmissionAdapter({ delayMs: 0 })} onSubmitted={onSubmitted} />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), onSubmitted, container };
}

describe('layout: steps, columns, styles', () => {
  it('walks through steps, validating only the current one, and submits a flat payload', async () => {
    const { user, onSubmitted, container } = renderForm(supplier);

    // Step 1: Company. Columns render side by side.
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument();
    expect(container.querySelectorAll('.fp-columns .fp-column')).toHaveLength(2);
    expect(screen.queryByLabelText(/^Contact person/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Register' })).not.toBeInTheDocument();

    // Next with an empty step stays put and shows that step's errors only.
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Company name is required')).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument();

    await user.type(screen.getByLabelText(/^Company name/), 'Asha Textiles');
    await user.type(screen.getByLabelText(/^GST number/), '27ABCDE1234F1Z5');
    const supplies = container.querySelector<HTMLElement>('[data-field-name="supplies"]')!;
    await user.click(within(supplies).getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'Chemicals' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));

    // Step 2: Contact. Back returns with values kept.
    expect(await screen.findByText('Step 2 of 3')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText(/^Company name/)).toHaveValue('Asha Textiles');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    await user.type(await screen.findByLabelText(/^Contact person/), 'Ravi');
    await user.type(screen.getByLabelText(/^Email/), 'ravi@asha.example');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    // Step 3: the last step has the real submit button.
    expect(await screen.findByText('Step 3 of 3')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /information above is correct/ }));
    await user.click(screen.getByRole('button', { name: 'Register' }));

    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
    expect(onSubmitted.mock.calls[0][0].payload).toEqual({
      companyName: 'Asha Textiles',
      gstNumber: '27ABCDE1234F1Z5',
      supplies: 'CHEM',
      contactName: 'Ravi',
      contactEmail: 'ravi@asha.example',
      declaration: true,
    });
  });

  it('pressing Enter on an early step acts as Next, not submit', async () => {
    const { user, onSubmitted } = renderForm(supplier);
    await user.type(screen.getByLabelText(/^Company name/), 'Asha{Enter}');
    expect(await screen.findByText('GST number is required')).toBeInTheDocument();
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('injects the theme and the embedded style snapshot, scoped to this form', () => {
    const { container } = renderForm({ ...supplier, layout: undefined });
    const css = container.querySelector('style')?.textContent ?? '';
    expect(css).toMatch(/\.fpf-\w+\{--primary:#0f766e/);
    expect(css).toMatch(/\.fpf-\w+ \.fps-highlight-box\{background-color:#eff6ff/);
    expect(container.querySelector('[data-field-name="declaration"]')).toHaveClass('fps-highlight-box');
    // Single-page mode: everything is on one page with sections framed.
    expect(screen.getByLabelText(/^Contact person/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Contact' })).toHaveClass('fp-section');
  });

  it('half-width fields get width classes', () => {
    const { container } = renderForm({ ...supplier, layout: undefined });
    expect(container.querySelector('[data-field-name="contactEmail"]')).toHaveClass('fp-w-half');
  });
});
