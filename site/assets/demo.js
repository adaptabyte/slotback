// Slotback live demo: the production matching engine (bundled from src/core) driving a simulated practice.
// Everything is synthetic and stays in this browser tab.
import {
  Engine,
  MemoryStore,
  DEFAULT_SETTINGS,
  addDays,
  addMinutes,
  checkEligibility,
  describeWindows,
  formatSlot,
  localToInstant,
  scoreEntry,
  toLocal,
} from './slotback-core.js';

const TZ = 'America/New_York';
const PRACTICE = 'Riverbend Health';
const PROVIDERS = {
  dr_lee: { name: 'Dr. Maya Lee, MD', short: 'Dr. Lee', modality: 'in_person' },
  np_ortiz: { name: 'Alex Ortiz, PMHNP', short: 'A. Ortiz', modality: 'telehealth' },
};
const TYPES = {
  eval: { name: 'New patient evaluation', short: 'New eval', minutes: 60 },
  fu: { name: 'Follow-up', short: 'Follow-up', minutes: 30 },
};
const DAY0 = 8 * 60; // calendar starts 8:00
const ROWS = 18; // 8:00–17:00 in 30-minute rows
const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtTime = (iso) =>
  new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const fmtClock = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const fmtShortDate = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric' }).format(new Date(iso));
const localMinutes = (iso) => toLocal(iso, TZ).minutes;

let S;

