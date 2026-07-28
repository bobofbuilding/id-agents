// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from 'vitest';

import type { DbAdapter } from '../../src/db/db-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { PgAgentsRepo } from '../../src/db/repos/postgres/agents-repo.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';

const adapters: SqliteAdapter[] = [];

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.close();
});

describe('same-identity agent redeploy repository update', () => {
  it('updates deployment fields without cascading durable SQLite history', async () => {
    const adapter = new SqliteAdapter(':memory:');
    adapters.push(adapter);
    await migrateSqlite(adapter);
    const teams = new SqliteTeamsRepo(adapter);
    const agents = new SqliteAgentsRepo(adapter);
    const teamId = await teams.getOrCreateTeamId('redeploy');
    const agentId = 'agent-stable';
    await agents.create({
      team_id: teamId,
      id: agentId,
      name: 'worker',
      type: 'claude',
      model: 'old-model',
      port: 43111,
      endpoint: 'http://localhost:43111',
      working_directory: '/profile/agents/stable',
      status: 'running',
      created_at: 123456,
      metadata: { durable: true },
      runtime: 'claude-code-cli',
      token_id: 'token-1',
      domain: 'worker.example.eth',
    });
    await adapter.query(
      `INSERT INTO wallets (agent_id, team_id, address, private_key, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [agentId, teamId, '0xabc', 'test-only-key', 123456],
    );
    await adapter.query(
      `INSERT INTO queries
         (team_id, agent_id, query_id, status, prompt, created, owner_kind, owner_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [teamId, agentId, 'query-retained', 'done', 'retained', 123456, 'agent', agentId],
    );
    await adapter.query(
      `INSERT INTO news_items
         (team_id, agent_id, timestamp, type, message, owner_kind, owner_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [teamId, agentId, 123456, 'retained', 'retained', 'agent', agentId],
    );

    await agents.redeploy(agentId, {
      name: 'worker',
      type: 'claude',
      model: 'new-model',
      port: 43111,
      endpoint: 'http://localhost:43111',
      working_directory: '/profile/agents/stable',
      status: 'pending',
      metadata: { durable: true, refreshed: true },
      runtime: 'codex',
      token_id: 'token-1',
      domain: 'worker.example.eth',
    });

    const row = await agents.getById(agentId);
    expect(row).toMatchObject({
      id: agentId,
      port: 43111,
      created_at: 123456,
      working_directory: '/profile/agents/stable',
      model: 'new-model',
      runtime: 'codex',
      status: 'pending',
      metadata: { durable: true, refreshed: true },
    });
    expect((await adapter.query(
      'SELECT COUNT(*) AS count FROM wallets WHERE agent_id = ?',
      [agentId],
    )).rows[0]).toMatchObject({ count: 1 });
    expect((await adapter.query(
      'SELECT COUNT(*) AS count FROM queries WHERE agent_id = ?',
      [agentId],
    )).rows[0]).toMatchObject({ count: 1 });
    expect((await adapter.query(
      'SELECT COUNT(*) AS count FROM news_items WHERE agent_id = ?',
      [agentId],
    )).rows[0]).toMatchObject({ count: 1 });
  });

  it('uses a PostgreSQL UPDATE rather than destructive replacement', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const adapter: DbAdapter = {
      dialect: 'postgres',
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [], rowCount: 1 };
      },
      async close() {},
    };
    const agents = new PgAgentsRepo(adapter);
    await agents.redeploy('agent-stable', {
      name: 'worker',
      type: 'claude',
      model: 'new-model',
      port: 43111,
      endpoint: 'http://localhost:43111',
      working_directory: '/profile/agents/stable',
      status: 'pending',
      metadata: { refreshed: true },
      runtime: 'codex',
      token_id: null,
      domain: null,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/^\s*UPDATE agents/i);
    expect(calls[0].sql).not.toMatch(/\bDELETE\s+FROM|ON CONFLICT/i);
    expect(calls[0].sql).not.toMatch(/created_at\s*=/i);
    expect(calls[0].params?.[0]).toBe('agent-stable');
  });

  it('fails closed when a SQLite redeploy no longer has exactly one target row', async () => {
    const adapter = new SqliteAdapter(':memory:');
    adapters.push(adapter);
    await migrateSqlite(adapter);
    const agents = new SqliteAgentsRepo(adapter);

    await expect(agents.redeploy('missing-agent', {
      name: 'worker',
      type: 'claude',
      model: 'new-model',
      port: 43111,
      endpoint: 'http://localhost:43111',
      working_directory: '/profile/agents/stable',
      status: 'pending',
      metadata: { refreshed: true },
      runtime: 'codex',
      token_id: null,
      domain: null,
    })).rejects.toThrow(/expected one row.*updated 0/i);
  });

  it('fails closed when PostgreSQL reports no redeploy target row', async () => {
    const adapter: DbAdapter = {
      dialect: 'postgres',
      async query() {
        return { rows: [], rowCount: 0 };
      },
      async close() {},
    };
    const agents = new PgAgentsRepo(adapter);

    await expect(agents.redeploy('missing-agent', {
      name: 'worker',
      type: 'claude',
      model: 'new-model',
      port: 43111,
      endpoint: 'http://localhost:43111',
      working_directory: '/profile/agents/stable',
      status: 'pending',
      metadata: { refreshed: true },
      runtime: 'codex',
      token_id: null,
      domain: null,
    })).rejects.toThrow(/expected one row.*updated 0/i);
  });
});
