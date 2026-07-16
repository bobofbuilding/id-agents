// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../../src/db/sqlite-adapter.js';
import { migrateConnectorsSqlite, downMigrateConnectorsSqlite } from '../../../src/connectors/catalog/migrations.js';

describe('connector registry migrations (sqlite)', () => {
  it('creates all connector tables', async () => {
    const adapter = new SqliteAdapter(':memory:');
    await migrateConnectorsSqlite(adapter);

    const { rows } = await adapter.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'connector%'`,
    );
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(
      [
        'connector_approval_policies',
        'connector_approval_requests',
        'connector_audit_events',
        'connector_capability_grants',
        'connector_connections',
        'connector_invocations',
        'connector_versions',
        'connectors',
      ].sort(),
    );
    await adapter.close();
  });

  it('is idempotent — running twice does not throw', async () => {
    const adapter = new SqliteAdapter(':memory:');
    await expect(migrateConnectorsSqlite(adapter)).resolves.toBeUndefined();
    await expect(migrateConnectorsSqlite(adapter)).resolves.toBeUndefined();
    await adapter.close();
  });

  it('down-migration drops every connector table, leaving core tables untouched', async () => {
    const adapter = new SqliteAdapter(':memory:');
    // Simulate running alongside the core schema.
    adapter.exec(`CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, name TEXT)`);

    await migrateConnectorsSqlite(adapter);
    await downMigrateConnectorsSqlite(adapter);

    const { rows } = await adapter.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'connector%'`,
    );
    expect(rows).toHaveLength(0);

    const { rows: teamRows } = await adapter.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'teams'`,
    );
    expect(teamRows).toHaveLength(1);
    await adapter.close();
  });
});
