import { createHash } from 'node:crypto';

export type Env = 'production' | 'development' | 'test';

export interface Config {
  env: Env;
  host: string;
  port: number;
  publicUrl: string;
  databasePath: string;
  encryptionKey: Buffer;
  trustProxy: boolean;
  sessionIdleMinutes: number;
  sessionMaxHours: number;
  requireMfa: boolean;
  sms: {
    provider: 'twilio' | 'webhook' | 'console' | 'none';
    twilio?: { accountSid: string; authToken: string; from?: string; messagingServiceSid?: string };
  };
  email: { provider: 'smtp' | 'webhook' | 'console' | 'none'; smtpUrl?: string; from?: string };
  notifyWebhook?: { url: string; secret: string };
  booking: { adapter: 'manual' | 'webhook' | 'fhir'; webhookUrl?: string; webhookSecret?: string };
  fhir?: { baseUrl: string; token?: string; clientId?: string; clientSecret?: string; tokenUrl?: string; scope?: string };
  pollSeconds: number;
  retentionDays: number;
  seedDemo: boolean;
}

export class ConfigError extends Error {}

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[], fallback: T): T {
  const v = (value ?? fallback) as T;
  if (!allowed.includes(v)) throw new ConfigError(`${name} must be one of: ${allowed.join(', ')}`);
  return v;
}

function int(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new ConfigError(`${name} must be a non-negative integer`);
  return n;
}

const bool = (v: string | undefined, fallback: boolean) =>
  v === undefined || v === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

