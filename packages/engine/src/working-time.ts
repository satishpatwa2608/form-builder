import type { WorkingCalendar } from './types';

/**
 * Working-time arithmetic for SLAs: "8 working hours from Friday 17:00" is
 * Monday 16:00 on a Mon-Fri 09:00-18:00 calendar. Pure and deterministic; a
 * missing calendar means wall-clock time. Calendars use a fixed UTC offset.
 */

export const DEFAULT_CALENDAR: WorkingCalendar = {
  workingDays: [1, 2, 3, 4, 5],
  start: '09:00',
  end: '18:00',
  holidays: [],
  utcOffsetMinutes: 330,
};

const DAY = 86_400_000;
const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Working window [from, to) of the local day containing `local` (ms, local time held as UTC), or null. */
function windowOf(local: number, cal: WorkingCalendar): [number, number] | null {
  const dayStart = Math.floor(local / DAY) * DAY;
  const d = new Date(dayStart);
  if (!cal.workingDays.includes(d.getUTCDay())) return null;
  if (cal.holidays.includes(d.toISOString().slice(0, 10))) return null;
  const from = dayStart + minutes(cal.start) * 60_000;
  const to = dayStart + minutes(cal.end) * 60_000;
  return to > from ? [from, to] : null;
}

const usable = (cal?: WorkingCalendar | null): cal is WorkingCalendar =>
  !!cal && cal.workingDays.length > 0 && minutes(cal.end) > minutes(cal.start);

/** `start` + `ms` of working time. */
export function addWorkingTime(start: Date, ms: number, cal?: WorkingCalendar | null): Date {
  if (!usable(cal) || ms <= 0) return new Date(start.getTime() + Math.max(ms, 0));
  const off = cal.utcOffsetMinutes * 60_000;
  let t = start.getTime() + off;
  let remaining = ms;
  for (let i = 0; i < 3700; i++) {
    const w = windowOf(t, cal);
    if (w) {
      if (t < w[0]) t = w[0];
      if (t < w[1]) {
        const available = w[1] - t;
        if (remaining <= available) return new Date(t + remaining - off);
        remaining -= available;
      }
    }
    t = Math.floor(t / DAY) * DAY + DAY;
  }
  return new Date(t - off);
}

/** Working time between `a` and `b` (0 if b <= a). */
export function workingTimeBetween(a: Date, b: Date, cal?: WorkingCalendar | null): number {
  if (b.getTime() <= a.getTime()) return 0;
  if (!usable(cal)) return b.getTime() - a.getTime();
  const off = cal.utcOffsetMinutes * 60_000;
  let t = a.getTime() + off;
  const end = b.getTime() + off;
  let total = 0;
  for (let i = 0; i < 3700 && t < end; i++) {
    const w = windowOf(t, cal);
    if (w) total += Math.max(0, Math.min(w[1], end) - Math.max(w[0], t));
    t = Math.floor(t / DAY) * DAY + DAY;
  }
  return total;
}

export const hoursMs = (h: number) => h * 3_600_000;
