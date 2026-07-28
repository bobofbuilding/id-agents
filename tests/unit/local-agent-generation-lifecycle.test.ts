// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteNewsRepo } from '../../src/db/repos/sqlite/news-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { PgAgentsRepo } from '../../src/db/repos/postgres/agents-repo.js';
import { PgQueriesRepo } from '../../src/db/repos/postgres/queries-repo.js';
import { transitionLocalAgentStopState } from '../../src/local-agent-server.js';

async function createInMemoryDb() {
  const adapter = new SqliteAdapter(':memory:');
  await migrateSqlite(adapter);
  return {
    adapter,
    teams: new SqliteTeamsRepo(adapter),
    agents: new SqliteAgentsRepo(adapter),
    queries: new SqliteQueriesRepo(adapter),
    news: new SqliteNewsRepo(adapter),
    async close() { await adapter.close(); },
  };
}

describe('local worker generation lifecycle', () => {
  const databases: Array<Awaited<ReturnType<typeof createInMemoryDb>>> = [];

  afterEach(async () => {
    for (const db of databases.splice(0)) await db.close();
  });

  it('does not let a stale worker stop or cancel work owned by its replacement', async () => {
    const db = await createInMemoryDb();
    databases.push(db);
    const teamId = await db.teams.getOrCreateTeamId('default');
    const agentId = 'agent-generation-stop';
    const replacementGeneration = 'replacement-generation';
    await db.agents.create({
      team_id: teamId,
      id: agentId,
      name: 'generation-stop',
      type: 'claude',
      model: 'gpt-5',
      port: 4101,
      status: 'running',
      created_at: 1,
      runtime: 'codex',
      metadata: {
        pid: 22002,
        processOwner: 'manager-child',
        managerOwnedLaunchIntent: true,
        processGeneration: replacementGeneration,
        processRuntime: 'codex',
        processRuntimeLane: 'codex:default',
      },
    });
    await db.queries.upsert(teamId, agentId, {
      query_id: 'stale-query',
      status: 'pending',
      prompt: 'old generation work',
      created: 10,
      metadata: { processGeneration: 'stale-generation' },
    });
    await db.queries.upsert(teamId, agentId, {
      query_id: 'replacement-query',
      status: 'processing',
      prompt: 'replacement generation work',
      created: 20,
      metadata: { processGeneration: replacementGeneration },
    });
    await db.queries.upsert(teamId, agentId, {
      query_id: 'legacy-untagged-query',
      status: 'pending',
      prompt: 'legacy work without generation ownership',
      created: 30,
    });

    const staleStop = await transitionLocalAgentStopState({
      db: db as any,
      teamId,
      agentId,
      processPid: 22001,
      processGeneration: 'stale-generation',
      completedAt: 100,
    });
    expect(staleStop).toEqual({ accepted: false, queryIds: [] });
    expect((await db.agents.getById(agentId))?.status).toBe('running');
    expect((await db.queries.getById(agentId, 'stale-query'))?.status).toBe('pending');
    expect((await db.queries.getById(agentId, 'replacement-query'))?.status).toBe('processing');
    expect(await db.news.poll(agentId, 0)).toEqual([]);

    const replacementStop = await transitionLocalAgentStopState({
      db: db as any,
      teamId,
      agentId,
      processPid: 22002,
      processGeneration: replacementGeneration,
      restartAfterManagerStart: true,
      completedAt: 200,
    });
    expect(replacementStop).toEqual({
      accepted: true,
      queryIds: ['replacement-query'],
    });
    const stopped = await db.agents.getById(agentId);
    expect(stopped?.status).toBe('offline');
    expect(stopped?.metadata).not.toHaveProperty('processGeneration');
    expect(stopped?.metadata?.managerRestartRequested).toBe(true);
    expect((await db.queries.getById(agentId, 'replacement-query'))?.status).toBe('cancelled');
    expect((await db.queries.getById(agentId, 'stale-query'))?.status).toBe('pending');
    expect((await db.queries.getById(agentId, 'legacy-untagged-query'))?.status).toBe('pending');
    expect(await db.news.poll(agentId, 0)).toEqual([
      expect.objectContaining({
        type: 'query.cancelled',
        query_id: 'replacement-query',
      }),
    ]);
  });

  it('conditions startup and health state writes on the exact generation', async () => {
    const db = await createInMemoryDb();
    databases.push(db);
    const teamId = await db.teams.getOrCreateTeamId('default');
    const agentId = 'agent-generation-state';
    await db.agents.create({
      team_id: teamId,
      id: agentId,
      name: 'generation-state',
      type: 'claude',
      model: 'gpt-5',
      port: 4102,
      status: 'starting',
      created_at: 1,
      runtime: 'codex',
      metadata: {
        managerOwnedLaunchIntent: true,
        processGeneration: 'current-generation',
        processRuntime: 'codex',
        processRuntimeLane: 'codex:default',
      },
    });

    expect(await db.agents.updateOwnedProcessState(
      agentId,
      'stale-generation',
      'offline',
    )).toBe(false);
    expect((await db.agents.getById(agentId))?.status).toBe('starting');

    const committedMetadata = {
      managerOwnedLaunchIntent: true,
      processGeneration: 'current-generation',
      processRuntime: 'codex',
      processRuntimeLane: 'codex:default',
      pid: 23001,
      processOwner: 'manager-child',
    };
    expect(await db.agents.updateOwnedProcessState(
      agentId,
      'current-generation',
      'running',
      committedMetadata,
    )).toBe(true);
    expect(await db.agents.getById(agentId)).toMatchObject({
      status: 'running',
      metadata: committedMetadata,
    });
    await expect(db.agents.updateOwnedProcessState(
      agentId,
      'current-generation',
      'offline',
      { ...committedMetadata, processGeneration: 'different-generation' },
    )).rejects.toThrow(/generation mismatch/);
  });

  it('uses one conditional PostgreSQL statement for state and query cancellation', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const adapter = {
      dialect: 'postgres' as const,
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return sql.includes('RETURNING query_id')
          ? { rows: [{ query_id: 'owned-query' }], rowCount: 1 }
          : { rows: [], rowCount: 1 };
      }),
      close: vi.fn(async () => {}),
    };
    const agents = new PgAgentsRepo(adapter);
    const queries = new PgQueriesRepo(adapter);

    expect(await agents.updateOwnedProcessState(
      'agent-postgres',
      'generation-postgres',
      'offline',
    )).toBe(true);
    expect(await queries.cancelForProcessGeneration(
      'agent-postgres',
      'generation-postgres',
      1234,
    )).toEqual(['owned-query']);

    expect(calls[0].sql).toContain("metadata->>'processGeneration' = $2");
    expect(calls[0].params).toEqual([
      'agent-postgres',
      'generation-postgres',
      'offline',
    ]);
    expect(calls[1].sql).toContain("metadata->>'processGeneration' = $2");
    expect(calls[1].sql).toContain('RETURNING query_id');
    expect(calls[1].params).toEqual([
      'agent-postgres',
      'generation-postgres',
      1234,
    ]);
  });
});
