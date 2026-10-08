import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FormContainer } from './FormContainer';
import { createMockSubmissionAdapter } from '../../adapters/submission/submission-adapter';
import { createMockDataSourceAdapter } from '../../adapters/data-source/data-source-adapter';
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

const fixture = (code: string) => fixtureDefinitions.find((d) => d.code === code)!;

function renderForm(definition: FormDefinition, extra: { urlParams?: Record<string, string> } = {}) {
  const onSubmitted = vi.fn<(r: SubmissionResult) => void>();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <FormContainer
        definition={definition}
        systemContext={{ userEmail: 'asha@example.com', urlParams: extra.urlParams }}
        submissionAdapter={createMockSubmissionAdapter({ delayMs: 0 })}
        dataSourceAdapter={createMockDataSourceAdapter({ delayMs: 0 })}
        onSubmitted={onSubmitted}
      />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), onSubmitted };
}

const trigger = (name: string) => within(document.querySelector<HTMLElement>(`[data-field-name="${name}"]`)!).getByRole('combobox');

async function choose(user: ReturnType<typeof userEvent.setup>, name: string, option: string) {
  await waitFor(() => expect(trigger(name)).toBeEnabled());
  await user.click(trigger(name));
  await user.click(await screen.findByRole('option', { name: option }));
}

describe('dependent dropdowns (Business -> Section -> Sub-section)', () => {
  it('children wait for their parent, load for it, and clear when it changes', async () => {
    const { user } = renderForm(fixture('PLANT_ISSUE_REPORT'));

    // Nothing chosen yet: children are disabled and say what they need.
    expect(trigger('section')).toBeDisabled();
    expect(trigger('section')).toHaveTextContent('Select Business first');
    expect(trigger('subSection')).toHaveTextContent('Select Section first');

    await choose(user, 'business', 'Denim');
    await choose(user, 'section', 'Dyeing');
    await choose(user, 'subSection', 'Rope dyeing');
    expect(trigger('subSection')).toHaveTextContent('Rope dyeing');

    // Changing the top of the chain clears everything below it.
    await choose(user, 'business', 'Yarn');
    await waitFor(() => expect(trigger('section')).toHaveTextContent('Select...'));
    expect(trigger('subSection')).toHaveTextContent('Select Section first');

    // And the section list is now Yarn's.
    await user.click(trigger('section'));
    expect(await screen.findByRole('option', { name: 'Spinning' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Dyeing' })).not.toBeInTheDocument();
  });

  it('submits the chosen ids with system and URL values', async () => {
    const { user, onSubmitted } = renderForm(fixture('PLANT_ISSUE_REPORT'), { urlParams: { source: 'QR' } });
    await choose(user, 'business', 'Denim');
    await choose(user, 'section', 'Weaving');

    const issues = document.querySelector<HTMLElement>('[data-field-name="issueTypes"]')!;
    await user.click(within(issues).getByRole('textbox'));
    await user.click(await screen.findByText('Safety'));

    await user.type(screen.getByLabelText(/^What happened/), 'Oil leak near loom 14, floor is slippery.');
    await user.click(screen.getByRole('button', { name: 'Submit report' }));

    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
    expect(onSubmitted.mock.calls[0][0].payload).toMatchObject({
      reportedBy: 'asha@example.com',
      source: 'QR',
      business: 'BUSINESS001',
      section: 'SEC_WEAVING',
      issueTypes: ['SAFETY'],
    });
    expect(onSubmitted.mock.calls[0][0].payload).not.toHaveProperty('subSection');
  });
});

describe('Category -> Product (the design doc POC)', () => {
  it('shows Product only for product complaints, with products loaded for that category', async () => {
    const { user } = renderForm(fixture('CUSTOMER_COMPLAINT'));
    expect(document.querySelector('[data-field-name="product"]')).toBeNull();
    await choose(user, 'category', 'Product');
    await choose(user, 'product', 'Rigid denim 13 oz');
    expect(trigger('product')).toHaveTextContent('Rigid denim 13 oz');
  });
});

describe('CAPTCHA (mock mode)', () => {
  it('checkbox mode blocks submit until ticked and sends the token', async () => {
    const { user, onSubmitted } = renderForm(fixture('CUSTOMER_COMPLAINT'));
    await user.type(screen.getByLabelText(/^Name/), 'Asha');
    await user.type(screen.getByLabelText(/^Email/), 'asha@example.com');
    await choose(user, 'category', 'Billing');
    await user.type(screen.getByLabelText(/^Complaint Description/), 'Charged twice for the same order in September.');

    await user.click(screen.getByRole('button', { name: 'Submit Complaint' }));
    expect(await screen.findByText('Please complete the verification', { selector: 'button span' })).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: "I'm not a robot" }));
    await user.click(screen.getByRole('button', { name: 'Submit Complaint' }));
    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
    expect(onSubmitted.mock.calls[0][0].payload.captchaToken).toMatch(/^mock-captcha-/);
  });

  it('invisible mode fetches a token at submit time', async () => {
    const def = fixture('CUSTOMER_COMPLAINT');
    const invisible: FormDefinition = { ...def, captcha: { ...def.captcha!, mode: 'INVISIBLE' } };
    const { user, onSubmitted } = renderForm(invisible);
    expect(screen.queryByRole('checkbox', { name: "I'm not a robot" })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText(/^Name/), 'Asha');
    await user.type(screen.getByLabelText(/^Email/), 'asha@example.com');
    await choose(user, 'category', 'Billing');
    await user.type(screen.getByLabelText(/^Complaint Description/), 'Charged twice for the same order in September.');
    await user.click(screen.getByRole('button', { name: 'Submit Complaint' }));

    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
    expect(onSubmitted.mock.calls[0][0].payload.captchaToken).toMatch(/^mock-captcha-/);
  });
});
