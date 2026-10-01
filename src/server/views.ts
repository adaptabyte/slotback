import { describeWindows, localToInstant, normalizeWindows, toLocal } from '../core/index.ts';
import type { Acuity, BookingMode, CurrentAppointment, Modality, TimeWindow, WaitlistEntry } from '../core/index.ts';
import type { PatientRecord } from './db.ts';
import { normalizePhone } from './db.ts';
import { html } from './html.ts';
import type { SafeHtml } from './html.ts';
import type { PracticeSettings } from './practice.ts';

export const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const NOTICE_OPTIONS: [number, string][] = [
  [60, '1 hour'],
  [180, '3 hours'],
  [24 * 60, '1 day'],
  [48 * 60, '2 days'],
  [7 * 24 * 60, '1 week'],
];

export const ACUITY_LABEL: Record<Acuity, string> = {
  1: '1 · Routine',
  2: '2 · Low',
  3: '3 · Moderate',
  4: '4 · High',
  5: '5 · Urgent',
};

export const STATUS_LABEL: Record<string, string> = {
  pending_review: 'Needs review',
  active: 'Waiting',
  paused: 'Paused',
  offered: 'Offer out',
  booking: 'Booking',
  booked: 'Booked',
  removed: 'Removed',
  new: 'New',
  open: 'No match yet',
  offering: 'Offering',
  filled: 'Filled',
  expired: 'Expired',
  withdrawn: 'Withdrawn',
  needs_attention: 'Needs attention',
  pending: 'Waiting for reply',
  accepted: 'Accepted',
  declined: 'Declined',
  superseded: 'Taken by another patient',
  requested: 'Writing to EHR',
  confirmed: 'Confirmed',
  failed: 'Failed',
};

export function statusBadge(status: string): SafeHtml {
  return html`<span class="badge s-${status}">${STATUS_LABEL[status] ?? status}</span>`;
}

export function fullName(p: PatientRecord | undefined): string {
  if (!p) return 'Unknown patient';
  return `${p.firstName} ${p.lastName}`.trim();
}

/** Weekday × time-block checkbox grid. Values look like `2:morning`. */
export function availabilityGrid(practice: PracticeSettings, windows: TimeWindow[]): SafeHtml {
  const selected = new Set<string>();
  for (const b of practice.timeBlocks) {
    for (const w of windows) {
      if (w.start <= b.start && b.end <= w.end) selected.add(`${w.day}:${b.id}`);
    }
  }
  return html`<table class="grid">
    <thead><tr><th></th>${practice.weekdays.map((d) => html`<th scope="col">${WEEKDAY_SHORT[d]}</th>`)}</tr></thead>
    <tbody>${practice.timeBlocks.map(
      (b) => html`<tr><th scope="row">${b.label}</th>${practice.weekdays.map((d) => {
        const v = `${d}:${b.id}`;
        return html`<td><label class="cell"><input type="checkbox" name="slot" value="${v}" ${selected.has(v) ? 'checked' : ''} aria-label="${WEEKDAY_LONG[d]} ${b.label}"><span></span></label></td>`;
      })}</tr>`,
    )}</tbody>
  </table>`;
}

export function windowsFromForm(practice: PracticeSettings, values: string[]): TimeWindow[] {
  const windows: TimeWindow[] = [];
  for (const v of values) {
    const [day, blockId] = v.split(':');
    const block = practice.timeBlocks.find((b) => b.id === blockId);
    const d = Number(day);
    if (block && practice.weekdays.includes(d)) windows.push({ day: d as TimeWindow['day'], start: block.start, end: block.end });
  }
  return normalizeWindows(windows);
}

export function describeAvailability(e: WaitlistEntry): string {
  return describeWindows(e.availability.weekly);
}

export interface EntryFormValues {
  patient: Omit<PatientRecord, 'id' | 'createdAt'>;
  entry: Omit<WaitlistEntry, 'id' | 'patientId' | 'status' | 'addedAt' | 'declines'>;
}

function opt(value: string, label: string, selected: boolean): SafeHtml {
  return html`<option value="${value}" ${selected ? 'selected' : ''}>${label}</option>`;
}

