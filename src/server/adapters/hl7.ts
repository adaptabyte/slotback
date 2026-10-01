import { localToInstant } from '../../core/index.ts';

/**
 * HL7 v2 SIU (scheduling) support. Most EHRs and interface engines (Mirth,
 * Rhapsody, Cloverleaf, Redox…) can forward SIU messages; a cancellation
 * (S15) or deletion (S17) becomes an opening, a new booking (S12) for a slot
 * we are trying to fill withdraws it.
 */
export interface Hl7Message {
  type: string;
  trigger: string;
  controlId: string;
  version: string;
  segments: string[][];
  separators: { field: string; component: string };
}

export function parseHl7(raw: string): Hl7Message {
  const text = raw.replace(/^\x0b/, '').replace(/\x1c\r?$/, '').trim();
  const lines = text.split(/\r\n|\r|\n/).filter(Boolean);
  if (!lines[0]?.startsWith('MSH')) throw new Error('Not an HL7 v2 message (missing MSH)');
  const field = lines[0][3];
  const component = lines[0][4] ?? '^';
  const segments = lines.map((l) => l.split(field));
  // MSH-1 is the separator itself, so MSH field n lives at index n-1.
  const msh = segments[0];
  const [type, trigger] = (msh[8] ?? '').split(component);
  return { type, trigger, controlId: msh[9] ?? '', version: msh[11] ?? '', segments, separators: { field, component } };
}

function seg(msg: Hl7Message, name: string): string[] | undefined {
  return msg.segments.find((s) => s[0] === name);
}

function comp(msg: Hl7Message, value: string | undefined, index: number): string {
  return (value ?? '').split(msg.separators.component)[index] ?? '';
}

/** HL7 DTM: YYYYMMDDHHMM[SS[.S]][+/-ZZZZ]. Without an offset the practice zone is assumed. */
export function parseHl7Time(value: string, zone: string): Date | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\.\d+)?([+-]\d{4})?$/.exec(value.trim());
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s, off] = m;
  if (off) {
    const sign = off[0] === '-' ? -1 : 1;
    const offMin = sign * (Number(off.slice(1, 3)) * 60 + Number(off.slice(3, 5)));
    return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s ?? 0)) - offMin * 60000);
  }
  return localToInstant(`${y}-${mo}-${d}`, `${h}:${mi}`, zone);
}

export interface SiuEvent {
  kind: 'freed' | 'booked' | 'other';
  trigger: string;
  appointmentId?: string;
  providerHl7Id?: string;
  start?: Date;
  end?: Date;
}

export function interpretSiu(msg: Hl7Message, zone: string): SiuEvent {
  if (msg.type !== 'SIU') return { kind: 'other', trigger: msg.trigger };
  const sch = seg(msg, 'SCH');
  const ais = seg(msg, 'AIS');
  const aip = seg(msg, 'AIP');
  // SCH-2 filler appointment id, falling back to SCH-1 placer id.
  const appointmentId = comp(msg, sch?.[2], 0) || comp(msg, sch?.[1], 0) || undefined;
  // Start: AIS-4, else SCH-11.4 (TQ). End: SCH-11.5, else start + AIS-7/SCH-9 duration (minutes).
  const startRaw = comp(msg, ais?.[4], 0) || comp(msg, sch?.[11], 3);
  const endRaw = comp(msg, sch?.[11], 4);
  const start = startRaw ? parseHl7Time(startRaw, zone) : undefined;
  let end = endRaw ? parseHl7Time(endRaw, zone) : undefined;
  if (start && !end) {
    const dur = Number(comp(msg, ais?.[7], 0) || comp(msg, sch?.[9], 0));
    if (dur > 0) end = new Date(start.getTime() + dur * 60000);
  }
  const providerHl7Id = comp(msg, aip?.[3], 0) || undefined;
  const kind = ['S15', 'S17'].includes(msg.trigger) ? 'freed' : msg.trigger === 'S12' ? 'booked' : 'other';
  return { kind, trigger: msg.trigger, appointmentId, providerHl7Id, start, end };
}

export function hl7Ack(msg: Hl7Message, code: 'AA' | 'AE' | 'AR', text = ''): string {
  const f = msg.separators.field;
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const msh = ['MSH', '^~\\&', 'SLOTBACK', '', '', '', ts, '', `ACK^${msg.trigger}`, `ACK${msg.controlId}`, 'P', msg.version || '2.5'];
  return [msh.join(f), ['MSA', code, msg.controlId, text].join(f)].join('\r') + '\r';
}
