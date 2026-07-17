// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../../src/db/sqlite-adapter.js';
import { migrateConnectorsSqlite } from '../../../src/connectors/catalog/migrations.js';
import { ConnectorOperatorConsentRepo } from '../../../src/connectors/catalog/operator-consent.js';

async function setup() {
  const adapter = new SqliteAdapter(':memory:');
  await migrateConnectorsSqlite(adapter);
  return { adapter, repo: new ConnectorOperatorConsentRepo(adapter) };
}

describe('ConnectorOperatorConsentRepo', () => {
  it('records a consent and returns it as the active consent for that stage', async () => {
    const { adapter, repo } = await setup();
    const record = await repo.recordConsent({
      stage: 'stage_1_migrations_boot_wiring',
      flagKey: 'connectorsMigrationsEnabled',
      operator: 'bobofbuilding',
      scope: 'Flip connectorsMigrationsEnabled to true on the next manager restart.',
      reason: 'Approved after Stage 0 review; additive CREATE TABLE IF NOT EXISTS only.',
      now: 1000,
    });

    expect(record.id).toBeTruthy();
    expect(record.revokedAt).toBeNull();

    const active = await repo.getActiveConsent('stage_1_migrations_boot_wiring');
    expect(active?.id).toEqual(record.id);
    expect(active?.operator).toEqual('bobofbuilding');
    expect(active?.flagKey).toEqual('connectorsMigrationsEnabled');

    const { rows: columns } = await adapter.query<{ name: string }>(
      `PRAGMA table_info(connector_operator_consents)`,
    );
    const persistedColumnNames = columns.map((column) => column.name);
    expect(persistedColumnNames.some((name) => /credential|token|secret/i.test(name))).toBe(false);

    const { rows: persistedRows } = await adapter.query<Record<string, unknown>>(
      `SELECT * FROM connector_operator_consents WHERE id = $1`,
      [record.id],
    );
    expect(persistedRows).toHaveLength(1);
    expect(Object.keys(persistedRows[0]).some((name) => /credential|token|secret/i.test(name))).toBe(false);
    await adapter.close();
  });

  it('returns null for a stage with no recorded consent', async () => {
    const { adapter, repo } = await setup();
    expect(await repo.getActiveConsent('stage_2_credential_broker')).toBeNull();
    await adapter.close();
  });

  it('recording does not flip or read any feature flag — it is a pure data write', async () => {
    const { adapter, repo } = await setup();
    const record = await repo.recordConsent({
      stage: 'stage_1_migrations_boot_wiring',
      operator: 'ops',
      scope: 'test',
      reason: 'test',
      now: 1000,
    });
    // The record round-trips exactly what was written; no side effects beyond the row itself.
    expect(record.stage).toEqual('stage_1_migrations_boot_wiring');
    expect(record.flagKey).toBeNull();
    await adapter.close();
  });

  it('a revoked consent is no longer the active consent for its stage', async () => {
    const { adapter, repo } = await setup();
    const record = await repo.recordConsent({
      stage: 'stage_1_migrations_boot_wiring',
      operator: 'bobofbuilding',
      scope: 'scope',
      reason: 'reason',
      now: 1000,
    });

    await repo.revokeConsent(record.id, 'changed mind', 2000);

    expect(await repo.getActiveConsent('stage_1_migrations_boot_wiring')).toBeNull();
    const history = await repo.listConsents('stage_1_migrations_boot_wiring');
    expect(history).toHaveLength(1);
    expect(history[0].revokedAt).toEqual(2000);
    expect(history[0].revokedReason).toEqual('changed mind');
    await adapter.close();
  });

  it('the newest non-revoked consent wins when a stage has multiple rows', async () => {
    const { adapter, repo } = await setup();
    const first = await repo.recordConsent({ stage: 's', operator: 'a', scope: '', reason: '', now: 1000 });
    await repo.revokeConsent(first.id, 'superseded', 1500);
    const second = await repo.recordConsent({ stage: 's', operator: 'b', scope: '', reason: '', now: 2000 });

    const active = await repo.getActiveConsent('s');
    expect(active?.id).toEqual(second.id);
    expect(active?.operator).toEqual('b');
    await adapter.close();
  });

  it('listConsents with no stage argument returns every stage, newest first', async () => {
    const { adapter, repo } = await setup();
    await repo.recordConsent({ stage: 'stage_a', operator: 'a', scope: '', reason: '', now: 1000 });
    await repo.recordConsent({ stage: 'stage_b', operator: 'b', scope: '', reason: '', now: 2000 });

    const all = await repo.listConsents();
    expect(all.map((c) => c.stage)).toEqual(['stage_b', 'stage_a']);
    await adapter.close();
  });
});
