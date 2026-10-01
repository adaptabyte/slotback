import { DEFAULT_SETTINGS, isValidTimeZone } from '../core/index.ts';
import type { Acuity, EngineSettings, Modality } from '../core/index.ts';

export interface ProviderConfig {
  id: string;
  name: string;
  defaultModality: Modality;
  locationId?: string;
  active: boolean;
  /** Secret iCal/ICS subscription URL of the provider's calendar (cancellation detection). */
  icalUrl?: string;
  /** Regex: calendar events whose title matches are ignored (e.g. "Lunch|Admin|Block"). */
  icalIgnore?: string;
  fhirScheduleId?: string;
  fhirPractitionerId?: string;
  /** Provider id as it appears in HL7 v2 AIP-3 / SCH segments. */
  hl7Id?: string;
}

export interface LocationConfig {
  id: string;
  name: string;
  fhirLocationId?: string;
}

export interface AppointmentTypeConfig {
  id: string;
  name: string;
  durationMinutes: number;
  modalities: Modality[];
  /** Shown on the public waitlist form. */
  patientSelectable: boolean;
}

export interface TimeBlock {
  id: string;
  label: string;
  start: string;
  end: string;
}

export interface PracticeSettings {
  name: string;
  /** Name used in texts/emails. Psychiatric practices often prefer something neutral. */
  messageName: string;
  phone: string;
  timeZone: string;
  /** `minimal` texts never include visit details – only a secure link. */
  privacyMode: 'standard' | 'minimal';
  autoApproveRequests: boolean;
  allowPatientAutoBook: boolean;
  defaultAcuity: Acuity;
  requestExpiryDays: number;
  weekdays: number[];
  timeBlocks: TimeBlock[];
  providers: ProviderConfig[];
  locations: LocationConfig[];
  appointmentTypes: AppointmentTypeConfig[];
  engine: EngineSettings;
}

export const DEFAULT_PRACTICE: PracticeSettings = {
  name: 'Your Practice',
  messageName: 'Your Practice',
  phone: '',
  timeZone: 'America/New_York',
  privacyMode: 'standard',
  autoApproveRequests: false,
  allowPatientAutoBook: true,
  defaultAcuity: 3,
  requestExpiryDays: 90,
  weekdays: [1, 2, 3, 4, 5],
  timeBlocks: [
    { id: 'morning', label: 'Morning (8–12)', start: '08:00', end: '12:00' },
    { id: 'afternoon', label: 'Afternoon (12–5)', start: '12:00', end: '17:00' },
    { id: 'evening', label: 'Evening (5–8)', start: '17:00', end: '20:00' },
  ],
  providers: [],
  locations: [],
  appointmentTypes: [
    { id: 'new_patient', name: 'New patient evaluation', durationMinutes: 60, modalities: ['in_person', 'telehealth'], patientSelectable: true },
    { id: 'follow_up', name: 'Follow-up / medication management', durationMinutes: 30, modalities: ['in_person', 'telehealth'], patientSelectable: true },
  ],
  engine: DEFAULT_SETTINGS,
};

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HHMM = /^([01]\d|2[0-4]):[0-5]\d$/;

