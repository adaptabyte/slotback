import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Booking,
  BookingStatus,
  Command,
  EntryStatus,
  Offer,
  OfferStatus,
  Opening,
  OpeningStatus,
  Store,
  WaitlistEntry,
} from '../core/index.ts';
import { randomToken, sha256 } from './crypto.ts';
import type { Vault } from './crypto.ts';

export interface PatientRecord {
  id: string;
  firstName: string;
  lastName: string;
  dob?: string;
  phone?: string;
  email?: string;
  preferredChannel: 'sms' | 'email' | 'both';
  smsConsent: boolean;
  /** Patient id in the EHR (e.g. FHIR Patient id or MRN). */
  externalRef?: string;
  /** Short staff-only note. Keep clinical detail in the EHR. */
  note?: string;
  createdAt: string;
  purgedAt?: string;
}

export type Role = 'admin' | 'staff' | 'provider';

export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  passwordHash?: string;
  totpSecret?: string;
  mfaEnabled: boolean;
  failedAttempts: number;
  lockedUntil?: string;
  disabled: boolean;
  createdAt: string;
}

export interface SessionRecord {
  tokenHash: string;
  userId: string;
  csrf: string;
  mfaPassed: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string;
}

export type TaskKind = 'book' | 'cancel_original';

export interface TaskRecord {
  id: string;
  kind: TaskKind;
  bookingId: string;
  entryId: string;
  status: 'open' | 'done' | 'failed';
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  data?: Record<string, unknown>;
}

export interface OutboxItem {
  id: number;
  command: Command;
  status: 'pending' | 'done' | 'dead';
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
  createdAt: string;
}

