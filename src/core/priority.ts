import type { Candidate, Opening, PriorityPolicy, Score, ScorePart, WaitlistEntry } from './types.ts';
import { minutesBetween } from './time.ts';

const DAY = 24 * 60;

/**
 * Explainable priority score. Every point is attributed to a labelled reason so
 * staff can always answer "why did this patient get the slot?".
 *
 * When `opening` is given, the score also credits how much sooner this
 * particular opening would see a patient who already has an appointment.
 */
export function scoreEntry(entry: WaitlistEntry, policy: PriorityPolicy, now: Date, opening?: Opening): Score {
  const parts: ScorePart[] = [];

  if (entry.acuity > 1) {
    parts.push({ label: `Clinical acuity ${entry.acuity}/5`, points: (entry.acuity - 1) * policy.acuityPoints });
  }

  const daysWaiting = Math.max(0, Math.floor(minutesBetween(entry.addedAt, now) / DAY));
  const waitPoints = Math.min(daysWaiting * policy.waitPointsPerDay, policy.waitPointsMax);
  if (waitPoints > 0) parts.push({ label: `Waiting ${daysWaiting} day${daysWaiting === 1 ? '' : 's'}`, points: waitPoints });

  if (!entry.currentAppointment) {
    if (policy.unscheduledPoints) parts.push({ label: 'No appointment yet', points: policy.unscheduledPoints });
  } else if (opening) {
    const daysSooner = Math.floor(minutesBetween(opening.start, entry.currentAppointment.start) / DAY);
    const saved = Math.min(Math.max(0, daysSooner) * policy.timeSavedPointsPerDay, policy.timeSavedPointsMax);
    if (saved > 0) parts.push({ label: `Seen ${daysSooner} day${daysSooner === 1 ? '' : 's'} sooner`, points: saved });
  }

  if (entry.boost) parts.push({ label: 'Provider adjustment', points: entry.boost });

  if (entry.declines > 0 && policy.declinePenalty) {
    parts.push({
      label: `Passed on ${entry.declines} earlier offer${entry.declines === 1 ? '' : 's'}`,
      points: -entry.declines * policy.declinePenalty,
    });
  }

  const total = Math.round(parts.reduce((sum, p) => sum + p.points, 0) * 10) / 10;
  return { total, parts: parts.map((p) => ({ ...p, points: Math.round(p.points * 10) / 10 })) };
}

/** Pinned first, then score, then longest waiting, then id (fully deterministic). */
export function compareCandidates(a: Omit<Candidate, 'rank'>, b: Omit<Candidate, 'rank'>): number {
  if (a.entry.pinned !== b.entry.pinned) return a.entry.pinned ? -1 : 1;
  if (b.score.total !== a.score.total) return b.score.total - a.score.total;
  if (a.entry.addedAt !== b.entry.addedAt) return a.entry.addedAt < b.entry.addedAt ? -1 : 1;
  return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
}

export function rank(entries: WaitlistEntry[], policy: PriorityPolicy, now: Date, opening?: Opening): Candidate[] {
  return entries
    .map((entry) => ({ entry, score: scoreEntry(entry, policy, now, opening) }))
    .sort(compareCandidates)
    .map((c, i) => ({ ...c, rank: i + 1 }));
}
