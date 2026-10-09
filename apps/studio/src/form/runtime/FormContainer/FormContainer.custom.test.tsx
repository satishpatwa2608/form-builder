import { beforeAll, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FormContainer } from './FormContainer';
import { createMockSubmissionAdapter } from '../../adapters/submission/submission-adapter';
import { createMockDataSourceAdapter } from '../../adapters/data-source/data-source-adapter';
import { seedLocalExtensions } from '../../adapters/extensions';
import { FieldPalette } from '../../builder/components/FieldPalette';
import type { FormDefinition, FormField, SubmissionResult } from '../../types';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
});

const STARS = 'x-abcd1234-stars';
const form = (fields: FormField[]): FormDefinition => ({
  id: 'f-v1',
  orgId: 'org-1',
  businessId: '',
  name: 'Review',
  code: 'REVIEW',
  version: 1,
  status: 'PUBLISHED',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields,
  createdBy: 'u',
  updatedBy: 'u',
});
const rating = (over: Partial<FormField> = {}): FormField => ({ id: 'r', type: 'CUSTOM', name: 'rating', label: 'Rate us', required: true, props: { custom: STARS, height: 60 }, ...over });

function renderForm(fields: FormField[]) {
  const onSubmitted = vi.fn<(r: SubmissionResult) => void>();
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FormContainer definition={form(fields)} submissionAdapter={createMockSubmissionAdapter({ delayMs: 0 })} dataSourceAdapter={createMockDataSourceAdapter({ delayMs: 0 })} onSubmitted={onSubmitted} />
    </QueryClientProvider>,
  );
  const frame = () => screen.getByTitle('Rate us') as HTMLIFrameElement;
  /** A message as the browser would deliver it from `source`. */
  const say = (data: unknown, source: MessageEventSource | null = frame().contentWindow) => act(() => void window.dispatchEvent(new MessageEvent('message', { data, source })));
  const submit = () => user.click(screen.getByRole('button', { name: /submit/i }));
  return { user, onSubmitted, frame, say, submit };
}

describe("A field drawn by the organisation's own code", () => {
  it('is shown in a frame that may run scripts and nothing else, from the copy the server keeps', () => {
    const { frame } = renderForm([rating()]);
    expect(frame().getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame().getAttribute('src')).toMatch(/\/public\/extensions\/org-1\/fields\/x-abcd1234-stars$/);
    expect(frame().getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame().style.height).toBe('60px');
  });

  it('is told its value when it says it is ready, and its answer is submitted as text', async () => {
    const { frame, say, submit, onSubmitted } = renderForm([rating({ defaultValue: '3' })]);
    const posted = vi.spyOn(frame().contentWindow!, 'postMessage');
    say({ fb: 1, type: 'ready' });
    expect(posted).toHaveBeenCalledWith({ fb: 1, type: 'init', value: '3', readOnly: false, required: true, label: 'Rate us' }, '*');
    say({ fb: 1, type: 'change', value: '5' });
    await submit();
    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
    expect(onSubmitted.mock.calls[0][0].payload).toMatchObject({ rating: '5' });
  });

  it('is required like any other field', async () => {
    const { submit, onSubmitted } = renderForm([rating()]);
    await submit();
    expect((await screen.findAllByText('Rate us is required')).length).toBeGreaterThan(0);
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('is believed only for text of a sane size, in the agreed shape, from its own frame', async () => {
    const { say, submit, onSubmitted } = renderForm([rating()]);
    say({ fb: 1, type: 'change', value: { stars: 5 } });
    say({ fb: 1, type: 'change', value: 'x'.repeat(10_001) });
    say({ type: 'change', value: '5' });
    say({ fb: 1, type: 'change', value: '5' }, window);
    say({ fb: 1, type: 'change', value: '5' }, null);
    say('change');
    say(null);
    await submit();
    expect((await screen.findAllByText('Rate us is required')).length).toBeGreaterThan(0);
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('grows and shrinks as it asks, within limits', () => {
    const { frame, say } = renderForm([rating()]);
    say({ fb: 1, type: 'height', height: 212.4 });
    expect(frame().style.height).toBe('212px');
    say({ fb: 1, type: 'height', height: 99_999 });
    expect(frame().style.height).toBe('800px');
    say({ fb: 1, type: 'height', height: -5 });
    expect(frame().style.height).toBe('40px');
    say({ fb: 1, type: 'height', height: 'tall' });
    expect(frame().style.height).toBe('40px');
  });

  it('cannot change its answer while the field is switched off', async () => {
    const { say, submit, onSubmitted } = renderForm([{ id: 'a', type: 'TEXT', name: 'name', label: 'Name' }, rating({ required: false, disabled: true, defaultValue: '2' })]);
    say({ fb: 1, type: 'change', value: '5' });
    await submit();
    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
    expect(onSubmitted.mock.calls[0][0].payload.rating).not.toBe('5');
  });

  it('says what to do when it has not been told which field it is', () => {
    renderForm([rating({ props: {} })]);
    expect(screen.queryByTitle('Rate us')).not.toBeInTheDocument();
    expect(screen.getByText(/Choose which of your extension's fields this is/)).toBeInTheDocument();
  });
});

describe('The palette', () => {
  const palette = () =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <FieldPalette fields={[]} onAdd={() => {}} />
      </QueryClientProvider>,
    );
  it('offers a custom field only when the organisation has one to offer', async () => {
    seedLocalExtensions([], [], []);
    const first = palette();
    expect(await screen.findByRole('button', { name: 'Signature' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Custom field' })).not.toBeInTheDocument();
    first.unmount();
    seedLocalExtensions([], [], [{ key: STARS, label: 'Acme rules: Star rating', height: 60 }]);
    palette();
    expect(await screen.findByRole('button', { name: 'Custom field' })).toBeInTheDocument();
    expect(screen.getByText('Your extension')).toBeInTheDocument();
  });
});
