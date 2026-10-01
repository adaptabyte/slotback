import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, checkEligibility, rank } from '../../src/core/index.ts';
import type { Opening } from '../../src/core/index.ts';
import { NOW, TZ, at, entry, minutesAfter, opening, setup } from './helpers.ts';

function asOpening(o = opening()): Opening {
  return {
    id: 'opn_x',
    status: 'new',
    createdAt: NOW.toISOString(),
    origin: { kind: 'cancellation' },
    chainDepth: 0,
    appointmentTypes: [],
    ...o,
  } as Opening;
}

test('eligibility explains every reason a patient is skipped', () => {
  const e = entry({
    providerIds: ['dr_patel'],
    modalities: ['telehealth'],
    durationMinutes: 60,
    availability: { timeZone: TZ, weekly: [{ day: 1, start: '08:00', end: '09:00' }], minNoticeMinutes: 96 * 60 },
    currentAppointment: {
      start: at('2026-10-07', '09:00'),
      end: at('2026-10-07', '09:30'),
      providerId: 'dr_patel',
      modality: 'telehealth',
    },
  });
  const codes = checkEligibility(e, asOpening(), NOW, DEFAULT_SETTINGS).map((r) => r.code);
  assert.deepEqual(codes.sort(), ['duration', 'modality', 'not_earlier', 'notice', 'provider', 'window'].sort());
  assert.deepEqual(checkEligibility(entry(), asOpening(), NOW, DEFAULT_SETTINGS), []);
});

test('ranking: pinned first, then acuity-weighted score, provider boost, then longest wait', () => {
  const low = entry({ id: 'low', acuity: 1 });
  const high = entry({ id: 'high', acuity: 5 });
  const boosted = entry({ id: 'boosted', acuity: 3, boost: 110 });
  const pinned = entry({ id: 'pinned', acuity: 1, pinned: true });
  const ranked = rank([low, high, boosted, pinned], DEFAULT_SETTINGS.priority, NOW).map((c) => c.entry.id);
  assert.deepEqual(ranked, ['pinned', 'boosted', 'high', 'low']);

  const top = rank([high], DEFAULT_SETTINGS.priority, NOW)[0];
  assert.ok(top.score.parts.some((p) => p.label === 'Clinical acuity 5/5' && p.points === 200));
  assert.ok(top.score.parts.some((p) => p.label === 'Waiting 10 days' && p.points === 10));
});

test('auto-book patient is booked instantly and notified once the EHR confirms', () => {
  const { store, engine } = setup();
  engine.addEntry(entry({ id: 'a', bookingMode: 'auto', acuity: 4 }), NOW);
  engine.addEntry(entry({ id: 'b', bookingMode: 'confirm', acuity: 2 }), NOW);

  const res = engine.createOpening(opening(), NOW);
  assert.equal(res.opening.status, 'booking');
  const book = res.commands.find((c) => c.type === 'book');
  assert.ok(book && book.type === 'book');
  assert.equal(store.getEntry('a')!.status, 'booking');
  assert.ok(!res.commands.some((c) => c.type === 'notify'), 'no notification until booking is confirmed');

  const done = engine.bookingResult(book.bookingId, { ok: true, externalId: 'ehr-123' }, minutesAfter(NOW, 1));
  assert.equal(store.getOpening(res.opening.id)!.status, 'filled');
  assert.equal(store.getEntry('a')!.status, 'booked');
  assert.deepEqual(
    done.commands.map((c) => (c.type === 'notify' ? `${c.kind}:${c.entryId}` : c.type)),
    ['auto_booked:a'],
  );
  assert.equal(store.getBooking(book.bookingId)!.externalId, 'ehr-123');
});

