import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FormContainer } from './FormContainer';
import { createMockSubmissionAdapter, type SubmissionAdapter } from '../../adapters/submission/submission-adapter';
import { createMockDataSourceAdapter } from '../../adapters/data-source/data-source-adapter';
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

const sizes = [{ label: 'Small', value: 'S' }, { label: 'Large', value: 'L' }];

const form = (extra: Partial<FormDefinition> = {}): FormDefinition => ({
  id: 'f-v1',
  orgId: 'org',
  businessId: '',
  name: 'Order',
  code: 'ORDER',
  version: 1,
  status: 'PUBLISHED',
  access: 'PUBLIC',
  layout: { mode: 'single', review: true },
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [
    { id: 'a', type: 'TEXT', name: 'who', label: 'Your name', required: true },
    { id: 'b', type: 'RADIO', name: 'size', label: 'Size', dataSource: { type: 'STATIC', options: sizes } },
    { id: 'c', type: 'SWITCH', name: 'gift', label: 'Gift wrap' },
    { id: 'd', type: 'TEXT', name: 'message', label: 'Gift message', visibility: { when: { field: 'gift', operator: 'equals', value: true } } },
    { id: 'r', type: 'REPEAT', name: 'lines', label: 'Lines', validation: { min: 1 } },
    { id: 'i', type: 'TEXT', name: 'item', label: 'Item', parentId: 'r' },
    { id: 'q', type: 'NUMBER', name: 'qty', label: 'Qty', parentId: 'r' },
    { id: 't', type: 'NUMBER', name: 'units', label: 'Units' },
    { id: 'h', type: 'HIDDEN', name: 'source', defaultValue: 'web' },
  ],
  rules: [{ id: 'u', then: [{ type: 'SET_VALUE', target: 'units', value: 'sum(qty)' }] }],
  createdBy: 'u',
  updatedBy: 'u',
  ...extra,
});

function renderForm(definition = form(), submission: SubmissionAdapter = createMockSubmissionAdapter({ delayMs: 0 })) {
  const onSubmitted = vi.fn<(r: SubmissionResult) => void>();
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FormContainer definition={definition} submissionAdapter={submission} dataSourceAdapter={createMockDataSourceAdapter({ delayMs: 0 })} onSubmitted={onSubmitted} />
    </QueryClientProvider>,
  );
  const submit = () => user.click(screen.getByRole('button', { name: /^submit/i }));
  return { user, onSubmitted, submit };
}

const review = () => screen.getByRole('region', { name: 'Check your answers' });
const answers = () =>
  Object.fromEntries([...review().querySelectorAll('.fp-review__item')].map((item) => [item.querySelector('dt')!.textContent, item.querySelector('dd')!.textContent]));

async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/^Your name/), 'Asha');
  await user.click(screen.getByRole('radio', { name: 'Large' }));
  await user.type(screen.getByLabelText(/^Item/), 'Pen');
  await user.type(screen.getByLabelText(/^Qty/), '3');
}

describe('review before sending', () => {
  it('shows what will be sent, as people would read it, and sends nothing yet', async () => {
    const { user, onSubmitted, submit } = renderForm();
    await fill(user);
    await submit();
    await waitFor(() => expect(review()).toBeInTheDocument());
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(answers()).toEqual({
      'Your name': 'Asha',
      Size: 'Large',
      'Gift wrap': 'No',
      // The "; " between a row's answers is drawn by the stylesheet, so it is not in the text.
      Lines: 'Item: PenQty: 3',
      Units: '3',
    });
    // The fields are out of the way, and still there.
    expect(screen.getByLabelText(/^Your name/)).not.toBeVisible();
  });

  it('does not open until the answers are complete and valid', async () => {
    const { submit } = renderForm();
    await submit();
    expect((await screen.findAllByText('Your name is required')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('region', { name: 'Check your answers' })).not.toBeInTheDocument();
  });

  it('goes back to change one answer, then submits from the review', async () => {
    const { user, onSubmitted, submit } = renderForm();
    await fill(user);
    await submit();
    await user.click(await screen.findByRole('button', { name: 'Change Your name' }));
    await waitFor(() => expect(screen.getByLabelText(/^Your name/)).toHaveFocus());
    expect(screen.queryByRole('region', { name: 'Check your answers' })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText(/^Your name/), ' Rao');
    await user.click(screen.getByRole('switch', { name: /Gift wrap/ }));
    await user.type(await screen.findByLabelText(/^Gift message/), 'Enjoy');
    await submit();
    await waitFor(() => expect(answers()).toMatchObject({ 'Your name': 'Asha Rao', 'Gift wrap': 'Yes', 'Gift message': 'Enjoy' }));

    await submit();
    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
    expect(onSubmitted.mock.calls[0][0].payload).toEqual({
      who: 'Asha Rao',
      size: 'L',
      gift: true,
      message: 'Enjoy',
      lines: [{ item: 'Pen', qty: 3 }],
      units: 3,
      source: 'web',
    });
  });

  it('Back returns to the form; a row answer can be changed from the review', async () => {
    const { user, submit } = renderForm();
    await fill(user);
    await submit();
    await user.click(await screen.findByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText(/^Your name/)).toBeVisible();
    await submit();
    await user.click(await screen.findByRole('button', { name: 'Change Lines' }));
    expect(screen.getByLabelText(/^Item/)).toBeVisible();
  });

  it('comes after the last step of a stepped form', async () => {
    const stepped = form({
      layout: { mode: 'steps', review: true },
      rules: [],
      fields: [
        { id: 's1', type: 'SECTION', name: 'one', label: 'One' },
        { id: 'a', type: 'TEXT', name: 'who', label: 'Your name', parentId: 's1', required: true },
        { id: 's2', type: 'SECTION', name: 'two', label: 'Two' },
        { id: 'b', type: 'TEXT', name: 'note', label: 'Note', parentId: 's2' },
      ],
    });
    const { user, onSubmitted, submit } = renderForm(stepped);
    await user.type(screen.getByLabelText(/^Your name/), 'Asha');
    await user.click(screen.getByRole('button', { name: /next/i }));
    await screen.findByText('Step 2 of 2');
    await submit();
    await waitFor(() => expect(answers()).toEqual({ 'Your name': 'Asha', Note: 'Not answered' }));
    expect(screen.queryByText(/Step 2 of 2/)).not.toBeInTheDocument();

    // Changing an answer on an earlier step goes to that step.
    await user.click(screen.getByRole('button', { name: 'Change Your name' }));
    expect(await screen.findByText('Step 1 of 2')).toBeInTheDocument();
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it("returns to the form when the server finds a problem", async () => {
    const refusing: SubmissionAdapter = { submit: async ({ payload }) => ({ ok: false, payload, error: 'Please check the fields', fieldErrors: [{ field: 'who', message: 'Already registered' }] }) };
    const { user, submit } = renderForm(form(), refusing);
    await fill(user);
    await submit();
    await screen.findByRole('region', { name: 'Check your answers' });
    await submit();
    expect((await screen.findAllByText('Already registered')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('region', { name: 'Check your answers' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('form', { name: 'Order' })).getByLabelText(/^Your name/)).toBeVisible();
  });

  it('a form without the option submits straight away', async () => {
    const { user, onSubmitted, submit } = renderForm(form({ layout: { mode: 'single' } }));
    await fill(user);
    await submit();
    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
  });
});