/** Shared waitlist form for staff and the public request page. */
export function entryFormFields(
  practice: PracticeSettings,
  mode: 'staff' | 'patient',
  patient?: Partial<PatientRecord>,
  entry?: Partial<WaitlistEntry>,
): SafeHtml {
  const types = practice.appointmentTypes.filter((t) => mode === 'staff' || t.patientSelectable);
  const providers = practice.providers.filter((p) => p.active);
  const tz = practice.timeZone;
  const cur = entry?.currentAppointment;
  const curLocal = cur ? toLocal(cur.start, tz) : undefined;
  const curTime = curLocal ? `${String(Math.floor(curLocal.minutes / 60)).padStart(2, '0')}:${String(curLocal.minutes % 60).padStart(2, '0')}` : '';
  const modalities = entry?.modalities ?? ['in_person', 'telehealth'];
  const mode_ = entry?.bookingMode ?? (practice.allowPatientAutoBook ? 'auto' : 'confirm');
  const blackout = entry?.availability?.blackoutDates?.[0];
  return html`
  <fieldset>
    <legend>${mode === 'patient' ? 'About you' : 'Patient'}</legend>
    <div class="row">
      <label>First name<input name="firstName" required maxlength="80" autocomplete="given-name" value="${patient?.firstName}"></label>
      <label>Last name<input name="lastName" required maxlength="80" autocomplete="family-name" value="${patient?.lastName}"></label>
      <label>Date of birth<input name="dob" type="date" ${mode === 'patient' ? 'required' : ''} autocomplete="bday" value="${patient?.dob}"></label>
    </div>
    <div class="row">
      <label>Mobile phone<input name="phone" type="tel" maxlength="30" autocomplete="tel" value="${patient?.phone}"></label>
      <label>Email<input name="email" type="email" maxlength="200" autocomplete="email" value="${patient?.email}"></label>
      <label>Contact me by<select name="preferredChannel">
        ${opt('sms', 'Text message', (patient?.preferredChannel ?? 'sms') === 'sms')}
        ${opt('email', 'Email', patient?.preferredChannel === 'email')}
        ${opt('both', 'Text and email', patient?.preferredChannel === 'both')}
      </select></label>
    </div>
    <label class="check"><input type="checkbox" name="smsConsent" value="1" ${patient?.smsConsent ?? mode === 'staff' ? 'checked' : ''}>
      ${mode === 'patient' ? 'I agree to receive text messages about appointment openings. Msg & data rates may apply. Reply STOP to opt out.' : 'Patient consented to text messages'}</label>
    ${
      mode === 'staff'
        ? html`<div class="row">
            <label>EHR patient ID / MRN<input name="externalRef" maxlength="100" value="${patient?.externalRef}"></label>
            <label class="grow">Staff note <small>(no clinical detail — keep that in the EHR)</small><input name="note" maxlength="200" value="${patient?.note}"></label>
          </div>`
        : ''
    }
  </fieldset>

  <fieldset>
    <legend>Visit</legend>
    <div class="row">
      <label>Visit type<select name="appointmentType" required>
        ${types.map((t) => opt(t.id, `${t.name} (${t.durationMinutes} min)`, entry?.appointmentType === t.id))}
      </select></label>
      <div class="field"><span class="label">How</span>
        <label class="check"><input type="checkbox" name="modality" value="in_person" ${modalities.includes('in_person') ? 'checked' : ''}> In person</label>
        <label class="check"><input type="checkbox" name="modality" value="telehealth" ${modalities.includes('telehealth') ? 'checked' : ''}> Telehealth</label>
      </div>
    </div>
    ${
      providers.length > 1
        ? html`<div class="field"><span class="label">Which ${mode === 'patient' ? 'clinicians would you see' : 'providers'}? <small>(none checked = any)</small></span>
            <div class="checks">${providers.map(
              (p) => html`<label class="check"><input type="checkbox" name="providerId" value="${p.id}" ${entry?.providerIds?.includes(p.id) ? 'checked' : ''}> ${p.name}</label>`,
            )}</div></div>`
        : ''
    }
    ${
      practice.locations.length > 1
        ? html`<div class="field"><span class="label">In-person locations <small>(none checked = any)</small></span>
            <div class="checks">${practice.locations.map(
              (l) => html`<label class="check"><input type="checkbox" name="locationId" value="${l.id}" ${entry?.locationIds?.includes(l.id) ? 'checked' : ''}> ${l.name}</label>`,
            )}</div></div>`
        : ''
    }
  </fieldset>

  <fieldset>
    <legend>${mode === 'patient' ? 'When can you come in?' : 'Availability'}</legend>
    <p class="hint">Check every time you could make on short notice. More times = sooner match.</p>
    ${availabilityGrid(practice, entry?.availability?.weekly ?? [])}
    <div class="row">
      <label>Notice needed<select name="minNotice">
        ${NOTICE_OPTIONS.map(([m, l]) => opt(String(m), l, (entry?.availability?.minNoticeMinutes ?? 180) === m))}
      </select></label>
      <label>Not before<input type="date" name="earliestDate" value="${entry?.availability?.earliestDate}"></label>
      <label>Away from<input type="date" name="awayFrom" value="${blackout?.start}"></label>
      <label>Away until<input type="date" name="awayUntil" value="${blackout?.end}"></label>
    </div>
  </fieldset>

  <fieldset>
    <legend>${mode === 'patient' ? 'Already have an appointment?' : 'Current appointment (to move earlier)'}</legend>
    <div class="row">
      <label>Date<input type="date" name="currentDate" value="${curLocal?.date}"></label>
      <label>Time<input type="time" name="currentTime" value="${curTime}"></label>
      ${
        mode === 'staff'
          ? html`<label>Provider<select name="currentProvider">${opt('', '—', !cur)}${providers.map((p) => opt(p.id, p.name, cur?.providerId === p.id))}</select></label>
                 <label>EHR appointment ID<input name="currentExternalId" maxlength="100" value="${cur?.externalId}"></label>`
          : ''
      }
    </div>
    ${mode === 'patient' ? html`<p class="hint">Leave blank if you don't have one yet. We'll only offer times earlier than it, and release it when we move you up.</p>` : ''}
  </fieldset>

  <fieldset>
    <legend>${mode === 'patient' ? 'When a time opens up…' : 'Booking mode'}</legend>
    ${
      practice.allowPatientAutoBook
        ? html`<label class="radio"><input type="radio" name="bookingMode" value="auto" ${mode_ === 'auto' ? 'checked' : ''}>
            <span><strong>Book me automatically</strong> into any matching time and text me the details (fastest)</span></label>`
        : ''
    }
    <label class="radio"><input type="radio" name="bookingMode" value="confirm" ${mode_ === 'confirm' ? 'checked' : ''}>
      <span><strong>Ask me first</strong>: text me and hold the time for ${practice.engine.offers.holdMinutes} minutes so I can accept</span></label>
  </fieldset>`;
}

