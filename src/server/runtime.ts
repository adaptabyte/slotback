import { Engine, addDays, formatSlot, localToInstant, minutesBetween, parseHHMM, toLocal } from '../core/index.ts';
import type { Command, EngineEvent, NotificationKind, Opening, Outcome } from '../core/index.ts';
import { AuditLog, SYSTEM } from './audit.ts';
import type { Actor } from './audit.ts';
import type { Config } from './config.ts';
import { Vault } from './crypto.ts';
import { Db, SqliteStore, newId } from './db.ts';
import type { PatientRecord } from './db.ts';
import { DEFAULT_PRACTICE, providerName, validatePractice, withDefaults } from './practice.ts';
import type { PracticeSettings, ProviderConfig } from './practice.ts';
import { FhirBooking, ManualBooking, WebhookBooking } from './adapters/booking.ts';
import type { BookingAdapter, BookingContext } from './adapters/booking.ts';
import { ConsoleChannel, SmtpEmail, TwilioSms, WebhookChannel, renderMessage } from './adapters/notify.ts';
import type { Channel } from './adapters/notify.ts';
import { FhirClient, fetchFreeSlots } from './adapters/fhir.ts';
import { diffIcal, fetchIcs, parseIcs } from './adapters/ical.ts';
import type { IcalSnapshot } from './adapters/ical.ts';

const INTEGRATION: Actor = { type: 'integration' };
const MAX_ATTEMPTS = 6;
const BACKOFF_SECONDS = [15, 60, 300, 900, 3600, 3600];
const ACTIVE = ['new', 'open', 'offering', 'booking', 'needs_attention'] as const;

export const MODALITY_LABEL = { in_person: 'in person', telehealth: 'telehealth' } as const;

function entityOf(e: EngineEvent): { type: string; id: string } | undefined {
  if (e.bookingId) return { type: 'booking', id: e.bookingId };
  if (e.offerId) return { type: 'offer', id: e.offerId };
  if (e.openingId) return { type: 'opening', id: e.openingId };
  if (e.entryId) return { type: 'entry', id: e.entryId };
  return undefined;
}

/** Wires the engine to storage, audit, the outbox, integrations and timers. */
export class App {
  readonly config: Config;
  readonly db: Db;
  readonly store: SqliteStore;
  readonly engine: Engine;
  readonly audit: AuditLog;
  readonly booking: BookingAdapter;
  readonly sms?: Channel;
  readonly email?: Channel;
  readonly devInbox?: ConsoleChannel;
  readonly fhir?: FhirClient;
  private practiceCache?: PracticeSettings;
  private inflight?: Promise<void>;
  private kicked = false;
  private rerun = false;
  private timers: NodeJS.Timeout[] = [];
  readonly log: (msg: string) => void;

  constructor(config: Config, opts: { log?: (msg: string) => void } = {}) {
    this.config = config;
    this.log = opts.log ?? ((m) => console.log(`[slotback] ${m}`));
    this.db = new Db(config.databasePath, new Vault(config.encryptionKey));
    this.store = new SqliteStore(this.db);
    this.audit = new AuditLog(this.db);
    this.engine = new Engine({ store: this.store, settings: () => this.practice().engine, newId });

    const manual = new ManualBooking(this.db);
    if (config.fhir) this.fhir = new FhirClient(config.fhir);
    this.booking =
      config.booking.adapter === 'webhook'
        ? new WebhookBooking(config.booking.webhookUrl!, config.booking.webhookSecret!)
        : config.booking.adapter === 'fhir'
          ? new FhirBooking(this.fhir!, manual)
          : manual;

    if (config.sms.provider === 'console' || config.email.provider === 'console') this.devInbox = new ConsoleChannel();
    const webhook = config.notifyWebhook ? new WebhookChannel(config.notifyWebhook.url, config.notifyWebhook.secret) : undefined;
    this.sms =
      config.sms.provider === 'twilio' ? new TwilioSms(config.sms.twilio!) : config.sms.provider === 'webhook' ? webhook : config.sms.provider === 'console' ? this.devInbox : undefined;
    this.email =
      config.email.provider === 'smtp'
        ? new SmtpEmail(config.email.smtpUrl!, config.email.from!)
        : config.email.provider === 'webhook'
          ? webhook
          : config.email.provider === 'console'
            ? this.devInbox
            : undefined;
  }

