import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FormContainer } from './FormContainer';
import { createMockSubmissionAdapter } from '../../adapters/submission/submission-adapter';
import { createMockDataSourceAdapter } from '../../adapters/data-source/data-source-adapter';
import { forgetProofs, PREVIEW_CODE, proofsFor, setCodeConfirmer } from '../../adapters/codes/code-confirmer';
import type { FormDefinition, FormField } from '../../types';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(() => {
  forgetProofs();
  setCodeConfirmer(null);
});

const form = (fields: FormField[]): FormDefinition => ({ id: 'f-v1', orgId: 'org', businessId: '', name: 'Sign up', code: 'SIGNUP', version: 1, status: 'PUBLISHED', access: 'PUBLIC', submission: { method: 'POST', endpointId: 'default-submit' }, fields, createdBy: 'u', updatedBy: 'u' });
const fields: FormField[] = [
  { id: 'e', type: 'EMAIL', name: 'email', label: 'Email', props: { verify: true } },
  { id: 'm', type: 'PHONE', name: 'mobile', label: 'Mobile', props: { verify: true } },
  { id: 'o', type: 'EMAIL', name: 'other', label: 'Other email' },
];
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <FormContainer definition={form(fields)} systemContext={{}} submissionAdapter={createMockSubmissionAdapter()} dataSourceAdapter={createMockDataSourceAdapter()} />
    </QueryClientProvider>,
  );

describe('a field confirmed with a code', () => {
  it('offers to send a code once something is typed, only on the fields the designer chose', async () => {
    show();
    const send = screen.getByRole('button', { name: 'Send me a code to confirm this email address' });
    expect(send).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send me a code to confirm this number' })).toBeDisabled();
    expect(screen.getAllByRole('button', { name: /Send me a code/ })).toHaveLength(2);
    await userEvent.type(screen.getByLabelText('Email'), 'ravi@example.test');
    expect(send).toBeEnabled();
  });

  it('sends the code, refuses a wrong one in the service\'s own words, and shows the field as confirmed', async () => {
    const sent: string[] = [];
    setCodeConfirmer({
      send: async (_def, field, value) => void sent.push(`${field}:${value}`),
      check: async (_def, _field, _value, code) => {
        if (code !== '482913') throw new Error('That code is not right. Check it and try again.');
        return 'v1.proof';
      },
    });
    show();
    await userEvent.type(screen.getByLabelText('Email'), 'ravi@example.test');
    await userEvent.click(screen.getByRole('button', { name: 'Send me a code to confirm this email address' }));
    expect(sent).toEqual(['email:ravi@example.test']);
    const box = await screen.findByLabelText('Code sent to your email address');
    expect(screen.getByText('We sent a 6-digit code. It works for 10 minutes.')).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm).toBeDisabled();
    await userEvent.type(box, '12 34x56');
    expect(box).toHaveValue('123456');
    await userEvent.click(confirm);
    expect(await screen.findByRole('alert')).toHaveTextContent('That code is not right. Check it and try again.');
    await userEvent.clear(box);
    await userEvent.type(box, '482913');
    await userEvent.click(confirm);
    expect(await screen.findByText('This email address is confirmed.')).toBeInTheDocument();
    expect(proofsFor(form(fields), { email: 'Ravi@Example.test ', mobile: '' })).toEqual({ email: 'v1.proof' });
  });

  it('a different answer has to be confirmed again, and its proof is not sent', async () => {
    setCodeConfirmer({ send: async () => undefined, check: async () => 'v1.proof' });
    show();
    const email = screen.getByLabelText('Email');
    await userEvent.type(email, 'ravi@example.test');
    await userEvent.click(screen.getByRole('button', { name: 'Send me a code to confirm this email address' }));
    await userEvent.type(await screen.findByLabelText('Code sent to your email address'), '111111');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('This email address is confirmed.')).toBeInTheDocument();
    await userEvent.type(email, 'x');
    expect(screen.queryByText('This email address is confirmed.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send me a code to confirm this email address' })).toBeEnabled();
    expect(proofsFor(form(fields), { email: 'ravi@example.testx' })).toEqual({});
  });

  it('a sending that fails says why, and can be tried again', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('The text message could not be sent. Try again in a moment.')).mockResolvedValue(undefined);
    setCodeConfirmer({ send, check: async () => 'p' });
    show();
    const row = screen.getByLabelText('Mobile').closest('div')!.parentElement!.parentElement!;
    await userEvent.type(screen.getByLabelText('Mobile'), '+919812345678');
    await userEvent.click(screen.getByRole('button', { name: 'Send me a code to confirm this number' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The text message could not be sent. Try again in a moment.');
    await userEvent.click(screen.getByRole('button', { name: 'Send me a code to confirm this number' }));
    expect(await screen.findByLabelText('Code sent to your number')).toBeInTheDocument();
    expect(within(row).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('in a preview nothing is sent, and one code always works', async () => {
    show();
    await userEvent.type(screen.getByLabelText('Email'), 'ravi@example.test');
    await userEvent.click(screen.getByRole('button', { name: 'Send me a code to confirm this email address' }));
    await userEvent.type(await screen.findByLabelText('Code sent to your email address'), PREVIEW_CODE);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('This email address is confirmed.')).toBeInTheDocument();
  });
});
