// SPDX-License-Identifier: MIT
/**
 * Connector catalog: publish/lifecycle for connectors and immutable,
 * hash-checked connector versions. The registry is a closed-world contract
 * — the router only ever resolves capabilities through resolveCapability(),
 * which requires an exact (connectorId, version, capabilityId) pin against a
 * published, non-revoked version. Draft/deprecated/disabled state and
 * unknown ids resolve to null, never a partial or "latest" match.
 */

import type { DbAdapter } from '../../db/db-adapter.js';
import type {
  CapabilityManifestEntry,
  ConnectorManifest,
  ConnectorRecord,
  ConnectorStatus,
  ConnectorVersionRecord,
  ConnectorVersionStatus,
} from '../types.js';
import { hashManifest, validateConnectorManifest } from './manifest-validator.js';

export class ManifestValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Connector manifest validation failed: ${errors.join('; ')}`);
  }
}

export class ConnectorRegistry {
  constructor(private readonly db: DbAdapter) {}

  async registerConnector(input: {
    id: string;
    displayName: string;
    description: string;
    owner: string;
    trustTier: ConnectorRecord['trustTier'];
    now?: number;
  }): Promise<void> {
    const now = input.now ?? Date.now();
    await this.db.query(
      `INSERT INTO connectors (id, display_name, description, owner, status, trust_tier, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [input.id, input.displayName, input.description, input.owner, input.trustTier, now, now],
    );
  }

  async setConnectorStatus(connectorId: string, status: ConnectorStatus, now = Date.now()): Promise<void> {
    await this.db.query(`UPDATE connectors SET status = $1, updated_at = $2 WHERE id = $3`, [
      status,
      now,
      connectorId,
    ]);
  }

  async getConnector(connectorId: string): Promise<ConnectorRecord | null> {
    const r = await this.db.query<Record<string, unknown>>(`SELECT * FROM connectors WHERE id = $1`, [connectorId]);
    return r.rows[0] ? rowToConnector(r.rows[0]) : null;
  }

  /** Validate, hash, and store a new immutable version in "draft" status. Throws on invalid manifest or duplicate (id, version). */
  async draftVersion(manifest: ConnectorManifest, backendKind: ConnectorVersionRecord['backendKind'], now = Date.now()): Promise<string> {
    const validation = validateConnectorManifest(manifest);
    if (!validation.ok) throw new ManifestValidationError(validation.errors);

    const manifestHash = hashManifest(manifest);
    await this.db.query(
      `INSERT INTO connector_versions (connector_id, version, status, manifest, manifest_hash, backend_kind, published_at, created_at)
       VALUES ($1, $2, 'draft', $3, $4, $5, NULL, $6)`,
      [manifest.connectorId, manifest.version, JSON.stringify(manifest), manifestHash, backendKind, now],
    );
    return manifestHash;
  }

  /** Publish a drafted version: makes it routable. Immutable — publishing never mutates the stored manifest/hash. */
  async publishVersion(connectorId: string, version: string, now = Date.now()): Promise<void> {
    const r = await this.db.query(
      `UPDATE connector_versions SET status = 'published', published_at = $1
       WHERE connector_id = $2 AND version = $3 AND status = 'draft'`,
      [now, connectorId, version],
    );
    if ((r.rowCount ?? 0) === 0) {
      throw new Error(`ConnectorRegistry: cannot publish ${connectorId}@${version} — not found or not in draft`);
    }
    await this.setConnectorStatus(connectorId, 'published', now);
  }

  async deprecateVersion(connectorId: string, version: string): Promise<void> {
    await this.db.query(`UPDATE connector_versions SET status = 'deprecated' WHERE connector_id = $1 AND version = $2`, [
      connectorId,
      version,
    ]);
  }

  /** Irreversible: immediately makes the version unroutable regardless of connector-level status. */
  async revokeVersion(connectorId: string, version: string): Promise<void> {
    await this.db.query(`UPDATE connector_versions SET status = 'revoked' WHERE connector_id = $1 AND version = $2`, [
      connectorId,
      version,
    ]);
  }

  async getVersion(connectorId: string, version: string): Promise<ConnectorVersionRecord | null> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM connector_versions WHERE connector_id = $1 AND version = $2`,
      [connectorId, version],
    );
    return r.rows[0] ? rowToVersion(r.rows[0]) : null;
  }

  /**
   * Resolve one capability through an exact pin. Returns null for any
   * unknown connector, unknown/unpublished/revoked version, or unknown
   * capability id — callers must treat null as deny, never as "try latest".
   */
  async resolveCapability(
    connectorId: string,
    version: string,
    capabilityId: string,
  ): Promise<{ connector: ConnectorRecord; version: ConnectorVersionRecord; capability: CapabilityManifestEntry } | null> {
    const connector = await this.getConnector(connectorId);
    if (!connector || connector.status === 'disabled') return null;

    const versionRecord = await this.getVersion(connectorId, version);
    if (!versionRecord || versionRecord.status !== 'published') return null;

    const capability = versionRecord.manifest.capabilities.find((c) => c.id === capabilityId);
    if (!capability) return null;

    return { connector, version: versionRecord, capability };
  }
}

function rowToConnector(row: Record<string, unknown>): ConnectorRecord {
  return {
    id: String(row.id),
    displayName: String(row.display_name),
    description: String(row.description ?? ''),
    owner: String(row.owner),
    status: row.status as ConnectorStatus,
    trustTier: row.trust_tier as ConnectorRecord['trustTier'],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToVersion(row: Record<string, unknown>): ConnectorVersionRecord {
  const manifest = typeof row.manifest === 'string' ? JSON.parse(row.manifest) : (row.manifest as ConnectorManifest);
  return {
    connectorId: String(row.connector_id),
    version: String(row.version),
    status: row.status as ConnectorVersionStatus,
    manifest,
    manifestHash: String(row.manifest_hash),
    backendKind: row.backend_kind as ConnectorVersionRecord['backendKind'],
    publishedAt: row.published_at == null ? null : Number(row.published_at),
    createdAt: Number(row.created_at),
  };
}
