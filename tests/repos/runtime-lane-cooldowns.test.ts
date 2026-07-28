// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import type { DbAdapter, QueryResult } from '../../src/db/db-adapter.js';
import { migratePostgres } from '../../src/db/migrations/postgres.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteRuntimeLaneCooldownsRepo } from '../../src/db/repos/sqlite/runtime-lane-cooldowns-repo.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import type { RuntimeLaneCooldownRecord } from '../../src/db/db-service.js';

function cooldown(
  teamId: string,
  runtime: string,
  runtimeNamespace: string,
  laneId: string,
  coolingUntilMs: number,
): RuntimeLaneCooldownRecord {
  return {
    lane_id: laneId,
    runtime,
    runtime_namespace: runtimeNamespace,
    kind: 'subscription',
    cooling_until_ms: coolingUntilMs,
    observed_at_ms: coolingUntilMs - 1_000,
    reason: 'subscription_monthly_cap',
    team_id: teamId,
    agent_id: null,
    agent_name: null,
    query_id: null,
    reset_text: null,
    message: null,
  };
}

describe('SQLite runtime credential-lane cooldown repository', () => {
  it('persists the same raw lane id independently by team and canonical runtime', async () => {
    const adapter = new SqliteAdapter(':memory:');
    await migrateSqlite(adapter);
    const repo = new SqliteRuntimeLaneCooldownsRepo(adapter);
    const now = Date.now();

    await repo.upsert(cooldown('team-a', 'claude-code-cli', 'claude-code-cli', 'shared', now + 60_000));
    await repo.upsert(cooldown('team-b', 'claude-code-cli', 'claude-code-cli', 'shared', now + 90_000));
    await repo.upsert(cooldown('team-a', 'codex', 'codex', 'shared', now + 120_000));

    const rows = await repo.listActive(now);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => [row.team_id, row.runtime_namespace, row.lane_id]))
      .toEqual([
        ['team-a', 'claude-code-cli', 'shared'],
        ['team-a', 'codex', 'shared'],
        ['team-b', 'claude-code-cli', 'shared'],
      ]);

    await adapter.close();
  });

  it('upgrades legacy lane-id primary keys without losing active cooldown ownership', async () => {
    const adapter = new SqliteAdapter(':memory:');
    const now = Date.now();
    adapter.exec(`
      CREATE TABLE runtime_lane_cooldowns (
        lane_id TEXT PRIMARY KEY,
        runtime TEXT NOT NULL,
        kind TEXT NOT NULL,
        cooling_until_ms INTEGER NOT NULL,
        observed_at_ms INTEGER NOT NULL,
        reason TEXT NOT NULL,
        team_id TEXT,
        agent_id TEXT,
        agent_name TEXT,
        query_id TEXT,
        reset_text TEXT,
        message TEXT
      );
      INSERT INTO runtime_lane_cooldowns (
        lane_id, runtime, kind, cooling_until_ms, observed_at_ms, reason,
        team_id, agent_id, agent_name, query_id, reset_text, message
      ) VALUES (
        'shared', 'claude-code-local', 'subscription', ${now + 60_000},
        ${now}, 'subscription_monthly_cap', 'team-a', 'agent-a',
        'worker-a', 'query-a', NULL, NULL
      );
    `);

    await migrateSqlite(adapter);

    const { rows: columns } = await adapter.query<{ name: string; notnull: number; pk: number }>(
      `SELECT name, "notnull", pk FROM pragma_table_info('runtime_lane_cooldowns')`,
    );
    expect(
      columns
        .filter((column) => Number(column.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map((column) => column.name),
    ).toEqual(['team_id', 'runtime_namespace', 'lane_id']);
    expect(columns.find((column) => column.name === 'team_id')?.notnull).toBe(1);

    const repo = new SqliteRuntimeLaneCooldownsRepo(adapter);
    const migrated = await repo.listActive(now);
    expect(migrated).toContainEqual(expect.objectContaining({
      team_id: 'team-a',
      runtime: 'claude-code-local',
      runtime_namespace: 'claude-code-cli',
      lane_id: 'shared',
      agent_id: 'agent-a',
      query_id: 'query-a',
    }));

    await repo.upsert(cooldown('team-b', 'claude-code-local', 'claude-code-cli', 'shared', now + 90_000));
    expect(await repo.listActive(now)).toHaveLength(2);

    await expect(migrateSqlite(adapter)).resolves.toBeUndefined();
    expect(await repo.listActive(now)).toHaveLength(2);
    await adapter.close();
  });

  it('canonicalizes alias namespaces in a composite schema without losing the safest cooldown', async () => {
    const adapter = new SqliteAdapter(':memory:');
    const now = Date.now();
    adapter.exec(`
      CREATE TABLE runtime_lane_cooldowns (
        lane_id TEXT NOT NULL,
        runtime TEXT NOT NULL,
        runtime_namespace TEXT NOT NULL,
        kind TEXT NOT NULL,
        cooling_until_ms INTEGER NOT NULL,
        observed_at_ms INTEGER NOT NULL,
        reason TEXT NOT NULL,
        team_id TEXT NOT NULL,
        agent_id TEXT,
        agent_name TEXT,
        query_id TEXT,
        reset_text TEXT,
        message TEXT,
        PRIMARY KEY (team_id, runtime_namespace, lane_id)
      );
      INSERT INTO runtime_lane_cooldowns VALUES
        (
          'shared', 'codex-cli', 'codex-cli', 'subscription',
          ${now + 60_000}, ${now + 10_000}, 'alias-shorter', 'team-a',
          'alias-agent', 'alias-worker', 'alias-query', NULL, NULL
        ),
        (
          'shared', 'codex', 'codex', 'subscription',
          ${now + 120_000}, ${now}, 'canonical-longer', 'team-a',
          'canonical-agent', 'canonical-worker', 'canonical-query', NULL, NULL
        ),
        (
          'local', 'claude-code-local', 'claude-code-local', 'subscription',
          ${now + 180_000}, ${now + 20_000}, 'alias-newer', 'team-a',
          'newer-agent', 'newer-worker', 'newer-query', NULL, NULL
        ),
        (
          'local', 'claude-code-cli', 'claude-code-cli', 'subscription',
          ${now + 180_000}, ${now + 10_000}, 'canonical-older', 'team-a',
          'older-agent', 'older-worker', 'older-query', NULL, NULL
        );
    `);

    await migrateSqlite(adapter);

    const { rows } = await adapter.query<{
      lane_id: string;
      runtime_namespace: string;
      cooling_until_ms: number;
      observed_at_ms: number;
      reason: string;
      query_id: string;
    }>(`
      SELECT lane_id, runtime_namespace, cooling_until_ms, observed_at_ms, reason, query_id
      FROM runtime_lane_cooldowns
      ORDER BY lane_id
    `);
    expect(rows).toEqual([
      {
        lane_id: 'local',
        runtime_namespace: 'claude-code-cli',
        cooling_until_ms: now + 180_000,
        observed_at_ms: now + 20_000,
        reason: 'alias-newer',
        query_id: 'newer-query',
      },
      {
        lane_id: 'shared',
        runtime_namespace: 'codex',
        cooling_until_ms: now + 120_000,
        observed_at_ms: now,
        reason: 'canonical-longer',
        query_id: 'canonical-query',
      },
    ]);

    await expect(migrateSqlite(adapter)).resolves.toBeUndefined();
    expect((await adapter.query(`SELECT * FROM runtime_lane_cooldowns`)).rows).toHaveLength(2);
    await adapter.close();
  });
});

