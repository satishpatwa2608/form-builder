import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FormContainer } from './FormContainer';
import { createMockSubmissionAdapter } from '../../adapters/submission/submission-adapter';
import { createMockDataSourceAdapter } from '../../adapters/data-source/data-source-adapter';
import type { FormDefinition, FormField, SubmissionResult } from '../../types';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
  // jsdom has no canvas: stand in for the two calls the signature pad makes.
  const ctx = new Proxy({}, { get: () => () => undefined, set: () => true });
  HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as HTMLCanvasElement['getContext'];
  HTMLCanvasElement.prototype.toDataURL = () => PNG;
});

const days = ['Mon', 'Tue', 'Wed'].map((label) => ({ label, value: label.toUpperCase() }));

const form = (fields: FormField[]): FormDefinition => ({
  id: 'f-v1',
  orgId: 'org',
  businessId: '',
  name: 'Booking',
  code: 'BOOKING',
  version: 1,
  status: 'PUBLISHED',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields,
  createdBy: 'u',
  updatedBy: 'u',
});

function renderForm(fields: FormField[]) {
  const onSubmitted = vi.fn<(r: SubmissionResult) => void>();
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FormContainer definition={form(fields)} submissionAdapter={createMockSubmissionAdapter({ delayMs: 0 })} dataSourceAdapter={createMockDataSourceAdapter({ delayMs: 0 })} onSubmitted={onSubmitted} />
    </QueryClientProvider>,
  );
  const submit = () => user.click(screen.getByRole('button', { name: /submit/i }));
  const payload = async () => {
    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
    return onSubmitted.mock.calls[0][0].payload;
  };
  return { user, onSubmitted, submit, payload };
}

