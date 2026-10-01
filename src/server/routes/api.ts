import { createHmac } from 'node:crypto';
import type { Acuity, Modality, WaitlistEntry } from '../../core/index.ts';
import { normalizeWindows, validateWindows } from '../../core/index.ts';
import type { App } from '../runtime.ts';
import type { Actor } from '../audit.ts';
import type { Ctx, Router } from '../http.ts';
import { HttpError, RateLimiter, readBody, readJson, sendJson, sendText } from '../http.ts';
import { safeEqual } from '../crypto.ts';
import type { PatientRecord } from '../db.ts';
import { hl7Ack, interpretSiu, parseHl7 } from '../adapters/hl7.ts';
import type { Hl7Message } from '../adapters/hl7.ts';

/** Machine API for interface engines and scripts (Bearer API key). See docs/api.md. */
export function apiRoutes(router: Router, app: App) {
  const limiter = new RateLimiter(600, 60000);

  function apiAuth(ctx: Ctx): true {
    if (!limiter.allow(`api:${ctx.ip}`)) throw new HttpError(429, 'Rate limit exceeded');
    const header = ctx.req.headers.authorization ?? '';
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const found = key ? app.db.resolveApiKey(key) : undefined;
    if (!found) throw new HttpError(401, 'Missing or invalid API key');
    ctx.state.apiKey = found;
    return true;
  }
  const actor = (ctx: Ctx): Actor => ({ type: 'api', id: (ctx.state.apiKey as { id: string }).id, ip: ctx.ip });

  const str = (v: unknown, name: string, required = true): string | undefined => {
    if (v === undefined || v === null || v === '') {
      if (required) throw new HttpError(422, `"${name}" is required`);
      return undefined;
    }
    if (typeof v !== 'string') throw new HttpError(422, `"${name}" must be a string`);
    return v;
  };
  const time = (v: unknown, name: string): string => {
    const s = str(v, name)!;
    const d = new Date(s);
    if (Number.isNaN(d.getTime()) || !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) throw new HttpError(422, `"${name}" must be an ISO-8601 timestamp with a time zone offset`);
    return d.toISOString();
  };

  router.get('/healthz', (ctx) => sendJson(ctx, { ok: true }));

  /** A slot became free. Body: {providerId, start, end, modality?, locationId?, appointmentTypes?, externalId?} */
  router.post('/api/v1/openings', apiAuth, async (ctx) => {
    const b = await readJson(ctx);
    const modality = str(b.modality, 'modality', false);
    if (modality && modality !== 'in_person' && modality !== 'telehealth') throw new HttpError(422, '"modality" must be in_person or telehealth');
    const start = time(b.start, 'start');
    const end = time(b.end, 'end');
    if (end <= start) throw new HttpError(422, '"end" must be after "start"');
    if (b.appointmentTypes !== undefined && (!Array.isArray(b.appointmentTypes) || b.appointmentTypes.some((t) => typeof t !== 'string'))) {
      throw new HttpError(422, '"appointmentTypes" must be an array of strings');
    }
    try {
      const res = app.ingestFreedSlot(actor(ctx), {
        providerId: str(b.providerId, 'providerId')!,
        start,
        end,
        modality: modality as Modality | undefined,
        locationId: str(b.locationId, 'locationId', false),
        appointmentTypes: b.appointmentTypes as string[] | undefined,
        externalId: str(b.externalId, 'externalId', false),
        source: 'api',
      });
      sendJson(ctx, { id: res.opening.id, status: res.opening.status, duplicate: res.duplicate }, res.duplicate ? 200 : 201);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(422, (err as Error).message);
    }
  });

  router.get('/api/v1/openings/:id', apiAuth, (ctx) => {
    const o = app.store.getOpening(ctx.params.id);
    if (!o) throw new HttpError(404, 'Not found');
    const bookings = app.store.listBookings().filter((b) => b.openingId === o.id);
    sendJson(ctx, {
      id: o.id,
      status: o.status,
      providerId: o.providerId,
      start: o.start,
      end: o.end,
      source: o.source,
      externalId: o.externalId,
      bookings: bookings.map((b) => ({ id: b.id, status: b.status, start: b.start, end: b.end, externalId: b.externalId })),
    });
  });

  router.post('/api/v1/openings/:id/withdraw', apiAuth, (ctx) => {
    if (!app.store.getOpening(ctx.params.id)) throw new HttpError(404, 'Not found');
    app.run(actor(ctx), (e, now) => e.withdrawOpening(ctx.params.id, now));
    sendJson(ctx, { id: ctx.params.id, status: app.store.getOpening(ctx.params.id)!.status });
  });

  /** The time is now booked in the source system: stop offering any overlapping opening. */
  router.post('/api/v1/slots/booked', apiAuth, async (ctx) => {
    const b = await readJson(ctx);
    app.ingestBookedSlot(actor(ctx), str(b.providerId, 'providerId')!, new Date(time(b.start, 'start')), new Date(time(b.end, 'end')));
    sendJson(ctx, { ok: true });
  });

  /** Async result for the webhook booking adapter (after it replied 202). */
  router.post('/api/v1/bookings/:id/result', apiAuth, async (ctx) => {
    const b = await readJson(ctx);
    const booking = app.store.getBooking(ctx.params.id);
    if (!booking) throw new HttpError(404, 'Not found');
    const result =
      b.ok === true
        ? { ok: true as const, externalId: str(b.externalId, 'externalId', false) }
        : { ok: false as const, reason: b.reason === 'conflict' ? ('conflict' as const) : ('error' as const), message: str(b.message, 'message', false) };
    app.run(actor(ctx), (e, now) => e.bookingResult(booking.id, result, now));
    sendJson(ctx, { id: booking.id, status: app.store.getBooking(booking.id)!.status });
  });

  /** Adds a patient to the waitlist from another system (status active unless `pendingReview`). */
  router.post('/api/v1/entries', apiAuth, async (ctx) => {
    const b = await readJson<Record<string, unknown>>(ctx);
    const p = app.practice();
    const pt = (b.patient ?? {}) as Record<string, unknown>;
    const type = p.appointmentTypes.find((t) => t.id === b.appointmentType);
    if (!type) throw new HttpError(422, `Unknown appointmentType; expected one of ${p.appointmentTypes.map((t) => t.id).join(', ')}`);
    const weekly = Array.isArray(b.availability) ? (b.availability as WaitlistEntry['availability']['weekly']) : [];
    const problems = weekly.length ? validateWindows(weekly) : ['"availability" needs at least one {day, start, end} window'];
    if (problems.length) throw new HttpError(422, problems.join('; '));
    const modalities = (Array.isArray(b.modalities) ? b.modalities : type.modalities).filter((m): m is Modality => m === 'in_person' || m === 'telehealth');
    const acuity = Number(b.acuity ?? p.defaultAcuity);
    if (![1, 2, 3, 4, 5].includes(acuity)) throw new HttpError(422, '"acuity" must be 1–5');
    const patient: Omit<PatientRecord, 'id' | 'createdAt'> = {
      firstName: str(pt.firstName, 'patient.firstName')!,
      lastName: str(pt.lastName, 'patient.lastName')!,
      dob: str(pt.dob, 'patient.dob', false),
      phone: str(pt.phone, 'patient.phone', false),
      email: str(pt.email, 'patient.email', false),
      preferredChannel: pt.preferredChannel === 'email' || pt.preferredChannel === 'both' ? pt.preferredChannel : 'sms',
      smsConsent: pt.smsConsent === true,
      externalRef: str(pt.externalRef, 'patient.externalRef', false),
    };
    if (!patient.phone && !patient.email) throw new HttpError(422, 'patient.phone or patient.email is required');
    let currentAppointment: WaitlistEntry['currentAppointment'];
    if (b.currentAppointment) {
      const c = b.currentAppointment as Record<string, unknown>;
      currentAppointment = {
        start: time(c.start, 'currentAppointment.start'),
        end: time(c.end, 'currentAppointment.end'),
        providerId: str(c.providerId, 'currentAppointment.providerId')!,
        modality: c.modality === 'telehealth' ? 'telehealth' : 'in_person',
        externalId: str(c.externalId, 'currentAppointment.externalId', false),
      };
    }
    const now = new Date();
    const entryId = app.newEntryId();
    app.db.tx(() => {
      const record = app.db.insertPatient(patient);
      const entry: WaitlistEntry = {
        id: entryId,
        patientId: record.id,
        status: b.pendingReview === true ? 'pending_review' : 'active',
        providerIds: Array.isArray(b.providerIds) ? (b.providerIds as string[]) : [],
        appointmentType: type.id,
        durationMinutes: type.durationMinutes,
        modalities: modalities.length ? modalities : type.modalities,
        locationIds: Array.isArray(b.locationIds) ? (b.locationIds as string[]) : [],
        availability: {
          timeZone: p.timeZone,
          weekly: normalizeWindows(weekly),
          minNoticeMinutes: Number(b.minNoticeMinutes ?? 180),
        },
        bookingMode: b.bookingMode === 'auto' ? 'auto' : 'confirm',
        currentAppointment,
        acuity: acuity as Acuity,
        boost: 0,
        pinned: false,
        addedAt: now.toISOString(),
        declines: 0,
        expiresAt: new Date(now.getTime() + p.requestExpiryDays * 86400000).toISOString(),
      };
      app.audit.record(actor(ctx), 'patient.created', { type: 'patient', id: record.id });
      app.run(actor(ctx), (e) => e.addEntry(entry, now), now);
    });
    sendJson(ctx, { id: entryId, status: app.store.getEntry(entryId)!.status }, 201);
  });

  /** HL7 v2 SIU over HTTP (most interface engines can POST; MLLP can be bridged by the engine). */
  router.post('/api/v1/hl7', apiAuth, async (ctx) => {
    const raw = await readBody(ctx);
    let msg: Hl7Message;
    try {
      msg = parseHl7(raw);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    const p = app.practice();
    try {
      const ev = interpretSiu(msg, p.timeZone);
      const provider = p.providers.find((x) => x.hl7Id && x.hl7Id === ev.providerHl7Id);
      if (ev.kind !== 'other' && provider && ev.start && ev.end) {
        if (ev.kind === 'freed' && ev.start > new Date()) {
          app.ingestFreedSlot(actor(ctx), {
            providerId: provider.id,
            start: ev.start.toISOString(),
            end: ev.end.toISOString(),
            source: 'hl7',
            externalId: ev.appointmentId,
          });
        } else if (ev.kind === 'booked') {
          app.ingestBookedSlot(actor(ctx), provider.id, ev.start, ev.end);
        }
      } else if (ev.kind !== 'other') {
        app.audit.record(actor(ctx), 'hl7.ignored', undefined, { trigger: ev.trigger, reason: provider ? 'missing times' : 'unknown provider' });
      }
      sendText(ctx, hl7Ack(msg, 'AA'), 200, 'x-application/hl7-v2+er7; charset=utf-8');
    } catch (err) {
      sendText(ctx, hl7Ack(msg, 'AE', (err as Error).message.slice(0, 80)), 200, 'x-application/hl7-v2+er7; charset=utf-8');
    }
  });

  // ------------------------------------------------------------ Twilio SMS

  if (app.config.sms.provider === 'twilio') {
    const authToken = app.config.sms.twilio!.authToken;
    router.post('/webhooks/twilio/sms', async (ctx) => {
      const body = new URLSearchParams(await readBody(ctx));
      const url = `${app.config.publicUrl}/webhooks/twilio/sms`;
      const signed = [...body.keys()].sort().reduce((acc, k) => acc + k + (body.get(k) ?? ''), url);
      const expected = createHmac('sha1', authToken).update(signed).digest('base64');
      if (!safeEqual(String(ctx.req.headers['x-twilio-signature'] ?? ''), expected)) throw new HttpError(403, 'Bad signature');
      const reply = handleSmsReply(body.get('From') ?? '', body.get('Body') ?? '', ctx.ip);
      const xml = reply ? `<Response><Message>${reply.replace(/[<&>]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' })[c]!)}</Message></Response>` : '<Response/>';
      sendText(ctx, xml, 200, 'text/xml; charset=utf-8');
    });
  }

  /** YES / NO replies to an offer text. */
  function handleSmsReply(from: string, text: string, ip: string): string | undefined {
    const t = text.trim().toLowerCase();
    const yes = /^(y|yes|yep|ok|accept|1)\b/.test(t);
    const no = /^(n|no|nope|decline|2)\b/.test(t);
    if (!yes && !no) return undefined;
    const name = app.practice().messageName;
    const offers = app.db
      .findPatientIdsByPhone(from)
      .flatMap((pid) => app.store.listEntries({ status: 'offered' }).filter((e) => e.patientId === pid))
      .flatMap((e) => app.store.listOffers({ entryId: e.id, status: 'pending' }));
    const offer = offers.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    if (!offer) return `${name}: There is no open offer for this number right now. You're still on the waitlist.`;
    const res = app.run({ type: 'patient', id: offer.patientId, ip }, (e, now) => e.respond(offer.id, yes ? 'accept' : 'decline', now));
    const msgs: Record<string, string> = {
      accepted: `${name}: Great — we're booking it now and will confirm shortly.`,
      declined: `${name}: No problem. You're still on the waitlist.`,
      expired: `${name}: Sorry, that offer expired. You're still on the waitlist.`,
      unavailable: `${name}: Sorry, that slot was just taken. You're still on the waitlist.`,
      already_responded: `${name}: We already have your answer for that offer.`,
    };
    return msgs[res.result];
  }
}
