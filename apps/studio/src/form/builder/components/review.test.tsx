import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FormDefinition } from '../../types';
import { localReviewCalls, seedLocalReview, type ReviewState } from '../../adapters/review';
import { ReviewDialog, reviewSummary } from './ReviewDialog';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const form: FormDefinition = {
  id: 'f1',
  orgId: 'o1',
  businessId: '',
  name: 'Leave request',
  code: 'LEAVE',
  version: 2,
  status: 'DRAFT',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [
    { id: 'a', type: 'TEXT', name: 'name', label: 'Your name' },
    { id: 'b', type: 'EMAIL', name: 'email', label: 'Email' },
  ],
  createdBy: 'u',
  updatedBy: 'u',
};
const dev = { id: 'u1', name: 'Dev Designer' };
const pia = { id: 'u2', name: 'Pia Publisher' };
const none: ReviewState['review'] = { status: 'NONE', requestedBy: null, requestedAt: null, note: '', decidedBy: null, decidedAt: null, decisionNote: '', stale: false };
const asked: ReviewState['review'] = { ...none, status: 'REQUESTED', requestedBy: dev, requestedAt: '2026-10-09T05:00:00.000Z', note: 'Check the wording.' };

function open(state: Partial<ReviewState>, props: { selectedFieldId?: string; unsaved?: boolean } = {}) {
  seedLocalReview(state);
  const onSelectField = vi.fn();
  const onOpenChange = vi.fn();
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ReviewDialog form={form} selectedFieldId={props.selectedFieldId} unsaved={!!props.unsaved} open onOpenChange={onOpenChange} onSelectField={onSelectField} />
    </QueryClientProvider>,
  );
  return { user, onSelectField, onOpenChange };
}

beforeEach(() => {
  localReviewCalls.length = 0;
});

describe('Where a draft stands, in a sentence', () => {
  it('says who did what, and what is needed next', () => {
    expect(reviewSummary({ review: none, required: false })).toMatch(/^Not reviewed/);
    expect(reviewSummary({ review: none, required: true })).toBe('Your organisation publishes a form only once someone else has approved it.');
    expect(reviewSummary({ review: asked, required: true })).toMatch(/^Dev Designer asked for a review on .*Waiting for a reviewer\.$/);
    const approved = { ...asked, status: 'APPROVED' as const, decidedBy: pia, decidedAt: '2026-10-09T06:00:00.000Z' };
    expect(reviewSummary({ review: approved, required: true })).toMatch(/^Approved by Pia Publisher on /);
    expect(reviewSummary({ review: { ...approved, stale: true }, required: true })).toBe('Approved by Pia Publisher, then changed. It needs a review again before it can be published.');
    expect(reviewSummary({ review: { ...approved, status: 'CHANGES_REQUESTED' }, required: false })).toMatch(/^Pia Publisher asked for changes on /);
  });
});

describe('The Review dialog', () => {
  it('a designer asks for a review with a note; with unsaved changes they are told to save first', async () => {
    const { user } = open({ can: { request: true, decide: false, decideBlocked: '', comment: true } });
    await user.type(await screen.findByRole('textbox', { name: 'Note to the reviewer' }), 'Check the wording.');
    await user.click(screen.getByRole('button', { name: 'Ask for a review' }));
    expect(localReviewCalls).toEqual([{ path: 'review/request', body: { note: 'Check the wording.' } }]);
  });

  it('asking is held back while there are unsaved changes, and says why', async () => {
    open({ can: { request: true, decide: false, decideBlocked: '', comment: true } }, { unsaved: true });
    expect(await screen.findByRole('button', { name: 'Ask for a review' })).toBeDisabled();
    expect(screen.getByText('Save the draft first, so the reviewer sees your changes.')).toBeInTheDocument();
  });

  it('a reviewer sees the request, approves, or asks for changes only with a reason', async () => {
    const { user } = open({ review: asked, can: { request: false, decide: true, decideBlocked: '', comment: true } });
    expect(await screen.findByRole('status', { name: 'Review status' })).toHaveTextContent('“Check the wording.”');
    expect(screen.getByRole('button', { name: 'Ask for changes' })).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'Note to the author' }), 'Add the employee id.');
    await user.click(screen.getByRole('button', { name: 'Ask for changes' }));
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(localReviewCalls.map((c) => c.path)).toEqual(['review/changes', 'review/approve']);
    expect(localReviewCalls[0].body).toEqual({ note: 'Add the employee id.' });
  });

  it('someone who may not decide their own work is told why instead of being shown the buttons', async () => {
    open({ required: true, review: asked, can: { request: false, decide: false, decideBlocked: 'Someone other than the person who asked for the review, or last changed the form, must decide.', comment: true } });
    expect(await screen.findByText(/Someone other than the person who asked/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('comments are about the selected field unless unticked; open ones come first; a comment leads to its field', async () => {
    const comment = (id: string, over: object) => ({ id, fieldId: '', fieldLabel: '', text: id, author: pia, createdAt: '2026-10-09T05:00:00.000Z', resolvedAt: null, resolvedBy: null, ...over });
    const { user, onSelectField } = open(
      {
        comments: [
          comment('Done already', { resolvedAt: '2026-10-09T05:30:00.000Z', resolvedBy: dev }),
          comment('Is email needed?', { fieldId: 'b', fieldLabel: 'Email' }),
          comment('About a field that has gone', { fieldId: 'zzz', fieldLabel: 'Fax number' }),
        ],
        can: { request: false, decide: false, decideBlocked: '', comment: true },
      },
      { selectedFieldId: 'a' },
    );
    const list = await screen.findByRole('list', { name: 'Comments' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('Is email needed?'),
      expect.stringContaining('on Fax number (no longer on the form)'),
      expect.stringContaining('Resolved by Dev Designer'),
    ]);
    expect(screen.getByText('Comments (2 open)')).toBeInTheDocument();

    await user.click(within(list).getByRole('button', { name: 'on Email' }));
    expect(onSelectField).toHaveBeenCalledWith('b');

    await user.type(screen.getByRole('textbox', { name: 'New comment' }), 'Say first and last name.');
    await user.click(screen.getByRole('button', { name: 'Add comment' }));
    await user.type(screen.getByRole('textbox', { name: 'New comment' }), 'Overall fine.');
    await user.click(screen.getByRole('checkbox', { name: /About “Your name”/ }));
    await user.click(screen.getByRole('button', { name: 'Add comment' }));
    await user.click(within(list).getAllByRole('button', { name: 'Resolve' })[0]);
    await user.click(within(list).getByRole('button', { name: 'Reopen' }));
    expect(localReviewCalls).toEqual([
      { path: 'comments', body: { text: 'Say first and last name.', fieldId: 'a' } },
      { path: 'comments', body: { text: 'Overall fine.' } },
      { path: 'comments/Is email needed?/resolve', body: undefined },
      { path: 'comments/Done already/reopen', body: undefined },
    ]);
  });

  it('someone who can only look sees the state and the comments, with nothing to press', async () => {
    open({ review: asked, comments: [{ id: 'c1', fieldId: '', fieldLabel: '', text: 'Looks fine', author: pia, createdAt: '2026-10-09T05:00:00.000Z', resolvedAt: null, resolvedBy: null }] });
    expect(await screen.findByText('Looks fine')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Ask for a review|Approve|Add comment|Resolve/ })).not.toBeInTheDocument();
  });
});
