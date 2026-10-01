import type { NotificationKind } from '../../core/index.ts';
import type { Config } from '../config.ts';
import { signPayload } from './booking.ts';

export interface OutgoingMessage {
  channel: 'sms' | 'email';
  to: string;
  subject: string;
  text: string;
}

export interface Channel {
  readonly name: string;
  send(msg: OutgoingMessage): Promise<{ id?: string }>;
}

/** Twilio Programmable Messaging (Twilio signs BAAs for HIPAA-eligible products). */
export class TwilioSms implements Channel {
  readonly name = 'twilio';
  private readonly cfg: NonNullable<Config['sms']['twilio']>;
  constructor(cfg: NonNullable<Config['sms']['twilio']>) {
    this.cfg = cfg;
  }
  async send(msg: OutgoingMessage) {
    const body = new URLSearchParams({ To: msg.to, Body: msg.text });
    if (this.cfg.messagingServiceSid) body.set('MessagingServiceSid', this.cfg.messagingServiceSid);
    else body.set('From', this.cfg.from!);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.cfg.accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: AbortSignal.timeout(15000),
    });
    const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
    if (!res.ok) throw new Error(`Twilio HTTP ${res.status}${json.code ? ` (code ${json.code})` : ''}`);
    return { id: json.sid };
  }
}

/** SMTP through the practice's own BAA-covered mail provider (Google Workspace, Microsoft 365, Paubox…). */
export class SmtpEmail implements Channel {
  readonly name = 'smtp';
  private readonly url: string;
  private readonly from: string;
  private transport?: { sendMail(o: Record<string, unknown>): Promise<{ messageId?: string }> };
  constructor(url: string, from: string) {
    this.url = url;
    this.from = from;
  }
  async send(msg: OutgoingMessage) {
    if (!this.transport) {
      const nodemailer = await import('nodemailer');
      // Refuse to send PHI over a connection that cannot be upgraded to TLS.
      const url = new URL(this.url);
      if (url.protocol === 'smtp:') url.searchParams.set('requireTLS', 'true');
      this.transport = nodemailer.createTransport(url.toString()) as unknown as typeof this.transport;
    }
    const info = await this.transport!.sendMail({ from: this.from, to: msg.to, subject: msg.subject, text: msg.text });
    return { id: info.messageId };
  }
}

/** Hands the message to the practice's own messaging platform. */
export class WebhookChannel implements Channel {
  readonly name = 'webhook';
  private readonly url: string;
  private readonly secret: string;
  constructor(url: string, secret: string) {
    this.url = url;
    this.secret = secret;
  }
  async send(msg: OutgoingMessage) {
    const body = JSON.stringify({ event: 'message.send', ...msg });
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-slotback-signature': signPayload(this.secret, body) },
      body,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Notification webhook returned HTTP ${res.status}`);
    return {};
  }
}

export interface DevMessage extends OutgoingMessage {
  at: string;
}

/** Development only: keeps messages in memory so the local demo can show a fake phone inbox. */
export class ConsoleChannel implements Channel {
  readonly name = 'console';
  readonly inbox: DevMessage[] = [];
  async send(msg: OutgoingMessage) {
    this.inbox.unshift({ ...msg, at: new Date().toISOString() });
    this.inbox.length = Math.min(this.inbox.length, 200);
    console.log(`[dev ${msg.channel} → ${msg.to}] ${msg.text}`);
    return {};
  }
}

// ---------------------------------------------------------------- templates

export interface MessageContext {
  kind: NotificationKind;
  privacyMode: 'standard' | 'minimal';
  practiceName: string;
  practicePhone: string;
  firstName: string;
  slot?: string;
  providerName?: string;
  modality?: string;
  expires?: string;
  previousSlot?: string;
  link?: string;
}

/** SMS-length copy. `minimal` mode never reveals visit details outside the secure link. */
export function renderMessage(c: MessageContext): { subject: string; text: string } {
  const who = c.practiceName;
  const call = c.practicePhone ? `please call ${c.practicePhone}` : 'please contact the office';
  const link = c.link ? ` ${c.link}` : '';
  if (c.privacyMode === 'minimal') {
    const subject = `${who}: appointment update`;
    switch (c.kind) {
      case 'offer':
        return { subject, text: `${who}: You have a time-sensitive appointment update. View it securely:${link}` };
      case 'offer_taken':
        return { subject, text: `${who}: The opening we sent you is no longer available. You're still on the waitlist.` };
      case 'booking_delayed':
        return { subject, text: `${who}: Thanks! We're finalizing your appointment and will confirm shortly.` };
      default:
        return { subject, text: `${who}: Your appointment has been updated. View it securely:${link}` };
    }
  }
  const details = `${c.slot}${c.providerName ? ` with ${c.providerName}` : ''}${c.modality ? ` (${c.modality})` : ''}`;
  switch (c.kind) {
    case 'offer':
      return {
        subject: `${who}: an earlier appointment is available`,
        text: `${who}: Hi ${c.firstName}, an earlier appointment opened up: ${details}. It's held for you until ${c.expires}. Accept or decline:${link}`,
      };
    case 'offer_taken':
      return {
        subject: `${who}: opening no longer available`,
        text: `${who}: Sorry, the ${c.slot} opening has been filled. You're still on the waitlist and we'll message you about the next match.`,
      };
    case 'booked':
      return {
        subject: `${who}: appointment confirmed`,
        text: `${who}: You're confirmed for ${details}.${c.previousSlot ? ` Your previous appointment (${c.previousSlot}) has been released.` : ''} Details:${link}`,
      };
    case 'auto_booked':
      return {
        subject: `${who}: you've been moved to an earlier appointment`,
        text: `${who}: Good news ${c.firstName}, you've been booked into an earlier appointment: ${details}.${c.previousSlot ? ` Your previous appointment (${c.previousSlot}) has been released.` : ''} If it doesn't work, ${call}. Details:${link}`,
      };
    case 'booking_delayed':
      return {
        subject: `${who}: confirming your appointment`,
        text: `${who}: Thanks for accepting ${c.slot}. We're finalizing it and will confirm shortly. With questions, ${call}.`,
      };
  }
}
