import type {
  Booking,
  BookingStatus,
  EntryStatus,
  Offer,
  OfferStatus,
  Opening,
  OpeningStatus,
  WaitlistEntry,
} from './types.ts';

/**
 * Synchronous persistence port used by the engine. The server implements it on
 * SQLite (`node:sqlite` is synchronous); tests and the browser demo use
 * {@link MemoryStore}. Implementations must return copies: the engine always
 * calls `save*` after mutating.
 */
export interface Store {
  getEntry(id: string): WaitlistEntry | undefined;
  listEntries(filter?: { status?: EntryStatus | EntryStatus[] }): WaitlistEntry[];
  saveEntry(entry: WaitlistEntry): void;

  getOpening(id: string): Opening | undefined;
  listOpenings(filter?: { status?: OpeningStatus | OpeningStatus[] }): Opening[];
  findOpeningByExternalId(source: string, externalId: string): Opening | undefined;
  saveOpening(opening: Opening): void;

  getOffer(id: string): Offer | undefined;
  listOffers(filter?: { openingId?: string; entryId?: string; status?: OfferStatus | OfferStatus[] }): Offer[];
  saveOffer(offer: Offer): void;

  getBooking(id: string): Booking | undefined;
  listBookings(filter?: { status?: BookingStatus | BookingStatus[]; entryId?: string }): Booking[];
  saveBooking(booking: Booking): void;
}

function matches<T extends string>(value: T, filter: T | T[] | undefined): boolean {
  if (filter === undefined) return true;
  return Array.isArray(filter) ? filter.includes(value) : value === filter;
}

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryStore implements Store {
  entries = new Map<string, WaitlistEntry>();
  openings = new Map<string, Opening>();
  offers = new Map<string, Offer>();
  bookings = new Map<string, Booking>();

  getEntry(id: string) {
    const e = this.entries.get(id);
    return e && clone(e);
  }
  listEntries(filter: { status?: EntryStatus | EntryStatus[] } = {}) {
    return [...this.entries.values()].filter((e) => matches(e.status, filter.status)).map(clone);
  }
  saveEntry(entry: WaitlistEntry) {
    this.entries.set(entry.id, clone(entry));
  }

  getOpening(id: string) {
    const o = this.openings.get(id);
    return o && clone(o);
  }
  listOpenings(filter: { status?: OpeningStatus | OpeningStatus[] } = {}) {
    return [...this.openings.values()].filter((o) => matches(o.status, filter.status)).map(clone);
  }
  findOpeningByExternalId(source: string, externalId: string) {
    for (const o of this.openings.values()) {
      if (o.source === source && o.externalId === externalId) return clone(o);
    }
    return undefined;
  }
  saveOpening(opening: Opening) {
    this.openings.set(opening.id, clone(opening));
  }

  getOffer(id: string) {
    const o = this.offers.get(id);
    return o && clone(o);
  }
  listOffers(filter: { openingId?: string; entryId?: string; status?: OfferStatus | OfferStatus[] } = {}) {
    return [...this.offers.values()]
      .filter(
        (o) =>
          (!filter.openingId || o.openingId === filter.openingId) &&
          (!filter.entryId || o.entryId === filter.entryId) &&
          matches(o.status, filter.status),
      )
      .map(clone);
  }
  saveOffer(offer: Offer) {
    this.offers.set(offer.id, clone(offer));
  }

  getBooking(id: string) {
    const b = this.bookings.get(id);
    return b && clone(b);
  }
  listBookings(filter: { status?: BookingStatus | BookingStatus[]; entryId?: string } = {}) {
    return [...this.bookings.values()]
      .filter((b) => matches(b.status, filter.status) && (!filter.entryId || b.entryId === filter.entryId))
      .map(clone);
  }
  saveBooking(booking: Booking) {
    this.bookings.set(booking.id, clone(booking));
  }
}
