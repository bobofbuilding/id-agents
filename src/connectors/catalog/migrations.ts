// SPDX-License-Identifier: MIT
/**
 * Additive, standalone migrations for the connector registry/grants/policy/
 * audit/consent tables. Wired into the live boot chain via
 * src/db/index.ts migrateDb, but gated behind the connectorsMigrationsEnabled
 * feature flag (default false) — see
 * docs/connectors/gmail-first-connector-architecture.md#staged-rollout
 * stage 1. Tests call migrateConnectors{Sqlite,Postgres} directly; flipping
 * the flag is the operator-approved action that makes migrateDb call them
 * on the live manager DB.
 *
 * Every statement is CREATE TABLE/INDEX IF NOT EXISTS, so re-running is a
 * no-op and there is no destructive rollback needed — dropping the tables
 * (see downMigrateConnectors*) is the only rollback action, and only the
 * registry/grant/audit/consent rows are affected; no other subsystem's
 * tables are touched.
 */

import type { DbAdapter } from '../../db/db-adapter.js';
import type { SqliteAdapter } from '../../db/sqlite-adapter.js';

const SQLITE_DDL = `
  CREATE TABLE IF NOT EXISTS connectors (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    trust_tier TEXT NOT NULL DEFAULT 'evaluation',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS connector_versions (
    connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    manifest TEXT NOT NULL,
    manifest_hash TEXT NOT NULL,
    backend_kind TEXT NOT NULL,
    published_at INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (connector_id, version)
  );
  CREATE INDEX IF NOT EXISTS connector_versions_status_idx ON connector_versions(connector_id, status);

  CREATE TABLE IF NOT EXISTS connector_connections (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    connector_id TEXT NOT NULL,
    connector_version TEXT NOT NULL,
    vault_credential_ref TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    approved_scopes TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (connector_id, connector_version) REFERENCES connector_versions(connector_id, version)
  );
  CREATE INDEX IF NOT EXISTS connector_connections_agent_idx ON connector_connections(agent_id, tenant_id, connector_id);

  CREATE TABLE IF NOT EXISTS connector_capability_grants (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
    capability_id TEXT NOT NULL,
    connector_version TEXT NOT NULL,
    effect TEXT NOT NULL DEFAULT 'allow',
    resource_scope TEXT NOT NULL DEFAULT '{}',
    grant_version INTEGER NOT NULL DEFAULT 1,
    issued_by TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    expires_at INTEGER,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS connector_grants_lookup_idx
    ON connector_capability_grants(agent_id, tenant_id, capability_id, revoked_at);

  CREATE TABLE IF NOT EXISTS connector_approval_policies (
    id TEXT PRIMARY KEY,
    capability_id TEXT NOT NULL,
    agent_id TEXT NOT NULL DEFAULT '*',
    tenant_id TEXT NOT NULL DEFAULT '*',
    mode TEXT NOT NULL,
    conditions TEXT NOT NULL DEFAULT '{}',
    policy_version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS connector_approval_policies_capability_idx
    ON connector_approval_policies(capability_id, agent_id, tenant_id);

  CREATE TABLE IF NOT EXISTS connector_approval_requests (
    id TEXT PRIMARY KEY,
    invocation_request_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    capability_id TEXT NOT NULL,
    args_hash TEXT NOT NULL,
    decision TEXT NOT NULL DEFAULT 'pending',
    approver TEXT,
    decided_at INTEGER,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS connector_approval_requests_invocation_idx
    ON connector_approval_requests(invocation_request_id);

  CREATE TABLE IF NOT EXISTS connector_invocations (
    request_id TEXT PRIMARY KEY,
    idempotency_key TEXT,
    agent_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    connector_id TEXT NOT NULL,
    connector_version TEXT NOT NULL,
    capability_id TEXT NOT NULL,
    connection_id TEXT,
    status TEXT NOT NULL,
    deny_code TEXT,
    args_hash TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS connector_invocations_idempotency_idx
    ON connector_invocations(agent_id, tenant_id, connector_id, connector_version, capability_id, connection_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

  CREATE TABLE IF NOT EXISTS connector_audit_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL,
    actor_agent_id TEXT NOT NULL,
    action TEXT NOT NULL,
    connector_id TEXT NOT NULL,
    connector_version TEXT NOT NULL,
    capability_id TEXT,
    decision TEXT NOT NULL,
    deny_code TEXT,
    args_hash TEXT,
    timestamp INTEGER NOT NULL,
    integrity_hash TEXT NOT NULL,
    prev_integrity_hash TEXT
  );
  CREATE INDEX IF NOT EXISTS connector_audit_events_actor_idx ON connector_audit_events(actor_agent_id, timestamp);

  CREATE TABLE IF NOT EXISTS connector_operator_consents (
    id TEXT PRIMARY KEY,
    stage TEXT NOT NULL,
    flag_key TEXT,
    operator TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    consented_at INTEGER NOT NULL,
    revoked_at INTEGER,
    revoked_reason TEXT
  );
  CREATE INDEX IF NOT EXISTS connector_operator_consents_stage_idx
    ON connector_operator_consents(stage, revoked_at);
`;

export async function migrateConnectorsSqlite(adapter: SqliteAdapter): Promise<void> {
  adapter.exec(SQLITE_DDL);
}

/** Drops every connector table. Rollback path for the staged rollout; test-only today. */
export async function downMigrateConnectorsSqlite(adapter: SqliteAdapter): Promise<void> {
  adapter.exec(`
    DROP TABLE IF EXISTS connector_operator_consents;
    DROP TABLE IF EXISTS connector_audit_events;
    DROP TABLE IF EXISTS connector_invocations;
    DROP TABLE IF EXISTS connector_approval_requests;
    DROP TABLE IF EXISTS connector_approval_policies;
    DROP TABLE IF EXISTS connector_capability_grants;
    DROP TABLE IF EXISTS connector_connections;
    DROP TABLE IF EXISTS connector_versions;
    DROP TABLE IF EXISTS connectors;
  `);
}

