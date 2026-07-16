// SPDX-License-Identifier: MIT

import crypto from 'crypto';
import type { DbAdapter } from '../../db/db-adapter.js';
import type { ApprovalMode, ApprovalPolicyRecord } from '../types.js';

export class ApprovalPolicyRepo {
  constructor(private readonly db: DbAdapter) {}

  async upsertPolicy(input: {
    capabilityId: string;
    agentId?: string;
    tenantId?: string;
    mode: ApprovalMode;
    conditions?: ApprovalPolicyRecord['conditions'];
    now?: number;
  }): Promise<ApprovalPolicyRecord> {
    const now = input.now ?? Date.now();
    const record: ApprovalPolicyRecord = {
      id: crypto.randomUUID(),
      capabilityId: input.capabilityId,
      agentId: input.agentId ?? '*',
      tenantId: input.tenantId ?? '*',
      mode: input.mode,
      conditions: input.conditions ?? {},
      policyVersion: 1,
      createdAt: now,
    };
    await this.db.query(
      `INSERT INTO connector_approval_policies (id, capability_id, agent_id, tenant_id, mode, conditions, policy_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        record.id,
        record.capabilityId,
        record.agentId,
        record.tenantId,
        record.mode,
        JSON.stringify(record.conditions),
        record.policyVersion,
        record.createdAt,
      ],
    );
    return record;
  }

  async listForCapability(capabilityId: string): Promise<ApprovalPolicyRecord[]> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM connector_approval_policies WHERE capability_id = $1`,
      [capabilityId],
    );
    return r.rows.map(rowToPolicy);
  }
}

function rowToPolicy(row: Record<string, unknown>): ApprovalPolicyRecord {
  return {
    id: String(row.id),
    capabilityId: String(row.capability_id),
    agentId: String(row.agent_id),
    tenantId: String(row.tenant_id),
    mode: row.mode as ApprovalMode,
    conditions: typeof row.conditions === 'string' ? JSON.parse(row.conditions) : (row.conditions as ApprovalPolicyRecord['conditions']),
    policyVersion: Number(row.policy_version),
    createdAt: Number(row.created_at),
  };
}
