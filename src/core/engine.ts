import type {
  Booking,
  Candidate,
  Command,
  EngineEvent,
  EngineSettings,
  Modality,
  Offer,
  Opening,
  OpeningStatus,
  Outcome,
  WaitlistEntry,
} from './types.ts';
import type { Store } from './store.ts';
import { explainOpening, rankCandidates } from './matcher.ts';
import type { OpeningExplanation } from './matcher.ts';
import { rank } from './priority.ts';
import { addMinutes, minutesBetween, parseHHMM, toLocal } from './time.ts';

export const DEFAULT_SETTINGS: EngineSettings = {
  // One acuity level (50) outweighs every non-clinical factor combined (20 + 10 + 15),
  // so by default acuity decides and waiting time / time saved only break ties.
  priority: {
    acuityPoints: 50,
    waitPointsPerDay: 1,
    waitPointsMax: 20,
    unscheduledPoints: 10,
    timeSavedPointsPerDay: 0.5,
    timeSavedPointsMax: 15,
    declinePenalty: 5,
  },
  offers: {
    holdMinutes: 30,
    minLeadMinutes: 60,
    parallelWithinHours: 24,
    parallelCount: 3,
    minImprovementHours: 24,
    quietHours: { start: '21:00', end: '08:00' },
  },
  cascadeFreedSlots: true,
};

export interface NewOpening {
  providerId: string;
  locationId?: string;
  modality: Modality;
  start: string;
  end: string;
  appointmentTypes?: string[];
  source: string;
  externalId?: string;
  origin?: Opening['origin'];
  chainDepth?: number;
}

export type BookingResult =
  | { ok: true; externalId?: string }
  | { ok: false; reason: 'conflict' | 'error'; message?: string };

export type RespondResult = 'accepted' | 'declined' | 'expired' | 'unavailable' | 'already_responded';

export interface EngineOptions {
  store: Store;
  settings?: EngineSettings | (() => EngineSettings);
  newId?: (prefix: string) => string;
}

const ACTIVE_OPENING: OpeningStatus[] = ['new', 'open', 'offering', 'booking', 'needs_attention'];
/** Statuses staff can set directly; the engine owns `offered`, `booking` and `booked`. */
const STAFF_SETTABLE = new Set(['pending_review', 'active', 'paused', 'removed']);

let counter = 0;
function defaultId(prefix: string): string {
  counter += 1;
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}

class Out implements Outcome {
  commands: Command[] = [];
  events: EngineEvent[] = [];
  readonly now: Date;
  constructor(now: Date) {
    this.now = now;
  }
  event(e: Omit<EngineEvent, 'at'>) {
    this.events.push({ at: this.now.toISOString(), ...e });
  }
  result(): Outcome {
    return { commands: this.commands, events: this.events };
  }
}

/**
 * The matching engine: a synchronous state machine over a {@link Store}.
 *
 * Every public method takes `now` explicitly (deterministic, testable,
 * simulatable) and returns the side effects the host must perform as
 * {@link Command}s, plus an {@link EngineEvent} trail for audit and UI.
 * Asynchronous work (writing the booking to an EHR) is reported back through
 * {@link Engine.bookingResult}.
 */
export class Engine {
  readonly store: Store;
  private readonly settingsFn: () => EngineSettings;
  private readonly newId: (prefix: string) => string;

  constructor(opts: EngineOptions) {
    this.store = opts.store;
    const s = opts.settings ?? DEFAULT_SETTINGS;
    this.settingsFn = typeof s === 'function' ? s : () => s;
    this.newId = opts.newId ?? defaultId;
  }

  get settings(): EngineSettings {
    return this.settingsFn();
  }

  // ---------------------------------------------------------------- openings

  /** Registers a newly opened slot and immediately tries to fill it. Idempotent per (source, externalId). */
  createOpening(input: NewOpening, now: Date): Outcome & { opening: Opening } {
    const out = new Out(now);
    const opening = this.insertOpening(input, now, out);
    return { ...out.result(), opening };
  }

  /** The slot was filled or removed outside Slotback (e.g. the front desk booked it by phone). */
  withdrawOpening(openingId: string, now: Date): Outcome {
    const out = new Out(now);
    const opening = this.store.getOpening(openingId);
    if (!opening || !['new', 'open', 'offering', 'needs_attention'].includes(opening.status)) return out.result();
    this.supersedePending(opening.id, undefined, out);
    opening.status = 'withdrawn';
    this.store.saveOpening(opening);
    out.event({ type: 'opening.withdrawn', openingId: opening.id });
    this.fillIdle(out);
    return out.result();
  }

