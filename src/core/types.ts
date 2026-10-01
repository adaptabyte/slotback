/**
 * Domain model for the Slotback matching engine.
 *
 * The engine deliberately never sees direct patient identifiers (name, phone,
 * email, DOB, MRN). It works on opaque ids plus scheduling preferences, which
 * keeps the "minimum necessary" surface small and lets the same code run in a
 * browser demo with synthetic data.
 */

/** UTC instant, ISO-8601 (e.g. `2026-10-07T14:00:00.000Z`). */
export type ISODateTime = string;
/** Calendar date in the practice time zone, `YYYY-MM-DD`. */
export type LocalDate = string;
/** Wall-clock time in the practice time zone, `HH:MM` (24h). */
export type LocalTime = string;
/** 0 = Sunday … 6 = Saturday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type Modality = 'in_person' | 'telehealth';

/**
 * `auto`    – the patient pre-authorized being booked into any matching slot.
 * `confirm` – the patient is sent an offer and must accept it within a hold window.
 */
export type BookingMode = 'auto' | 'confirm';

export interface TimeWindow {
  day: Weekday;
  start: LocalTime;
  end: LocalTime;
}

export interface DateSpan {
  start: LocalDate;
  end: LocalDate;
}

export interface Availability {
  /** IANA zone the windows are expressed in (normally the practice's zone). */
  timeZone: string;
  /** Recurring weekly windows the patient can attend. */
  weekly: TimeWindow[];
  /** Inclusive date ranges the patient is unavailable (vacations, etc). */
  blackoutDates?: DateSpan[];
  /** Do not offer anything before this date. */
  earliestDate?: LocalDate;
  /** Minimum lead time the patient needs between notification and visit. */
  minNoticeMinutes: number;
}

/** An appointment the patient already holds and would like to move earlier. */
export interface CurrentAppointment {
  start: ISODateTime;
  end: ISODateTime;
  providerId: string;
  modality: Modality;
  locationId?: string;
  appointmentType?: string;
  /** Id of the appointment in the source EHR/calendar, if known. */
  externalId?: string;
}

export type EntryStatus =
  | 'pending_review' // patient self-requested; staff has not approved yet
  | 'active' // eligible for matching
  | 'paused'
  | 'offered' // has an outstanding offer
  | 'booking' // a booking is being written to the EHR
  | 'booked' // done – off the waitlist
  | 'removed';

/** Clinician-assigned clinical acuity. 5 = most urgent. */
export type Acuity = 1 | 2 | 3 | 4 | 5;

export interface WaitlistEntry {
  id: string;
  patientId: string;
  status: EntryStatus;
  /** Acceptable providers; empty = any provider in the practice. */
  providerIds: string[];
  appointmentType: string;
  durationMinutes: number;
  /** Acceptable visit modalities. */
  modalities: Modality[];
  /** Acceptable in-person locations; empty = any. */
  locationIds: string[];
  availability: Availability;
  bookingMode: BookingMode;
  currentAppointment?: CurrentAppointment;
  acuity: Acuity;
  /** Manual provider up/down-rank, in priority points. */
  boost: number;
  /** Pinned entries are always offered first. */
  pinned: boolean;
  addedAt: ISODateTime;
  /** Offers this patient declined or let expire. */
  declines: number;
  expiresAt?: ISODateTime;
  bookedAt?: ISODateTime;
}

export type OpeningStatus =
  | 'new'
  | 'open' // nobody eligible right now; waits for new entries
  | 'offering' // offers outstanding
  | 'booking' // booking in progress
  | 'filled'
  | 'expired' // too close to start time to fill
  | 'withdrawn' // filled elsewhere / removed by staff
  | 'needs_attention'; // booking failed for a non-conflict reason

export type OpeningOriginKind = 'cancellation' | 'moved_up' | 'manual' | 'new_capacity';

export interface Opening {
  id: string;
  providerId: string;
  locationId?: string;
  modality: Modality;
  start: ISODateTime;
  end: ISODateTime;
  /** Appointment types this slot may host; empty = any type that fits. */
  appointmentTypes: string[];
  /** Where the opening came from: `manual`, `api`, `ical:<id>`, `fhir`, `hl7`, `cascade`… */
  source: string;
  externalId?: string;
  status: OpeningStatus;
  createdAt: ISODateTime;
  origin: { kind: OpeningOriginKind; fromOpeningId?: string; entryId?: string };
  /** 0 for an original opening; n for the n-th slot freed by a chain of move-ups. */
  chainDepth: number;
  /** Set once an external feed (iCal/FHIR/HL7) has reported this same slot, so it is not imported twice. */
  confirmedBySource?: boolean;
}