  // --------------------------------------------------------------- settings

  practice(): PracticeSettings {
    if (!this.practiceCache) {
      const p = withDefaults(this.db.getSetting<PracticeSettings>('practice') ?? DEFAULT_PRACTICE);
      p.engine = { ...p.engine, timeZone: p.timeZone };
      this.practiceCache = p;
    }
    return this.practiceCache;
  }

  /** When quiet hours are on, the instant they end; otherwise `now`. Patient messages wait until then. */
  private deliveryTime(now: Date): Date {
    if (!this.engine.inQuietHours(now)) return now;
    const p = this.practice();
    const end = p.engine.offers.quietHours!.end;
    const local = toLocal(now, p.timeZone);
    const date = local.minutes >= parseHHMM(end) ? addDays(local.date, 1) : local.date;
    return localToInstant(date, end, p.timeZone);
  }

  savePractice(next: PracticeSettings, actor: Actor): string[] {
    const errors = validatePractice(next);
    if (errors.length) return errors;
    this.db.tx(() => {
      this.db.setSetting('practice', next);
      this.audit.record(actor, 'settings.updated', { type: 'settings', id: 'practice' });
    });
    this.practiceCache = undefined;
    return [];
  }

  isConfigured(): boolean {
    return this.db.getSetting('practice') !== undefined;
  }

  // ------------------------------------------------------------- operations

  /** Runs an engine operation atomically: state changes, audit trail and outbox commit together. */
  run<T extends Outcome>(actor: Actor, fn: (engine: Engine, now: Date) => T, now = new Date()): T {
    const result = this.db.tx(() => {
      const r = fn(this.engine, now);
      for (const e of r.events) {
        this.audit.record(actor, e.type, entityOf(e), { ...e.data, openingId: e.openingId, entryId: e.entryId, offerId: e.offerId }, new Date(e.at));
      }
      const quietUntil = this.deliveryTime(now);
      for (const c of r.commands) this.db.enqueue(c, c.type === 'notify' ? quietUntil : now);
      return r;
    });
    if (result.commands.length) this.kick();
    return result;
  }

  /**
   * Entry point for every external "this slot is free" signal (iCal, FHIR, HL7,
   * API). Deduplicates against openings we already track, including slots our
   * own move-ups freed, so a slot is never offered twice.
   */
  ingestFreedSlot(
    actor: Actor,
    input: { providerId: string; start: string; end: string; source: string; externalId?: string; modality?: Opening['modality']; locationId?: string; appointmentTypes?: string[] },
    now = new Date(),
  ): { opening: Opening; duplicate: boolean } {
    const practice = this.practice();
    const provider = practice.providers.find((p) => p.id === input.providerId);
    if (!provider) throw new Error(`Unknown provider "${input.providerId}"`);
    const start = new Date(input.start).toISOString();
    const same = this.store
      .listOpenings({ status: [...ACTIVE, 'filled'] })
      .filter((o) => o.providerId === input.providerId && o.start === start);
    const active = same.find((o) => (ACTIVE as readonly string[]).includes(o.status));
    if (active) return { opening: active, duplicate: true };
    const recentCutoff = new Date(now.getTime() - 30 * 86400000).toISOString();
    const cascade = same.find((o) => o.origin.kind === 'moved_up' && !o.confirmedBySource && o.createdAt >= recentCutoff);
    if (cascade) {
      this.db.tx(() => {
        this.store.saveOpening({ ...cascade, confirmedBySource: true });
        this.audit.record(actor, 'opening.source_confirmed', { type: 'opening', id: cascade.id }, { source: input.source });
      });
      return { opening: cascade, duplicate: true };
    }
    const res = this.run(
      actor,
      (e) =>
        e.createOpening(
          {
            providerId: input.providerId,
            start,
            end: input.end,
            source: input.source,
            externalId: input.externalId,
            modality: input.modality ?? provider.defaultModality,
            locationId: input.locationId ?? provider.locationId,
            appointmentTypes: input.appointmentTypes,
            origin: { kind: input.source === 'manual' ? 'manual' : 'cancellation' },
          },
          now,
        ),
      now,
    );
    return { opening: res.opening, duplicate: false };
  }