const POSTGRES_DDL = `
  CREATE TABLE IF NOT EXISTS connectors (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    trust_tier TEXT NOT NULL DEFAULT 'evaluation',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS connector_versions (
    connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    manifest JSONB NOT NULL,
    manifest_hash TEXT NOT NULL,
    backend_kind TEXT NOT NULL,
    published_at BIGINT,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (connector_id, version)
  );
  CREATE INDEX IF NOT EXISTS connector_versions_status_idx ON connector_versions(connector_id, status);

  CREATE TABLE IF NOT EXISTS connector_connections (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    connector_id TEXT NOT NULL,
    connector_version TEXT NOT NULL,
    vault_credential_ref TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    approved_scopes JSONB NOT NULL DEFAULT '[]',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    FOREIGN KEY (connector_id, connector_version) REFERENCES connector_versions(connector_id, version)
  );
  CREATE INDEX IF NOT EXISTS connector_connections_agent_idx ON connector_connections(agent_id, tenant_id, connector_id);

  CREATE TABLE IF NOT EXISTS connector_capability_grants (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
    capability_id TEXT NOT NULL,
    connector_version TEXT NOT NULL,
    effect TEXT NOT NULL DEFAULT 'allow',
    resource_scope JSONB NOT NULL DEFAULT '{}',
    grant_version INTEGER NOT NULL DEFAULT 1,
    issued_by TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    expires_at BIGINT,
    revoked_at BIGINT,
    created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS connector_grants_lookup_idx
    ON connector_capability_grants(agent_id, tenant_id, capability_id, revoked_at);

  CREATE TABLE IF NOT EXISTS connector_approval_policies (
    id TEXT PRIMARY KEY,
    capability_id TEXT NOT NULL,
    agent_id TEXT NOT NULL DEFAULT '*',
    tenant_id TEXT NOT NULL DEFAULT '*',
    mode TEXT NOT NULL,
    conditions JSONB NOT NULL DEFAULT '{}',
    policy_version INTEGER NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS connector_approval_policies_capability_idx
    ON connector_approval_policies(capability_id, agent_id, tenant_id);

  CREATE TABLE IF NOT EXISTS connector_approval_requests (
    id TEXT PRIMARY KEY,
    invocation_request_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    capability_id TEXT NOT NULL,
    args_hash TEXT NOT NULL,
    decision TEXT NOT NULL DEFAULT 'pending',
    approver TEXT,
    decided_at BIGINT,
    expires_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS connector_approval_requests_invocation_idx
    ON connector_approval_requests(invocation_request_id);

  CREATE TABLE IF NOT EXISTS connector_invocations (
    request_id TEXT PRIMARY KEY,
    idempotency_key TEXT,
    agent_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    connector_id TEXT NOT NULL,
    connector_version TEXT NOT NULL,
    capability_id TEXT NOT NULL,
    connection_id TEXT,
    status TEXT NOT NULL,
    deny_code TEXT,
    args_hash TEXT,
    created_at BIGINT NOT NULL,
    completed_at BIGINT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS connector_invocations_idempotency_idx
    ON connector_invocations(agent_id, tenant_id, connector_id, connector_version, capability_id, connection_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

  CREATE TABLE IF NOT EXISTS connector_audit_events (
    seq BIGSERIAL PRIMARY KEY,
    request_id TEXT NOT NULL,
    actor_agent_id TEXT NOT NULL,
    action TEXT NOT NULL,
    connector_id TEXT NOT NULL,
    connector_version TEXT NOT NULL,
    capability_id TEXT,
    decision TEXT NOT NULL,
    deny_code TEXT,
    args_hash TEXT,
    timestamp BIGINT NOT NULL,
    integrity_hash TEXT NOT NULL,
    prev_integrity_hash TEXT
  );
  CREATE INDEX IF NOT EXISTS connector_audit_events_actor_idx ON connector_audit_events(actor_agent_id, timestamp);

  CREATE TABLE IF NOT EXISTS connector_operator_consents (
    id TEXT PRIMARY KEY,
    stage TEXT NOT NULL,
    flag_key TEXT,
    operator TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    consented_at BIGINT NOT NULL,
    revoked_at BIGINT,
    revoked_reason TEXT
  );
  CREATE INDEX IF NOT EXISTS connector_operator_consents_stage_idx
    ON connector_operator_consents(stage, revoked_at);
`;

export async function migrateConnectorsPostgres(adapter: DbAdapter): Promise<void> {
  for (const statement of POSTGRES_DDL.split(';').map((s) => s.trim()).filter(Boolean)) {
    await adapter.query(statement);
  }
}

export async function downMigrateConnectorsPostgres(adapter: DbAdapter): Promise<void> {
  const statements = [
    'DROP TABLE IF EXISTS connector_operator_consents',
    'DROP TABLE IF EXISTS connector_audit_events',
    'DROP TABLE IF EXISTS connector_invocations',
    'DROP TABLE IF EXISTS connector_approval_requests',
    'DROP TABLE IF EXISTS connector_approval_policies',
    'DROP TABLE IF EXISTS connector_capability_grants',
    'DROP TABLE IF EXISTS connector_connections',
    'DROP TABLE IF EXISTS connector_versions',
    'DROP TABLE IF EXISTS connectors',
  ];
  for (const statement of statements) await adapter.query(statement);
}