test('confirm-mode: offer → decline cascades to next patient → accept books', () => {
  const { store, engine } = setup();
  engine.addEntry(entry({ id: 'first', acuity: 5 }), NOW);
  engine.addEntry(entry({ id: 'second', acuity: 3 }), NOW);

  // Opening is 3 days out → sequential offers (one at a time).
  const res = engine.createOpening(opening(), NOW);
  const offer1 = store.listOffers({ status: 'pending' });
  assert.equal(offer1.length, 1);
  assert.equal(offer1[0].entryId, 'first');
  assert.equal(offer1[0].expiresAt, minutesAfter(NOW, 30).toISOString());
  assert.ok(res.commands.some((c) => c.type === 'notify' && c.kind === 'offer' && c.entryId === 'first'));

  const declined = engine.respond(offer1[0].id, 'decline', minutesAfter(NOW, 5));
  assert.equal(declined.result, 'declined');
  assert.equal(store.getEntry('first')!.declines, 1);
  const offer2 = store.listOffers({ status: 'pending' });
  assert.equal(offer2.length, 1);
  assert.equal(offer2[0].entryId, 'second');

  const accepted = engine.respond(offer2[0].id, 'accept', minutesAfter(NOW, 10));
  assert.equal(accepted.result, 'accepted');
  const book = accepted.commands.find((c) => c.type === 'book');
  assert.ok(book && book.type === 'book');
  const done = engine.bookingResult(book.bookingId, { ok: true }, minutesAfter(NOW, 11));
  assert.ok(done.commands.some((c) => c.type === 'notify' && c.kind === 'booked' && c.entryId === 'second'));
  assert.equal(store.getEntry('first')!.status, 'active', 'decliner stays on the waitlist');
});

test('unanswered offers expire on tick and cascade', () => {
  const { store, engine } = setup();
  engine.addEntry(entry({ id: 'slow', acuity: 5 }), NOW);
  engine.addEntry(entry({ id: 'next', acuity: 2 }), NOW);
  engine.createOpening(opening(), NOW);
  assert.equal(engine.tick(minutesAfter(NOW, 29)).events.length, 0);
  const t = engine.tick(minutesAfter(NOW, 31));
  assert.ok(t.events.some((e) => e.type === 'offer.expired' && e.entryId === 'slow'));
  assert.equal(store.listOffers({ status: 'pending' })[0].entryId, 'next');
  assert.equal(store.getEntry('slow')!.status, 'active');

  const late = engine.respond(store.listOffers({ entryId: 'slow' })[0].id, 'accept', minutesAfter(NOW, 32));
  assert.equal(late.result, 'expired');
});

test('near-term openings are offered in parallel; first acceptance wins, others are told', () => {
  const { store, engine } = setup();
  for (const id of ['p1', 'p2', 'p3', 'p4']) engine.addEntry(entry({ id }), NOW);
  // Today at 14:00, six hours away → within parallelWithinHours (24).
  engine.createOpening(opening({ start: at('2026-10-05', '14:00'), end: at('2026-10-05', '14:30') }), NOW);
  const pending = store.listOffers({ status: 'pending' });
  assert.equal(pending.length, 3);
  // The hold never runs past start − minLead.
  assert.ok(pending.every((o) => o.expiresAt <= at('2026-10-05', '13:00')));

  const winner = pending.find((o) => o.entryId === 'p3')!;
  const res = engine.respond(winner.id, 'accept', minutesAfter(NOW, 2));
  assert.equal(res.result, 'accepted');
  const taken = res.commands.filter((c) => c.type === 'notify' && c.kind === 'offer_taken').map((c) => c.type === 'notify' && c.entryId);
  assert.deepEqual(taken.sort(), ['p1', 'p2']);
  const loser = pending.find((o) => o.entryId === 'p1')!;
  assert.equal(engine.respond(loser.id, 'accept', minutesAfter(NOW, 3)).result, 'unavailable');
  assert.equal(store.getEntry('p1')!.status, 'active');
});

