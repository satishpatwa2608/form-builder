import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FormContainer } from './FormContainer';
import { createMockSubmissionAdapter } from '../../adapters/submission/submission-adapter';
import { createMockDataSourceAdapter } from '../../adapters/data-source/data-source-adapter';
import { fixtureDefinitions } from '../../fixtures';
import type { FormDefinition, SubmissionResult } from '../../types';
import { fakeApi } from '../../../test/fake-api';

// Radix Select/Checkbox rely on pointer-capture, scrollIntoView and ResizeObserver, which jsdom lacks.
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

const basic = fixtureDefinitions.find((d) => d.code === 'CUSTOMER_COMPLAINT_BASIC')!;
const NOW = new Date('2026-09-29T08:00:00.000Z');

function renderForm(definition: FormDefinition = basic, adapter = createMockSubmissionAdapter({ delayMs: 0 })) {
  const onSubmitted = vi.fn<(r: SubmissionResult) => void>();
  const user = userEvent.setup();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <FormContainer
        definition={definition}
        systemContext={{ now: NOW }}
        submissionAdapter={adapter}
        dataSourceAdapter={createMockDataSourceAdapter({ delayMs: 0 })}
        onSubmitted={onSubmitted}
      />
    </QueryClientProvider>,
  );
  return { user, onSubmitted };
}

async function chooseCategory(user: ReturnType<typeof userEvent.setup>, label: string) {
  const field = document.querySelector<HTMLElement>('[data-field-name="category"]')!;
  await user.click(within(field).getByRole('combobox'));
  await user.click(await screen.findByRole('option', { name: label }));
}

async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/^Name/), 'Asha Rao');
  await user.type(screen.getByLabelText(/^Email/), 'asha@example.com');
  await chooseCategory(user, 'Billing');
  await user.type(screen.getByLabelText(/^Complaint Description/), 'I was charged twice for order 4471 in September.');
}

describe('FormContainer', () => {
  it('renders the form from its definition', () => {
    renderForm();
    expect(screen.getByRole('heading', { name: 'Customer Complaint (Basic)' })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Name/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit Complaint' })).toBeInTheDocument();
    // Visibility rules: product fields only show for category PRODUCT.
    expect(screen.queryByLabelText(/^Product Name/)).not.toBeInTheDocument();
  });

  it('blocks an empty submit and lists every error', async () => {
    const { user, onSubmitted } = renderForm();
    await user.click(screen.getByRole('button', { name: 'Submit Complaint' }));

    const summary = await screen.findByRole('alert');
    expect(within(summary).getByText('Name is required')).toBeInTheDocument();
    expect(within(summary).getByText('Email is required')).toBeInTheDocument();
    expect(within(summary).getByText('Complaint Category is required')).toBeInTheDocument();
    expect(within(summary).getByText('Complaint Description is required')).toBeInTheDocument();
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('shows fields when their visibility rule starts to hold, and requires them then', async () => {
    const { user } = renderForm();
    await chooseCategory(user, 'Product');
    expect(await screen.findByLabelText(/^Product Name/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Serial Number/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Submit Complaint' }));
    const summary = await screen.findByRole('alert');
    expect(within(summary).getByText('Product Name is required')).toBeInTheDocument();
  });

  it('applies requiredWhen', async () => {
    const { user } = renderForm();
    await fillRequired(user);
    await user.click(screen.getByRole('checkbox', { name: /call me/i }));
    await user.click(screen.getByRole('button', { name: 'Submit Complaint' }));
    const summary = await screen.findByRole('alert');
    expect(within(summary).getByText('Phone is required')).toBeInTheDocument();
  });

  it('submits the payload built from visible values plus system fields', async () => {
    const { user, onSubmitted } = renderForm();
    await fillRequired(user);
    await user.type(screen.getByLabelText(/^Amount disputed/), '1200');
    await user.click(screen.getByRole('button', { name: 'Submit Complaint' }));

    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
    expect(onSubmitted.mock.calls[0][0].payload).toEqual({
      businessId: 'BUSINESS001',
      submittedAt: '2026-09-29T08:00:00.000Z',
      name: 'Asha Rao',
      email: 'asha@example.com',
      category: 'BILLING',
      severity: 'MEDIUM',
      amountDisputed: 1200,
      description: 'I was charged twice for order 4471 in September.',
      contactMe: false,
    });
    expect(await screen.findByText('Thank you. Your complaint has been registered.')).toBeInTheDocument();
  });

  it('shows an adapter rejection without leaving the form', async () => {
    const { user, onSubmitted } = renderForm(basic, createMockSubmissionAdapter({ delayMs: 0, fail: 'Service unavailable' }));
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Submit Complaint' }));
    expect(await screen.findByText('Service unavailable')).toBeInTheDocument();
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/^Name/)).toHaveValue('Asha Rao');
  });

  it('cancel with RESET clears the form', async () => {
    const { user } = renderForm();
    await user.type(screen.getByLabelText(/^Name/), 'Asha');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByLabelText(/^Name/)).toHaveValue('');
  });

  it('loads the latest published version by form code', async () => {
    // Served by the Forms API: the list, the form's versions, then the live one.
    const basic = fixtureDefinitions.find((d) => d.code === 'CUSTOMER_COMPLAINT_BASIC')!;
    fakeApi({
      'GET /forms': () => ({ body: [{ id: 'v2', code: basic.code, publishedVersion: 1 }] }),
      'GET /forms/v2/versions': () => ({ body: [{ id: 'v2', status: 'DRAFT' }, { id: 'v1', status: 'PUBLISHED' }] }),
      'GET /forms/v1': () => ({ body: { definition: basic, folderId: 'f', permissions: [] } }),
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <FormContainer formCode="CUSTOMER_COMPLAINT_BASIC" />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'Customer Complaint (Basic)' })).toBeInTheDocument();
  });

  it('says so when a code has no published version', async () => {
    fakeApi({ 'GET /forms': () => ({ body: [] }) });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <FormContainer formCode="NO_SUCH_FORM" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('This form is not available.')).toBeInTheDocument();
  });
});
