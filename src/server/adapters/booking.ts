import type { Booking, BookingResult, CurrentAppointment, Opening, WaitlistEntry } from '../../core/index.ts';
import { hmacHex } from '../crypto.ts';
import type { Db, PatientRecord } from '../db.ts';
import type { PracticeSettings } from '../practice.ts';
import { typeName } from '../practice.ts';
import { FhirClient } from './fhir.ts';

export interface BookingContext {
  booking: Booking;
  opening: Opening;
  entry: WaitlistEntry;
  patient: PatientRecord;
  practice: PracticeSettings;
}

export interface CancelContext {
  booking: Booking;
  entry: WaitlistEntry;
  patient: PatientRecord;
  appointment: CurrentAppointment;
  practice: PracticeSettings;
}

/** `pending` = the result will arrive later (staff task or async webhook callback). */
export type BookOutcome = BookingResult | { pending: true };
export type CancelOutcome = { ok: true } | { pending: true };

/**
 * Writes bookings back to the system of record. Thrown errors are treated as
 * transient and retried by the outbox; returned failures are final.
 */
export interface BookingAdapter {
  readonly name: string;
  book(ctx: BookingContext): Promise<BookOutcome>;
  cancelOriginal(ctx: CancelContext): Promise<CancelOutcome>;
}

/** Universal fallback: a front-desk task ("enter this in your EHR"), resolved with one click. */
export class ManualBooking implements BookingAdapter {
  readonly name = 'manual';
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  async book(ctx: BookingContext): Promise<BookOutcome> {
    this.db.createTask({ kind: 'book', bookingId: ctx.booking.id, entryId: ctx.entry.id });
    return { pending: true };
  }
  async cancelOriginal(ctx: CancelContext): Promise<CancelOutcome> {
    this.db.createTask({
      kind: 'cancel_original',
      bookingId: ctx.booking.id,
      entryId: ctx.entry.id,
      data: { appointment: ctx.appointment },
    });
    return { pending: true };
  }
}

export function signPayload(secret: string, body: string, at = Date.now()): string {
  const t = Math.floor(at / 1000);
  return `t=${t},v1=${hmacHex(secret, `${t}.${body}`)}`;
}

/**
 * POSTs signed JSON to the practice's integration endpoint (interface engine,
 * iPaaS, or custom script). 2xx with `{externalId}` = booked, 202 = will call
 * back `POST /api/v1/bookings/:id/result`, 409 = slot already taken.
 */
export class WebhookBooking implements BookingAdapter {
  readonly name = 'webhook';
  private readonly url: string;
  private readonly secret: string;
  constructor(url: string, secret: string) {
    this.url = url;
    this.secret = secret;
  }

  private async post(event: string, payload: Record<string, unknown>) {
    const body = JSON.stringify({ event, ...payload });
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-slotback-signature': signPayload(this.secret, body) },
      body,
      signal: AbortSignal.timeout(20000),
    });
    if (res.status >= 500 || res.status === 429) throw new Error(`Booking webhook returned HTTP ${res.status}`);
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      // empty body is fine
    }
    return { status: res.status, json };
  }

  async book(ctx: BookingContext): Promise<BookOutcome> {
    const { booking, patient, practice } = ctx;
    const { status, json } = await this.post('booking.requested', {
      bookingId: booking.id,
      appointment: {
        start: booking.start,
        end: booking.end,
        providerId: booking.providerId,
        locationId: booking.locationId,
        modality: booking.modality,
        appointmentType: booking.appointmentType,
        appointmentTypeName: typeName(practice, booking.appointmentType),
        sourceSlot: { source: ctx.opening.source, externalId: ctx.opening.externalId },
      },
      // Minimum necessary for the receiving system to find the chart.
      patient: { externalRef: patient.externalRef, firstName: patient.firstName, lastName: patient.lastName, dob: patient.dob },
    });
    if (status === 202) return { pending: true };
    if (status >= 200 && status < 300) {
      return { ok: true, externalId: typeof json.externalId === 'string' ? json.externalId : undefined };
    }
    if (status === 409) return { ok: false, reason: 'conflict', message: 'Slot already taken in EHR' };
    return { ok: false, reason: 'error', message: `Booking webhook returned HTTP ${status}` };
  }

  async cancelOriginal(ctx: CancelContext): Promise<CancelOutcome> {
    const { status } = await this.post('appointment.cancel_requested', {
      bookingId: ctx.booking.id,
      appointment: ctx.appointment,
      patient: { externalRef: ctx.patient.externalRef, firstName: ctx.patient.firstName, lastName: ctx.patient.lastName, dob: ctx.patient.dob },
      reason: 'Moved to an earlier appointment from the waitlist',
    });
    if (status === 202) return { pending: true };
    if (status >= 200 && status < 300) return { ok: true };
    throw new Error(`Cancel webhook returned HTTP ${status}`);
  }
}