export type OfferStatus = 'pending' | 'accepted' | 'declined' | 'expired' | 'superseded';

export interface Offer {
  id: string;
  openingId: string;
  entryId: string;
  patientId: string;
  status: OfferStatus;
  mode: BookingMode;
  createdAt: ISODateTime;
  expiresAt: ISODateTime;
  respondedAt?: ISODateTime;
  rank: number;
  score: number;
}

export type BookingStatus = 'requested' | 'confirmed' | 'failed';

export interface Booking {
  id: string;
  openingId: string;
  entryId: string;
  offerId: string;
  patientId: string;
  mode: BookingMode;
  status: BookingStatus;
  providerId: string;
  locationId?: string;
  modality: Modality;
  appointmentType: string;
  start: ISODateTime;
  end: ISODateTime;
  createdAt: ISODateTime;
  resolvedAt?: ISODateTime;
  externalId?: string;
  error?: string;
}

export interface PriorityPolicy {
  /** Points per acuity level above 1. */
  acuityPoints: number;
  waitPointsPerDay: number;
  waitPointsMax: number;
  /** Bonus for patients with no appointment at all yet. */
  unscheduledPoints: number;
  /** Points per day an opening is earlier than the patient's current appointment. */
  timeSavedPointsPerDay: number;
  timeSavedPointsMax: number;
  /** Penalty per declined / unanswered offer. */
  declinePenalty: number;
}

export interface OfferPolicy {
  /** How long a patient has to accept an offer. */
  holdMinutes: number;
  /** Do not try to fill an opening that starts within this many minutes. */
  minLeadMinutes: number;
  /** When an opening starts within this many hours, offer it to several patients at once. */
  parallelWithinHours: number;
  /** How many patients to offer to at once when parallel offering kicks in. */
  parallelCount: number;
  /** Only move a patient who already has an appointment if it saves at least this much. */
  minImprovementHours: number;
  /**
   * No offers that need a reply are sent in this local window (e.g. 21:00–08:00);
   * openings wait until morning. Auto-book patients can still be booked.
   */
  quietHours?: { start: LocalTime; end: LocalTime };
}

export interface EngineSettings {
  priority: PriorityPolicy;
  offers: OfferPolicy;
  /** When a patient is moved up, re-offer the slot they vacated. */
  cascadeFreedSlots: boolean;
  /** Practice time zone; needed for quiet hours. */
  timeZone?: string;
}

export interface ScorePart {
  label: string;
  points: number;
}

export interface Score {
  total: number;
  parts: ScorePart[];
}

export interface Candidate {
  entry: WaitlistEntry;
  score: Score;
  rank: number;
}

export interface Ineligibility {
  code: string;
  message: string;
}

export type NotificationKind =
  | 'offer' // an opening is held for you; accept or decline
  | 'offer_taken' // someone else accepted first / slot no longer available
  | 'booked' // your accepted offer is confirmed
  | 'auto_booked' // you were automatically booked
  | 'booking_delayed'; // we could not finalize automatically; office will follow up

export type Command =
  | { type: 'book'; bookingId: string }
  | { type: 'cancel_original'; bookingId: string; entryId: string; appointment: CurrentAppointment }
  | {
      type: 'notify';
      kind: NotificationKind;
      patientId: string;
      entryId: string;
      offerId?: string;
      bookingId?: string;
    };

export type EngineEventType =
  | 'opening.created'
  | 'opening.ranked'
  | 'opening.no_match'
  | 'opening.deferred'
  | 'opening.filled'
  | 'opening.expired'
  | 'opening.withdrawn'
  | 'opening.needs_attention'
  | 'offer.sent'
  | 'offer.auto_accepted'
  | 'offer.accepted'
  | 'offer.declined'
  | 'offer.expired'
  | 'offer.superseded'
  | 'booking.requested'
  | 'booking.confirmed'
  | 'booking.failed'
  | 'chain.freed'
  | 'entry.updated';

export interface EngineEvent {
  at: ISODateTime;
  type: EngineEventType;
  openingId?: string;
  entryId?: string;
  offerId?: string;
  bookingId?: string;
  /** Non-identifying structured detail (ids, counts, scores). */
  data?: Record<string, unknown>;
}

export interface Outcome {
  commands: Command[];
  events: EngineEvent[];
}
