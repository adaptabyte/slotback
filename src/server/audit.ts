import { createHash } from 'node:crypto';
import type { Db } from './db.ts';

export interface Actor {
  type: 'user' | 'patient' | 'system' | 'api' | 'integration';
  id?: string;
  ip?: string;
}

export const SYSTEM: Actor = { type: 'system' };

export interface AuditRecord {
  seq: number;
  at: string;
  actorType: string;
  actorId?: string;
  action: string;
  entityType?: string;
  entityId?: string;
  ip?: string;
  details?: Record<string, unknown>;
  hash: string;
}

const GENESIS = '0'.repeat(64);

function digest(prev: string, r: Omit<AuditRecord, 'seq' | 'hash'>): string {
  const canonical = JSON.stringify([r.at, r.actorType, r.actorId ?? null, r.action, r.entityType ?? null, r.entityId ?? null, r.ip ?? null, r.details ?? null]);
  return createHash('sha256').update(prev).update('\n').update(canonical).digest('hex');
}

/**
 * Append-only, hash-chained audit log (HIPAA §164.312(b) audit controls).
 *
 * Every row stores the SHA-256 of the previous row's hash plus its own
 * content, and SQLite triggers reject UPDATE/DELETE, so any tampering with
 * history is detectable by {@link AuditLog.verify}. Details carry ids only —
 * never names, phone numbers or other direct identifiers.
 */
export class AuditLog {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  record(actor: Actor, action: string, entity?: { type: string; id: string }, details?: Record<string, unknown>, at = new Date()) {
    const last = this.db.sql.prepare('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1').get() as { hash: string } | undefined;
    const prev = last?.hash ?? GENESIS;
    const row = {
      at: at.toISOString(),
      actorType: actor.type,
      actorId: actor.id,
      action,
      entityType: entity?.type,
      entityId: entity?.id,
      ip: actor.ip,
      details,
    };
    this.db.sql
      .prepare(
        'INSERT INTO audit_log (at, actor_type, actor_id, action, entity_type, entity_id, ip, details, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        row.at,
        row.actorType,
        row.actorId ?? null,
        row.action,
        row.entityType ?? null,
        row.entityId ?? null,
        row.ip ?? null,
        row.details ? JSON.stringify(row.details) : null,
        prev,
        digest(prev, row),
      );
  }

  list(opts: { limit?: number; beforeSeq?: number; entityId?: string } = {}): AuditRecord[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.beforeSeq) {
      where.push('seq < ?');
      args.push(opts.beforeSeq);
    }
    if (opts.entityId) {
      where.push('(entity_id = ? OR details LIKE ?)');
      args.push(opts.entityId, `%"${opts.entityId}"%`);
    }
    args.push(opts.limit ?? 100);
    const rows = this.db.sql
      .prepare(`SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`)
      .all(...args) as Record<string, unknown>[];
    return rows.map((r) => ({
      seq: Number(r.seq),
      at: String(r.at),
      actorType: String(r.actor_type),
      actorId: (r.actor_id as string | null) ?? undefined,
      action: String(r.action),
      entityType: (r.entity_type as string | null) ?? undefined,
      entityId: (r.entity_id as string | null) ?? undefined,
      ip: (r.ip as string | null) ?? undefined,
      details: r.details ? JSON.parse(String(r.details)) : undefined,
      hash: String(r.hash),
    }));
  }

  /** Recomputes the whole chain. Returns the first broken sequence number, if any. */
  verify(): { ok: true; count: number } | { ok: false; brokenAt: number } {
    let prev = GENESIS;
    let count = 0;
    for (const r of this.db.sql.prepare('SELECT * FROM audit_log ORDER BY seq').iterate() as Iterable<Record<string, unknown>>) {
      const row = {
        at: String(r.at),
        actorType: String(r.actor_type),
        actorId: (r.actor_id as string | null) ?? undefined,
        action: String(r.action),
        entityType: (r.entity_type as string | null) ?? undefined,
        entityId: (r.entity_id as string | null) ?? undefined,
        ip: (r.ip as string | null) ?? undefined,
        details: r.details ? JSON.parse(String(r.details)) : undefined,
      };
      if (r.prev_hash !== prev || digest(prev, row) !== r.hash) return { ok: false, brokenAt: Number(r.seq) };
      prev = String(r.hash);
      count++;
    }
    return { ok: true, count };
  }
}
