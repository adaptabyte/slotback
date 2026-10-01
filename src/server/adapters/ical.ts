import { localToInstant } from '../../core/index.ts';

/**
 * Minimal RFC 5545 reader for cancellation detection.
 *
 * We only need each event's identity and time span. Titles are read in memory
 * to apply the provider's ignore-pattern and are never stored.
 */
export interface IcsEvent {
  key: string;
  start: Date;
  end: Date;
  cancelled: boolean;
  allDay: boolean;
  recurring: boolean;
  summary: string;
}

/** Common Windows zone names emitted by Outlook/Exchange feeds. */
const WINDOWS_ZONES: Record<string, string> = {
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Atlantic Standard Time': 'America/Halifax',
  'GMT Standard Time': 'Europe/London',
  'UTC': 'UTC',
};

function unfold(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

function parseLine(line: string): Prop | undefined {
  // NAME;PARAM=VAL;PARAM="V:AL":VALUE  – the first colon outside quotes ends the params.
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ':' && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return undefined;
  const [name, ...rawParams] = line.slice(0, colon).split(';');
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

function parseDate(prop: Prop, fallbackZone: string): { date: Date; allDay: boolean } | undefined {
  const v = prop.value.trim();
  if (prop.params.VALUE === 'DATE' || /^\d{8}$/.test(v)) {
    const date = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
    return { date: localToInstant(date, '00:00', fallbackZone), allDay: true };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s, z] = m;
  if (z) return { date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s ?? 0))), allDay: false };
  const tzid = prop.params.TZID;
  const zone = tzid ? (WINDOWS_ZONES[tzid] ?? tzid) : fallbackZone;
  try {
    return { date: localToInstant(`${y}-${mo}-${d}`, `${h}:${mi}`, zone), allDay: false };
  } catch {
    return { date: localToInstant(`${y}-${mo}-${d}`, `${h}:${mi}`, fallbackZone), allDay: false };
  }
}

function parseDuration(value: string): number | undefined {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m) return undefined;
  const [, w, d, h, mi, s] = m.map((x) => Number(x ?? 0));
  return (((w * 7 + d) * 24 + h) * 60 + mi) * 60000 + s * 1000;
}

export function parseIcs(text: string, fallbackZone: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  let cur: Prop[] | undefined;
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') cur = [];
    else if (line === 'END:VEVENT' && cur) {
      const get = (n: string) => cur!.find((p) => p.name === n);
      const uid = get('UID')?.value;
      const dtstart = get('DTSTART');
      const start = dtstart && parseDate(dtstart, fallbackZone);
      if (uid && start) {
        const dtend = get('DTEND');
        let end = dtend ? parseDate(dtend, fallbackZone)?.date : undefined;
        if (!end) {
          const dur = get('DURATION');
          const ms = dur ? parseDuration(dur.value) : undefined;
          end = new Date(start.date.getTime() + (ms ?? (start.allDay ? 86400000 : 0)));
        }
        const rid = get('RECURRENCE-ID')?.value;
        events.push({
          key: rid ? `${uid}#${rid}` : uid,
          start: start.date,
          end,
          cancelled: get('STATUS')?.value.trim().toUpperCase() === 'CANCELLED',
          allDay: start.allDay,
          recurring: Boolean(get('RRULE')),
          summary: (get('SUMMARY')?.value ?? '').replace(/\\([,;\\])/g, '$1').replace(/\\n/gi, ' '),
        });
      }
      cur = undefined;
    } else if (cur) {
      const p = parseLine(line);
      if (p) cur.push(p);
    }
  }
  return events;
}

/** What we remember between polls: event key → time span. No titles, no attendees. */
export type IcalSnapshot = Record<string, { start: string; end: string }>;

export interface IcalDiff {
  snapshot: IcalSnapshot;
  freed: { key: string; start: string; end: string }[];
  /** Set when the change looks like a feed glitch rather than real cancellations. */
  suspicious?: string;
}

/**
 * Compares the current feed with the last snapshot. An event that disappeared,
 * was marked CANCELLED, or moved frees its previous time span.
 */
export function diffIcal(
  previous: IcalSnapshot | undefined,
  events: IcsEvent[],
  now: Date,
  opts: { horizonDays: number; ignore?: string },
): IcalDiff {
  const ignore = opts.ignore ? new RegExp(opts.ignore, 'i') : undefined;
  const horizon = new Date(now.getTime() + opts.horizonDays * 86400000);
  const snapshot: IcalSnapshot = {};
  const cancelled = new Set<string>();
  for (const e of events) {
    if (e.allDay || e.recurring || e.end <= e.start) continue;
    if (e.start <= now || e.start > horizon) continue;
    if (ignore?.test(e.summary)) continue;
    if (e.cancelled) cancelled.add(e.key);
    else snapshot[e.key] = { start: e.start.toISOString(), end: e.end.toISOString() };
  }
  if (!previous) return { snapshot, freed: [] };

  const freed: IcalDiff['freed'] = [];
  const nowIso = now.toISOString();
  let considered = 0;
  for (const [key, span] of Object.entries(previous)) {
    if (span.start <= nowIso) continue;
    considered++;
    const current = snapshot[key];
    if (!current || cancelled.has(key) || current.start !== span.start) {
      freed.push({ key, ...span });
    }
  }
  // An empty or half-empty feed is far more likely an outage than a mass cancellation.
  if (considered >= 4 && freed.length / considered > 0.5) {
    return {
      snapshot: previous,
      freed: [],
      suspicious: `${freed.length} of ${considered} upcoming events vanished at once; ignoring this poll`,
    };
  }
  return { snapshot, freed };
}

export async function fetchIcs(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal, headers: { accept: 'text/calendar' } });
  if (!res.ok) throw new Error(`iCal feed returned HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('Response is not an iCalendar feed');
  return text;
}