export interface LinkToken {
  kind: 'offer' | 'manage' | 'setup';
  refId: string;
  expiresAt: string;
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);

  CREATE TABLE patients (
    id TEXT PRIMARY KEY,
    enc TEXT NOT NULL,
    phone_idx TEXT,
    email_idx TEXT,
    created_at TEXT NOT NULL,
    purged_at TEXT
  );
  CREATE INDEX patients_phone ON patients(phone_idx);

  CREATE TABLE entries (
    id TEXT PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(id),
    status TEXT NOT NULL,
    enc TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX entries_status ON entries(status);
  CREATE INDEX entries_patient ON entries(patient_id);

  CREATE TABLE openings (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    source TEXT NOT NULL,
    external_id TEXT,
    start_at TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX openings_status ON openings(status);
  CREATE INDEX openings_ext ON openings(source, external_id);

  CREATE TABLE offers (
    id TEXT PRIMARY KEY,
    opening_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    status TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX offers_opening ON offers(opening_id);
  CREATE INDEX offers_entry ON offers(entry_id);
  CREATE INDEX offers_status ON offers(status);

  CREATE TABLE bookings (
    id TEXT PRIMARY KEY,
    opening_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    status TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX bookings_status ON bookings(status);
  CREATE INDEX bookings_entry ON bookings(entry_id);

  CREATE TABLE outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    command TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX outbox_due ON outbox(status, next_attempt_at);

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    booking_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    status TEXT NOT NULL,
    data TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    resolved_by TEXT
  );
  CREATE INDEX tasks_status ON tasks(status);

  CREATE TABLE link_tokens (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX link_tokens_ref ON link_tokens(kind, ref_id);

  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL,
    password_hash TEXT,
    totp_enc TEXT,
    mfa_enabled INTEGER NOT NULL DEFAULT 0,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    csrf TEXT NOT NULL,
    mfa_passed INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    ip TEXT NOT NULL
  );

  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );

  CREATE TABLE source_state (id TEXT PRIMARY KEY, enc TEXT NOT NULL, updated_at TEXT NOT NULL);

  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    channel TEXT NOT NULL,
    status TEXT NOT NULL,
    provider_message_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE audit_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    ip TEXT,
    details TEXT,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL
  );
  CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  `,
];

type Row = Record<string, unknown>;

function inList(values: readonly string[]): string {
  return values.map(() => '?').join(',');
}

function asArray<T>(v: T | T[] | undefined): T[] | undefined {
  return v === undefined ? undefined : Array.isArray(v) ? v : [v];
}

export function normalizePhone(raw: string): string | undefined {
  const digits = raw.replace(/[^\d+]/g, '');
  const plain = digits.replace(/\+/g, '');
  if (plain.length < 10 || plain.length > 15) return undefined;
  if (digits.startsWith('+')) return `+${plain}`;
  if (plain.length === 10) return `+1${plain}`; // North American default
  if (plain.length === 11 && plain.startsWith('1')) return `+${plain}`;
  return `+${plain}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomToken(12)}`;
}

export class Db {
  readonly sql: DatabaseSync;
  readonly vault: Vault;
  private txDepth = 0;

  constructor(path: string, vault: Vault) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.sql = new DatabaseSync(path);
    this.vault = vault;
    this.sql.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;');
    this.migrate();
  }

  private migrate() {
    const version = (this.sql.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.sql.exec(MIGRATIONS[v]);
        this.sql.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  /** Runs `fn` atomically. Nested calls use savepoints. */
  tx<T>(fn: () => T): T {
    const sp = `sp${this.txDepth}`;
    this.sql.exec(this.txDepth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.txDepth++;
    try {
      const result = fn();
      this.txDepth--;
      this.sql.exec(this.txDepth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return result;
    } catch (err) {
      this.txDepth--;
      this.sql.exec(this.txDepth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw err;
    }
  }

  close() {
    this.sql.close();
  }

  // --------------------------------------------------------------- settings

  getSetting<T>(key: string): T | undefined {
    const row = this.sql.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
    return row ? this.vault.decryptJson<T>(String(row.value), `settings:${key}`) : undefined;
  }

  setSetting(key: string, value: unknown) {
    this.sql
      .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, this.vault.encryptJson(value, `settings:${key}`), new Date().toISOString());
  }

  // --------------------------------------------------------------- patients

  insertPatient(input: Omit<PatientRecord, 'id' | 'createdAt'>): PatientRecord {
    const patient: PatientRecord = { ...input, id: newId('pat'), createdAt: new Date().toISOString() };
    this.sql
      .prepare('INSERT INTO patients (id, enc, phone_idx, email_idx, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(patient.id, this.vault.encryptJson(patient, `patients:${patient.id}`), ...this.indexes(patient), patient.createdAt);
    return patient;
  }

  updatePatient(patient: PatientRecord) {
    this.sql
      .prepare('UPDATE patients SET enc = ?, phone_idx = ?, email_idx = ? WHERE id = ?')
      .run(this.vault.encryptJson(patient, `patients:${patient.id}`), ...this.indexes(patient), patient.id);
  }

  private indexes(p: PatientRecord): [string | null, string | null] {
    const phone = p.phone ? normalizePhone(p.phone) : undefined;
    return [
      phone ? this.vault.blindIndex(`phone:${phone}`) : null,
      p.email ? this.vault.blindIndex(`email:${p.email.trim().toLowerCase()}`) : null,
    ];
  }

  getPatient(id: string): PatientRecord | undefined {
    const row = this.sql.prepare('SELECT enc FROM patients WHERE id = ?').get(id) as Row | undefined;
    return row ? this.vault.decryptJson<PatientRecord>(String(row.enc), `patients:${id}`) : undefined;
  }

  findPatientIdsByPhone(phone: string): string[] {
    const normalized = normalizePhone(phone);
    if (!normalized) return [];
    const rows = this.sql
      .prepare('SELECT id FROM patients WHERE phone_idx = ? AND purged_at IS NULL')
      .all(this.vault.blindIndex(`phone:${normalized}`)) as Row[];
    return rows.map((r) => String(r.id));
  }

  /** Irreversibly removes identifiers once a patient is off the waitlist past the retention window. */
  purgePatient(id: string) {
    const now = new Date().toISOString();
    const tombstone: PatientRecord = {
      id,
      firstName: '(purged)',
      lastName: '',
      preferredChannel: 'sms',
      smsConsent: false,
      createdAt: now,
      purgedAt: now,
    };
    this.sql
      .prepare('UPDATE patients SET enc = ?, phone_idx = NULL, email_idx = NULL, purged_at = ? WHERE id = ?')
      .run(this.vault.encryptJson(tombstone, `patients:${id}`), now, id);
  }

  // ------------------------------------------------------------ link tokens

  /** Creates an unguessable link token; only its hash is stored. */
  createLinkToken(kind: LinkToken['kind'], refId: string, expiresAt: string): string {
    const token = randomToken(24);
    this.sql
      .prepare('INSERT INTO link_tokens (token_hash, kind, ref_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(sha256(token), kind, refId, expiresAt, new Date().toISOString());
    return token;
  }

  resolveLinkToken(kind: LinkToken['kind'], token: string, now = new Date()): string | undefined {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return undefined;
    const row = this.sql
      .prepare('SELECT ref_id, expires_at FROM link_tokens WHERE token_hash = ? AND kind = ?')
      .get(sha256(token), kind) as Row | undefined;
    if (!row || String(row.expires_at) <= now.toISOString()) return undefined;
    return String(row.ref_id);
  }

  revokeLinkTokens(kind: LinkToken['kind'], refId: string) {
    this.sql.prepare('DELETE FROM link_tokens WHERE kind = ? AND ref_id = ?').run(kind, refId);
  }

  // ------------------------------------------------------------------ users

  private toUser(r: Row): UserRecord {
    return {
      id: String(r.id),
      username: String(r.username),
      displayName: String(r.display_name),
      role: r.role as Role,
      passwordHash: (r.password_hash as string | null) ?? undefined,
      totpSecret: r.totp_enc ? this.vault.decrypt(String(r.totp_enc), `users:${r.id}`) : undefined,
      mfaEnabled: Boolean(r.mfa_enabled),
      failedAttempts: Number(r.failed_attempts),
      lockedUntil: (r.locked_until as string | null) ?? undefined,
      disabled: Boolean(r.disabled),
      createdAt: String(r.created_at),
    };
  }

  createUser(username: string, displayName: string, role: Role): UserRecord {
    const id = newId('usr');
    this.sql
      .prepare('INSERT INTO users (id, username, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, username.trim(), displayName.trim() || username.trim(), role, new Date().toISOString());
    return this.getUser(id)!;
  }

  getUser(id: string): UserRecord | undefined {
    const r = this.sql.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
    return r && this.toUser(r);
  }

  getUserByUsername(username: string): UserRecord | undefined {
    const r = this.sql.prepare('SELECT * FROM users WHERE username = ?').get(username.trim()) as Row | undefined;
    return r && this.toUser(r);
  }

  listUsers(): UserRecord[] {
    return (this.sql.prepare('SELECT * FROM users ORDER BY username').all() as Row[]).map((r) => this.toUser(r));
  }

  countUsers(): number {
    return Number((this.sql.prepare('SELECT COUNT(*) AS n FROM users').get() as Row).n);
  }

  updateUser(u: UserRecord) {
    this.sql
      .prepare(
        `UPDATE users SET display_name = ?, role = ?, password_hash = ?, totp_enc = ?, mfa_enabled = ?,
         failed_attempts = ?, locked_until = ?, disabled = ? WHERE id = ?`,
      )
      .run(
        u.displayName,
        u.role,
        u.passwordHash ?? null,
        u.totpSecret ? this.vault.encrypt(u.totpSecret, `users:${u.id}`) : null,
        u.mfaEnabled ? 1 : 0,
        u.failedAttempts,
        u.lockedUntil ?? null,
        u.disabled ? 1 : 0,
        u.id,
      );
  }

  // --------------------------------------------------------------- sessions

  createSession(userId: string, ip: string, maxHours: number, mfaPassed: boolean): { token: string; session: SessionRecord } {
    const token = randomToken(32);
    const now = new Date();
    const session: SessionRecord = {
      tokenHash: sha256(token),
      userId,
      csrf: randomToken(24),
      mfaPassed,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + maxHours * 3600000).toISOString(),
      ip,
    };
    this.sql
      .prepare('INSERT INTO sessions (token_hash, user_id, csrf, mfa_passed, created_at, last_seen_at, expires_at, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(session.tokenHash, userId, session.csrf, mfaPassed ? 1 : 0, session.createdAt, session.lastSeenAt, session.expiresAt, ip);
    return { token, session };
  }

  getSession(token: string): SessionRecord | undefined {
    const r = this.sql.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(token)) as Row | undefined;
    if (!r) return undefined;
    return {
      tokenHash: String(r.token_hash),
      userId: String(r.user_id),
      csrf: String(r.csrf),
      mfaPassed: Boolean(r.mfa_passed),
      createdAt: String(r.created_at),
      lastSeenAt: String(r.last_seen_at),
      expiresAt: String(r.expires_at),
      ip: String(r.ip),
    };
  }

  touchSession(tokenHash: string, patch: { lastSeenAt?: string; mfaPassed?: boolean }) {
    if (patch.lastSeenAt) this.sql.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(patch.lastSeenAt, tokenHash);
    if (patch.mfaPassed !== undefined) {
      this.sql.prepare('UPDATE sessions SET mfa_passed = ? WHERE token_hash = ?').run(patch.mfaPassed ? 1 : 0, tokenHash);
    }
  }

  deleteSession(tokenHash: string) {
    this.sql.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteUserSessions(userId: string) {
    this.sql.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  // --------------------------------------------------------------- api keys

  createApiKey(name: string): { id: string; key: string } {
    const id = newId('key');
    const key = `sbk_${randomToken(32)}`;
    this.sql
      .prepare('INSERT INTO api_keys (id, name, key_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(id, name, sha256(key), new Date().toISOString());
    return { id, key };
  }

  resolveApiKey(key: string): { id: string; name: string } | undefined {
    const r = this.sql
      .prepare('SELECT id, name FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL')
      .get(sha256(key)) as Row | undefined;
    if (!r) return undefined;
    this.sql.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), String(r.id));
    return { id: String(r.id), name: String(r.name) };
  }

  listApiKeys(): { id: string; name: string; createdAt: string; lastUsedAt?: string; revokedAt?: string }[] {
    return (this.sql.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as Row[]).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      createdAt: String(r.created_at),
      lastUsedAt: (r.last_used_at as string | null) ?? undefined,
      revokedAt: (r.revoked_at as string | null) ?? undefined,
    }));
  }

  revokeApiKey(id: string) {
    this.sql.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(new Date().toISOString(), id);
  }

  // ----------------------------------------------------------------- outbox

  enqueue(command: Command, at = new Date()) {
    this.sql
      .prepare('INSERT INTO outbox (command, status, next_attempt_at, created_at) VALUES (?, ?, ?, ?)')
      .run(JSON.stringify(command), 'pending', at.toISOString(), at.toISOString());
  }

  dueOutbox(now: Date, limit = 20): OutboxItem[] {
    const rows = this.sql
      .prepare("SELECT * FROM outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?")
      .all(now.toISOString(), limit) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      command: JSON.parse(String(r.command)) as Command,
      status: r.status as OutboxItem['status'],
      attempts: Number(r.attempts),
      nextAttemptAt: String(r.next_attempt_at),
      lastError: (r.last_error as string | null) ?? undefined,
      createdAt: String(r.created_at),
    }));
  }

  finishOutbox(id: number) {
    this.sql.prepare("UPDATE outbox SET status = 'done', last_error = NULL WHERE id = ?").run(id);
  }

  retryOutbox(id: number, attempts: number, nextAt: Date, error: string, dead: boolean) {
    this.sql
      .prepare('UPDATE outbox SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?')
      .run(dead ? 'dead' : 'pending', attempts, nextAt.toISOString(), error.slice(0, 500), id);
  }

  outboxStats(): { pending: number; dead: number } {
    const r = this.sql
      .prepare("SELECT SUM(status = 'pending') AS pending, SUM(status = 'dead') AS dead FROM outbox")
      .get() as Row;
    return { pending: Number(r.pending ?? 0), dead: Number(r.dead ?? 0) };
  }

  // ------------------------------------------------------------------ tasks

  createTask(task: Omit<TaskRecord, 'id' | 'createdAt' | 'status'>): TaskRecord {
    const t: TaskRecord = { ...task, id: newId('tsk'), status: 'open', createdAt: new Date().toISOString() };
    this.sql
      .prepare('INSERT INTO tasks (id, kind, booking_id, entry_id, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(t.id, t.kind, t.bookingId, t.entryId, t.status, t.data ? JSON.stringify(t.data) : null, t.createdAt);
    return t;
  }

  private toTask(r: Row): TaskRecord {
    return {
      id: String(r.id),
      kind: r.kind as TaskKind,
      bookingId: String(r.booking_id),
      entryId: String(r.entry_id),
      status: r.status as TaskRecord['status'],
      createdAt: String(r.created_at),
      resolvedAt: (r.resolved_at as string | null) ?? undefined,
      resolvedBy: (r.resolved_by as string | null) ?? undefined,
      data: r.data ? JSON.parse(String(r.data)) : undefined,
    };
  }

  getTask(id: string): TaskRecord | undefined {
    const r = this.sql.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return r && this.toTask(r);
  }

  listTasks(status: TaskRecord['status'] | 'all' = 'open', limit = 200): TaskRecord[] {
    const rows =
      status === 'all'
        ? this.sql.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?').all(limit)
        : this.sql.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at LIMIT ?').all(status, limit);
    return (rows as Row[]).map((r) => this.toTask(r));
  }

  resolveTask(id: string, status: 'done' | 'failed', userId: string) {
    this.sql
      .prepare("UPDATE tasks SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ? AND status = 'open'")
      .run(status, new Date().toISOString(), userId, id);
  }

  // ----------------------------------------------------------- source state

  getSourceState<T>(id: string): T | undefined {
    const r = this.sql.prepare('SELECT enc FROM source_state WHERE id = ?').get(id) as Row | undefined;
    return r ? this.vault.decryptJson<T>(String(r.enc), `source_state:${id}`) : undefined;
  }

  setSourceState(id: string, state: unknown) {
    this.sql
      .prepare('INSERT INTO source_state (id, enc, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET enc = excluded.enc, updated_at = excluded.updated_at')
      .run(id, this.vault.encryptJson(state, `source_state:${id}`), new Date().toISOString());
  }

  // ---------------------------------------------------------- notifications

  logNotification(n: { patientId: string; kind: string; channel: string; status: 'sent' | 'failed' | 'skipped'; providerMessageId?: string; error?: string }) {
    this.sql
      .prepare('INSERT INTO notifications (patient_id, kind, channel, status, provider_message_id, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(n.patientId, n.kind, n.channel, n.status, n.providerMessageId ?? null, n.error?.slice(0, 300) ?? null, new Date().toISOString());
  }

  listNotifications(patientId: string): { kind: string; channel: string; status: string; createdAt: string }[] {
    return (
      this.sql.prepare('SELECT kind, channel, status, created_at FROM notifications WHERE patient_id = ? ORDER BY id DESC LIMIT 50').all(patientId) as Row[]
    ).map((r) => ({ kind: String(r.kind), channel: String(r.channel), status: String(r.status), createdAt: String(r.created_at) }));
  }

  // ------------------------------------------------------------ maintenance

  /** Entries closed longer than `days` whose patient has no other open entry. */
  purgeCandidates(days: number, now = new Date()): string[] {
    const cutoff = new Date(now.getTime() - days * 86400000).toISOString();
    const rows = this.sql
      .prepare(
        `SELECT p.id FROM patients p WHERE p.purged_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.patient_id = p.id AND (e.status NOT IN ('booked','removed') OR e.updated_at > ?))
         AND EXISTS (SELECT 1 FROM entries e WHERE e.patient_id = p.id)`,
      )
      .all(cutoff) as Row[];
    return rows.map((r) => String(r.id));
  }

  deleteExpired(now = new Date()) {
    const iso = now.toISOString();
    this.sql.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(iso);
    this.sql.prepare('DELETE FROM link_tokens WHERE expires_at <= ?').run(iso);
    this.sql.prepare("DELETE FROM outbox WHERE status = 'done' AND created_at <= ?").run(new Date(now.getTime() - 30 * 86400000).toISOString());
  }
}

/** {@link Store} implementation on SQLite. Waitlist entries are encrypted at rest. */
export class SqliteStore implements Store {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  private decryptEntry(r: Row): WaitlistEntry {
    return this.db.vault.decryptJson<WaitlistEntry>(String(r.enc), `entries:${r.id}`);
  }

  getEntry(id: string) {
    const r = this.db.sql.prepare('SELECT id, enc FROM entries WHERE id = ?').get(id) as Row | undefined;
    return r && this.decryptEntry(r);
  }

  listEntries(filter: { status?: EntryStatus | EntryStatus[] } = {}) {
    const statuses = asArray(filter.status);
    const rows = statuses
      ? this.db.sql.prepare(`SELECT id, enc FROM entries WHERE status IN (${inList(statuses)}) ORDER BY created_at`).all(...statuses)
      : this.db.sql.prepare('SELECT id, enc FROM entries ORDER BY created_at').all();
    return (rows as Row[]).map((r) => this.decryptEntry(r));
  }

  listEntriesForPatient(patientId: string): WaitlistEntry[] {
    const rows = this.db.sql.prepare('SELECT id, enc FROM entries WHERE patient_id = ? ORDER BY created_at').all(patientId) as Row[];
    return rows.map((r) => this.decryptEntry(r));
  }

  saveEntry(entry: WaitlistEntry) {
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `INSERT INTO entries (id, patient_id, status, enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, enc = excluded.enc, updated_at = excluded.updated_at`,
      )
      .run(entry.id, entry.patientId, entry.status, this.db.vault.encryptJson(entry, `entries:${entry.id}`), entry.addedAt, now);
  }

  getOpening(id: string) {
    const r = this.db.sql.prepare('SELECT data FROM openings WHERE id = ?').get(id) as Row | undefined;
    return r ? (JSON.parse(String(r.data)) as Opening) : undefined;
  }

  listOpenings(filter: { status?: OpeningStatus | OpeningStatus[] } = {}) {
    const statuses = asArray(filter.status);
    const rows = statuses
      ? this.db.sql.prepare(`SELECT data FROM openings WHERE status IN (${inList(statuses)}) ORDER BY start_at`).all(...statuses)
      : this.db.sql.prepare('SELECT data FROM openings ORDER BY start_at').all();
    return (rows as Row[]).map((r) => JSON.parse(String(r.data)) as Opening);
  }

  listRecentOpenings(limit: number): Opening[] {
    const rows = this.db.sql.prepare('SELECT data FROM openings ORDER BY rowid DESC LIMIT ?').all(limit) as Row[];
    return rows.map((r) => JSON.parse(String(r.data)) as Opening);
  }

  findOpeningByExternalId(source: string, externalId: string) {
    const r = this.db.sql
      .prepare('SELECT data FROM openings WHERE source = ? AND external_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(source, externalId) as Row | undefined;
    return r ? (JSON.parse(String(r.data)) as Opening) : undefined;
  }

  saveOpening(o: Opening) {
    this.db.sql
      .prepare(
        `INSERT INTO openings (id, status, source, external_id, start_at, data) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data`,
      )
      .run(o.id, o.status, o.source, o.externalId ?? null, o.start, JSON.stringify(o));
  }

  getOffer(id: string) {
    const r = this.db.sql.prepare('SELECT data FROM offers WHERE id = ?').get(id) as Row | undefined;
    return r ? (JSON.parse(String(r.data)) as Offer) : undefined;
  }

  listOffers(filter: { openingId?: string; entryId?: string; status?: OfferStatus | OfferStatus[] } = {}) {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.openingId) {
      where.push('opening_id = ?');
      args.push(filter.openingId);
    }
    if (filter.entryId) {
      where.push('entry_id = ?');
      args.push(filter.entryId);
    }
    const statuses = asArray(filter.status);
    if (statuses) {
      where.push(`status IN (${inList(statuses)})`);
      args.push(...statuses);
    }
    const sql = `SELECT data FROM offers ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY rowid`;
    return (this.db.sql.prepare(sql).all(...args) as Row[]).map((r) => JSON.parse(String(r.data)) as Offer);
  }

  saveOffer(o: Offer) {
    this.db.sql
      .prepare(
        `INSERT INTO offers (id, opening_id, entry_id, status, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data`,
      )
      .run(o.id, o.openingId, o.entryId, o.status, JSON.stringify(o));
  }

  getBooking(id: string) {
    const r = this.db.sql.prepare('SELECT data FROM bookings WHERE id = ?').get(id) as Row | undefined;
    return r ? (JSON.parse(String(r.data)) as Booking) : undefined;
  }

  listBookings(filter: { status?: BookingStatus | BookingStatus[]; entryId?: string } = {}) {
    const where: string[] = [];
    const args: string[] = [];
    const statuses = asArray(filter.status);
    if (statuses) {
      where.push(`status IN (${inList(statuses)})`);
      args.push(...statuses);
    }
    if (filter.entryId) {
      where.push('entry_id = ?');
      args.push(filter.entryId);
    }
    const sql = `SELECT data FROM bookings ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY rowid`;
    return (this.db.sql.prepare(sql).all(...args) as Row[]).map((r) => JSON.parse(String(r.data)) as Booking);
  }

  saveBooking(b: Booking) {
    this.db.sql
      .prepare(
        `INSERT INTO bookings (id, opening_id, entry_id, status, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data`,
      )
      .run(b.id, b.openingId, b.entryId, b.status, JSON.stringify(b));
  }
}
