import { DEFAULT_SETTINGS, Engine, MemoryStore, localToInstant } from '../../src/core/index.ts';
import type { EngineSettings, NewOpening, WaitlistEntry } from '../../src/core/index.ts';

export const TZ = 'America/New_York';
/** Monday 2026-10-05 08:00 New York. */
export const NOW = localToInstant('2026-10-05', '08:00', TZ);

export function at(date: string, time: string): string {
  return localToInstant(date, time, TZ).toISOString();
}

let seq = 0;
export function entry(overrides: Partial<WaitlistEntry> = {}): WaitlistEntry {
  seq += 1;
  return {
    id: overrides.id ?? `ent_${seq}`,
    patientId: overrides.patientId ?? `pat_${seq}`,
    status: 'active',
    providerIds: [],
    appointmentType: 'follow_up',
    durationMinutes: 30,
    modalities: ['in_person', 'telehealth'],
    locationIds: [],
    availability: {
      timeZone: TZ,
      weekly: [1, 2, 3, 4, 5].map((day) => ({ day: day as 1, start: '08:00', end: '18:00' })),
      minNoticeMinutes: 60,
    },
    bookingMode: 'confirm',
    acuity: 3,
    boost: 0,
    pinned: false,
    addedAt: new Date(NOW.getTime() - 10 * 86400000).toISOString(),
    declines: 0,
    ...overrides,
  };
}

export function opening(overrides: Partial<NewOpening> = {}): NewOpening {
  return {
    providerId: 'dr_lee',
    modality: 'in_person',
    start: at('2026-10-08', '10:00'),
    end: at('2026-10-08', '10:30'),
    source: 'manual',
    ...overrides,
  };
}

export function setup(settings: Partial<EngineSettings> = {}) {
  const store = new MemoryStore();
  let n = 0;
  const engine = new Engine({
    store,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    newId: (p) => `${p}_${++n}`,
  });
  return { store, engine };
}

export function minutesAfter(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60000);
}
