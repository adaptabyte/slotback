import type { Availability, TimeWindow } from './types.ts';
import { parseHHMM, toLocal, WEEKDAY_NAMES } from './time.ts';

/** True when [start, end) falls entirely inside one of the patient's weekly windows. */
export function fitsWeeklyWindow(av: Availability, start: Date, end: Date): boolean {
  const s = toLocal(start, av.timeZone);
  const e = toLocal(end, av.timeZone);
  // A visit that crosses local midnight never fits a same-day window.
  const endMinutes = e.date === s.date ? e.minutes : e.minutes === 0 ? 24 * 60 : -1;
  if (endMinutes < 0) return false;
  return av.weekly.some(
    (w) => w.day === s.weekday && parseHHMM(w.start) <= s.minutes && endMinutes <= parseHHMM(w.end),
  );
}

export function inBlackout(av: Availability, start: Date): boolean {
  if (!av.blackoutDates?.length) return false;
  const { date } = toLocal(start, av.timeZone);
  return av.blackoutDates.some((span) => span.start <= date && date <= span.end);
}

export function beforeEarliestDate(av: Availability, start: Date): boolean {
  if (!av.earliestDate) return false;
  return toLocal(start, av.timeZone).date < av.earliestDate;
}

export function validateWindows(windows: TimeWindow[]): string[] {
  const errors: string[] = [];
  for (const w of windows) {
    if (!Number.isInteger(w.day) || w.day < 0 || w.day > 6) errors.push(`Invalid weekday ${w.day}`);
    try {
      if (parseHHMM(w.start) >= parseHHMM(w.end)) errors.push(`${WEEKDAY_NAMES[w.day]} window ends before it starts`);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  return errors;
}

/** Merges overlapping/adjacent windows per day and sorts them. */
export function normalizeWindows(windows: TimeWindow[]): TimeWindow[] {
  const byDay = new Map<number, [number, number][]>();
  for (const w of windows) {
    const list = byDay.get(w.day) ?? [];
    list.push([parseHHMM(w.start), parseHHMM(w.end)]);
    byDay.set(w.day, list);
  }
  const out: TimeWindow[] = [];
  for (const day of [...byDay.keys()].sort((a, b) => a - b)) {
    const spans = byDay.get(day)!.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const span of spans) {
      const last = merged[merged.length - 1];
      if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
      else merged.push([...span]);
    }
    for (const [s, e] of merged) {
      out.push({ day: day as TimeWindow['day'], start: fmt(s), end: fmt(e) });
    }
  }
  return out;
}

function fmt(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function to12h(t: string): string {
  const m = parseHHMM(t);
  const h = Math.floor(m / 60) % 24;
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const min = m % 60;
  return min ? `${h12}:${String(min).padStart(2, '0')}${suffix}` : `${h12}${suffix}`;
}

/** "Mon 9am–12pm · Wed 1pm–5pm" */
export function describeWindows(windows: TimeWindow[]): string {
  if (!windows.length) return 'No times selected';
  return normalizeWindows(windows)
    .map((w) => `${WEEKDAY_NAMES[w.day]} ${to12h(w.start)}–${to12h(w.end)}`)
    .join(' · ');
}