/**
 * FHIR R4 write-back: creates an Appointment (referencing the Slot when the
 * opening came from FHIR) and cancels the original. Falls back to a staff
 * task when the patient or provider is not linked to FHIR ids.
 */
export class FhirBooking implements BookingAdapter {
  readonly name = 'fhir';
  private readonly client: FhirClient;
  private readonly fallback: ManualBooking;
  constructor(client: FhirClient, fallback: ManualBooking) {
    this.client = client;
    this.fallback = fallback;
  }

  async book(ctx: BookingContext): Promise<BookOutcome> {
    const { booking, patient, practice, opening } = ctx;
    const provider = practice.providers.find((p) => p.id === booking.providerId);
    if (!patient.externalRef || !provider?.fhirPractitionerId) return this.fallback.book(ctx);
    const location = practice.locations.find((l) => l.id === booking.locationId);
    const participant = [
      { actor: { reference: `Patient/${patient.externalRef}` }, status: 'accepted' },
      { actor: { reference: `Practitioner/${provider.fhirPractitionerId}` }, status: 'accepted' },
    ];
    if (location?.fhirLocationId) participant.push({ actor: { reference: `Location/${location.fhirLocationId}` }, status: 'accepted' });
    const resource = {
      resourceType: 'Appointment',
      status: 'booked',
      start: booking.start,
      end: booking.end,
      minutesDuration: Math.round((Date.parse(booking.end) - Date.parse(booking.start)) / 60000),
      appointmentType: { text: typeName(practice, booking.appointmentType) },
      ...(opening.source === 'fhir' && opening.externalId ? { slot: [{ reference: `Slot/${opening.externalId}` }] } : {}),
      participant,
      comment: 'Booked from the waitlist by Slotback',
    };
    const res = await this.client.request<{ id?: string }>('POST', 'Appointment', resource);
    if (res.status === 409 || res.status === 412) return { ok: false, reason: 'conflict', message: 'Slot already taken in EHR' };
    if (res.status >= 500 || res.status === 429) throw new Error(`FHIR Appointment create returned HTTP ${res.status}`);
    if (res.status >= 400) return { ok: false, reason: 'error', message: `FHIR Appointment create returned HTTP ${res.status}` };
    const id = res.json?.id ?? res.location?.match(/Appointment\/([^/]+)/)?.[1];
    return { ok: true, externalId: id };
  }

  async cancelOriginal(ctx: CancelContext): Promise<CancelOutcome> {
    const id = ctx.appointment.externalId;
    if (!id) return this.fallback.cancelOriginal(ctx);
    const current = await this.client.request<Record<string, unknown>>('GET', `Appointment/${encodeURIComponent(id)}`);
    if (current.status === 404) return this.fallback.cancelOriginal(ctx);
    if (current.status >= 400 || !current.json) throw new Error(`FHIR Appointment read returned HTTP ${current.status}`);
    const updated = {
      ...current.json,
      status: 'cancelled',
      cancelationReason: { text: 'Moved to an earlier appointment from the waitlist' },
    };
    const res = await this.client.request('PUT', `Appointment/${encodeURIComponent(id)}`, updated);
    if (res.status >= 400) throw new Error(`FHIR Appointment update returned HTTP ${res.status}`);
    return { ok: true };
  }
}