describe('new fields in the live form', () => {
  it('switch, tick boxes and stepper', async () => {
    const { user, submit, payload } = renderForm([
      { id: 'a', type: 'SWITCH', name: 'urgent', label: 'Urgent' },
      { id: 'b', type: 'CHECKBOX_GROUP', name: 'days', label: 'Days', dataSource: { type: 'STATIC', options: days } },
      { id: 'c', type: 'STEPPER', name: 'guests', label: 'Guests', validation: { min: 1, max: 3 }, props: { step: 1 } },
    ]);
    await user.click(screen.getByRole('switch', { name: /Urgent/ }));
    await user.click(screen.getByRole('checkbox', { name: 'Wed' }));
    await user.click(screen.getByRole('checkbox', { name: 'Mon' }));

    const guests = screen.getByLabelText(/^Guests/) as HTMLInputElement;
    const more = screen.getByRole('button', { name: 'Increase Guests' });
    const fewer = screen.getByRole('button', { name: 'Decrease Guests' });
    await user.click(more);
    expect(guests.value).toBe('1'); // starts at the minimum
    await user.click(more);
    await user.click(more);
    await user.click(more);
    expect(guests.value).toBe('3');
    expect(more).toBeDisabled();
    await user.click(fewer);
    expect(guests.value).toBe('2');

    await submit();
    expect(await payload()).toEqual({ urgent: true, days: ['MON', 'WED'], guests: 2 });
  });

  it('a stepper moves by its step without rounding noise', async () => {
    const { user } = renderForm([{ id: 'c', type: 'STEPPER', name: 'kg', label: 'Weight', props: { step: 0.1 }, validation: { min: 0 } }]);
    const more = screen.getByRole('button', { name: 'Increase Weight' });
    for (let i = 0; i < 4; i++) await user.click(more);
    expect((screen.getByLabelText(/^Weight/) as HTMLInputElement).value).toBe('0.3');
  });

  it('consent must be accepted, and shows its terms as text', async () => {
    const { user, submit, onSubmitted, payload } = renderForm([
      { id: 'a', type: 'CONSENT', name: 'terms', label: 'I accept', required: true, props: { text: 'Clause 1.\n<b>Clause 2</b>' } },
    ]);
    expect(screen.getByRole('region', { name: 'Terms' })).toHaveTextContent('Clause 1. <b>Clause 2</b>');
    expect(document.querySelector('.fp-consent__text b')).toBeNull();
    await submit();
    expect((await screen.findAllByText('Please accept to continue')).length).toBeGreaterThan(0);
    expect(onSubmitted).not.toHaveBeenCalled();
    await user.click(screen.getByRole('checkbox', { name: /I accept/ }));
    await submit();
    expect(await payload()).toEqual({ terms: true });
  });

  it('a signature can be typed, cleared, and is required', async () => {
    const { user, submit, onSubmitted, payload } = renderForm([{ id: 'a', type: 'SIGNATURE', name: 'sign', label: 'Signature', required: true }]);
    expect(screen.getByRole('img', { name: 'Signature: not signed yet' })).toBeInTheDocument();
    await submit();
    expect((await screen.findAllByText('Please sign')).length).toBeGreaterThan(0);
    expect(onSubmitted).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Or type your name to sign Signature'), 'Asha Rao');
    expect(await screen.findByRole('img', { name: 'Signature: signed' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByRole('img', { name: 'Signature: not signed yet' })).toBeInTheDocument();

    await user.type(screen.getByLabelText('Or type your name to sign Signature'), 'Asha');
    await submit();
    expect(await payload()).toEqual({ sign: PNG });
  });

  it('a picture is shown only from a safe address', () => {
    renderForm([
      { id: 'a', type: 'TEXT', name: 't', label: 'T' },
      { id: 'b', type: 'IMAGE', name: 'ok', label: 'Our office', props: { src: 'https://cdn.example.com/office.png', alt: 'The office' } },
      { id: 'c', type: 'IMAGE', name: 'bad', props: { src: 'javascript:alert(1)', alt: 'Nope' } },
      { id: 'd', type: 'IMAGE', name: 'empty', props: { src: '', alt: '' } },
    ]);
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.getByRole('img', { name: 'The office' })).toHaveAttribute('src', 'https://cdn.example.com/office.png');
    expect(screen.getByText('Our office')).toBeInTheDocument();
  });
});

const grouped = (type: 'TABS' | 'ACCORDION'): FormField[] => [
  { id: 'g', type, name: 'group', label: 'Parts' },
  { id: 's1', type: 'SECTION', name: 'you', label: 'About you', parentId: 'g' },
  { id: 'a', type: 'TEXT', name: 'who', label: 'Who', parentId: 's1' },
  { id: 's2', type: 'SECTION', name: 'trip', label: 'Your trip', parentId: 'g' },
  { id: 'b', type: 'TEXT', name: 'where', label: 'Where', parentId: 's2', required: true },
  { id: 's3', type: 'SECTION', name: 'extra', label: 'Extras', parentId: 'g', visibility: { when: { field: 'who', operator: 'equals', value: 'vip' } } },
  { id: 'c', type: 'TEXT', name: 'perk', label: 'Perk', parentId: 's3' },
];

describe('tabs', () => {
  it('show one section at a time and keep what was typed on the others', async () => {
    const { user, submit, payload } = renderForm(grouped('TABS'));
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['About you', 'Your trip']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText(/^Who/)).toBeVisible();
    expect(screen.getByRole('tabpanel', { name: 'About you' })).toBeVisible();

    await user.type(screen.getByLabelText(/^Who/), 'Asha');
    await user.click(screen.getByRole('tab', { name: 'Your trip' }));
    expect(screen.getByRole('tabpanel', { name: 'Your trip' })).toBeVisible();
    await user.type(screen.getByLabelText(/^Where/), 'Pune');
    await submit();
    expect(await payload()).toEqual({ who: 'Asha', where: 'Pune' });
  });

  it('move with the arrow keys, and a tab hidden by a rule appears when it applies', async () => {
    const { user } = renderForm(grouped('TABS'));
    screen.getByRole('tab', { name: 'About you' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Your trip' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'About you' })).toHaveAttribute('aria-selected', 'true');
    await user.type(screen.getByLabelText(/^Who/), 'vip');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['About you', 'Your trip', 'Extras']);
  });

  it('flag the tab with a mistake and open it from the error list', async () => {
    const { user, submit, onSubmitted } = renderForm(grouped('TABS'));
    await submit();
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(await screen.findByRole('tab', { name: /Your trip \(needs attention\)/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'About you' })).toHaveAttribute('aria-selected', 'true');

    const summary = screen.getByText(/Please fix this field/).closest('[role="alert"]') as HTMLElement;
    await user.click(within(summary).getByRole('button', { name: /Where/ }));
    await waitFor(() => expect(screen.getByRole('tab', { name: /Your trip/ })).toHaveAttribute('aria-selected', 'true'));
    await waitFor(() => expect(screen.getByLabelText(/^Where/)).toHaveFocus());
  });
});

describe('accordion', () => {
  it('opens one panel at a time, and the open one can be closed', async () => {
    const { user } = renderForm(grouped('ACCORDION'));
    const you = screen.getByRole('button', { name: /About you/ });
    const trip = screen.getByRole('button', { name: /Your trip/ });
    expect(you).toHaveAttribute('aria-expanded', 'true');
    expect(trip).toHaveAttribute('aria-expanded', 'false');
    await user.click(trip);
    expect(you).toHaveAttribute('aria-expanded', 'false');
    expect(trip).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText(/^Where/)).toBeVisible();
    await user.click(trip);
    expect(trip).toHaveAttribute('aria-expanded', 'false');
  });
});
