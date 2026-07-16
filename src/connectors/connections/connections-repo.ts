// SPDX-License-Identifier: MIT
/**
 * Connection records: subject-bound (agent + tenant) links to a connector
 * version, carrying only an opaque vault_credential_ref — never a token.
 * Creating a connection does not grant any capability; see grants-repo.ts.
 */

import crypto from 'crypto';
import type { DbAdapter } from '../../db/db-adapter.js';
import type { ConnectionRecord } from '../types.js';

export class ConnectorConnectionsRepo {
  constructor(private readonly db: DbAdapter) {}

  async create(input: {
    agentId: string;
    tenantId: string;
    connectorId: string;
    connectorVersion: string;
    vaultCredentialRef?: string | null;
    status?: ConnectionRecord['status'];
    approvedScopes?: string[];
    now?: number;
  }): Promise<ConnectionRecord> {
    const now = input.now ?? Date.now();
    const record: ConnectionRecord = {
      id: crypto.randomUUID(),
      agentId: input.agentId,
      tenantId: input.tenantId,
      connectorId: input.connectorId,
      connectorVersion: input.connectorVersion,
      vaultCredentialRef: input.vaultCredentialRef ?? null,
      status: input.status ?? 'pending',
      approvedScopes: input.approvedScopes ?? [],
      createdAt: now,
      updatedAt: now,
    };
    await this.db.query(
      `INSERT INTO connector_connections (
        id, agent_id, tenant_id, connector_id, connector_version, vault_credential_ref,
        status, approved_scopes, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        record.id,
        record.agentId,
        record.tenantId,
        record.connectorId,
        record.connectorVersion,
        record.vaultCredentialRef,
        record.status,
        JSON.stringify(record.approvedScopes),
        record.createdAt,
        record.updatedAt,
      ],
    );
    return record;
  }

  async getById(connectionId: string): Promise<ConnectionRecord | null> {
    const r = await this.db.query<Record<string, unknown>>(`SELECT * FROM connector_connections WHERE id = $1`, [
      connectionId,
    ]);
    return r.rows[0] ? rowToConnection(r.rows[0]) : null;
  }

  async revoke(connectionId: string, now = Date.now()): Promise<void> {
    await this.db.query(`UPDATE connector_connections SET status = 'revoked', updated_at = $1 WHERE id = $2`, [
      now,
      connectionId,
    ]);
  }
}

function rowToConnection(row: Record<string, unknown>): ConnectionRecord {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    tenantId: String(row.tenant_id),
    connectorId: String(row.connector_id),
    connectorVersion: String(row.connector_version),
    vaultCredentialRef: row.vault_credential_ref == null ? null : String(row.vault_credential_ref),
    status: row.status as ConnectionRecord['status'],
    approvedScopes: typeof row.approved_scopes === 'string' ? JSON.parse(row.approved_scopes) : (row.approved_scopes as string[]),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