  /** A feed reports the time is now booked (e.g. front desk filled it by phone): stop offering it. */
  ingestBookedSlot(actor: Actor, providerId: string, start: Date, end: Date, now = new Date()) {
    for (const o of this.store.listOpenings({ status: ['open', 'offering', 'new'] })) {
      if (o.providerId !== providerId) continue;
      if (new Date(o.start) < end && start < new Date(o.end)) {
        this.run(actor, (e) => e.withdrawOpening(o.id, now), now);
      }
    }
  }

  bookingContext(bookingId: string): BookingContext | undefined {
    const booking = this.store.getBooking(bookingId);
    if (!booking) return undefined;
    const opening = this.store.getOpening(booking.openingId)!;
    const entry = this.store.getEntry(booking.entryId)!;
    const patient = this.db.getPatient(booking.patientId)!;
    return { booking, opening, entry, patient, practice: this.practice() };
  }

  // ----------------------------------------------------------------- outbox

  kick() {
    if (this.inflight) {
      this.rerun = true;
      return;
    }
    if (this.kicked) return;
    this.kicked = true;
    setImmediate(() => {
      this.kicked = false;
      void this.processOutbox();
    });
  }

  /**
   * Executes due commands; transient failures retry with backoff, then fall back to staff.
   * Concurrent calls share the drain in progress (and schedule one more pass after it).
   */
  processOutbox(): Promise<void> {
    if (this.inflight) {
      this.rerun = true;
      return this.inflight;
    }
    this.inflight = this.drain().finally(() => {
      this.inflight = undefined;
      if (this.rerun) {
        this.rerun = false;
        this.kick();
      }
    });
    return this.inflight;
  }

