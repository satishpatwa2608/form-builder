import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnswerApprovalPage } from './AnswerApprovalPage';

const ASKED = { title: 'Close: REQ-000004', instructions: 'Refund of 4,500 agreed with the customer.', form: 'Refund request', reference: 'REQ-000004', askedOf: 'Nia', open: true, decision: null };
const state = vi.hoisted(() => ({ asked: {} as Record<string, unknown>, calls: [] as { path: string; body?: any }[], fail: '' }));
vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {
    fields: Record<string, string> = {};
  },
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : 'That did not work'),
  api: async (path: string, init?: { body?: any }) => {
    state.calls.push({ path, body: init?.body });
    if (state.fail) throw new Error(state.fail);
    return path.endsWith('/look') ? state.asked : { done: true };
  },
}));
const open = () =>
  render(
    <MemoryRouter initialEntries={['/answer?key=fbap_abc']}>
      <AnswerApprovalPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  state.asked = ASKED;
  state.calls = [];
  state.fail = '';
});

describe('answering an approval from its email', () => {
  it('opening the link shows what is asked and decides nothing', async () => {
    open();
    expect(await screen.findByText('Close: REQ-000004')).toBeInTheDocument();
    expect(screen.getByText('Refund of 4,500 agreed with the customer.')).toBeInTheDocument();
    expect(screen.getByText(/Answering as Nia/)).toBeInTheDocument();
    expect(state.calls).toEqual([{ path: '/public/approvals/look', body: { key: 'fbap_abc' } }]);
  });

  it('Reject sends a rejection (not whatever was pressed before), with the comment', async () => {
    open();
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'Amount is wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(await screen.findByText(/Rejected\. Thank you, Nia/)).toBeInTheDocument();
    expect(state.calls.at(-1)).toEqual({ path: '/public/approvals/decide', body: { key: 'fbap_abc', decision: 'REJECTED', comment: 'Amount is wrong' } });
  });

  it('Approve sends an approval', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(state.calls.at(-1)?.body).toMatchObject({ decision: 'APPROVED' }));
    expect(await screen.findByText(/Approved\. Thank you/)).toBeInTheDocument();
  });

  it('already decided, or a link that no longer works: no buttons, and the way to sign in', async () => {
    state.asked = { ...ASKED, open: false, decision: 'APPROVED' };
    const first = open();
    expect(await screen.findByText('This has already been approved.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    first.unmount();

    state.fail = 'This link is not valid. It may have been used already.';
    open();
    expect(await screen.findByText('This link is not valid. It may have been used already.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in to see the record' })).toBeInTheDocument();
  });
});
