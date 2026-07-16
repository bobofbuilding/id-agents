// SPDX-License-Identifier: MIT
/**
 * Append-only, integrity-chained connector audit log. Every event's
 * integrityHash covers its own canonical fields plus the previous event's
 * hash, so any row edited or deleted out of band breaks the chain — callers
 * can detect tampering with verifyChain() without a separate WORM store.
 *
 * Only redacted/hashed fields are ever written here: no raw provider bodies,
 * tokens, or PII. Callers pass sanitizedArgsHash (a SHA-256 of the
 * already-redacted argument object), never the raw args.
 */

import crypto from 'crypto';
import type { DbAdapter } from '../../db/db-adapter.js';
import type { ConnectorAuditEvent, ConnectorResultStatus, DenyCode } from '../types.js';

export interface AppendAuditEventInput {
  requestId: string;
  actorAgentId: string;
  action: string;
  connectorId: string;
  connectorVersion: string;
  capabilityId: string | null;
  decision: ConnectorResultStatus;
  denyCode: DenyCode | null;
  argsHash: string | null;
  timestamp: number;
}

function computeIntegrityHash(prevHash: string | null, event: Omit<ConnectorAuditEvent, 'integrityHash' | 'seq'>): string {
  const canonical = JSON.stringify({
    prevIntegrityHash: prevHash,
    requestId: event.requestId,
    actorAgentId: event.actorAgentId,
    action: event.action,
    connectorId: event.connectorId,
    connectorVersion: event.connectorVersion,
    capabilityId: event.capabilityId,
    decision: event.decision,
    denyCode: event.denyCode,
    argsHash: event.argsHash,
    timestamp: event.timestamp,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** SHA-256 helper for callers to hash their already-redacted argument objects before passing argsHash in. */
export function hashSanitizedArgs(sanitizedArgs: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(sanitizedArgs ?? null))).digest('hex');
}

export class ConnectorAuditLog {
  constructor(private readonly db: DbAdapter) {}

  private async lastHash(): Promise<string | null> {
    const r = await this.db.query<{ integrity_hash: string }>(
      `SELECT integrity_hash FROM connector_audit_events ORDER BY seq DESC LIMIT 1`,
    );
    return r.rows[0]?.integrity_hash ?? null;
  }

  async append(input: AppendAuditEventInput): Promise<ConnectorAuditEvent> {
    const prevHash = await this.lastHash();
    const base: Omit<ConnectorAuditEvent, 'integrityHash' | 'seq'> = {
      requestId: input.requestId,
      actorAgentId: input.actorAgentId,
      action: input.action,
      connectorId: input.connectorId,
      connectorVersion: input.connectorVersion,
      capabilityId: input.capabilityId,
      decision: input.decision,
      denyCode: input.denyCode,
      argsHash: input.argsHash,
      timestamp: input.timestamp,
      prevIntegrityHash: prevHash,
    };
    const integrityHash = computeIntegrityHash(prevHash, base);

    const r = await this.db.query<{ seq: number }>(
      `INSERT INTO connector_audit_events (
        request_id, actor_agent_id, action, connector_id, connector_version, capability_id,
        decision, deny_code, args_hash, timestamp, integrity_hash, prev_integrity_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING seq`,
      [
        base.requestId,
        base.actorAgentId,
        base.action,
        base.connectorId,
        base.connectorVersion,
        base.capabilityId,
        base.decision,
        base.denyCode,
        base.argsHash,
        base.timestamp,
        integrityHash,
        prevHash,
      ],
    );

    return { ...base, integrityHash, seq: Number(r.rows[0]?.seq ?? 0) };
  }

  async listByActor(actorAgentId: string, limit = 100): Promise<ConnectorAuditEvent[]> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM connector_audit_events WHERE actor_agent_id = $1 ORDER BY seq ASC LIMIT $2`,
      [actorAgentId, limit],
    );
    return r.rows.map(rowToEvent);
  }

  async listAll(limit = 1000): Promise<ConnectorAuditEvent[]> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM connector_audit_events ORDER BY seq ASC LIMIT $1`,
      [limit],
    );
    return r.rows.map(rowToEvent);
  }

  /** Recompute each event's hash from its stored fields and compare to what's stored — detects tampering or gaps. */
  async verifyChain(): Promise<{ ok: boolean; brokenAtSeq?: number }> {
    const events = await this.listAll(Number.MAX_SAFE_INTEGER);
    let prevHash: string | null = null;
    for (const event of events) {
      const expected = computeIntegrityHash(prevHash, event);
      if (expected !== event.integrityHash || event.prevIntegrityHash !== prevHash) {
        return { ok: false, brokenAtSeq: event.seq };
      }
      prevHash = event.integrityHash;
    }
    return { ok: true };
  }
}

function rowToEvent(row: Record<string, unknown>): ConnectorAuditEvent {
  return {
    seq: Number(row.seq),
    requestId: String(row.request_id),
    actorAgentId: String(row.actor_agent_id),
    action: String(row.action),
    connectorId: String(row.connector_id),
    connectorVersion: String(row.connector_version),
    capabilityId: row.capability_id == null ? null : String(row.capability_id),
    decision: row.decision as ConnectorResultStatus,
    denyCode: row.deny_code == null ? null : (row.deny_code as DenyCode),
    argsHash: row.args_hash == null ? null : String(row.args_hash),
    timestamp: Number(row.timestamp),
    integrityHash: String(row.integrity_hash),
    prevIntegrityHash: row.prev_integrity_hash == null ? null : String(row.prev_integrity_hash),
  };
}
