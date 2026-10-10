import { useMemo, useState } from 'react';
import { addMonths, eachDayOfInterval, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, startOfMonth, startOfWeek } from 'date-fns';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@ui/button';
import { useInbox, type InboxFilters, type RecordRow } from '../../adapters/workflow';

interface InboxCalendarProps {
  /** The view being looked at (whose work, which form, which status): the calendar shows the same records. */
  filters: InboxFilters;
  onOpen: (id: string) => void;
  /** The month to open on; today's when left out. */
  startOn?: Date;
}

/** When a record is due: the time to resolve it, or, without one, the time allowed in its status. */
const dueOf = (row: RecordRow) => row.resolutionDueAt ?? row.dueAt;
const DAY_ROOM = 4;

/**
 * What is due, laid out as a month. Each day lists the records due that day, most urgent first; one click opens
 * a record. It asks for the whole month at once, with the same filters as the list beside it.
 */
export function InboxCalendar({ filters, onOpen, startOn }: InboxCalendarProps) {
  const [month, setMonth] = useState(() => startOfMonth(startOn ?? new Date()));
  const from = startOfWeek(month, { weekStartsOn: 1 });
  const to = endOfWeek(endOfMonth(month), { weekStartsOn: 1 });
  const { data, isLoading } = useInbox({ ...filters, page: 1, sort: 'due', limit: 300, dueFrom: from.toISOString(), dueTo: new Date(to.getTime() + 1).toISOString() });
  const days = useMemo(() => eachDayOfInterval({ start: from, end: to }), [from.getTime(), to.getTime()]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = data?.rows ?? [];
  const today = new Date();
  const [open, setOpen] = useState<string>();

  return (
    <div className="wi-cal" role="group" aria-label="Calendar of what is due">
      <div className="wi-cal__head">
        <Button type="button" variant="outline" size="sm" aria-label="Previous month" onClick={() => setMonth((m) => addMonths(m, -1))}>
          <ChevronLeft />
        </Button>
        <strong aria-live="polite">{format(month, 'MMMM yyyy')}</strong>
        <Button type="button" variant="outline" size="sm" aria-label="Next month" onClick={() => setMonth((m) => addMonths(m, 1))}>
          <ChevronRight />
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setMonth(startOfMonth(new Date()))}>
          This month
        </Button>
        <span className="wi-sub">{isLoading ? 'Loading…' : rows.length === 0 ? 'Nothing is due this month in this view.' : `${rows.length} due${data && data.total > rows.length ? ` (the first ${rows.length} of ${data.total})` : ''}`}</span>
      </div>
      <div className="wi-cal__grid" role="grid" aria-label={format(month, 'MMMM yyyy')}>
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div key={d} className="wi-cal__dow" role="columnheader">
            {d}
          </div>
        ))}
        {days.map((day) => {
          const due = rows.filter((r) => dueOf(r) && isSameDay(new Date(dueOf(r)!), day));
          const key = format(day, 'yyyy-MM-dd');
          const all = open === key;
          const late = day < today && !isSameDay(day, today);
          return (
            <div key={key} role="gridcell" aria-label={`${format(day, 'd MMMM')}: ${due.length} due`} className={`wi-cal__day${isSameMonth(day, month) ? '' : ' wi-cal__day--other'}${isSameDay(day, today) ? ' wi-cal__day--today' : ''}`}>
              <span className="wi-cal__date">{format(day, 'd')}</span>
              {(all ? due : due.slice(0, DAY_ROOM)).map((r) => (
                <button key={r.uuid} type="button" className={`wi-cal__item wi-cal__item--${r.priority}${late ? ' wi-cal__item--late' : ''}`} title={`${data?.forms[r.formId]?.name ?? r.formCode} · due ${format(new Date(dueOf(r)!), 'HH:mm')}`} onClick={() => onOpen(r.uuid)}>
                  {r.ref || 'Open'}
                </button>
              ))}
              {due.length > DAY_ROOM && (
                <button type="button" className="wi-cal__more" onClick={() => setOpen(all ? undefined : key)}>
                  {all ? 'Show fewer' : `${due.length - DAY_ROOM} more`}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
