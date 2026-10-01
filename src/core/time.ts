/** Time-zone helpers built only on `Intl`, so they work in Node and browsers. */

import type { ISODateTime, LocalDate, LocalTime, Weekday } from './types.ts';

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS: Record<string, Weekday> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface LocalParts {
  date: LocalDate;
  weekday: Weekday;
  /** Minutes since local midnight. */
  minutes: number;
}

function rawParts(instant: Date, timeZone: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(instant)) out[p.type] = p.value;
  return out;
}

export function toLocal(instant: Date | ISODateTime, timeZone: string): LocalParts {
  const d = typeof instant === 'string' ? new Date(instant) : instant;
  const p = rawParts(d, timeZone);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: WEEKDAYS[p.weekday] ?? 0,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

/** Offset of `timeZone` from UTC at `instant`, in minutes (local − UTC). */
export function tzOffsetMinutes(instant: Date, timeZone: string): number {
  const p = rawParts(instant, timeZone);
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  const truncated = Math.floor(instant.getTime() / 1000) * 1000;
  return Math.round((asUtc - truncated) / 60000);
}

/** Converts a wall-clock date + time in `timeZone` to a UTC instant. */
export function localToInstant(date: LocalDate, time: LocalTime, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const minutes = parseHHMM(time);
  const guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  let offset = tzOffsetMinutes(new Date(guess), timeZone);
  let result = guess - offset * 60000;
  // Re-check once: the offset at the guessed instant can differ across a DST edge.
  const offset2 = tzOffsetMinutes(new Date(result), timeZone);
  if (offset2 !== offset) {
    offset = offset2;
    result = guess - offset * 60000;
  }
  return new Date(result);
}

export function parseHHMM(s: LocalTime): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`Invalid time "${s}", expected HH:MM`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) throw new Error(`Invalid time "${s}"`);
  return h * 60 + min;
}

export function formatHHMM(minutes: number): LocalTime {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function addMinutes(instant: ISODateTime, minutes: number): ISODateTime {
  return new Date(new Date(instant).getTime() + minutes * 60000).toISOString();
}

export function minutesBetween(from: ISODateTime | Date, to: ISODateTime | Date): number {
  return (new Date(to).getTime() - new Date(from).getTime()) / 60000;
}

/** Adds whole days to a `YYYY-MM-DD` date. */
export function addDays(date: LocalDate, days: number): LocalDate {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Human-friendly "Tue, Oct 7 at 10:00 AM" in the given zone. */
export function formatSlot(instant: ISODateTime | Date, timeZone: string): string {
  const d = typeof instant === 'string' ? new Date(instant) : instant;
  const date = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(d);
  return `${date} at ${time}`;
}
