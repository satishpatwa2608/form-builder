import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@ui/button';
import { Checkbox } from '@ui/checkbox';
import { Input } from '@ui/input';
import type { WorkingCalendar } from '../types';
import { useCalendar, useSaveCalendar } from '../adapters/workflow';
import { messageOf } from '../adapters/backend';
import { useFormPermissions } from '../hooks/useFormPermissions';
import { Setting } from '../builder/components/settings';
import { VISIBLE_BORDER } from '../runtime/styles';
import '../styles/form-builder.css';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The org's working time: SLAs set to "working hours only" count against it. */
export default function WorkingTimePage() {
  const { canManagePages } = useFormPermissions();
  const { data, isLoading } = useCalendar();
  const save = useSaveCalendar();
  const [cal, setCal] = useState<WorkingCalendar | null>(null);
  const [holiday, setHoliday] = useState('');
  useEffect(() => {
    if (data) setCal(data);
  }, [data]);

  if (!canManagePages) return <p className="p-6 text-sm text-muted-foreground">Setting working time needs the Form Admin module.</p>;
  if (isLoading || !cal) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  const set = (changes: Partial<WorkingCalendar>) => setCal({ ...cal, ...changes });
  const offsetHours = cal.utcOffsetMinutes / 60;

  return (
    <div className="p-6 space-y-6" style={{ maxWidth: 720 }}>
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold text-gray-900">Working time</h1>
        <p className="text-sm text-muted-foreground">SLAs set to "working hours only" count only these hours. Others run around the clock.</p>
      </div>
      <div className="fb-panel fb-settings" style={{ gap: 14 }}>
        <Setting label="Working days">
          {() => (
            <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
              {DAYS.map((d, i) => (
                <label key={d} className="flex items-center gap-2 text-sm" style={{ marginRight: 10 }}>
                  <Checkbox
                    className={VISIBLE_BORDER}
                    checked={cal.workingDays.includes(i)}
                    onCheckedChange={(c) => set({ workingDays: c === true ? [...cal.workingDays, i].sort() : cal.workingDays.filter((x) => x !== i) })}
                  />
                  {d}
                </label>
              ))}
            </div>
          )}
        </Setting>
        <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
          <Setting label="Starts">{(id) => <Input id={id} type="time" value={cal.start} onChange={(e) => set({ start: e.target.value })} />}</Setting>
          <Setting label="Ends">{(id) => <Input id={id} type="time" value={cal.end} onChange={(e) => set({ end: e.target.value })} />}</Setting>
          <Setting label="Time zone (hours from UTC)">
            {(id) => <Input id={id} type="number" step="0.25" value={offsetHours} onChange={(e) => set({ utcOffsetMinutes: Math.round(Number(e.target.value) * 60) || 0 })} />}
          </Setting>
        </div>
        <Setting label="Holidays" hint="No working time on these dates.">
          {(id) => (
            <div className="fb-settings" style={{ gap: 6 }}>
              <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
                {cal.holidays.map((h) => (
                  <span key={h} className="fb-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    {h}
                    <button type="button" aria-label={`Remove ${h}`} onClick={() => set({ holidays: cal.holidays.filter((x) => x !== h) })} style={{ display: 'inline-flex' }}>
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <Input id={id} type="date" value={holiday} onChange={(e) => setHoliday(e.target.value)} style={{ maxWidth: 200 }} />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!holiday || cal.holidays.includes(holiday)}
                  onClick={() => {
                    set({ holidays: [...cal.holidays, holiday].sort() });
                    setHoliday('');
                  }}
                >
                  <Plus /> Add holiday
                </Button>
              </div>
            </div>
          )}
        </Setting>
        <Button
          type="button"
          style={{ alignSelf: 'flex-start' }}
          disabled={save.isPending}
          onClick={async () => {
            try {
              await save.mutateAsync(cal);
              toast.success('Working time saved');
            } catch (e) {
              toast.error(messageOf(e));
            }
          }}
        >
          Save
        </Button>
      </div>
    </div>
  );
}