test('parallel batch stops at an auto-book patient (auto patients are never skipped)', () => {
  const { store, engine } = setup();
  engine.addEntry(entry({ id: 'c1', acuity: 5 }), NOW);
  engine.addEntry(entry({ id: 'auto', acuity: 4, bookingMode: 'auto' }), NOW);
  engine.addEntry(entry({ id: 'c2', acuity: 3 }), NOW);
  engine.createOpening(opening({ start: at('2026-10-05', '14:00'), end: at('2026-10-05', '14:30') }), NOW);
  assert.deepEqual(store.listOffers({ status: 'pending' }).map((o) => o.entryId), ['c1']);
  const offer = store.listOffers({ status: 'pending' })[0];
  const res = engine.respond(offer.id, 'decline', minutesAfter(NOW, 1));
  assert.ok(res.commands.some((c) => c.type === 'book'));
  assert.equal(store.getEntry('auto')!.status, 'booking');
});

test('moving a patient up frees their old slot, which cascades to the next patient', () => {
  const { store, engine } = setup();
  engine.addEntry(
    entry({
      id: 'mover',
      acuity: 5,
      bookingMode: 'auto',
      currentAppointment: {
        start: at('2026-10-29', '10:00'),
        end: at('2026-10-29', '10:30'),
        providerId: 'dr_lee',
        modality: 'in_person',
        externalId: 'appt-777',
      },
    }),
    NOW,
  );
  engine.addEntry(entry({ id: 'newbie', acuity: 2, bookingMode: 'auto' }), NOW);

  const first = engine.createOpening(opening(), NOW);
  const book1 = first.commands.find((c) => c.type === 'book')!;
  assert.equal(store.getEntry('mover')!.status, 'booking');

  const done = engine.bookingResult(book1.type === 'book' ? book1.bookingId : '', { ok: true }, minutesAfter(NOW, 1));
  const cancel = done.commands.find((c) => c.type === 'cancel_original');
  assert.ok(cancel && cancel.type === 'cancel_original' && cancel.appointment.externalId === 'appt-777');
  const chained = store.listOpenings().find((o) => o.source === 'cascade')!;
  assert.equal(chained.chainDepth, 1);
  assert.equal(chained.origin.kind, 'moved_up');
  assert.equal(chained.start, at('2026-10-29', '10:00'));
  assert.equal(chained.status, 'booking');
  assert.equal(store.getEntry('newbie')!.status, 'booking');
});

test('booking conflicts withdraw the opening; other failures flag it for staff', () => {
  const { store, engine } = setup();
  engine.addEntry(entry({ id: 'a', bookingMode: 'auto' }), NOW);
  const r1 = engine.createOpening(opening(), NOW);
  const b1 = r1.commands.find((c) => c.type === 'book')!;
  const f1 = engine.bookingResult(b1.type === 'book' ? b1.bookingId : '', { ok: false, reason: 'conflict' }, NOW);
  assert.equal(store.getOpening(r1.opening.id)!.status, 'withdrawn');
  assert.ok(f1.commands.some((c) => c.type === 'notify' && c.kind === 'offer_taken'));
  assert.equal(store.getEntry('a')!.status, 'active');

  const r2 = engine.createOpening(opening({ start: at('2026-10-09', '10:00'), end: at('2026-10-09', '10:30') }), NOW);
  const b2 = r2.commands.find((c) => c.type === 'book')!;
  engine.bookingResult(b2.type === 'book' ? b2.bookingId : '', { ok: false, reason: 'error', message: 'HTTP 500' }, NOW);
  assert.equal(store.getOpening(r2.opening.id)!.status, 'needs_attention');
});

test('openings wait for a matching patient, and expire when too close to fill', () => {
  const { store, engine } = setup();
  const res = engine.createOpening(opening(), NOW);
  assert.equal(res.opening.status, 'open');
  assert.ok(res.events.some((e) => e.type === 'opening.no_match'));

  // A patient joins later and picks the idle opening up immediately.
  const add = engine.addEntry(entry({ id: 'late', bookingMode: 'confirm' }), minutesAfter(NOW, 60));
  assert.ok(add.commands.some((c) => c.type === 'notify' && c.kind === 'offer'));

  const soon = engine.createOpening(
    opening({ providerId: 'dr_kim', start: at('2026-10-05', '08:30'), end: at('2026-10-05', '09:00') }),
    NOW,
  );
  assert.equal(soon.opening.status, 'expired');
  assert.equal(store.listOpenings({ status: 'expired' }).length, 1);
});