  private async drain(): Promise<void> {
    for (let round = 0; round < 10; round++) {
      const due = this.db.dueOutbox(new Date());
      if (!due.length) break;
      for (const item of due) {
        try {
          await this.execute(item.command);
          this.db.finishOutbox(item.id);
        } catch (err) {
          const attempts = item.attempts + 1;
          const dead = attempts >= MAX_ATTEMPTS;
          const message = err instanceof Error ? err.message : String(err);
          const next = new Date(Date.now() + BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)] * 1000);
          this.db.retryOutbox(item.id, attempts, next, message, dead);
          this.log(`outbox #${item.id} ${item.command.type} failed (attempt ${attempts}): ${message}`);
          if (dead) this.onDead(item.command, message);
        }
      }
    }
  }

  private onDead(cmd: Command, message: string) {
    if (cmd.type === 'book') {
      this.run(INTEGRATION, (e) => e.bookingResult(cmd.bookingId, { ok: false, reason: 'error', message }, new Date()));
    } else if (cmd.type === 'cancel_original') {
      this.db.createTask({ kind: 'cancel_original', bookingId: cmd.bookingId, entryId: cmd.entryId, data: { appointment: cmd.appointment } });
    } else {
      this.audit.record(SYSTEM, 'notification.undeliverable', { type: 'entry', id: cmd.entryId }, { kind: cmd.kind });
    }
  }

  private async execute(cmd: Command) {
    switch (cmd.type) {
      case 'book': {
        const ctx = this.bookingContext(cmd.bookingId);
        if (!ctx || ctx.booking.status !== 'requested') return;
        const result = await this.booking.book(ctx);
        if ('pending' in result) {
          this.audit.record(INTEGRATION, 'booking.pending', { type: 'booking', id: cmd.bookingId }, { adapter: this.booking.name });
        } else {
          this.run(INTEGRATION, (e) => e.bookingResult(cmd.bookingId, result, new Date()));
        }
        return;
      }
      case 'cancel_original': {
        const ctx = this.bookingContext(cmd.bookingId);
        if (!ctx) return;
        const result = await this.booking.cancelOriginal({ ...ctx, appointment: cmd.appointment });
        this.audit.record(INTEGRATION, 'pending' in result ? 'original.cancel_pending' : 'original.cancelled', { type: 'booking', id: cmd.bookingId });
        return;
      }
      case 'notify':
        await this.notify(cmd);
        return;
    }
  }

  // ---------------------------------------------------------- notifications

  private channelsFor(p: PatientRecord): { channel: 'sms' | 'email'; to: string; via: Channel }[] {
    const sms = p.phone && p.smsConsent && this.sms ? { channel: 'sms' as const, to: p.phone, via: this.sms } : undefined;
    const email = p.email && this.email ? { channel: 'email' as const, to: p.email, via: this.email } : undefined;
    if (p.preferredChannel === 'both') return [sms, email].filter((x) => x !== undefined);
    const preferred = p.preferredChannel === 'email' ? email : sms;
    const fallback = p.preferredChannel === 'email' ? sms : email;
    return preferred ? [preferred] : fallback ? [fallback] : [];
  }

  private async notify(cmd: Extract<Command, { type: 'notify' }>) {
    const patient = this.db.getPatient(cmd.patientId);
    if (!patient || patient.purgedAt) return;
    const practice = this.practice();
    const tz = practice.timeZone;
    const entry = this.store.getEntry(cmd.entryId);
    const offer = cmd.offerId ? this.store.getOffer(cmd.offerId) : undefined;
    const booking = cmd.bookingId ? this.store.getBooking(cmd.bookingId) : undefined;
    // A retried or delayed offer that has since resolved must not go out.
    if (cmd.kind === 'offer' && offer?.status !== 'pending') return;
    const opening = this.store.getOpening(offer?.openingId ?? booking?.openingId ?? '');
    const start = booking?.start ?? opening?.start;

    let link: string | undefined;
    if (cmd.kind === 'offer' && offer) {
      const token = this.db.createLinkToken('offer', offer.id, new Date(Date.parse(offer.expiresAt) + 86400000).toISOString());
      link = `${this.config.publicUrl}/o/${token}`;
    } else if ((cmd.kind === 'booked' || cmd.kind === 'auto_booked') && booking) {
      const token = this.db.createLinkToken('manage', cmd.entryId, new Date(Date.parse(booking.start) + 2 * 86400000).toISOString());
      link = `${this.config.publicUrl}/m/${token}`;
    }

    const message = renderMessage({
      kind: cmd.kind,
      privacyMode: practice.privacyMode,
      practiceName: practice.messageName,
      practicePhone: practice.phone,
      firstName: patient.firstName,
      slot: start ? formatSlot(start, tz) : undefined,
      providerName: opening ? providerName(practice, opening.providerId) : undefined,
      modality: opening ? MODALITY_LABEL[opening.modality] : undefined,
      expires: offer ? new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(offer.expiresAt)) : undefined,
      previousSlot: entry?.currentAppointment && cmd.kind !== 'offer' ? formatSlot(entry.currentAppointment.start, tz) : undefined,
      link,
    });

    const targets = this.channelsFor(patient);
    if (!targets.length) {
      this.db.logNotification({ patientId: patient.id, kind: cmd.kind, channel: 'none', status: 'skipped', error: 'No usable contact channel' });
      this.audit.record(SYSTEM, 'notification.undeliverable', { type: 'entry', id: cmd.entryId }, { kind: cmd.kind });
      return;
    }
    let delivered = 0;
    let lastError = '';
    for (const t of targets) {
      try {
        const res = await t.via.send({ channel: t.channel, to: t.to, subject: message.subject, text: message.text });
        this.db.logNotification({ patientId: patient.id, kind: cmd.kind, channel: t.channel, status: 'sent', providerMessageId: res.id });
        delivered++;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.db.logNotification({ patientId: patient.id, kind: cmd.kind, channel: t.channel, status: 'failed', error: lastError });
      }
    }
    this.audit.record(SYSTEM, 'notification.sent', { type: 'entry', id: cmd.entryId }, { kind: cmd.kind satisfies NotificationKind, delivered });
    if (!delivered) throw new Error(lastError || 'Notification failed');
  }

  // ---------------------------------------------------------------- sources

  async pollSources(now = new Date()) {
    const practice = this.practice();
    for (const p of practice.providers.filter((x) => x.active)) {
      if (p.icalUrl) await this.pollIcal(p, now).catch((err) => this.sourceError(`ical:${p.id}`, err));
      if (p.fhirScheduleId && this.fhir) await this.pollFhir(p, now).catch((err) => this.sourceError(`fhir:${p.id}`, err));
    }
  }

  private sourceError(source: string, err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    this.log(`source ${source} failed: ${message}`);
    this.audit.record(SYSTEM, 'source.error', { type: 'source', id: source }, { message: message.slice(0, 200) });
  }

  async pollIcal(p: ProviderConfig, now = new Date(), text?: string) {
    const id = `ical:${p.id}`;
    const body = text ?? (await fetchIcs(p.icalUrl!, AbortSignal.timeout(20000)));
    const events = parseIcs(body, this.practice().timeZone);
    const prev = this.db.getSourceState<IcalSnapshot>(id);
    const diff = diffIcal(prev, events, now, { horizonDays: 60, ignore: p.icalIgnore });
    if (diff.suspicious) {
      this.audit.record(SYSTEM, 'source.suspicious', { type: 'source', id }, { message: diff.suspicious });
      return;
    }
    this.db.setSourceState(id, diff.snapshot);
    for (const f of diff.freed) {
      if (minutesBetween(now, f.start) < this.practice().engine.offers.minLeadMinutes) continue;
      this.ingestFreedSlot(INTEGRATION, { providerId: p.id, start: f.start, end: f.end, source: id, externalId: `${f.key}@${f.start}` }, now);
    }
    if (prev) {
      for (const [key, span] of Object.entries(diff.snapshot)) {
        if (!prev[key] || prev[key].start !== span.start) this.ingestBookedSlot(INTEGRATION, p.id, new Date(span.start), new Date(span.end), now);
      }
    }
  }

  async pollFhir(p: ProviderConfig, now = new Date()) {
    const horizon = new Date(now.getTime() + 30 * 86400000);
    const slots = await fetchFreeSlots(this.fhir!, p.fhirScheduleId!, now, horizon);
    const id = `fhir:${p.id}`;
    const freeIds = new Set(slots.map((s) => s.id));
    for (const s of slots) {
      if (minutesBetween(now, s.start) < this.practice().engine.offers.minLeadMinutes) continue;
      this.ingestFreedSlot(INTEGRATION, { providerId: p.id, start: s.start, end: s.end, source: 'fhir', externalId: s.id }, now);
    }
    // Slots that stopped being free were booked elsewhere: withdraw what we were offering.
    for (const o of this.store.listOpenings({ status: ['open', 'offering'] })) {
      if (o.source === 'fhir' && o.providerId === p.id && o.externalId && !freeIds.has(o.externalId) && o.start < horizon.toISOString()) {
        this.run(INTEGRATION, (e) => e.withdrawOpening(o.id, now), now);
      }
    }
    this.db.setSourceState(id, { lastPoll: now.toISOString(), free: slots.length });
  }

  // ------------------------------------------------------------ maintenance

  maintenance(now = new Date()) {
    // Expire stale waitlist requests.
    for (const e of this.store.listEntries({ status: ['active', 'paused', 'pending_review'] })) {
      if (e.expiresAt && e.expiresAt <= now.toISOString()) {
        this.run(SYSTEM, (eng) => eng.updateEntry(e.id, { status: 'removed' }, now), now);
      }
    }
    // Remove direct identifiers of patients who left the waitlist long ago.
    for (const id of this.db.purgeCandidates(this.config.retentionDays, now)) {
      this.db.tx(() => {
        this.db.purgePatient(id);
        this.audit.record(SYSTEM, 'patient.purged', { type: 'patient', id }, { retentionDays: this.config.retentionDays });
      });
    }
    this.db.deleteExpired(now);
  }

  start() {
    const tick = () => {
      try {
        this.run(SYSTEM, (e, now) => e.tick(now));
      } catch (err) {
        this.log(`tick failed: ${(err as Error).message}`);
      }
      void this.processOutbox();
    };
    tick();
    this.timers.push(setInterval(tick, 15000));
    this.timers.push(setInterval(() => void this.pollSources(), this.config.pollSeconds * 1000));
    this.timers.push(setInterval(() => this.maintenance(), 3600000));
    setTimeout(() => void this.pollSources(), 2000).unref();
    this.maintenance();
    for (const t of this.timers) t.unref();
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Staff-facing label for an opening's slot. */
  slotLabel(o: { start: string; providerId: string }): string {
    const p = this.practice();
    return `${formatSlot(o.start, p.timeZone)} · ${providerName(p, o.providerId)}`;
  }

  newEntryId(): string {
    return newId('ent');
  }
}
