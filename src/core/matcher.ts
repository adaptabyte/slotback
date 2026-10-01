import type { Candidate, EngineSettings, Ineligibility, Opening, WaitlistEntry } from './types.ts';
import { beforeEarliestDate, fitsWeeklyWindow, inBlackout } from './availability.ts';
import { rank } from './priority.ts';
import { formatSlot, minutesBetween } from './time.ts';

const MODALITY_LABEL = { in_person: 'in-person', telehealth: 'telehealth' } as const;

/**
 * Returns every reason `entry` cannot take `opening` (empty array = eligible).
 * Reasons are human readable so staff can see exactly why a patient was skipped.
 */
export function checkEligibility(
  entry: WaitlistEntry,
  opening: Opening,
  now: Date,
  settings: EngineSettings,
): Ineligibility[] {
  const reasons: Ineligibility[] = [];
  const start = new Date(opening.start);
  const visitEnd = new Date(start.getTime() + entry.durationMinutes * 60000);
  const tz = entry.availability.timeZone;

  if (entry.status !== 'active') {
    reasons.push({ code: 'status', message: `Waitlist status is "${entry.status.replace('_', ' ')}"` });
  }
  if (entry.expiresAt && entry.expiresAt <= now.toISOString()) {
    reasons.push({ code: 'expired', message: 'Waitlist request has expired' });
  }
  if (entry.providerIds.length && !entry.providerIds.includes(opening.providerId)) {
    reasons.push({ code: 'provider', message: 'Prefers a different provider' });
  }
  if (opening.appointmentTypes.length && !opening.appointmentTypes.includes(entry.appointmentType)) {
    reasons.push({ code: 'type', message: `Slot does not allow "${entry.appointmentType}" visits` });
  }
  const slotMinutes = minutesBetween(opening.start, opening.end);
  if (slotMinutes < entry.durationMinutes) {
    reasons.push({ code: 'duration', message: `Needs ${entry.durationMinutes} min; slot is ${slotMinutes} min` });
  }
  if (!entry.modalities.includes(opening.modality)) {
    reasons.push({ code: 'modality', message: `Does not want ${MODALITY_LABEL[opening.modality]} visits` });
  }
  if (
    opening.modality === 'in_person' &&
    entry.locationIds.length &&
    (!opening.locationId || !entry.locationIds.includes(opening.locationId))
  ) {
    reasons.push({ code: 'location', message: 'Prefers a different location' });
  }
  const leadMinutes = minutesBetween(now, start);
  if (leadMinutes < entry.availability.minNoticeMinutes) {
    reasons.push({ code: 'notice', message: `Needs ${formatNotice(entry.availability.minNoticeMinutes)} notice` });
  }
  if (beforeEarliestDate(entry.availability, start)) {
    reasons.push({ code: 'earliest', message: `Not available before ${entry.availability.earliestDate}` });
  }
  if (inBlackout(entry.availability, start)) {
    reasons.push({ code: 'blackout', message: 'Unavailable on that date' });
  }
  if (!fitsWeeklyWindow(entry.availability, start, visitEnd)) {
    reasons.push({ code: 'window', message: `Not available ${formatSlot(start, tz)}` });
  }
  if (entry.currentAppointment) {
    const savedHours = minutesBetween(start, entry.currentAppointment.start) / 60;
    if (savedHours <= 0) {
      reasons.push({ code: 'not_earlier', message: 'Already booked earlier than this slot' });
    } else if (savedHours < settings.offers.minImprovementHours) {
      reasons.push({ code: 'not_much_earlier', message: 'Slot is not meaningfully earlier than current appointment' });
    }
  }
  return reasons;
}

function formatNotice(minutes: number): string {
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} day${minutes === 24 * 60 ? '' : 's'}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'}`;
  return `${minutes} min`;
}

/** Eligible entries for `opening`, best first. */
export function rankCandidates(
  entries: WaitlistEntry[],
  opening: Opening,
  now: Date,
  settings: EngineSettings,
): Candidate[] {
  const eligible = entries.filter((e) => checkEligibility(e, opening, now, settings).length === 0);
  return rank(eligible, settings.priority, now, opening);
}

export interface OpeningExplanation {
  eligible: Candidate[];
  ineligible: { entry: WaitlistEntry; reasons: Ineligibility[] }[];
}

/** Full breakdown for staff: who is eligible (ranked) and why everyone else is not. */
export function explainOpening(
  entries: WaitlistEntry[],
  opening: Opening,
  now: Date,
  settings: EngineSettings,
): OpeningExplanation {
  const eligible: WaitlistEntry[] = [];
  const ineligible: OpeningExplanation['ineligible'] = [];
  for (const entry of entries) {
    const reasons = checkEligibility(entry, opening, now, settings);
    if (reasons.length) ineligible.push({ entry, reasons });
    else eligible.push(entry);
  }
  return { eligible: rank(eligible, settings.priority, now, opening), ineligible };
}
