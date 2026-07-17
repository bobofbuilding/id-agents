// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../../src/db/sqlite-adapter.js';
import { migrateDb } from '../../../src/db/index.js';
import type { Db } from '../../../src/db/db-service.js';

async function connectorTableNames(adapter: SqliteAdapter): Promise<string[]> {
  const { rows } = await adapter.query<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'connector%'`,
  );
  return rows.map((r) => r.name).sort();
}

describe('migrateDb connector migration boot wiring', () => {
  afterEach(() => {
    delete process.env.ID_CONNECTORS_MIGRATIONS_ENABLED;
  });

  it('is a no-op for the connector tables when connectorsMigrationsEnabled is off (repo default)', async () => {
    delete process.env.ID_CONNECTORS_MIGRATIONS_ENABLED;
    const adapter = new SqliteAdapter(':memory:');
    await migrateDb({ adapter } as unknown as Db);

    expect(await connectorTableNames(adapter)).toEqual([]);
    await adapter.close();
  });

  it('creates the connector tables once ID_CONNECTORS_MIGRATIONS_ENABLED is set, without touching core tables', async () => {
    process.env.ID_CONNECTORS_MIGRATIONS_ENABLED = 'true';
    const adapter = new SqliteAdapter(':memory:');
    await migrateDb({ adapter } as unknown as Db);

    const names = await connectorTableNames(adapter);
    expect(names).toContain('connectors');
    expect(names).toContain('connector_operator_consents');

    const { rows: teamRows } = await adapter.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'teams'`,
    );
    expect(teamRows).toHaveLength(1);
    await adapter.close();
  });
});
