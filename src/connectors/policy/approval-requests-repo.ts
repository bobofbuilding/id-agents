// SPDX-License-Identifier: MIT
/**
 * Single-use approval requests. One row per invocation request id (enforced
 * by a unique index on invocation_request_id) — a second invocation, even
 * with identical args, must create its own request rather than reuse a
 * decided one, so a stale approval can never be replayed onto a new call.
 */

import crypto from 'crypto';
import type { DbAdapter } from '../../db/db-adapter.js';
import type { ApprovalDecision, ApprovalRequestRecord } from '../types.js';

const DEFAULT_TTL_MS = 15 * 60 * 1000;

export class ApprovalRequestsRepo {
  constructor(private readonly db: DbAdapter) {}

  async create(input: {
    invocationRequestId: string;
    agentId: string;
    capabilityId: string;
    argsHash: string;
    ttlMs?: number;
    now?: number;
  }): Promise<ApprovalRequestRecord> {
    const now = input.now ?? Date.now();
    const record: ApprovalRequestRecord = {
      id: crypto.randomUUID(),
      invocationRequestId: input.invocationRequestId,
      agentId: input.agentId,
      capabilityId: input.capabilityId,
      argsHash: input.argsHash,
      decision: 'pending',
      approver: null,
      decidedAt: null,
      expiresAt: now + (input.ttlMs ?? DEFAULT_TTL_MS),
      createdAt: now,
    };
    await this.db.query(
      `INSERT INTO connector_approval_requests (
        id, invocation_request_id, agent_id, capability_id, args_hash, decision, approver, decided_at, expires_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        record.id,
        record.invocationRequestId,
        record.agentId,
        record.capabilityId,
        record.argsHash,
        record.decision,
        record.approver,
        record.decidedAt,
        record.expiresAt,
        record.createdAt,
      ],
    );
    return record;
  }

  async getByInvocationRequestId(invocationRequestId: string): Promise<ApprovalRequestRecord | null> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM connector_approval_requests WHERE invocation_request_id = $1`,
      [invocationRequestId],
    );
    return r.rows[0] ? rowToRequest(r.rows[0]) : null;
  }

  /**
   * Decide a pending request. Rejects (throws) if the request is missing,
   * already decided, or past expiry — a decision can never be replayed onto
   * an already-terminal request, and an expired request cannot be approved
   * after the fact.
   */
  async decide(
    id: string,
    decision: Exclude<ApprovalDecision, 'pending' | 'expired'>,
    approver: string,
    now = Date.now(),
  ): Promise<ApprovalRequestRecord> {
    const r = await this.db.query<Record<string, unknown>>(`SELECT * FROM connector_approval_requests WHERE id = $1`, [
      id,
    ]);
    const existing = r.rows[0] ? rowToRequest(r.rows[0]) : null;
    if (!existing) throw new Error(`ApprovalRequestsRepo: request "${id}" not found`);
    if (existing.decision !== 'pending') {
      throw new Error(`ApprovalRequestsRepo: request "${id}" is already "${existing.decision}", cannot re-decide`);
    }
    if (existing.expiresAt <= now) {
      await this.db.query(`UPDATE connector_approval_requests SET decision = 'expired' WHERE id = $1`, [id]);
      throw new Error(`ApprovalRequestsRepo: request "${id}" expired at ${existing.expiresAt}`);
    }

    await this.db.query(
      `UPDATE connector_approval_requests SET decision = $1, approver = $2, decided_at = $3 WHERE id = $4`,
      [decision, approver, now, id],
    );
    return { ...existing, decision, approver, decidedAt: now };
  }
}

function rowToRequest(row: Record<string, unknown>): ApprovalRequestRecord {
  return {
    id: String(row.id),
    invocationRequestId: String(row.invocation_request_id),
    agentId: String(row.agent_id),
    capabilityId: String(row.capability_id),
    argsHash: String(row.args_hash),
    decision: row.decision as ApprovalDecision,
    approver: row.approver == null ? null : String(row.approver),
    decidedAt: row.decided_at == null ? null : Number(row.decided_at),
    expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at),
  };
}