/** Reads configuration from environment variables (see `.env.example`). Secrets never live in the database. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = oneOf('SLOTBACK_ENV', env.SLOTBACK_ENV, ['production', 'development', 'test'] as const, 'production');
  const prod = mode === 'production';
  const port = int('PORT', env.PORT, 8080);
  const publicUrl = (env.SLOTBACK_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');

  let encryptionKey: Buffer;
  if (env.SLOTBACK_ENCRYPTION_KEY) {
    encryptionKey = Buffer.from(env.SLOTBACK_ENCRYPTION_KEY, 'base64');
    if (encryptionKey.length !== 32) {
      throw new ConfigError('SLOTBACK_ENCRYPTION_KEY must be 32 random bytes, base64-encoded (run `npm run cli -- gen-key`)');
    }
  } else if (prod) {
    throw new ConfigError('SLOTBACK_ENCRYPTION_KEY is required in production (run `npm run cli -- gen-key`)');
  } else {
    // Deterministic, publicly known key: fine for synthetic demo data, never for PHI.
    encryptionKey = createHash('sha256').update('slotback-insecure-development-key').digest();
  }

  const sms = oneOf('SLOTBACK_SMS', env.SLOTBACK_SMS, ['twilio', 'webhook', 'console', 'none'] as const, prod ? 'none' : 'console');
  const email = oneOf('SLOTBACK_EMAIL', env.SLOTBACK_EMAIL, ['smtp', 'webhook', 'console', 'none'] as const, prod ? 'none' : 'console');
  const bookingAdapter = oneOf('SLOTBACK_BOOKING', env.SLOTBACK_BOOKING, ['manual', 'webhook', 'fhir'] as const, 'manual');

  const config: Config = {
    env: mode,
    host: env.HOST ?? '0.0.0.0',
    port,
    publicUrl,
    databasePath: env.SLOTBACK_DATABASE ?? (mode === 'test' ? ':memory:' : prod ? './data/slotback.db' : './data/slotback-dev.db'),
    encryptionKey,
    trustProxy: bool(env.SLOTBACK_TRUST_PROXY, false),
    sessionIdleMinutes: int('SLOTBACK_SESSION_IDLE_MINUTES', env.SLOTBACK_SESSION_IDLE_MINUTES, 15),
    sessionMaxHours: int('SLOTBACK_SESSION_MAX_HOURS', env.SLOTBACK_SESSION_MAX_HOURS, 12),
    requireMfa: bool(env.SLOTBACK_REQUIRE_MFA, prod),
    sms: { provider: sms },
    email: { provider: email, smtpUrl: env.SLOTBACK_SMTP_URL, from: env.SLOTBACK_EMAIL_FROM },
    booking: {
      adapter: bookingAdapter,
      webhookUrl: env.SLOTBACK_BOOKING_WEBHOOK_URL,
      webhookSecret: env.SLOTBACK_BOOKING_WEBHOOK_SECRET,
    },
    pollSeconds: int('SLOTBACK_POLL_SECONDS', env.SLOTBACK_POLL_SECONDS, 120),
    retentionDays: int('SLOTBACK_RETENTION_DAYS', env.SLOTBACK_RETENTION_DAYS, 90),
    seedDemo: bool(env.SLOTBACK_SEED_DEMO, false),
  };

  if (sms === 'twilio') {
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !(env.TWILIO_FROM || env.TWILIO_MESSAGING_SERVICE_SID)) {
      throw new ConfigError('Twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID');
    }
    config.sms.twilio = {
      accountSid: env.TWILIO_ACCOUNT_SID,
      authToken: env.TWILIO_AUTH_TOKEN,
      from: env.TWILIO_FROM,
      messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
    };
  }
  if (email === 'smtp' && (!config.email.smtpUrl || !config.email.from)) {
    throw new ConfigError('SMTP email needs SLOTBACK_SMTP_URL and SLOTBACK_EMAIL_FROM');
  }
  if (sms === 'webhook' || email === 'webhook') {
    if (!env.SLOTBACK_NOTIFY_WEBHOOK_URL || !env.SLOTBACK_NOTIFY_WEBHOOK_SECRET) {
      throw new ConfigError('Webhook notifications need SLOTBACK_NOTIFY_WEBHOOK_URL and SLOTBACK_NOTIFY_WEBHOOK_SECRET');
    }
    config.notifyWebhook = { url: env.SLOTBACK_NOTIFY_WEBHOOK_URL, secret: env.SLOTBACK_NOTIFY_WEBHOOK_SECRET };
  }
  if (bookingAdapter === 'webhook' && (!config.booking.webhookUrl || !config.booking.webhookSecret)) {
    throw new ConfigError('Webhook booking needs SLOTBACK_BOOKING_WEBHOOK_URL and SLOTBACK_BOOKING_WEBHOOK_SECRET');
  }
  if (env.SLOTBACK_FHIR_BASE_URL) {
    config.fhir = {
      baseUrl: env.SLOTBACK_FHIR_BASE_URL.replace(/\/+$/, ''),
      token: env.SLOTBACK_FHIR_TOKEN,
      clientId: env.SLOTBACK_FHIR_CLIENT_ID,
      clientSecret: env.SLOTBACK_FHIR_CLIENT_SECRET,
      tokenUrl: env.SLOTBACK_FHIR_TOKEN_URL,
      scope: env.SLOTBACK_FHIR_SCOPE,
    };
  }
  if (bookingAdapter === 'fhir' && !config.fhir) {
    throw new ConfigError('FHIR booking needs SLOTBACK_FHIR_BASE_URL');
  }

  if (prod) {
    if (!publicUrl.startsWith('https://')) throw new ConfigError('SLOTBACK_PUBLIC_URL must be https:// in production');
    if (sms === 'console' || email === 'console') {
      throw new ConfigError('Console notifications print messages to logs and are not allowed in production');
    }
    if (config.seedDemo) throw new ConfigError('SLOTBACK_SEED_DEMO is only allowed in development');
    for (const url of [config.booking.webhookUrl, config.notifyWebhook?.url, config.fhir?.baseUrl]) {
      if (url && !url.startsWith('https://')) throw new ConfigError(`Integration URLs must use https:// in production (${url})`);
    }
  }
  return config;
}
