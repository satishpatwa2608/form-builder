import { describe, expect, it } from 'vitest';
import { addWorkingTime, DEFAULT_CALENDAR, hoursMs, workingTimeBetween } from '../src';

// IST (+5:30), Mon-Fri 09:00-18:00. 2026-10-02 (Fri) is a holiday in some tests.
const ist = (s: string) => new Date(`${s}+05:30`);
const cal = DEFAULT_CALENDAR;

describe('working time', () => {
  it('adds hours inside the working day', () => {
    expect(addWorkingTime(ist('2026-09-29T10:00:00'), hoursMs(3), cal)).toEqual(ist('2026-09-29T13:00:00'));
  });

  it('carries over to the next working day, skipping weekends', () => {
    // Fri 17:00 + 8h = 1h Fri + 7h Mon -> Mon 16:00
    expect(addWorkingTime(ist('2026-10-02T17:00:00'), hoursMs(8), cal)).toEqual(ist('2026-10-05T16:00:00'));
  });

  it('starts counting at the next opening when submitted out of hours', () => {
    expect(addWorkingTime(ist('2026-09-29T20:00:00'), hoursMs(1), cal)).toEqual(ist('2026-09-30T10:00:00'));
    expect(addWorkingTime(ist('2026-10-03T11:00:00'), hoursMs(1), cal)).toEqual(ist('2026-10-05T10:00:00')); // Saturday
  });

  it('skips holidays', () => {
    const withHoliday = { ...cal, holidays: ['2026-10-02'] };
    expect(addWorkingTime(ist('2026-10-01T17:00:00'), hoursMs(2), withHoliday)).toEqual(ist('2026-10-05T10:00:00'));
  });

  it('measures working time between two moments', () => {
    expect(workingTimeBetween(ist('2026-10-02T17:00:00'), ist('2026-10-05T16:00:00'), cal)).toBe(hoursMs(8));
    expect(workingTimeBetween(ist('2026-10-03T00:00:00'), ist('2026-10-04T23:00:00'), cal)).toBe(0);
  });

  it('no calendar = wall clock', () => {
    expect(addWorkingTime(ist('2026-10-03T11:00:00'), hoursMs(1), null)).toEqual(ist('2026-10-03T12:00:00'));
    expect(workingTimeBetween(ist('2026-10-03T11:00:00'), ist('2026-10-03T12:30:00'))).toBe(hoursMs(1.5));
  });
});