/** Staff-only ranking controls. */
export function rankingFields(practice: PracticeSettings, entry?: Partial<WaitlistEntry>): SafeHtml {
  const acuity = entry?.acuity ?? practice.defaultAcuity;
  return html`<fieldset>
    <legend>Clinical priority</legend>
    <div class="row">
      <label>Acuity<select name="acuity">${([1, 2, 3, 4, 5] as Acuity[]).map((a) => opt(String(a), ACUITY_LABEL[a], acuity === a))}</select></label>
      <label>Provider adjustment <small>(± points)</small><input type="number" name="boost" min="-200" max="200" step="1" value="${entry?.boost ?? 0}"></label>
      <label class="check"><input type="checkbox" name="pinned" value="1" ${entry?.pinned ? 'checked' : ''}> Pin to top</label>
    </div>
  </fieldset>`;
}

export function parseEntryForm(
  form: URLSearchParams,
  practice: PracticeSettings,
  mode: 'staff' | 'patient',
): { values?: EntryFormValues; draft: EntryFormValues; errors: string[] } {
  const errors: string[] = [];
  const s = (k: string) => (form.get(k) ?? '').trim();
  const firstName = s('firstName');
  const lastName = s('lastName');
  if (!firstName || !lastName) errors.push('First and last name are required.');
  const dob = s('dob');
  if (dob && !/^\d{4}-\d{2}-\d{2}$/.test(dob)) errors.push('Date of birth is invalid.');
  if (mode === 'patient' && !dob) errors.push('Date of birth is required so the office can find your chart.');
  const phoneRaw = s('phone');
  const phone = phoneRaw ? normalizePhone(phoneRaw) : undefined;
  if (phoneRaw && !phone) errors.push('Phone number looks invalid.');
  const email = s('email').toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Email looks invalid.');
  if (!phone && !email) errors.push('Give a mobile number or an email so we can reach you.');
  const preferredChannel = (['sms', 'email', 'both'].includes(s('preferredChannel')) ? s('preferredChannel') : 'sms') as PatientRecord['preferredChannel'];
  const smsConsent = form.get('smsConsent') === '1';
  if (mode === 'patient' && phone && preferredChannel !== 'email' && !smsConsent) {
    errors.push('Please agree to text messages, or choose email as your contact method.');
  }

  const type = practice.appointmentTypes.find((t) => t.id === s('appointmentType') && (mode === 'staff' || t.patientSelectable));
  if (!type) errors.push('Choose a visit type.');
  const chosen = form.getAll('modality').filter((m): m is Modality => m === 'in_person' || m === 'telehealth');
  const modalities = type ? chosen.filter((m) => type.modalities.includes(m)) : chosen;
  if (!chosen.length) errors.push('Choose in person, telehealth, or both.');
  else if (type && !modalities.length) errors.push(`${type.name} visits are not offered that way.`);
  const providerIds = form.getAll('providerId').filter((id) => practice.providers.some((p) => p.id === id));
  const locationIds = form.getAll('locationId').filter((id) => practice.locations.some((l) => l.id === id));
  const weekly = windowsFromForm(practice, form.getAll('slot'));
  if (!weekly.length) errors.push('Check at least one day/time you are available.');
  const minNotice = Number(s('minNotice'));
  const minNoticeMinutes = NOTICE_OPTIONS.some(([m]) => m === minNotice) ? minNotice : 180;
  const earliestDate = /^\d{4}-\d{2}-\d{2}$/.test(s('earliestDate')) ? s('earliestDate') : undefined;
  const awayFrom = s('awayFrom');
  const awayUntil = s('awayUntil') || awayFrom;
  const blackoutDates =
    /^\d{4}-\d{2}-\d{2}$/.test(awayFrom) && /^\d{4}-\d{2}-\d{2}$/.test(awayUntil) && awayFrom <= awayUntil ? [{ start: awayFrom, end: awayUntil }] : undefined;

  let currentAppointment: CurrentAppointment | undefined;
  const cd = s('currentDate');
  const ct = s('currentTime');
  if (cd || ct) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cd) || !/^\d{2}:\d{2}$/.test(ct)) {
      errors.push('Current appointment needs both a date and a time.');
    } else if (type) {
      const start = localToInstant(cd, ct, practice.timeZone);
      if (start.getTime() < Date.now()) errors.push('Current appointment is in the past.');
      const providerId = (mode === 'staff' && s('currentProvider')) || providerIds[0] || practice.providers.find((p) => p.active)?.id || '';
      currentAppointment = {
        start: start.toISOString(),
        end: new Date(start.getTime() + type.durationMinutes * 60000).toISOString(),
        providerId,
        modality: modalities[0] ?? 'in_person',
        locationId: practice.providers.find((p) => p.id === providerId)?.locationId,
        appointmentType: type.id,
        externalId: mode === 'staff' ? s('currentExternalId') || undefined : undefined,
      };
    }
  }
  const bookingMode: BookingMode = s('bookingMode') === 'auto' && practice.allowPatientAutoBook ? 'auto' : 'confirm';
  const acuityNum = Number(s('acuity'));
  const acuity = ([1, 2, 3, 4, 5].includes(acuityNum) ? acuityNum : practice.defaultAcuity) as Acuity;
  const boost = Math.max(-200, Math.min(200, Math.round(Number(s('boost')) || 0)));

  const patient: EntryFormValues['patient'] = {
    firstName,
    lastName,
    dob: dob || undefined,
    phone: phone ?? (phoneRaw || undefined),
    email: email || undefined,
    preferredChannel,
    smsConsent,
    externalRef: mode === 'staff' ? s('externalRef') || undefined : undefined,
    note: mode === 'staff' ? s('note') || undefined : undefined,
  };
  const entry: EntryFormValues['entry'] = {
    providerIds,
    appointmentType: type?.id ?? '',
    durationMinutes: type?.durationMinutes ?? 0,
    modalities: chosen,
    locationIds,
    availability: { timeZone: practice.timeZone, weekly, minNoticeMinutes, earliestDate, blackoutDates },
    bookingMode,
    currentAppointment,
    acuity: mode === 'staff' ? acuity : practice.defaultAcuity,
    boost: mode === 'staff' ? boost : 0,
    pinned: mode === 'staff' ? form.get('pinned') === '1' : false,
    expiresAt: new Date(Date.now() + practice.requestExpiryDays * 86400000).toISOString(),
  };
  const draft = { patient, entry };
  if (errors.length || !type) return { errors, draft };
  return { errors, draft, values: { patient: { ...patient, phone }, entry: { ...entry, modalities } } };
}

export function relativeTime(iso: string, now = new Date()): string {
  const diff = (Date.parse(iso) - now.getTime()) / 60000;
  const abs = Math.abs(diff);
  const fmt = abs < 1 ? 'now' : abs < 60 ? `${Math.round(abs)} min` : abs < 48 * 60 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} days`;
  if (fmt === 'now') return 'just now';
  return diff > 0 ? `in ${fmt}` : `${fmt} ago`;
}

export function shortDateTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}