  // ------------------------------------------------------------------ offers

  respond(offerId: string, response: 'accept' | 'decline', now: Date): Outcome & { result: RespondResult } {
    const out = new Out(now);
    const offer = this.store.getOffer(offerId);
    if (!offer) throw new Error(`Unknown offer ${offerId}`);
    if (offer.status !== 'pending') {
      const result: RespondResult =
        offer.status === 'expired' ? 'expired' : offer.status === 'superseded' ? 'unavailable' : 'already_responded';
      return { ...out.result(), result };
    }
    if (offer.expiresAt <= now.toISOString()) {
      this.expireOffer(offer, out);
      this.refill(offer.openingId, out);
      this.fillIdle(out);
      return { ...out.result(), result: 'expired' };
    }

    const opening = this.store.getOpening(offer.openingId)!;
    const entry = this.store.getEntry(offer.entryId)!;

    if (response === 'decline') {
      offer.status = 'declined';
      offer.respondedAt = now.toISOString();
      this.store.saveOffer(offer);
      entry.declines += 1;
      entry.status = 'active';
      this.store.saveEntry(entry);
      out.event({ type: 'offer.declined', offerId: offer.id, openingId: opening.id, entryId: entry.id });
      this.refill(opening.id, out);
      this.fillIdle(out);
      return { ...out.result(), result: 'declined' };
    }

    if (opening.status !== 'offering') {
      offer.status = 'superseded';
      this.store.saveOffer(offer);
      entry.status = 'active';
      this.store.saveEntry(entry);
      this.fillIdle(out);
      return { ...out.result(), result: 'unavailable' };
    }

    offer.status = 'accepted';
    offer.respondedAt = now.toISOString();
    this.store.saveOffer(offer);
    out.event({ type: 'offer.accepted', offerId: offer.id, openingId: opening.id, entryId: entry.id });
    this.supersedePending(opening.id, offer.id, out);
    this.startBooking(opening, entry, offer, out);
    this.fillIdle(out);
    return { ...out.result(), result: 'accepted' };
  }

  // ---------------------------------------------------------------- bookings

  /** Reports the outcome of a `book` command (EHR write-back, webhook, or staff task). */
  bookingResult(bookingId: string, result: BookingResult, now: Date): Outcome {
    const out = new Out(now);
    const booking = this.store.getBooking(bookingId);
    if (!booking || booking.status !== 'requested') return out.result();
    const opening = this.store.getOpening(booking.openingId)!;
    const entry = this.store.getEntry(booking.entryId)!;
    booking.resolvedAt = now.toISOString();

    if (result.ok) {
      booking.status = 'confirmed';
      booking.externalId = result.externalId;
      this.store.saveBooking(booking);
      opening.status = 'filled';
      this.store.saveOpening(opening);
      const freed = entry.currentAppointment;
      entry.status = 'booked';
      entry.bookedAt = now.toISOString();
      this.store.saveEntry(entry);
      out.event({ type: 'booking.confirmed', bookingId, openingId: opening.id, entryId: entry.id });
      out.event({ type: 'opening.filled', openingId: opening.id, entryId: entry.id, data: { chainDepth: opening.chainDepth } });
      out.commands.push({
        type: 'notify',
        kind: booking.mode === 'auto' ? 'auto_booked' : 'booked',
        patientId: entry.patientId,
        entryId: entry.id,
        bookingId,
      });
      if (freed) {
        out.commands.push({ type: 'cancel_original', bookingId, entryId: entry.id, appointment: freed });
        if (this.settings.cascadeFreedSlots) {
          out.event({
            type: 'chain.freed',
            openingId: opening.id,
            entryId: entry.id,
            data: { start: freed.start, providerId: freed.providerId },
          });
          this.insertOpening(
            {
              providerId: freed.providerId,
              locationId: freed.locationId,
              modality: freed.modality,
              start: freed.start,
              end: freed.end,
              source: 'cascade',
              externalId: freed.externalId,
              origin: { kind: 'moved_up', fromOpeningId: opening.id, entryId: entry.id },
              chainDepth: opening.chainDepth + 1,
            },
            now,
            out,
          );
        }
      }
      return out.result();
    }

    booking.status = 'failed';
    booking.error = result.message ?? result.reason;
    this.store.saveBooking(booking);
    entry.status = 'active';
    this.store.saveEntry(entry);
    out.event({ type: 'booking.failed', bookingId, openingId: opening.id, entryId: entry.id, data: { reason: result.reason } });
    if (result.reason === 'conflict') {
      // The slot was taken in the EHR before we could write it: nothing to fill.
      opening.status = 'withdrawn';
      this.store.saveOpening(opening);
      out.event({ type: 'opening.withdrawn', openingId: opening.id, data: { reason: 'conflict' } });
      out.commands.push({ type: 'notify', kind: 'offer_taken', patientId: entry.patientId, entryId: entry.id, bookingId });
    } else {
      opening.status = 'needs_attention';
      this.store.saveOpening(opening);
      out.event({ type: 'opening.needs_attention', openingId: opening.id, bookingId });
      out.commands.push({ type: 'notify', kind: 'booking_delayed', patientId: entry.patientId, entryId: entry.id, bookingId });
    }
    this.fillIdle(out);
    return out.result();
  }

