// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';

describe('QueriesRepo.countActive', () => {
  it('counts pending and processing work across teams but excludes terminal rows', async () => {
    const adapter = new SqliteAdapter(':memory:');
    await migrateSqlite(adapter);
    const agents = new SqliteAgentsRepo(adapter);
    const queries = new SqliteQueriesRepo(adapter);
    const teams = new SqliteTeamsRepo(adapter);
    try {
      const teamA = await teams.getOrCreateTeamId('team-a');
      const teamB = await teams.getOrCreateTeamId('team-b');
      await agents.create({
        team_id: teamA,
        id: 'agent-a',
        name: 'agent-a',
        type: 'claude',
        model: 'test',
        status: 'running',
        created_at: 1,
      });
      await agents.create({
        team_id: teamB,
        id: 'agent-b',
        name: 'agent-b',
        type: 'claude',
        model: 'test',
        status: 'running',
        created_at: 1,
      });
      await queries.create(teamA, 'pending-a', 'agent-a', 'pending', 1);
      await queries.upsert(teamA, 'agent-a', { query_id: 'processing-a', status: 'processing' });
      await queries.upsert(teamB, 'agent-b', { query_id: 'processing-b', status: 'processing' });
      await queries.upsert(teamB, 'agent-b', { query_id: 'done-b', status: 'completed' });

      expect(await queries.countActive()).toBe(3);
    } finally {
      await adapter.close();
    }
  });
});