describe('Postgres runtime credential-lane cooldown migration', () => {
  it('deduplicates canonical keys by safest/latest cooldown before normalizing constraints', async () => {
    const statements: string[] = [];
    const adapter: DbAdapter = {
      dialect: 'postgres',
      async query<T = unknown>(sql: string): Promise<QueryResult<T>> {
        statements.push(sql);
        return { rows: [], rowCount: 0 };
      },
      async close(): Promise<void> {},
    };

    await migratePostgres(adapter);

    const normalizationIndex = statements.findIndex((sql) =>
      sql.includes('ROW_NUMBER() OVER') && sql.includes('runtime_lane_cooldowns'),
    );
    const namespaceNotNullIndex = statements.findIndex((sql) =>
      sql.includes('runtime_lane_cooldowns ALTER COLUMN runtime_namespace SET NOT NULL'),
    );
    const primaryKeyIndex = statements.findIndex((sql) =>
      sql.includes("ARRAY['team_id', 'runtime_namespace', 'lane_id']"),
    );
    expect(normalizationIndex).toBeGreaterThan(-1);
    expect(normalizationIndex).toBeLessThan(namespaceNotNullIndex);
    expect(normalizationIndex).toBeLessThan(primaryKeyIndex);

    const normalizationSql = statements[normalizationIndex].replace(/\s+/g, ' ');
    expect(normalizationSql).toContain(
      "PARTITION BY COALESCE(team_id, ''), CASE WHEN COALESCE(runtime_namespace, runtime) = 'codex-cli' THEN 'codex'",
    );
    expect(normalizationSql).toContain(
      "WHEN COALESCE(runtime_namespace, runtime) = 'claude-code-local' THEN 'claude-code-cli'",
    );
    expect(normalizationSql).toContain(
      'ORDER BY cooling_until_ms DESC, observed_at_ms DESC, ctid DESC',
    );
    expect(normalizationSql).toContain(
      'LOCK TABLE runtime_lane_cooldowns IN ACCESS EXCLUSIVE MODE',
    );
    expect(normalizationSql.indexOf('DELETE FROM runtime_lane_cooldowns')).toBeLessThan(
      normalizationSql.indexOf('UPDATE runtime_lane_cooldowns'),
    );
    expect(normalizationSql).toContain("team_id = COALESCE(team_id, '')");
  });
});
