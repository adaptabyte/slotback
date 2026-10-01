import { addDays, localToInstant, toLocal } from '../core/index.ts';
import type { Acuity, BookingMode, Modality, TimeWindow, WaitlistEntry } from '../core/index.ts';
import { hashPassword } from './crypto.ts';
import type { App } from './runtime.ts';
import { DEFAULT_PRACTICE } from './practice.ts';
import type { PracticeSettings } from './practice.ts';

const TZ = 'America/New_York';

/** Development only: a realistic, fully synthetic behavioral-health practice. */
export function seedDemo(app: App): { username: string; password: string } | undefined {
  if (app.config.env === 'production') throw new Error('Refusing to seed demo data in production');
  if (app.db.countUsers() > 0) return undefined;

  const practice: PracticeSettings = {
    ...DEFAULT_PRACTICE,
    name: 'Riverbend Behavioral Health (Demo)',
    messageName: 'Riverbend Health',
    phone: '(555) 010-2000',
    timeZone: TZ,
    privacyMode: 'standard',
    // Quiet hours off so the demo responds at any time of day.
    engine: { ...DEFAULT_PRACTICE.engine, offers: { ...DEFAULT_PRACTICE.engine.offers, quietHours: undefined } },
    providers: [
      { id: 'dr_lee', name: 'Dr. Maya Lee, MD', defaultModality: 'in_person', locationId: 'main', active: true },
      { id: 'np_ortiz', name: 'Jordan Ortiz, PMHNP', defaultModality: 'telehealth', active: true },
      { id: 'dr_chen', name: 'Dr. Sam Chen, PsyD', defaultModality: 'in_person', locationId: 'main', active: true },
    ],
    locations: [{ id: 'main', name: 'Riverbend — 120 Main St' }],
    appointmentTypes: [
      { id: 'new_eval', name: 'New patient psychiatric evaluation', durationMinutes: 60, modalities: ['in_person', 'telehealth'], patientSelectable: true },
      { id: 'med_mgmt', name: 'Medication management follow-up', durationMinutes: 30, modalities: ['in_person', 'telehealth'], patientSelectable: true },
      { id: 'therapy', name: 'Psychotherapy session', durationMinutes: 50, modalities: ['in_person', 'telehealth'], patientSelectable: true },
    ],
  };
  app.savePractice(practice, { type: 'system', id: 'seed' });

  const username = 'demo';
  const password = 'demo-password-2026';
  const user = app.db.createUser(username, 'Demo Front Desk', 'admin');
  user.passwordHash = hashPassword(password);
  app.db.updateUser(user);

  const today = toLocal(new Date(), TZ).date;
  const weekdays = (days: number[], start: string, end: string): TimeWindow[] => days.map((d) => ({ day: d as TimeWindow['day'], start, end }));
  const appt = (daysOut: number, time: string, providerId: string, minutes: number, modality: Modality) => {
    let date = addDays(today, daysOut);
    // land on a weekday
    while ([0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay())) date = addDays(date, 1);
    const start = localToInstant(date, time, TZ);
    return { start: start.toISOString(), end: new Date(start.getTime() + minutes * 60000).toISOString(), providerId, modality };
  };

  const people: {
    first: string;
    last: string;
    type: string;
    minutes: number;
    acuity: Acuity;
    mode: BookingMode;
    providers: string[];
    modalities: Modality[];
    windows: TimeWindow[];
    waitingDays: number;
    current?: ReturnType<typeof appt>;
    status?: WaitlistEntry['status'];
  }[] = [
    { first: 'Avery', last: 'Thompson', type: 'new_eval', minutes: 60, acuity: 5, mode: 'auto', providers: ['dr_lee'], modalities: ['in_person', 'telehealth'], windows: weekdays([1, 2, 3, 4, 5], '08:00', '17:00'), waitingDays: 6, current: appt(41, '09:00', 'dr_lee', 60, 'in_person') },
    { first: 'Jordan', last: 'Patel', type: 'med_mgmt', minutes: 30, acuity: 3, mode: 'confirm', providers: [], modalities: ['telehealth'], windows: weekdays([1, 3, 5], '12:00', '17:00'), waitingDays: 18, current: appt(23, '14:00', 'np_ortiz', 30, 'telehealth') },
    { first: 'Riley', last: 'Nguyen', type: 'new_eval', minutes: 60, acuity: 4, mode: 'confirm', providers: ['dr_lee', 'dr_chen'], modalities: ['in_person'], windows: weekdays([2, 4], '08:00', '12:00'), waitingDays: 25 },
    { first: 'Casey', last: 'Morgan', type: 'therapy', minutes: 50, acuity: 2, mode: 'auto', providers: ['dr_chen'], modalities: ['in_person', 'telehealth'], windows: weekdays([1, 2, 3, 4, 5], '12:00', '20:00'), waitingDays: 40, current: appt(30, '16:00', 'dr_chen', 50, 'in_person') },
    { first: 'Taylor', last: 'Brooks', type: 'med_mgmt', minutes: 30, acuity: 1, mode: 'confirm', providers: [], modalities: ['in_person', 'telehealth'], windows: weekdays([1, 2, 3, 4, 5], '08:00', '20:00'), waitingDays: 9, current: appt(16, '10:30', 'dr_lee', 30, 'in_person') },
    { first: 'Morgan', last: 'Reyes', type: 'new_eval', minutes: 60, acuity: 3, mode: 'auto', providers: [], modalities: ['telehealth'], windows: weekdays([1, 2, 3, 4, 5], '08:00', '12:00'), waitingDays: 33 },
    { first: 'Quinn', last: 'Foster', type: 'therapy', minutes: 50, acuity: 4, mode: 'confirm', providers: ['dr_chen'], modalities: ['in_person'], windows: weekdays([1, 3], '08:00', '17:00'), waitingDays: 12 },
    { first: 'Sam', last: 'Okafor', type: 'med_mgmt', minutes: 30, acuity: 3, mode: 'confirm', providers: ['np_ortiz'], modalities: ['telehealth'], windows: weekdays([2, 4], '17:00', '20:00'), waitingDays: 0, status: 'pending_review' },
  ];

  const now = new Date();
  people.forEach((p, i) => {
    const patient = app.db.insertPatient({
      firstName: p.first,
      lastName: p.last,
      dob: `19${70 + i * 3}-0${(i % 9) + 1}-1${i}`,
      phone: `+1555010${String(100 + i).padStart(4, '0')}`,
      email: `${p.first.toLowerCase()}.${p.last.toLowerCase()}@example.com`,
      preferredChannel: 'sms',
      smsConsent: true,
      externalRef: `MRN-${4100 + i}`,
    });
    const entry: WaitlistEntry = {
      id: app.newEntryId(),
      patientId: patient.id,
      status: p.status ?? 'active',
      providerIds: p.providers,
      appointmentType: p.type,
      durationMinutes: p.minutes,
      modalities: p.modalities,
      locationIds: [],
      availability: { timeZone: TZ, weekly: p.windows, minNoticeMinutes: 120 },
      bookingMode: p.mode,
      currentAppointment: p.current ? { ...p.current, appointmentType: p.type, locationId: p.current.modality === 'in_person' ? 'main' : undefined } : undefined,
      acuity: p.acuity,
      boost: 0,
      pinned: false,
      addedAt: new Date(now.getTime() - p.waitingDays * 86400000).toISOString(),
      declines: 0,
      expiresAt: new Date(now.getTime() + 90 * 86400000).toISOString(),
    };
    app.run({ type: 'system', id: 'seed' }, (e) => e.addEntry(entry, now), now);
  });
  return { username, password };
}
