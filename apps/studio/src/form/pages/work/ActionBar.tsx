import { useState } from 'react';
import { Button } from '@ui/button';
import { Textarea } from '@ui/textarea';
import type { WorkflowAction } from '../../types';
import { fieldErrorsOf, messageOf } from '../../adapters/backend';
import { VISIBLE_BORDER } from '../../runtime/styles';

interface ActionBarProps {
  actions: WorkflowAction[];
  busy: boolean;
  /** Resolves when the server accepted the move; rejects with the API error. */
  onAct: (key: string, comment: string) => Promise<unknown>;
}

/**
 * The form's named moves as buttons. Picking one opens a small confirm box
 * (with a comment when the action asks for one); the server checks required
 * work fields and says which are missing.
 */
export function ActionBar({ actions, busy, onAct }: ActionBarProps) {
  const [open, setOpen] = useState<WorkflowAction | null>(null);
  const [comment, setComment] = useState('');
  const [errors, setErrors] = useState<string[]>([]);

  if (!actions.length) return null;

  const confirm = async () => {
    if (!open) return;
    setErrors([]);
    try {
      await onAct(open.key, comment.trim());
      setOpen(null);
      setComment('');
    } catch (e) {
      const fields = fieldErrorsOf(e);
      setErrors(fields?.length ? fields.map((f) => f.message) : [messageOf(e)]);
    }
  };

  return (
    <div className="fb-settings" style={{ gap: 8 }}>
      <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }} role="group" aria-label="Actions">
        {actions.map((a) => (
          <Button
            key={a.key}
            type="button"
            size="sm"
            variant={open?.key === a.key ? 'default' : 'outline'}
            disabled={busy}
            onClick={() => {
              setOpen(open?.key === a.key ? null : a);
              setErrors([]);
            }}
          >
            {a.label}
          </Button>
        ))}
      </div>
      {open && (
        <div className="fb-panel fb-settings" style={{ gap: 8, padding: 10 }}>
          <Textarea
            className={VISIBLE_BORDER}
            rows={2}
            maxLength={2000}
            value={comment}
            aria-label={`${open.label} comment`}
            placeholder={open.requireComment ? 'Comment (required)' : 'Comment (optional)'}
            onChange={(e) => setComment(e.target.value)}
          />
          {open.requireFiles && (
            <p className="text-sm" style={{ margin: 0 }}>
              {`Needs ${open.requireFiles.picturesOnly ? ((open.requireFiles.count ?? 1) === 1 ? 'a picture' : `${open.requireFiles.count} pictures`) : (open.requireFiles.count ?? 1) === 1 ? 'a file' : `${open.requireFiles.count} files`} added to the record while it is in this status${open.requireFiles.if ? ', for items like this one' : ''}. Add ${(open.requireFiles.count ?? 1) === 1 ? 'it' : 'them'} under Files first.`}
            </p>
          )}
          {errors.length > 0 && (
            <ul role="alert" style={{ margin: 0, paddingLeft: 18, color: 'var(--destructive)', fontSize: 13 }}>
              {errors.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={() => void confirm()}>
              {open.label}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setOpen(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
