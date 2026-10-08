import { useState } from 'react';
import { Button } from '@ui/button';
import { Textarea } from '@ui/textarea';
import { messageOf } from '../../adapters/backend';
import { VISIBLE_BORDER } from '../../runtime/styles';

/** Reopen a closed item (within the form's window), with the reason. */
export function ReopenBox({ busy, onReopen }: { busy: boolean; onReopen: (comment: string) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  if (!open) {
    return (
      <Button type="button" size="sm" variant="outline" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(true)}>
        Reopen
      </Button>
    );
  }
  return (
    <div className="fb-panel fb-settings" style={{ gap: 8, padding: 10 }}>
      <Textarea className={VISIBLE_BORDER} rows={2} aria-label="Why reopen" placeholder="Why is it reopened? (required)" value={comment} onChange={(e) => setComment(e.target.value)} />
      {error && (
        <p role="alert" style={{ margin: 0, color: 'var(--destructive)', fontSize: 13 }}>
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy || !comment.trim()}
          onClick={async () => {
            setError('');
            try {
              await onReopen(comment.trim());
              setOpen(false);
              setComment('');
            } catch (e) {
              setError(messageOf(e));
            }
          }}
        >
          Reopen
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