function mondayOnOrAfter(date) {
  let d = date;
  while (new Date(`${d}T12:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1);
  return d;
}

function init() {
  for (const t of S?.timers ?? []) clearTimeout(t);
  const W = mondayOnOrAfter(toLocal(new Date(), TZ).date);
  const at = (day, time) => localToInstant(addDays(W, day), time, TZ).toISOString();
  const store = new MemoryStore();
  let seq = 0;
  const engine = new Engine({
    store,
    settings: { ...DEFAULT_SETTINGS, timeZone: TZ, offers: { ...DEFAULT_SETTINGS.offers, quietHours: undefined } },
    newId: (p) => `${p}_${++seq}`,
  });
  S = {
    W,
    at,
    store,
    engine,
    now: new Date(at(0, '08:30')),
    patients: new Map(),
    appts: [],
    log: [],
    msgs: [],
    decisions: new Map(),
    provider: 'dr_lee',
    selected: null,
    minimal: false,
    tour: 0,
    ehrSeq: 1040,
    timers: [],
    fresh: new Set(),
  };

  const regular = {
    dr_lee: [
      [0, '09:00', 'eval', 'K.M.'], [0, '10:30', 'fu', 'P.D.'], [0, '13:00', 'eval', 'L.H.'], [0, '15:00', 'fu', 'T.R.'],
      [1, '09:00', 'fu', 'J.K.'], [1, '10:00', 'eval', 'R.S.', 'lee-tue-10'], [1, '11:00', 'fu', 'D.P.'], [1, '14:00', 'eval', 'M.A.'], [1, '16:00', 'fu', 'B.C.'],
      [2, '09:00', 'eval', 'G.W.'], [2, '11:00', 'fu', 'E.N.'], [2, '13:30', 'eval', 'S.V.'], [2, '15:00', 'fu', 'H.O.'],
      [3, '09:30', 'fu', 'C.F.'], [3, '11:00', 'eval', 'N.B.'], [3, '14:00', 'fu', 'I.Q.'], [3, '15:00', 'fu', 'L.W.', 'lee-thu-15'], [3, '16:00', 'eval', 'Z.T.'],
      [4, '10:00', 'eval', 'F.J.'], [4, '13:30', 'fu', 'O.M.'], [4, '15:00', 'fu', 'U.Y.'],
    ],
    np_ortiz: [
      [0, '09:00', 'fu', 'W.E.'], [0, '13:00', 'fu', 'R.T.'], [0, '14:00', 'fu', 'A.G.', 'ortiz-mon-14'], [0, '15:30', 'fu', 'Y.U.'],
      [1, '10:00', 'fu', 'I.O.'], [1, '13:00', 'fu', 'P.A.'], [1, '15:00', 'fu', 'S.D.'],
      [2, '09:30', 'fu', 'F.G.'], [2, '13:00', 'fu', 'H.J.'], [2, '14:30', 'fu', 'K.L.'],
      [3, '10:00', 'fu', 'Z.X.'], [3, '16:00', 'fu', 'C.V.'],
      [4, '09:00', 'fu', 'B.N.'], [4, '11:00', 'fu', 'M.Q.'], [4, '14:00', 'fu', 'E.R.'],
    ],
  };
  let k = 0;
  for (const [providerId, list] of Object.entries(regular)) {
    for (const [day, time, type, label, id] of list) {
      const start = at(day, time);
      S.appts.push({ id: id ?? `a${++k}`, providerId, start, end: addMinutes(start, TYPES[type].minutes), type, label, kind: 'appt' });
    }
  }

  const days = (list, start, end) => list.map((day) => ({ day, start, end }));
  const MF = [1, 2, 3, 4, 5];
  const people = [
    { first: 'Avery', last: 'Thompson', type: 'eval', providers: ['dr_lee'], modalities: ['in_person', 'telehealth'], weekly: days(MF, '08:00', '17:00'), mode: 'auto', acuity: 5, waited: 6, current: ['dr_lee', 23, '09:00'] },
    { first: 'Riley', last: 'Nguyen', type: 'eval', providers: ['dr_lee'], modalities: ['in_person'], weekly: days([2, 4], '08:00', '12:00'), mode: 'confirm', acuity: 4, waited: 25 },
    { first: 'Morgan', last: 'Reyes', type: 'eval', providers: [], modalities: ['in_person', 'telehealth'], weekly: days(MF, '08:00', '12:00'), mode: 'confirm', acuity: 3, waited: 33 },
    { first: 'Casey', last: 'Brennan', type: 'eval', providers: ['dr_lee'], modalities: ['in_person', 'telehealth'], weekly: days(MF, '08:00', '17:00'), mode: 'auto', acuity: 2, waited: 40, current: ['dr_lee', 35, '14:00'] },
    { first: 'Jordan', last: 'Patel', type: 'fu', providers: ['np_ortiz'], modalities: ['telehealth'], weekly: days([1, 3, 5], '12:00', '17:00'), mode: 'confirm', acuity: 3, waited: 18, current: ['np_ortiz', 14, '14:00'] },
    { first: 'Taylor', last: 'Brooks', type: 'fu', providers: [], modalities: ['in_person', 'telehealth'], weekly: days(MF, '08:00', '17:00'), mode: 'confirm', acuity: 1, waited: 9, current: ['dr_lee', 10, '10:30'] },
    { first: 'Sam', last: 'Okafor', type: 'fu', providers: [], modalities: ['in_person'], weekly: days([2, 4], '12:00', '17:00'), mode: 'confirm', acuity: 4, waited: 3 },
    { first: 'Quinn', last: 'Foster', type: 'fu', providers: ['np_ortiz'], modalities: ['telehealth'], weekly: days(MF, '08:00', '17:00'), mode: 'auto', acuity: 2, waited: 12, current: ['np_ortiz', 17, '11:00'] },
  ];
  people.forEach((p, i) => addPerson(p, i));
}

function addPerson(p, i) {
  const patientId = `pat_${S.patients.size + 1}`;
  const entryId = `ent_${S.patients.size + 1}`;
  S.patients.set(patientId, { first: p.first, last: p.last, entryId });
  let currentAppointment;
  if (p.current) {
    const [providerId, day, time] = p.current;
    const start = S.at(day, time);
    const end = addMinutes(start, TYPES[p.type].minutes);
    const modality = PROVIDERS[providerId].modality;
    currentAppointment = { start, end, providerId, modality, appointmentType: p.type, externalId: `appt-${entryId}` };
    S.appts.push({ id: `appt-${entryId}`, providerId, start, end, type: p.type, label: `${p.first} ${p.last[0]}.`, kind: 'appt', entryId });
  }
  const entry = {
    id: entryId,
    patientId,
    status: 'active',
    providerIds: p.providers,
    appointmentType: p.type,
    durationMinutes: TYPES[p.type].minutes,
    modalities: p.modalities,
    locationIds: [],
    availability: { timeZone: TZ, weekly: p.weekly, minNoticeMinutes: 60 },
    bookingMode: p.mode,
    currentAppointment,
    acuity: p.acuity,
    boost: 0,
    pinned: false,
    addedAt: new Date(S.now.getTime() - (p.waited ?? 0) * 86400000 - (i ?? 0) * 60000).toISOString(),
    declines: 0,
  };
  return S.engine.addEntry(entry, S.now);
}

// ------------------------------------------------------------------ helpers

const entryOf = (id) => S.store.getEntry(id);
function nameOfEntry(entryId) {
  const e = entryOf(entryId);
  const p = e && S.patients.get(e.patientId);
  return p ? `${p.first} ${p.last[0]}.` : 'a patient';
}
function firstNameOfEntry(entryId) {
  const e = entryOf(entryId);
  return (e && S.patients.get(e.patientId)?.first) ?? 'there';
}
const slot = (o) => `${formatSlot(o.start, TZ)} with ${PROVIDERS[o.providerId].short}`;

function log(kind, text, code) {
  const item = { id: `${Date.now()}-${Math.random()}`, at: S.now.toISOString(), kind, text, code };
  S.log.unshift(item);
  S.fresh.add(item.id);
}

function message(entryId, text, extra = {}) {
  const e = entryOf(entryId);
  const item = { id: `m${S.msgs.length + 1}`, to: nameOfEntry(entryId), entryId, at: S.now.toISOString(), text, ...extra };
  S.msgs.unshift(item);
  S.fresh.add(item.id);
  log('msg', `Text sent to ${e ? S.patients.get(e.patientId).first : 'patient'}`, `SMS: "${text.slice(0, 70)}…"`);
}

function renderText(kind, entryId, data) {
  const first = firstNameOfEntry(entryId);
  const link = 'waitlist.riverbend.example/o/' + Math.random().toString(36).slice(2, 8);
  if (S.minimal) {
    if (kind === 'offer') return `${PRACTICE}: You have a time-sensitive appointment update. View it securely: ${link}`;
    if (kind === 'offer_taken') return `${PRACTICE}: The opening we sent you is no longer available. You're still on the waitlist.`;
    return `${PRACTICE}: Your appointment has been updated. View it securely: ${link}`;
  }
  const where = data.opening ? ` (${data.opening.modality === 'telehealth' ? 'telehealth' : 'in person'})` : '';
  const details = data.opening ? `${formatSlot(data.opening.start, TZ)} with ${PROVIDERS[data.opening.providerId].name}${where}` : '';
  const prev = data.previous ? ` Your previous appointment (${formatSlot(data.previous, TZ)}) has been released.` : '';
  switch (kind) {
    case 'offer':
      return `${PRACTICE}: Hi ${first}, an earlier appointment opened up: ${details}. It's held for you until ${fmtClock(data.expiresAt)}. Accept or decline: ${link}`;
    case 'offer_taken':
      return `${PRACTICE}: Sorry, that opening has been filled. You're still on the waitlist and we'll message you about the next match.`;
    case 'booked':
      return `${PRACTICE}: You're confirmed for ${details}.${prev}`;
    case 'auto_booked':
      return `${PRACTICE}: Good news ${first}, you've been booked into an earlier appointment: ${details}.${prev} If it doesn't work, please call (555) 010-2000.`;
    default:
      return `${PRACTICE}: Thanks! We're finalizing your appointment and will confirm shortly.`;
  }
}

// ------------------------------------------------------------- engine glue

function apply(outcome) {
  for (const ev of outcome.events) describe(ev);
  for (const cmd of outcome.commands) execute(cmd);
  render();
}

function describe(ev) {
  const o = ev.openingId ? S.store.getOpening(ev.openingId) : undefined;
  const d = ev.data ?? {};
  switch (ev.type) {
    case 'opening.created': {
      S.selected = ev.openingId;
      const why = o.origin.kind === 'moved_up' ? `freed when ${nameOfEntry(o.origin.entryId)} moved up` : 'cancelled in the EHR';
      log('open', `Opening detected: ${slot(o)} (${why}).`, o.chainDepth ? `chain step ${o.chainDepth}` : `source: EHR schedule`);
      break;
    }
    case 'opening.ranked': {
      snapshotDecision(o, d);
      const top = d.top.slice(0, 3).map((t) => `${nameOfEntry(t.entryId)} (${t.score})`).join(', ');
      log('rank', `${d.eligible} patient${d.eligible === 1 ? '' : 's'} on the waitlist fit this slot. Top: ${top}.`);
      break;
    }
    case 'opening.no_match':
      snapshotDecision(o, { top: [], eligible: 0 });
      log('bad', `Nobody on the waitlist fits ${slot(o)} yet. It stays open and is matched the moment someone who fits joins.`);
      break;
    case 'offer.auto_accepted':
      log('book', `${nameOfEntry(ev.entryId)} ranks #1 and chose "book me automatically", so no offer is needed.`);
      break;
    case 'offer.sent': {
      const offer = S.store.getOffer(ev.offerId);
      log('offer', `Offer sent to ${nameOfEntry(ev.entryId)} (#${d.rank}), held until ${fmtClock(offer.expiresAt)}.${d.parallel ? ' Sent to several patients at once because the slot is soon: first to accept wins.' : ''}`);
      break;
    }
    case 'offer.accepted':
      log('book', `${nameOfEntry(ev.entryId)} accepted.`);
      break;
    case 'offer.declined':
      log('offer', `${nameOfEntry(ev.entryId)} declined, so the slot goes to the next patient.`);
      break;
    case 'offer.expired':
      log('bad', `${nameOfEntry(ev.entryId)} didn't reply within the hold, so the slot moves on.`);
      break;
    case 'offer.superseded':
      log('offer', `${nameOfEntry(ev.entryId)}'s offer withdrawn: someone else took the slot.`);
      break;
    case 'booking.requested':
      log('ehr', `Writing ${nameOfEntry(ev.entryId)}'s appointment to the EHR…`, `POST /fhir/Appointment  status=booked  start=${o.start}`);
      break;
    case 'booking.confirmed':
      log('done', `Booked ${nameOfEntry(ev.entryId)} into ${slot(o)}.`);
      break;
    case 'chain.freed':
      log('open', `${nameOfEntry(ev.entryId)}'s old appointment (${formatSlot(d.start, TZ)}) is now free. Re-offering it.`);
      break;
    case 'opening.expired':
      log('bad', `${slot(o)} is now too close to start to fill.`);
      break;
    case 'opening.withdrawn':
      log('bad', `${slot(o)} withdrawn.`);
      break;
  }
}

function snapshotDecision(o, d) {
  const policy = S.engine.settings.priority;
  const topIds = new Set(d.top.map((t) => t.entryId));
  const ranked = d.top.map((t) => {
    const e = entryOf(t.entryId);
    return { entryId: t.entryId, rank: t.rank, score: scoreEntry({ ...e, status: 'active' }, policy, S.now, o) };
  });
  const ineligible = [];
  for (const e of S.store.listEntries({ status: ['active', 'offered', 'paused', 'booking'] })) {
    if (topIds.has(e.id)) continue;
    const reasons = checkEligibility(e, o, S.now, S.engine.settings);
    if (reasons.length) ineligible.push({ entryId: e.id, reasons: reasons.map((r) => r.message) });
  }
  S.decisions.set(o.id, { ranked, eligible: d.eligible, ineligible, at: S.now.toISOString() });
}

function execute(cmd) {
  if (cmd.type === 'notify') {
    const offer = cmd.offerId ? S.store.getOffer(cmd.offerId) : undefined;
    const booking = cmd.bookingId ? S.store.getBooking(cmd.bookingId) : undefined;
    const opening = S.store.getOpening(offer?.openingId ?? booking?.openingId ?? '');
    const e = entryOf(cmd.entryId);
    const text = renderText(cmd.kind, cmd.entryId, {
      opening,
      expiresAt: offer?.expiresAt,
      previous: cmd.kind !== 'offer' && e?.currentAppointment ? e.currentAppointment.start : undefined,
    });
    message(cmd.entryId, text, { kind: cmd.kind, offerId: cmd.kind === 'offer' ? cmd.offerId : undefined });
  } else if (cmd.type === 'book') {
    const t = setTimeout(() => {
      const b = S.store.getBooking(cmd.bookingId);
      if (!b || b.status !== 'requested') return;
      const ext = `Appointment/ehr-${++S.ehrSeq}`;
      log('ehr', `EHR confirmed the appointment.`, `201 Created  ${ext}`);
      S.appts.push({ id: `bk-${b.id}`, providerId: b.providerId, start: b.start, end: b.end, type: b.appointmentType, label: nameOfEntry(b.entryId), kind: 'moved', entryId: b.entryId });
      apply(S.engine.bookingResult(b.id, { ok: true, externalId: ext }, S.now));
    }, 750);
    S.timers.push(t);
  } else if (cmd.type === 'cancel_original') {
    const idx = S.appts.findIndex((a) => a.entryId === cmd.entryId && a.start === cmd.appointment.start && a.kind === 'appt');
    if (idx >= 0) S.appts.splice(idx, 1);
    log('ehr', `Released ${nameOfEntry(cmd.entryId)}'s original appointment in the EHR.`, `PUT /fhir/Appointment/${cmd.appointment.externalId}  status=cancelled`);
  }
}

// ----------------------------------------------------------------- actions

function cancelAppt(id) {
  const i = S.appts.findIndex((a) => a.id === id);
  if (i < 0) return;
  const a = S.appts[i];
  S.appts.splice(i, 1);
  log('bad', `${a.label} cancelled ${formatSlot(a.start, TZ)} with ${PROVIDERS[a.providerId].short}.`, 'EHR: appointment status → cancelled');
  if (a.entryId) {
    // A waitlisted patient cancelled the appointment they were trying to move: they no longer have one.
    const e = entryOf(a.entryId);
    if (e?.currentAppointment?.start === a.start) S.engine.updateEntry(e.id, { currentAppointment: undefined }, S.now);
  }
  S.provider = a.providerId;
  apply(
    S.engine.createOpening(
      { providerId: a.providerId, modality: PROVIDERS[a.providerId].modality, start: a.start, end: a.end, source: 'ehr', externalId: a.id },
      S.now,
    ),
  );
}

function respond(offerId, answer) {
  const offer = S.store.getOffer(offerId);
  if (!offer) return;
  S.msgs.unshift({ id: `r${S.msgs.length + 1}`, to: nameOfEntry(offer.entryId), at: S.now.toISOString(), text: answer === 'accept' ? 'YES' : 'NO', reply: true });
  const res = S.engine.respond(offerId, answer, S.now);
  if (res.result === 'expired') log('bad', `${nameOfEntry(offer.entryId)} replied too late: the hold had expired.`);
  if (res.result === 'unavailable') log('offer', `${nameOfEntry(offer.entryId)} replied, but the slot was already taken.`);
  apply(res);
}

function advance(minutes) {
  S.now = new Date(S.now.getTime() + minutes * 60000);
  log('rank', `Clock advanced ${minutes} minutes.`);
  apply(S.engine.tick(S.now));
}

// -------------------------------------------------------------------- tour

const morganId = () => [...S.patients.values()].find((p) => p.first === 'Morgan')?.entryId;
const TOUR = [
  {
    text: () => `<b>Tuesday 10:00 AM just cancelled.</b> A patient called Dr. Lee's office to cancel a new-patient evaluation. Click <b>✕</b> on the flashing appointment, or let the demo do it.`,
    act: 'Cancel it for me',
    run: () => cancelAppt('lee-tue-10'),
    done: () => !S.appts.some((a) => a.id === 'lee-tue-10'),
  },
  {
    text: () => `Slotback ranked the waitlist and <b>auto-booked Avery</b> (acuity 5, chose "book me automatically"). Watch the pipeline: the booking goes to the EHR, Avery gets a text, and Avery's old slot is released and re-offered…`,
    done: () => entryOf(morganId())?.status === 'offered',
  },
  {
    text: () => `<b>Morgan</b> asked to be asked first, so she got a text and the slot is held for her for 30 minutes. Tap <b>Accept</b> on her phone.`,
    act: 'Accept for Morgan',
    run: () => {
      const o = S.store.listOffers({ entryId: morganId(), status: 'pending' })[0];
      if (o) respond(o.id, 'accept');
    },
    done: () => ['booking', 'booked'].includes(entryOf(morganId())?.status),
  },
  {
    text: () => `<b>One cancellation, two patients seen sooner, zero phone calls.</b> Now try it yourself: set Taylor's acuity to 5 and cancel Dr. Lee's Thursday 3:00 PM, fast-forward the clock to let an offer expire, or add a patient.`,
    act: 'Finish tour',
    run: () => {
      S.tour = -1;
    },
    done: () => false,
  },
];

function renderTour() {
  const el = $('tour');
  if (S.tour < 0) {
    el.hidden = true;
    return;
  }
  while (S.tour < TOUR.length - 1 && TOUR[S.tour].done()) S.tour++;
  const step = TOUR[S.tour];
  el.hidden = false;
  el.innerHTML = `<span class="n">Guided tour · ${S.tour + 1}/${TOUR.length}</span><p>${step.text()}</p>
    <div class="tour-actions">${step.act ? `<button class="btn small" type="button" data-action="tour-run">${esc(step.act)}</button>` : ''}
    <button class="btn small ghost" type="button" data-action="tour-skip">${S.tour === TOUR.length - 1 ? 'Close' : 'Skip tour'}</button></div>`;
}

// ------------------------------------------------------------------ render

function render() {
  $('clock').textContent = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(S.now);
  $('privacy-minimal').checked = S.minimal;
  renderTour();
  renderTabs();
  renderCalendar();
  renderPhone();
  renderWaitlist();
  renderPipeline();
  S.fresh.clear();
}

function renderTabs() {
  $('provider-tabs').innerHTML = Object.entries(PROVIDERS)
    .map(([id, p]) => `<button type="button" role="tab" aria-selected="${S.provider === id}" data-action="tab" data-id="${id}">${esc(p.short)} <small>· ${p.modality === 'telehealth' ? 'telehealth' : 'in person'}</small></button>`)
    .join('');
}

function activeOpenings() {
  return S.store.listOpenings({ status: ['new', 'open', 'offering', 'booking', 'needs_attention'] });
}

function openingLabel(o) {
  if (o.status === 'offering') {
    const offers = S.store.listOffers({ openingId: o.id, status: 'pending' });
    const mins = offers.length ? Math.max(0, Math.round((Date.parse(offers[0].expiresAt) - S.now.getTime()) / 60000)) : 0;
    return ['Open · offered', `${offers.map((x) => nameOfEntry(x.entryId)).join(', ')} · ${mins} min left`];
  }
  if (o.status === 'booking') {
    const b = S.store.listBookings({ status: 'requested' }).find((x) => x.openingId === o.id);
    return ['Open · booking', b ? nameOfEntry(b.entryId) : ''];
  }
  return ['Open · no match yet', 'waiting for a fit'];
}

function renderCalendar() {
  const prov = S.provider;
  const weekEnd = localToInstant(addDays(S.W, 5), '00:00', TZ).toISOString();
  const nowLocal = toLocal(S.now, TZ);
  const dayIdx = (iso) => {
    const d = toLocal(iso, TZ).date;
    for (let i = 0; i < 5; i++) if (addDays(S.W, i) === d) return i;
    return -1;
  };
  const row = (iso) => 2 + (localMinutes(iso) - DAY0) / 30;
  let html = '<div></div>';
  for (let i = 0; i < 5; i++) {
    const date = addDays(S.W, i);
    html += `<div class="dh ${date === nowLocal.date ? 'today' : ''}" style="grid-column:${i + 2};grid-row:1">${WD[i]}<small>${fmtShortDate(localToInstant(date, '12:00', TZ))}</small></div>`;
  }
  for (let r = 0; r < ROWS; r++) {
    const m = DAY0 + r * 30;
    html += `<div class="tm" style="grid-column:1;grid-row:${r + 2}">${r % 2 === 0 ? `${((m / 60 + 11) % 12) + 1}${m < 720 ? 'a' : 'p'}` : ''}</div>`;
    for (let i = 0; i < 5; i++) {
      const date = addDays(S.W, i);
      const past = date < nowLocal.date || (date === nowLocal.date && m + 30 <= nowLocal.minutes);
      html += `<div class="cell ${r % 2 === 0 ? 'hour' : ''} ${past ? 'past' : ''}" style="grid-column:${i + 2};grid-row:${r + 2}"></div>`;
    }
  }
  const inWeek = (iso) => iso < weekEnd && dayIdx(iso) >= 0 && localMinutes(iso) >= DAY0 && localMinutes(iso) < DAY0 + ROWS * 30;
  const tourTarget = S.tour === 0 ? 'lee-tue-10' : null;
  for (const a of S.appts.filter((x) => x.providerId === prov && inWeek(x.start))) {
    const done = a.end <= S.now.toISOString();
    const canCancel = a.start > S.now.toISOString();
    html += `<div class="ev ${a.kind} ${done ? 'done' : ''} ${a.id === tourTarget ? 'pulse' : ''}" style="grid-column:${dayIdx(a.start) + 2};grid-row:${row(a.start)} / ${row(a.end)}" ${a.id === tourTarget ? 'id="tour-target"' : ''}>
      <b>${esc(a.kind === 'moved' ? `↑ ${a.label}` : a.label)}</b><span>${esc(a.kind === 'moved' ? 'moved up' : TYPES[a.type].short)}</span>
      ${canCancel ? `<button class="x" type="button" data-action="cancel" data-id="${esc(a.id)}" aria-label="Cancel ${esc(a.label)}'s ${esc(fmtTime(a.start))} appointment">✕</button>` : ''}</div>`;
  }
  for (const o of activeOpenings().filter((x) => x.providerId === prov && inWeek(x.start))) {
    const [title, sub] = openingLabel(o);
    html += `<div class="ev open ${S.selected === o.id ? 'sel' : ''}" role="button" tabindex="0" data-action="select" data-id="${o.id}" style="grid-column:${dayIdx(o.start) + 2};grid-row:${row(o.start)} / ${row(o.end)}" title="Why this patient? Click for the ranking">
      <b>${esc(title)}</b><span>${esc(sub)}</span></div>`;
  }
  const ni = dayIdx(S.now.toISOString());
  if (ni >= 0 && nowLocal.minutes >= DAY0 && nowLocal.minutes < DAY0 + ROWS * 30) {
    const off = nowLocal.minutes - DAY0;
    html += `<div class="nowline" style="grid-column:${ni + 2};grid-row:${2 + Math.floor(off / 30)};align-self:start;margin-top:${((off % 30) / 30) * 2.1}rem" aria-hidden="true"></div>`;
  }
  $('calendar').innerHTML = html;

  const later = S.appts.filter((a) => a.providerId === prov && a.start >= weekEnd).sort((a, b) => (a.start < b.start ? -1 : 1));
  const laterOpen = activeOpenings().filter((o) => o.providerId === prov && o.start >= weekEnd);
  const chips = [
    ...later.map((a) => ({ start: a.start, html: `<span class="chip ${a.kind === 'moved' ? 'moved' : ''}">${esc(fmtShortDate(a.start))} ${esc(fmtClock(a.start))} · ${esc(a.label)} <button type="button" data-action="cancel" data-id="${esc(a.id)}" aria-label="Cancel ${esc(a.label)}'s appointment">✕</button></span>` })),
    ...laterOpen.map((o) => ({ start: o.start, html: `<span class="chip open" role="button" tabindex="0" data-action="select" data-id="${o.id}">${esc(fmtShortDate(o.start))} ${esc(fmtClock(o.start))} · ${esc(openingLabel(o).join(': '))}</span>` })),
  ].sort((a, b) => (a.start < b.start ? -1 : 1));
  $('later').innerHTML = chips.length ? `<span class="lbl">Later weeks:</span>${chips.map((c) => c.html).join('')}` : '';
}

function renderPhone() {
  $('phone-count').textContent = S.msgs.length ? `${S.msgs.filter((m) => !m.reply).length} texts sent` : '';
  if (!S.msgs.length) {
    $('phone').innerHTML = `<p class="empty">Texts to patients appear here. Cancel an appointment to start.</p>`;
    return;
  }
  $('phone').innerHTML = S.msgs
    .map((m) => {
      const offer = m.offerId ? S.store.getOffer(m.offerId) : undefined;
      const live = offer && offer.status === 'pending' && offer.expiresAt > S.now.toISOString();
      const state = offer && !live ? `<span class="small">${{ accepted: 'Accepted', declined: 'Declined', expired: 'Expired', superseded: 'Filled by someone else' }[offer.status] ?? 'Expired'}</span>` : '';
      return `<div class="msg ${m.reply ? 'reply' : ''} ${S.fresh.has(m.id) ? 'fresh' : ''}">
        <span class="who">${m.reply ? `${esc(m.to)} replied` : `To ${esc(m.to)}`} · ${esc(fmtTime(m.at))}</span>
        <div class="bubble">${esc(m.text)}</div>
        ${live ? `<div class="act"><button class="btn small" type="button" data-action="respond" data-id="${offer.id}" data-answer="accept">Accept</button><button class="btn small ghost" type="button" data-action="respond" data-id="${offer.id}" data-answer="decline">Decline</button></div>` : state}
      </div>`;
    })
    .join('');
}

function renderWaitlist() {
  const open = new Set([...document.querySelectorAll('#waitlist details[open]')].map((d) => d.dataset.id));
  const focusKey = document.activeElement?.dataset?.key;
  const ranked = S.engine.rankedWaitlist(S.now);
  const done = S.store.listEntries({ status: 'booked' });
  const rows = ranked.map((c) => wlRow(c.entry, c.rank, c.score, open)).join('') + done.map((e) => wlRow(e, '✓', null, open)).join('');
  $('waitlist').innerHTML = `<div class="wl">${rows}</div>`;
  if (focusKey) document.querySelector(`#waitlist [data-key="${focusKey}"]`)?.focus();
}

function wlRow(e, rank, score, open) {
  const p = S.patients.get(e.patientId);
  const pref = e.providerIds.length ? e.providerIds.map((id) => PROVIDERS[id].short).join(', ') : 'any provider';
  const cur = e.currentAppointment ? `has ${fmtShortDate(e.currentAppointment.start)}` : 'no appointment yet';
  const statusText = { active: 'waiting', offered: 'offer out', booking: 'booking', booked: 'moved up', paused: 'paused' }[e.status] ?? e.status;
  const booked = e.status === 'booked' ? S.store.listBookings({ entryId: e.id, status: 'confirmed' })[0] : undefined;
  const locked = ['booking', 'booked'].includes(e.status);
  return `<div class="wl-row">
    <span class="rk">${rank}</span>
    <div class="nm"><b>${esc(p.first)} ${esc(p.last)}</b>
      <span>${esc(TYPES[e.appointmentType].short)} · ${esc(pref)} · ${esc(describeWindows(e.availability.weekly))}</span>
      <span>${booked ? `now booked ${esc(fmtTime(booked.start))}` : esc(cur)} · <span class="pill ${e.status}">${esc(statusText)}</span></span></div>
    <div class="ctl">
      <select aria-label="Acuity for ${esc(p.first)}" data-action="acuity" data-id="${e.id}" data-key="ac-${e.id}" ${locked ? 'disabled' : ''}>
        ${[1, 2, 3, 4, 5].map((a) => `<option value="${a}" ${e.acuity === a ? 'selected' : ''}>Acuity ${a}${a === 5 ? ' · urgent' : a === 1 ? ' · routine' : ''}</option>`).join('')}
      </select>
      <select aria-label="Booking mode for ${esc(p.first)}" data-action="mode" data-id="${e.id}" data-key="md-${e.id}" ${locked ? 'disabled' : ''}>
        <option value="auto" ${e.bookingMode === 'auto' ? 'selected' : ''}>Auto-book</option>
        <option value="confirm" ${e.bookingMode === 'confirm' ? 'selected' : ''}>Ask first</option>
      </select>
      <label class="pin"><input type="checkbox" data-action="pin" data-id="${e.id}" data-key="pn-${e.id}" ${e.pinned ? 'checked' : ''} ${locked ? 'disabled' : ''}> Pin</label>
    </div>
    ${
      score
        ? `<details class="score" data-id="${e.id}" ${open.has(e.id) ? 'open' : ''}><summary aria-label="Score ${score.total}, show breakdown">${score.total}</summary>
            <ul>${score.parts.map((x) => `<li><span>${esc(x.label)}</span><b>${x.points > 0 ? '+' : ''}${x.points}</b></li>`).join('')}${e.pinned ? '<li><span>Pinned by provider</span><b>top</b></li>' : ''}
            <li><span>+ up to 15 per opening for days saved</span><b></b></li></ul></details>`
        : '<span></span>'
    }
  </div>`;
}

function renderPipeline() {
  const d = S.selected && S.decisions.get(S.selected);
  const o = S.selected && S.store.getOpening(S.selected);
  if (d && o) {
    $('decision').innerHTML = `<div class="decision">
      <h3>Why this patient? · ${esc(formatSlot(o.start, TZ))}</h3>
      ${
        d.ranked.length
          ? `<ol>${d.ranked
              .map(
                (r) => `<li><b>${esc(nameOfEntry(r.entryId))}</b> · ${r.score.total} pts<small>${esc(r.score.parts.map((x) => `${x.label} ${x.points > 0 ? '+' : ''}${x.points}`).join(' · '))}</small></li>`,
              )
              .join('')}</ol>`
          : '<p class="empty">No eligible patients when this slot opened.</p>'
      }
      ${d.ineligible.length ? `<details><summary>Not eligible (${d.ineligible.length})</summary><ul>${d.ineligible.map((i) => `<li><b>${esc(nameOfEntry(i.entryId))}:</b> ${esc(i.reasons.join('; '))}</li>`).join('')}</ul></details>` : ''}
    </div>`;
  } else {
    $('decision').innerHTML = '';
  }
  $('pipeline').innerHTML = S.log.length
    ? S.log
        .map(
          (l) => `<li class="k-${l.kind} ${S.fresh.has(l.id) ? 'fresh' : ''}"><time>${esc(fmtClock(l.at))}</time><span class="dot" aria-hidden="true"></span><span>${esc(l.text)}${l.code ? `<code>${esc(l.code)}</code>` : ''}</span></li>`,
        )
        .join('')
    : `<li><span></span><span></span><span class="empty">Each step Slotback takes shows up here: detection, ranking, offers, EHR write-back and texts.</span></li>`;
}

// --------------------------------------------------------------- add form

function renderAddForm() {
  $('add-form').innerHTML = `
    <label>First name<input id="add-first" required maxlength="20" value="Jamie"></label>
    <label>Last name<input id="add-last" required maxlength="20" value="Rivera"></label>
    <label>Visit<select id="add-type"><option value="eval">New eval (60 min)</option><option value="fu">Follow-up (30 min)</option></select></label>
    <label>Provider<select id="add-prov"><option value="">Any</option><option value="dr_lee">Dr. Lee</option><option value="np_ortiz">A. Ortiz</option></select></label>
    <label>Days<select id="add-days"><option value="1,2,3,4,5">Weekdays</option><option value="1,3,5">Mon / Wed / Fri</option><option value="2,4">Tue / Thu</option></select></label>
    <label>Times<select id="add-times"><option value="08:00-17:00">Any time</option><option value="08:00-12:00">Mornings</option><option value="12:00-17:00">Afternoons</option></select></label>
    <label>When matched<select id="add-mode"><option value="auto">Book automatically</option><option value="confirm">Ask first</option></select></label>
    <label>Acuity<select id="add-acuity"><option>1</option><option>2</option><option selected>3</option><option>4</option><option>5</option></select></label>
    <div class="full"><button class="btn small" type="submit">Add to waitlist</button><span class="small">Joins instantly and is matched against any open slot.</span></div>`;
}

function submitAdd(ev) {
  ev.preventDefault();
  const v = (id) => $(id).value.trim();
  const [start, end] = v('add-times').split('-');
  const prov = v('add-prov');
  const res = addPerson({
    first: v('add-first') || 'New',
    last: v('add-last') || 'Patient',
    type: v('add-type'),
    providers: prov ? [prov] : [],
    modalities: prov ? [PROVIDERS[prov].modality] : ['in_person', 'telehealth'],
    weekly: v('add-days').split(',').map((d) => ({ day: Number(d), start, end })),
    mode: v('add-mode'),
    acuity: Number(v('add-acuity')),
    waited: 0,
  });
  log('rank', `${v('add-first') || 'New'} joined the waitlist.`);
  $('add-form').hidden = true;
  document.querySelector('[data-action="toggle-add"]').setAttribute('aria-expanded', 'false');
  apply(res);
}

// ----------------------------------------------------------------- events

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el || !document.querySelector('main.demo').contains(el)) return;
  const id = el.dataset.id;
  switch (el.dataset.action) {
    case 'cancel':
      cancelAppt(id);
      break;
    case 'select':
      S.selected = id;
      render();
      break;
    case 'respond':
      respond(id, el.dataset.answer);
      break;
    case 'tab':
      S.provider = id;
      render();
      break;
    case 'advance':
      advance(Number(el.dataset.minutes));
      break;
    case 'reset':
      init();
      render();
      break;
    case 'tour-run':
      TOUR[S.tour]?.run?.();
      render();
      break;
    case 'tour-skip':
      S.tour = -1;
      render();
      break;
    case 'toggle-add': {
      const f = $('add-form');
      f.hidden = !f.hidden;
      el.setAttribute('aria-expanded', String(!f.hidden));
      if (!f.hidden) $('add-first').focus();
      break;
    }
  }
});

document.addEventListener('keydown', (ev) => {
  const el = ev.target.closest?.('[data-action="select"]');
  if (el && (ev.key === 'Enter' || ev.key === ' ')) {
    ev.preventDefault();
    el.click();
  }
});

document.addEventListener('change', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const id = el.dataset.id;
  if (el.dataset.action === 'acuity') apply(S.engine.updateEntry(id, { acuity: Number(el.value) }, S.now));
  if (el.dataset.action === 'mode') apply(S.engine.updateEntry(id, { bookingMode: el.value }, S.now));
  if (el.dataset.action === 'pin') apply(S.engine.updateEntry(id, { pinned: el.checked }, S.now));
  if (el.dataset.action === 'privacy') {
    S.minimal = el.checked;
    render();
  }
});

init();
renderAddForm();
$('add-form').addEventListener('submit', submitAdd);
render();
