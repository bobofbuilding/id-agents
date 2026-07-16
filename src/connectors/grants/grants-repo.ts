// SPDX-License-Identifier: MIT

import crypto from 'crypto';
import type { DbAdapter } from '../../db/db-adapter.js';
import type { CapabilityGrantRecord, ResourceScope } from '../types.js';

export class ConnectorGrantsRepo {
  constructor(private readonly db: DbAdapter) {}

  /** Grant creation is an operator/policy-service action; agents must never call this on their own behalf. */
  async issueGrant(input: {
    agentId: string;
    tenantId: string;
    connectionId: string;
    capabilityId: string;
    connectorVersion: string;
    effect: CapabilityGrantRecord['effect'];
    resourceScope?: ResourceScope;
    issuedBy: string;
    reason: string;
    expiresAt?: number | null;
    now?: number;
  }): Promise<CapabilityGrantRecord> {
    const now = input.now ?? Date.now();
    const record: CapabilityGrantRecord = {
      id: crypto.randomUUID(),
      agentId: input.agentId,
      tenantId: input.tenantId,
      connectionId: input.connectionId,
      capabilityId: input.capabilityId,
      connectorVersion: input.connectorVersion,
      effect: input.effect,
      resourceScope: input.resourceScope ?? {},
      grantVersion: 1,
      issuedBy: input.issuedBy,
      reason: input.reason,
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
      createdAt: now,
    };
    await this.db.query(
      `INSERT INTO connector_capability_grants (
        id, agent_id, tenant_id, connection_id, capability_id, connector_version, effect,
        resource_scope, grant_version, issued_by, reason, expires_at, revoked_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        record.id,
        record.agentId,
        record.tenantId,
        record.connectionId,
        record.capabilityId,
        record.connectorVersion,
        record.effect,
        JSON.stringify(record.resourceScope),
        record.grantVersion,
        record.issuedBy,
        record.reason,
        record.expiresAt,
        record.revokedAt,
        record.createdAt,
      ],
    );
    return record;
  }

  /** Immediate revocation — the router must treat this as denying every future invocation right away. */
  async revoke(grantId: string, now = Date.now()): Promise<void> {
    await this.db.query(`UPDATE connector_capability_grants SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL`, [
      now,
      grantId,
    ]);
  }

  async listCandidates(agentId: string, tenantId: string, capabilityId: string): Promise<CapabilityGrantRecord[]> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM connector_capability_grants WHERE agent_id = $1 AND tenant_id = $2 AND capability_id = $3`,
      [agentId, tenantId, capabilityId],
    );
    return r.rows.map(rowToGrant);
  }
}

function rowToGrant(row: Record<string, unknown>): CapabilityGrantRecord {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    tenantId: String(row.tenant_id),
    connectionId: String(row.connection_id),
    capabilityId: String(row.capability_id),
    connectorVersion: String(row.connector_version),
    effect: row.effect as CapabilityGrantRecord['effect'],
    resourceScope: typeof row.resource_scope === 'string' ? JSON.parse(row.resource_scope) : (row.resource_scope as ResourceScope),
    grantVersion: Number(row.grant_version),
    issuedBy: String(row.issued_by),
    reason: String(row.reason ?? ''),
    expiresAt: row.expires_at == null ? null : Number(row.expires_at),
    revokedAt: row.revoked_at == null ? null : Number(row.revoked_at),
    createdAt: Number(row.created_at),
  };
}
