import { useEffect, useState } from 'react';
import { Button } from '@ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@ui/dialog';
import { Input } from '@ui/input';
import { VISIBLE_BORDER, errorText } from '../../runtime/styles';

interface ScheduleDialogProps {
  formName: string;
  version: number;
  /** When the draft is set to publish now, if it is. */
  publishAt?: string | null;
  open: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolves to a reason when the schedule was refused. */
  onSchedule: (publishAt: string) => Promise<string | undefined>;
  onCancelSchedule: () => Promise<void>;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** A time as the value of a date-and-time box, in the person's own time zone. */
const toLocal = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const pretty = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' });

/** Set a draft to publish itself at a chosen time, change that time, or call it off. */
export function ScheduleDialog({ formName, version, publishAt, open, busy, onOpenChange, onSchedule, onCancelSchedule }: ScheduleDialogProps) {
  const [when, setWhen] = useState('');
  const [problem, setProblem] = useState<string>();
  useEffect(() => {
    if (!open) return;
    setProblem(undefined);
    // Start from the current schedule, or tomorrow at nine.
    const tomorrow = new Date(Date.now() + 86_400_000);
    tomorrow.setHours(9, 0, 0, 0);
    setWhen(toLocal(publishAt ? new Date(publishAt) : tomorrow));
  }, [open, publishAt]);

  const chosen = when ? new Date(when) : undefined;
  const valid = !!chosen && !Number.isNaN(chosen.getTime());
  const inPast = valid && chosen!.getTime() <= Date.now();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent style={{ width: 'min(520px, calc(100vw - 2rem))' }}>
        <DialogHeader>
          <DialogTitle>Publish later</DialogTitle>
          <DialogDescription>
            {formName} v{version} will go live by itself at the time you choose. It is checked again then, with the rights you hold at that moment.
          </DialogDescription>
        </DialogHeader>
        <div className="fb-settings" style={{ gap: 12 }}>
          {publishAt && (
            <p className="text-sm" role="status">
              Set to publish on <strong>{pretty(publishAt)}</strong>.
            </p>
          )}
          <div className="fb-setting">
            <label className="fb-setting__label" htmlFor="schedule-when">
              Publish on
            </label>
            <Input id="schedule-when" type="datetime-local" className={VISIBLE_BORDER} value={when} min={toLocal(new Date())} onChange={(e) => setWhen(e.target.value)} />
            <span className="fb-setting__hint">Your own time zone. Until then the current published version, if there is one, stays live.</span>
          </div>
          {(inPast || problem) && (
            <p role="alert" className="text-sm" style={errorText}>
              {inPast ? 'Choose a time in the future, or publish now.' : problem}
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            {publishAt && (
              <Button type="button" variant="outline" disabled={busy} style={{ marginRight: 'auto' }} onClick={() => void onCancelSchedule().then(() => onOpenChange(false))}>
                Cancel the schedule
              </Button>
            )}
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button
              type="button"
              disabled={busy || !valid || inPast}
              onClick={async () => {
                const refused = await onSchedule(chosen!.toISOString());
                if (refused) setProblem(refused);
                else onOpenChange(false);
              }}
            >
              {publishAt ? 'Change the time' : 'Schedule'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