  // ----------------------------------------------------------------- entries

  addEntry(entry: WaitlistEntry, now: Date): Outcome {
    const out = new Out(now);
    if (!STAFF_SETTABLE.has(entry.status)) throw new Error(`New entries cannot start as "${entry.status}"`);
    this.store.saveEntry(entry);
    out.event({ type: 'entry.updated', entryId: entry.id, data: { status: entry.status } });
    this.fillIdle(out);
    return out.result();
  }

  /** Staff/patient edits. Changing the status away from `offered` withdraws the outstanding offer. */
  updateEntry(id: string, patch: Partial<Omit<WaitlistEntry, 'id' | 'patientId'>>, now: Date): Outcome {
    const out = new Out(now);
    const entry = this.store.getEntry(id);
    if (!entry) throw new Error(`Unknown entry ${id}`);
    if (patch.status && !STAFF_SETTABLE.has(patch.status)) {
      throw new Error(`Status "${patch.status}" is managed by the engine`);
    }
    if (patch.status && (entry.status === 'booking' || entry.status === 'booked')) {
      throw new Error(`Entry is ${entry.status}; its status can no longer be changed`);
    }
    const leavingOffer = entry.status === 'offered' && patch.status && patch.status !== 'active';
    // Ranking edits on an entry with an outstanding offer apply from the next opening on.
    Object.assign(entry, patch);
    this.store.saveEntry(entry);
    out.event({ type: 'entry.updated', entryId: id, data: { fields: Object.keys(patch) } });
    if (leavingOffer) {
      for (const offer of this.store.listOffers({ entryId: id, status: 'pending' })) {
        offer.status = 'superseded';
        this.store.saveOffer(offer);
        out.event({ type: 'offer.superseded', offerId: offer.id, openingId: offer.openingId, entryId: id });
        this.refill(offer.openingId, out);
      }
    }
    this.fillIdle(out);
    return out.result();
  }

  // -------------------------------------------------------------------- time

  /** Expires unanswered offers (cascading to the next patient) and openings that are too close to fill. */
  tick(now: Date): Outcome {
    const out = new Out(now);
    const iso = now.toISOString();
    const touched = new Set<string>();
    for (const offer of this.store.listOffers({ status: 'pending' })) {
      if (offer.expiresAt <= iso) {
        this.expireOffer(offer, out);
        touched.add(offer.openingId);
      }
    }
    for (const id of touched) this.refill(id, out);
    for (const opening of this.store.listOpenings({ status: ['open', 'offering'] })) {
      if (this.tooLate(opening, now)) this.expireOpening(opening, out);
    }
    this.fillIdle(out);
    return out.result();
  }

  // ------------------------------------------------------------------- views

  explain(openingId: string, now: Date): OpeningExplanation {
    const opening = this.store.getOpening(openingId);
    if (!opening) throw new Error(`Unknown opening ${openingId}`);
    const entries = this.store.listEntries({ status: ['active', 'offered', 'paused', 'pending_review'] });
    return explainOpening(entries, opening, now, this.settings);
  }

  /** The standing waitlist in priority order (independent of any particular opening). */
  rankedWaitlist(now: Date, providerId?: string): Candidate[] {
    const entries = this.store
      .listEntries({ status: ['active', 'offered', 'paused', 'booking'] })
      .filter((e) => !providerId || !e.providerIds.length || e.providerIds.includes(providerId));
    return rank(entries, this.settings.priority, now);
  }

  // --------------------------------------------------------------- internals

