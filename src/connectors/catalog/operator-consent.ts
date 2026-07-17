// SPDX-License-Identifier: MIT
/**
 * Durable record of operator sign-off for a connector staged-rollout action
 * (see docs/connectors/gmail-first-connector-architecture.md#staged-rollout).
 * Pure data layer — recording, listing, or revoking a consent row never
 * flips a feature flag, touches a credential, or makes a network call; it is
 * only the audit trail a human operator's decision leaves behind before they
 * separately flip a flag in config/feature-flags/connectors.json.
 */

import crypto from 'crypto';
import type { DbAdapter } from '../../db/db-adapter.js';

export interface ConnectorOperatorConsentRecord {
  id: string;
  /** Staged-rollout stage this consent authorizes, e.g. "stage_1_migrations_boot_wiring". */
  stage: string;
  /** ConnectorFeatureFlags key this consent authorizes flipping, if any. */
  flagKey: string | null;
  /** Human operator identity recorded for accountability — never a credential/secret. */
  operator: string;
  /** Free-text description of exactly what was consented to. */
  scope: string;
  reason: string;
  consentedAt: number;
  revokedAt: number | null;
  revokedReason: string | null;
}

function rowToConsent(row: Record<string, unknown>): ConnectorOperatorConsentRecord {
  return {
    id: String(row.id),
    stage: String(row.stage),
    flagKey: row.flag_key == null ? null : String(row.flag_key),
    operator: String(row.operator),
    scope: String(row.scope ?? ''),
    reason: String(row.reason ?? ''),
    consentedAt: Number(row.consented_at),
    revokedAt: row.revoked_at == null ? null : Number(row.revoked_at),
    revokedReason: row.revoked_reason == null ? null : String(row.revoked_reason),
  };
}

export class ConnectorOperatorConsentRepo {
  constructor(private readonly db: DbAdapter) {}

  /** Record a new operator consent. Append-only — never mutates a prior row; revoke() supersedes instead. */
  async recordConsent(input: {
    stage: string;
    flagKey?: string | null;
    operator: string;
    scope: string;
    reason: string;
    now?: number;
  }): Promise<ConnectorOperatorConsentRecord> {
    const now = input.now ?? Date.now();
    const record: ConnectorOperatorConsentRecord = {
      id: crypto.randomUUID(),
      stage: input.stage,
      flagKey: input.flagKey ?? null,
      operator: input.operator,
      scope: input.scope,
      reason: input.reason,
      consentedAt: now,
      revokedAt: null,
      revokedReason: null,
    };
    await this.db.query(
      `INSERT INTO connector_operator_consents (
        id, stage, flag_key, operator, scope, reason, consented_at, revoked_at, revoked_reason
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        record.id,
        record.stage,
        record.flagKey,
        record.operator,
        record.scope,
        record.reason,
        record.consentedAt,
        record.revokedAt,
        record.revokedReason,
      ],
    );
    return record;
  }

  /** Immediate revocation — an active consent stops counting as sign-off right away. */
  async revokeConsent(id: string, reason: string, now = Date.now()): Promise<void> {
    await this.db.query(
      `UPDATE connector_operator_consents SET revoked_at = $1, revoked_reason = $2 WHERE id = $3 AND revoked_at IS NULL`,
      [now, reason, id],
    );
  }

  /** Most recent non-revoked consent for a stage, or null if none exists. */
  async getActiveConsent(stage: string): Promise<ConnectorOperatorConsentRecord | null> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM connector_operator_consents
       WHERE stage = $1 AND revoked_at IS NULL
       ORDER BY consented_at DESC`,
      [stage],
    );
    const row = r.rows[0];
    return row ? rowToConsent(row) : null;
  }

  /** Full history for a stage (or every stage, if omitted), newest first. */
  async listConsents(stage?: string): Promise<ConnectorOperatorConsentRecord[]> {
    const r = stage
      ? await this.db.query<Record<string, unknown>>(
          `SELECT * FROM connector_operator_consents WHERE stage = $1 ORDER BY consented_at DESC`,
          [stage],
        )
      : await this.db.query<Record<string, unknown>>(
          `SELECT * FROM connector_operator_consents ORDER BY consented_at DESC`,
        );
    return r.rows.map(rowToConsent);
  }
}
