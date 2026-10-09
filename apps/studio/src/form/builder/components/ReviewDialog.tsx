import { useState } from 'react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { Button } from '@ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@ui/dialog';
import { Textarea } from '@ui/textarea';
import type { FormDefinition } from '../../types';
import { fieldLabel } from '../../engine';
import { messageOf } from '../../adapters/backend';
import { useFormReview, useReviewAction, type ReviewState } from '../../adapters/review';
import { VISIBLE_BORDER } from '../../runtime/styles';

const when = (at: string | null) => (at ? format(new Date(at), 'dd MMM, HH:mm') : '');

/** Where the draft stands, in a sentence. */
export function reviewSummary({ review, required }: Pick<ReviewState, 'review' | 'required'>): string {
  const by = (p: { name: string } | null) => p?.name ?? 'someone';
  if (review.status === 'APPROVED' && review.stale) return `Approved by ${by(review.decidedBy)}, then changed. It needs a review again${required ? ' before it can be published' : ''}.`;
  if (review.status === 'APPROVED') return `Approved by ${by(review.decidedBy)} on ${when(review.decidedAt)}.`;
  if (review.status === 'REQUESTED') return `${by(review.requestedBy)} asked for a review on ${when(review.requestedAt)}. Waiting for a reviewer.`;
  if (review.status === 'CHANGES_REQUESTED') return `${by(review.decidedBy)} asked for changes on ${when(review.decidedAt)}.`;
  return required ? 'Your organisation publishes a form only once someone else has approved it.' : 'Not reviewed. Ask for a review if you want a second pair of eyes before publishing.';
}

interface ReviewDialogProps {
  form: FormDefinition;
  /** The field selected in the builder: a comment can be about it. */
  selectedFieldId?: string;
  /** There are changes not saved yet: the reviewer would not see them. */
  unsaved: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectField: (fieldId: string) => void;
}

/** Review before publish: ask, approve or ask for changes, and talk about the form and its fields. */
export function ReviewDialog({ form, selectedFieldId, unsaved, open, onOpenChange, onSelectField }: ReviewDialogProps) {
  const { data } = useFormReview(form.id, open);
  const act = useReviewAction(form.id);
  const [note, setNote] = useState('');
  const [comment, setComment] = useState('');
  const [aboutField, setAboutField] = useState(true);
  const selected = form.fields.find((f) => f.id === selectedFieldId);
  const run = (path: string, body?: unknown, method?: 'post' | 'delete') => act.mutateAsync({ path, body, method }).catch((e) => void toast.error(messageOf(e)));

  if (!data) return null;
  const { review, can, comments } = data;
  const open_ = comments.filter((c) => !c.resolvedAt);
  const done = comments.filter((c) => c.resolvedAt);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="large" style={{ maxHeight: 'calc(100vh - 2rem)', overflowY: 'auto' }}>
        <DialogHeader>
          <DialogTitle>Review</DialogTitle>
          <DialogDescription>
            {form.name}, version {form.version}
          </DialogDescription>
        </DialogHeader>

        <div className={review.status === 'CHANGES_REQUESTED' || (review.status === 'APPROVED' && review.stale) ? 'fb-issues' : 'fb-banner'} role="status" aria-label="Review status">
          {reviewSummary(data)}
          {review.status === 'REQUESTED' && review.note && <div style={{ marginTop: 6 }}>“{review.note}”</div>}
          {(review.status === 'CHANGES_REQUESTED' || review.status === 'APPROVED') && review.decisionNote && <div style={{ marginTop: 6 }}>“{review.decisionNote}”</div>}
        </div>

        {(can.request || can.decide) && (
          <div className="fb-settings" style={{ gap: 8 }}>
            <Textarea
              className={VISIBLE_BORDER}
              aria-label={can.decide ? 'Note to the author' : 'Note to the reviewer'}
              placeholder={can.decide ? 'What you think, or what needs to change' : 'Anything the reviewer should look at (optional)'}
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              {can.request && (
                <Button type="button" disabled={act.isPending || unsaved} onClick={() => void run('review/request', { note }).then(() => setNote(''))}>
                  Ask for a review
                </Button>
              )}
              {can.decide && (
                <>
                  <Button type="button" disabled={act.isPending} onClick={() => void run('review/approve', { note }).then(() => setNote(''))}>
                    Approve
                  </Button>
                  <Button type="button" variant="outline" disabled={act.isPending || !note.trim()} title={note.trim() ? undefined : 'Say what needs to change'} onClick={() => void run('review/changes', { note }).then(() => setNote(''))}>
                    Ask for changes
                  </Button>
                </>
              )}
              {can.request && unsaved && <span className="fb-muted">Save the draft first, so the reviewer sees your changes.</span>}
            </div>
          </div>
        )}
        {review.status === 'REQUESTED' && !can.decide && can.decideBlocked && <p className="fb-muted">{can.decideBlocked}</p>}
        {review.status === 'REQUESTED' && review.requestedBy && !can.decide && !can.decideBlocked && can.comment && (
          <div>
            <Button type="button" variant="ghost" disabled={act.isPending} onClick={() => void run('review/cancel')}>
              Take the request back
            </Button>
          </div>
        )}

        <div className="fb-panel__title">Comments{open_.length ? ` (${open_.length} open)` : ''}</div>
        {!comments.length && <p className="fb-muted">No comments yet.</p>}
        <ul className="fb-comments" aria-label="Comments">
          {[...open_, ...done].map((c) => (
            <li key={c.id} data-resolved={!!c.resolvedAt}>
              <div className="fb-comments__head">
                <strong>{c.author?.name ?? 'Someone'}</strong>
                <span className="fb-muted">{when(c.createdAt)}</span>
                {c.fieldId &&
                  (form.fields.some((f) => f.id === c.fieldId) ? (
                    <button
                      type="button"
                      className="fb-link"
                      onClick={() => {
                        onSelectField(c.fieldId);
                        onOpenChange(false);
                      }}
                    >
                      on {c.fieldLabel}
                    </button>
                  ) : (
                    <span className="fb-muted">on {c.fieldLabel} (no longer on the form)</span>
                  ))}
              </div>
              <div>{c.text}</div>
              {c.resolvedAt && <div className="fb-muted">Resolved by {c.resolvedBy?.name ?? 'someone'}</div>}
              {can.comment && (
                <div className="fb-comments__actions">
                  <button type="button" className="fb-link" onClick={() => void run(`comments/${c.id}/${c.resolvedAt ? 'reopen' : 'resolve'}`)}>
                    {c.resolvedAt ? 'Reopen' : 'Resolve'}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
        {can.comment && (
          <div className="fb-settings" style={{ gap: 8 }}>
            <Textarea className={VISIBLE_BORDER} aria-label="New comment" placeholder="Write a comment" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
              <Button
                type="button"
                variant="outline"
                disabled={act.isPending || !comment.trim()}
                onClick={() => void run('comments', { text: comment, ...(selected && aboutField ? { fieldId: selected.id } : {}) }).then(() => setComment(''))}
              >
                Add comment
              </Button>
              {selected && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={aboutField} onChange={(e) => setAboutField(e.target.checked)} />
                  About “{fieldLabel(selected)}”
                </label>
              )}
              {!selected && <span className="fb-muted">Select a field first to comment on it; otherwise the comment is about the whole form.</span>}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