  private insertOpening(input: NewOpening, now: Date, out: Out): Opening {
    const start = new Date(input.start);
    const end = new Date(input.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new Error('Invalid opening start/end');
    if (end <= start) throw new Error('Opening must end after it starts');
    if (input.externalId) {
      const existing = this.store.findOpeningByExternalId(input.source, input.externalId);
      if (existing && ACTIVE_OPENING.includes(existing.status)) return existing;
    }
    const opening: Opening = {
      id: this.newId('opn'),
      providerId: input.providerId,
      locationId: input.locationId,
      modality: input.modality,
      start: start.toISOString(),
      end: end.toISOString(),
      appointmentTypes: input.appointmentTypes ?? [],
      source: input.source,
      externalId: input.externalId,
      status: 'new',
      createdAt: now.toISOString(),
      origin: input.origin ?? { kind: 'cancellation' },
      chainDepth: input.chainDepth ?? 0,
    };
    this.store.saveOpening(opening);
    out.event({
      type: 'opening.created',
      openingId: opening.id,
      data: { source: opening.source, origin: opening.origin.kind, chainDepth: opening.chainDepth },
    });
    this.fill(opening.id, out);
    return this.store.getOpening(opening.id)!;
  }

  /** Re-runs matching for an opening once it has no outstanding offers. */
  private refill(openingId: string, out: Out) {
    const opening = this.store.getOpening(openingId);
    if (opening?.status === 'offering' && this.store.listOffers({ openingId, status: 'pending' }).length === 0) {
      this.fill(openingId, out);
    }
  }

  private fill(openingId: string, out: Out) {
    const opening = this.store.getOpening(openingId);
    if (!opening || !['new', 'open', 'offering'].includes(opening.status)) return;
    if (this.store.listOffers({ openingId, status: 'pending' }).length) return;
    const now = out.now;
    if (this.tooLate(opening, now)) {
      this.expireOpening(opening, out);
      return;
    }

    const alreadyOffered = new Set(this.store.listOffers({ openingId }).map((o) => o.entryId));
    const candidates = rankCandidates(this.store.listEntries({ status: 'active' }), opening, now, this.settings).filter(
      (c) => !alreadyOffered.has(c.entry.id),
    );

    if (!candidates.length) {
      const wasOpen = opening.status === 'open';
      opening.status = 'open';
      this.store.saveOpening(opening);
      if (!wasOpen) out.event({ type: 'opening.no_match', openingId });
      return;
    }

    out.event({
      type: 'opening.ranked',
      openingId,
      data: {
        eligible: candidates.length,
        top: candidates.slice(0, 5).map((c) => ({ entryId: c.entry.id, rank: c.rank, score: c.score.total })),
      },
    });

    const { offers: policy } = this.settings;
    const top = candidates[0];
    if (top.entry.bookingMode === 'auto') {
      const offer = this.newOffer(opening, top, 'auto', now);
      offer.status = 'accepted';
      offer.respondedAt = now.toISOString();
      offer.expiresAt = now.toISOString();
      this.store.saveOffer(offer);
      out.event({ type: 'offer.auto_accepted', offerId: offer.id, openingId, entryId: top.entry.id, data: { rank: 1, score: top.score.total } });
      this.startBooking(opening, top.entry, offer, out);
      return;
    }

    if (this.inQuietHours(now)) {
      // An offer sent now would expire while the patient sleeps: hold the opening until morning.
      const wasOpen = opening.status === 'open';
      opening.status = 'open';
      this.store.saveOpening(opening);
      if (!wasOpen) out.event({ type: 'opening.deferred', openingId, data: { reason: 'quiet_hours' } });
      return;
    }

    // Near-term openings go to several patients at once (first to accept wins),
    // but never past an auto-book patient: they would have been booked outright.
    const hoursAway = minutesBetween(now, opening.start) / 60;
    const batchSize = hoursAway <= policy.parallelWithinHours ? Math.max(1, policy.parallelCount) : 1;
    const batch: Candidate[] = [];
    for (const c of candidates) {
      if (c.entry.bookingMode !== 'confirm' || batch.length >= batchSize) break;
      batch.push(c);
    }

    for (const c of batch) {
      const offer = this.newOffer(opening, c, 'confirm', now);
      this.store.saveOffer(offer);
      c.entry.status = 'offered';
      this.store.saveEntry(c.entry);
      out.event({
        type: 'offer.sent',
        offerId: offer.id,
        openingId,
        entryId: c.entry.id,
        data: { rank: c.rank, score: c.score.total, expiresAt: offer.expiresAt, parallel: batch.length > 1 },
      });
      out.commands.push({ type: 'notify', kind: 'offer', patientId: c.entry.patientId, entryId: c.entry.id, offerId: offer.id });
    }
    opening.status = 'offering';
    this.store.saveOpening(opening);
  }

  private newOffer(opening: Opening, c: Candidate, mode: Offer['mode'], now: Date): Offer {
    const { holdMinutes, minLeadMinutes } = this.settings.offers;
    const holdEnd = addMinutes(now.toISOString(), holdMinutes);
    const latest = addMinutes(opening.start, -minLeadMinutes);
    return {
      id: this.newId('ofr'),
      openingId: opening.id,
      entryId: c.entry.id,
      patientId: c.entry.patientId,
      status: 'pending',
      mode,
      createdAt: now.toISOString(),
      expiresAt: holdEnd < latest ? holdEnd : latest,
      rank: c.rank,
      score: c.score.total,
    };
  }

  private startBooking(opening: Opening, entry: WaitlistEntry, offer: Offer, out: Out) {
    const booking: Booking = {
      id: this.newId('bkg'),
      openingId: opening.id,
      entryId: entry.id,
      offerId: offer.id,
      patientId: entry.patientId,
      mode: offer.mode,
      status: 'requested',
      providerId: opening.providerId,
      locationId: opening.locationId,
      modality: opening.modality,
      appointmentType: entry.appointmentType,
      start: opening.start,
      end: addMinutes(opening.start, entry.durationMinutes),
      createdAt: out.now.toISOString(),
    };
    this.store.saveBooking(booking);
    opening.status = 'booking';
    this.store.saveOpening(opening);
    entry.status = 'booking';
    this.store.saveEntry(entry);
    out.event({ type: 'booking.requested', bookingId: booking.id, openingId: opening.id, entryId: entry.id, data: { mode: offer.mode } });
    out.commands.push({ type: 'book', bookingId: booking.id });
  }

  private expireOffer(offer: Offer, out: Out) {
    offer.status = 'expired';
    this.store.saveOffer(offer);
    const entry = this.store.getEntry(offer.entryId);
    if (entry && entry.status === 'offered') {
      entry.status = 'active';
      entry.declines += 1;
      this.store.saveEntry(entry);
    }
    out.event({ type: 'offer.expired', offerId: offer.id, openingId: offer.openingId, entryId: offer.entryId });
  }

  private supersedePending(openingId: string, exceptOfferId: string | undefined, out: Out) {
    for (const other of this.store.listOffers({ openingId, status: 'pending' })) {
      if (other.id === exceptOfferId) continue;
      other.status = 'superseded';
      this.store.saveOffer(other);
      const e = this.store.getEntry(other.entryId);
      if (e && e.status === 'offered') {
        e.status = 'active';
        this.store.saveEntry(e);
      }
      out.event({ type: 'offer.superseded', offerId: other.id, openingId, entryId: other.entryId });
      out.commands.push({ type: 'notify', kind: 'offer_taken', patientId: other.patientId, entryId: other.entryId, offerId: other.id });
    }
  }

  private expireOpening(opening: Opening, out: Out) {
    for (const offer of this.store.listOffers({ openingId: opening.id, status: 'pending' })) {
      this.expireOffer(offer, out);
    }
    opening.status = 'expired';
    this.store.saveOpening(opening);
    out.event({ type: 'opening.expired', openingId: opening.id });
  }

  inQuietHours(now: Date): boolean {
    const { quietHours } = this.settings.offers;
    const tz = this.settings.timeZone;
    if (!quietHours || !tz) return false;
    const m = toLocal(now, tz).minutes;
    const start = parseHHMM(quietHours.start);
    const end = parseHHMM(quietHours.end);
    if (start === end) return false;
    return start < end ? m >= start && m < end : m >= start || m < end;
  }

  private tooLate(opening: Opening, now: Date): boolean {
    return minutesBetween(now, opening.start) < this.settings.offers.minLeadMinutes;
  }

  /** Gives idle openings (nobody was eligible earlier) another chance, soonest first. */
  private fillIdle(out: Out) {
    const idle = this.store.listOpenings({ status: 'open' }).sort((a, b) => (a.start < b.start ? -1 : 1));
    for (const opening of idle) this.fill(opening.id, out);
  }
}