/** Validates a full settings object; returns human-readable problems (empty = valid). */
export function validatePractice(p: PracticeSettings): string[] {
  const errors: string[] = [];
  if (!p.name?.trim()) errors.push('Practice name is required.');
  if (!p.messageName?.trim()) errors.push('Message name is required.');
  if (!isValidTimeZone(p.timeZone)) errors.push(`Unknown time zone "${p.timeZone}".`);
  if (![1, 2, 3, 4, 5].includes(p.defaultAcuity)) errors.push('Default acuity must be 1–5.');
  if (!Array.isArray(p.weekdays) || p.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    errors.push('Weekdays must be numbers 0 (Sun) – 6 (Sat).');
  }
  const unique = (label: string, ids: string[]) => {
    for (const id of ids) if (!ID.test(id)) errors.push(`${label} id "${id}" must be lowercase letters, digits, _ or -.`);
    if (new Set(ids).size !== ids.length) errors.push(`${label} ids must be unique.`);
  };
  unique('Provider', p.providers.map((x) => x.id));
  unique('Location', p.locations.map((x) => x.id));
  unique('Appointment type', p.appointmentTypes.map((x) => x.id));
  unique('Time block', p.timeBlocks.map((x) => x.id));
  for (const prov of p.providers) {
    if (!prov.name?.trim()) errors.push(`Provider ${prov.id} needs a name.`);
    if (!['in_person', 'telehealth'].includes(prov.defaultModality)) errors.push(`Provider ${prov.id}: invalid defaultModality.`);
    if (prov.locationId && !p.locations.some((l) => l.id === prov.locationId)) {
      errors.push(`Provider ${prov.id}: unknown location "${prov.locationId}".`);
    }
    if (prov.icalUrl && !/^https:\/\//.test(prov.icalUrl)) errors.push(`Provider ${prov.id}: iCal URL must start with https://`);
    if (prov.icalIgnore) {
      try {
        new RegExp(prov.icalIgnore, 'i');
      } catch {
        errors.push(`Provider ${prov.id}: icalIgnore is not a valid regular expression.`);
      }
    }
  }
  for (const t of p.appointmentTypes) {
    if (!Number.isInteger(t.durationMinutes) || t.durationMinutes < 5 || t.durationMinutes > 480) {
      errors.push(`Appointment type ${t.id}: duration must be 5–480 minutes.`);
    }
    if (!t.modalities?.length) errors.push(`Appointment type ${t.id}: pick at least one modality.`);
  }
  for (const b of p.timeBlocks) {
    if (!HHMM.test(b.start) || !HHMM.test(b.end) || b.start >= b.end) errors.push(`Time block ${b.id}: invalid times.`);
  }
  const pr = p.engine.priority;
  const of = p.engine.offers;
  const nums: [string, number, number, number][] = [
    ['Acuity points', pr.acuityPoints, 0, 1000],
    ['Wait points per day', pr.waitPointsPerDay, 0, 100],
    ['Max wait points', pr.waitPointsMax, 0, 1000],
    ['No-appointment bonus', pr.unscheduledPoints, 0, 1000],
    ['Time-saved points per day', pr.timeSavedPointsPerDay, 0, 100],
    ['Max time-saved points', pr.timeSavedPointsMax, 0, 1000],
    ['Decline penalty', pr.declinePenalty, 0, 1000],
    ['Offer hold (minutes)', of.holdMinutes, 5, 24 * 60],
    ['Minimum lead time (minutes)', of.minLeadMinutes, 0, 7 * 24 * 60],
    ['Parallel window (hours)', of.parallelWithinHours, 0, 14 * 24],
    ['Parallel offers', of.parallelCount, 1, 20],
    ['Minimum improvement (hours)', of.minImprovementHours, 0, 90 * 24],
  ];
  const q = of.quietHours;
  if (q && (!HHMM.test(q.start) || !HHMM.test(q.end))) errors.push('Quiet hours must be HH:MM times.');
  for (const [label, v, min, max] of nums) {
    if (typeof v !== 'number' || Number.isNaN(v) || v < min || v > max) errors.push(`${label} must be between ${min} and ${max}.`);
  }
  return errors;
}

/** Fills in fields added in newer versions so old stored settings keep working. */
export function withDefaults(stored: Partial<PracticeSettings> | undefined): PracticeSettings {
  const s = { ...DEFAULT_PRACTICE, ...(stored ?? {}) };
  s.engine = {
    ...DEFAULT_SETTINGS,
    ...(stored?.engine ?? {}),
    priority: { ...DEFAULT_SETTINGS.priority, ...(stored?.engine?.priority ?? {}) },
    offers: { ...DEFAULT_SETTINGS.offers, ...(stored?.engine?.offers ?? {}) },
  };
  return s;
}

export function providerName(p: PracticeSettings, id: string): string {
  return p.providers.find((x) => x.id === id)?.name ?? id;
}

export function locationName(p: PracticeSettings, id: string | undefined): string {
  if (!id) return '';
  return p.locations.find((x) => x.id === id)?.name ?? id;
}

export function typeName(p: PracticeSettings, id: string): string {
  return p.appointmentTypes.find((x) => x.id === id)?.name ?? id;
}
