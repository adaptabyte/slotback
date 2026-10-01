import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffIcal, parseIcs } from '../../src/server/adapters/ical.ts';
import { hl7Ack, interpretSiu, parseHl7 } from '../../src/server/adapters/hl7.ts';
import { renderMessage } from '../../src/server/adapters/notify.ts';

const ICS = (events: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\n${events}END:VCALENDAR\r\n`;
const ev = (uid: string, start: string, end: string, extra = '') =>
  `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART;TZID=America/New_York:${start}\r\nDTEND;TZID=America/New_York:${end}\r\nSUMMARY:Pt appt\r\n${extra}END:VEVENT\r\n`;

test('iCal: parses TZID/UTC times and folded lines', () => {
  const events = parseIcs(
    ICS(
      ev('a@x', '20261007T100000', '20261007T110000') +
        'BEGIN:VEVENT\r\nUID:b@x\r\nDTSTART:20261008T150000Z\r\nDURATION:PT30M\r\nSUMMARY:Lunch\r\n block\r\nEND:VEVENT\r\n' +
        'BEGIN:VEVENT\r\nUID:c@x\r\nDTSTART;VALUE=DATE:20261009\r\nSUMMARY:Holiday\r\nEND:VEVENT\r\n',
    ),
    'America/New_York',
  );
  assert.equal(events.length, 3);
  assert.equal(events[0].start.toISOString(), '2026-10-07T14:00:00.000Z');
  assert.equal(events[1].end.toISOString(), '2026-10-08T15:30:00.000Z');
  assert.equal(events[1].summary, 'Lunchblock');
  assert.equal(events[2].allDay, true);
});

test('iCal diff: removed, cancelled and moved events free their slots; ignore pattern and glitches respected', () => {
  const now = new Date('2026-10-05T12:00:00Z');
  const base = ev('1', '20261007T090000', '20261007T100000') + ev('2', '20261007T100000', '20261007T110000') +
    ev('3', '20261007T110000', '20261007T120000') + ev('4', '20261008T090000', '20261008T100000') +
    ev('5', '20261008T100000', '20261008T110000') + ev('6', '20261008T110000', '20261008T120000');
  const first = diffIcal(undefined, parseIcs(ICS(base), 'America/New_York'), now, { horizonDays: 60 });
  assert.equal(first.freed.length, 0, 'first poll only records a baseline');
  assert.equal(Object.keys(first.snapshot).length, 6);

  const next =
    ev('1', '20261007T090000', '20261007T100000', 'STATUS:CANCELLED\r\n') + // cancelled
    ev('3', '20261007T140000', '20261007T150000') + // moved
    ev('4', '20261008T090000', '20261008T100000') + ev('5', '20261008T100000', '20261008T110000') + ev('6', '20261008T110000', '20261008T120000');
  // event 2 deleted entirely
  const d = diffIcal(first.snapshot, parseIcs(ICS(next), 'America/New_York'), now, { horizonDays: 60 });
  assert.deepEqual(d.freed.map((f) => f.key).sort(), ['1', '2', '3']);
  assert.equal(d.freed.find((f) => f.key === '3')!.start, '2026-10-07T15:00:00.000Z', 'the old time of a moved visit is freed');

  const empty = diffIcal(first.snapshot, parseIcs(ICS(''), 'America/New_York'), now, { horizonDays: 60 });
  assert.equal(empty.freed.length, 0);
  assert.match(empty.suspicious ?? '', /vanished/);
  assert.deepEqual(empty.snapshot, first.snapshot, 'baseline kept after a glitch');

  const ignored = diffIcal(undefined, parseIcs(ICS(ev('L', '20261007T120000', '20261007T130000').replace('Pt appt', 'Lunch')), 'America/New_York'), now, {
    horizonDays: 60,
    ignore: 'lunch|admin',
  });
  assert.equal(Object.keys(ignored.snapshot).length, 0);
});

const SIU = [
  'MSH|^~\\&|EHR|CLINIC|SLOTBACK|CLINIC|20261005120000||SIU^S15|MSG0001|P|2.5.1',
  'SCH|PL123|FL456||||CANCEL^Patient cancelled|||30|min|^^30^20261007140000^20261007143000',
  'PID|1||MRN123||Doe^Jane',
  'AIS|1||FOLLOWUP|20261007140000|||30|min',
  'AIP|1||DRA^A^Doctor',
].join('\r');

test('HL7 SIU^S15 becomes a freed slot and is acknowledged', () => {
  const msg = parseHl7(`\x0b${SIU}\x1c\r`);
  assert.equal(msg.type, 'SIU');
  assert.equal(msg.trigger, 'S15');
  const e = interpretSiu(msg, 'America/New_York');
  assert.equal(e.kind, 'freed');
  assert.equal(e.appointmentId, 'FL456');
  assert.equal(e.providerHl7Id, 'DRA');
  assert.equal(e.start?.toISOString(), '2026-10-07T18:00:00.000Z');
  assert.equal(e.end?.toISOString(), '2026-10-07T18:30:00.000Z');
  assert.match(hl7Ack(msg, 'AA'), /^MSH\|\^~\\&\|SLOTBACK.*\rMSA\|AA\|MSG0001\|\r$/s);
});

test('minimal-privacy messages never include visit details', () => {
  const base = {
    privacyMode: 'minimal' as const,
    practiceName: 'Clinic',
    practicePhone: '',
    firstName: 'Jane',
    slot: 'Tue, Oct 7 at 2:00 PM',
    providerName: 'Dr. Psych',
    modality: 'telehealth',
    expires: '3:30 PM',
    link: 'https://x/o/abc',
  };
  for (const kind of ['offer', 'offer_taken', 'booked', 'auto_booked', 'booking_delayed'] as const) {
    const m = renderMessage({ ...base, kind });
    assert.ok(!m.text.includes('Oct 7') && !m.text.includes('Dr. Psych') && !m.text.includes('Jane'), `${kind}: ${m.text}`);
  }
  const std = renderMessage({ ...base, privacyMode: 'standard', kind: 'offer' });
  assert.ok(std.text.includes('Oct 7') && std.text.includes('https://x/o/abc') && std.text.length < 320);
});