test('createOpening is idempotent per source + externalId while active', () => {
  const { store, engine } = setup();
  const a = engine.createOpening(opening({ source: 'fhir', externalId: 'slot-1' }), NOW);
  const b = engine.createOpening(opening({ source: 'fhir', externalId: 'slot-1' }), NOW);
  assert.equal(a.opening.id, b.opening.id);
  assert.equal(store.listOpenings().length, 1);
});

test('pausing a patient with an outstanding offer passes the slot on', () => {
  const { store, engine } = setup();
  engine.addEntry(entry({ id: 'x', acuity: 5 }), NOW);
  engine.addEntry(entry({ id: 'y', acuity: 1 }), NOW);
  engine.createOpening(opening(), NOW);
  assert.equal(store.listOffers({ status: 'pending' })[0].entryId, 'x');
  engine.updateEntry('x', { status: 'paused' }, minutesAfter(NOW, 1));
  assert.equal(store.listOffers({ status: 'pending' })[0].entryId, 'y');
  assert.throws(() => engine.updateEntry('y', { status: 'booked' }, NOW));
});

test('explain() reports ranked eligible patients and reasons for the rest', () => {
  const { engine } = setup();
  engine.addEntry(entry({ id: 'ok', status: 'paused' }), NOW);
  engine.addEntry(entry({ id: 'tele', modalities: ['telehealth'], status: 'paused' }), NOW);
  const { opening: o } = engine.createOpening(opening(), NOW);
  const ex = engine.explain(o.id, NOW);
  assert.equal(ex.eligible.length, 0);
  const byId = Object.fromEntries(ex.ineligible.map((i) => [i.entry.id, i.reasons.map((r) => r.code)]));
  assert.deepEqual(byId.ok, ['status']);
  assert.deepEqual(byId.tele.sort(), ['modality', 'status']);
});

test('default policy: a higher acuity level always outranks non-clinical factors', () => {
  const urgentNew = entry({ id: 'urgent', acuity: 5, addedAt: NOW.toISOString(), currentAppointment: {
    start: at('2026-10-09', '10:00'), end: at('2026-10-09', '11:00'), providerId: 'dr_lee', modality: 'in_person' } });
  const longWaiter = entry({ id: 'waiter', acuity: 4, addedAt: new Date(NOW.getTime() - 400 * 86400000).toISOString() });
  const o = asOpening(opening({ start: at('2026-10-06', '10:00'), end: at('2026-10-06', '11:00') }));
  assert.deepEqual(rank([longWaiter, urgentNew], DEFAULT_SETTINGS.priority, NOW, o).map((c) => c.entry.id), ['urgent', 'waiter']);
});

test('quiet hours: confirm offers wait for morning, auto-book still proceeds', () => {
  const { store, engine } = setup({
    ...DEFAULT_SETTINGS,
    timeZone: TZ,
    offers: { ...DEFAULT_SETTINGS.offers, quietHours: { start: '21:00', end: '08:00' } },
  });
  const night = new Date(at('2026-10-05', '23:00'));
  engine.addEntry(entry({ id: 'asker', acuity: 5 }), night);
  const res = engine.createOpening(opening(), night);
  assert.equal(res.opening.status, 'open');
  assert.ok(res.events.some((e) => e.type === 'opening.deferred'));
  assert.equal(store.listOffers().length, 0);
  assert.equal(engine.tick(new Date(at('2026-10-06', '07:59'))).commands.length, 0);
  const morning = engine.tick(new Date(at('2026-10-06', '08:00')));
  assert.ok(morning.commands.some((c) => c.type === 'notify' && c.kind === 'offer'));

  engine.addEntry(entry({ id: 'auto', bookingMode: 'auto', acuity: 5 }), night);
  const r2 = engine.createOpening(opening({ start: at('2026-10-09', '10:00'), end: at('2026-10-09', '10:30') }), night);
  assert.equal(r2.opening.status, 'booking');
});
