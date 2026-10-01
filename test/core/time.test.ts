import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeWindows,
  fitsWeeklyWindow,
  localToInstant,
  normalizeWindows,
  toLocal,
  tzOffsetMinutes,
} from '../../src/core/index.ts';
import type { Availability } from '../../src/core/index.ts';

test('localToInstant / toLocal round-trip across a DST change', () => {
  // US DST ends 2026-11-01 at 02:00 local.
  for (const [date, time] of [
    ['2026-10-31', '09:00'],
    ['2026-11-01', '09:00'],
    ['2026-03-08', '09:00'],
    ['2026-07-04', '23:30'],
  ]) {
    const instant = localToInstant(date, time, 'America/New_York');
    const local = toLocal(instant, 'America/New_York');
    assert.equal(local.date, date);
    assert.equal(local.minutes, Number(time.slice(0, 2)) * 60 + Number(time.slice(3)));
  }
  assert.equal(tzOffsetMinutes(new Date('2026-07-01T12:00:00Z'), 'America/New_York'), -240);
  assert.equal(tzOffsetMinutes(new Date('2026-12-01T12:00:00Z'), 'America/New_York'), -300);
  assert.equal(localToInstant('2026-10-05', '08:00', 'America/New_York').toISOString(), '2026-10-05T12:00:00.000Z');
});

test('fitsWeeklyWindow requires the whole visit inside one window on the right weekday', () => {
  const av: Availability = {
    timeZone: 'America/Chicago',
    weekly: [{ day: 2, start: '09:00', end: '12:00' }],
    minNoticeMinutes: 0,
  };
  const tue = (t: string) => localToInstant('2026-10-06', t, 'America/Chicago');
  assert.equal(fitsWeeklyWindow(av, tue('09:00'), tue('10:00')), true);
  assert.equal(fitsWeeklyWindow(av, tue('11:30'), tue('12:00')), true);
  assert.equal(fitsWeeklyWindow(av, tue('11:30'), tue('12:30')), false);
  assert.equal(fitsWeeklyWindow(av, tue('08:30'), tue('09:30')), false);
  const wed = localToInstant('2026-10-07', '09:00', 'America/Chicago');
  assert.equal(fitsWeeklyWindow(av, wed, new Date(wed.getTime() + 3600000)), false);
});

test('normalizeWindows merges overlaps and describeWindows is readable', () => {
  const merged = normalizeWindows([
    { day: 1, start: '13:00', end: '17:00' },
    { day: 1, start: '08:00', end: '12:00' },
    { day: 1, start: '12:00', end: '13:00' },
    { day: 3, start: '09:30', end: '11:00' },
  ]);
  assert.deepEqual(merged, [
    { day: 1, start: '08:00', end: '17:00' },
    { day: 3, start: '09:30', end: '11:00' },
  ]);
  assert.equal(describeWindows(merged), 'Mon 8am–5pm · Wed 9:30am–11am');
});
