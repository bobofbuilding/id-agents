// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';

describe('runtime session ownership upgrade query', () => {
  it('excludes external XMTP sessions while retaining exact completed agent sessions', async () => {
    const adapter = new SqliteAdapter(':memory:');
    await migrateSqlite(adapter);
    const teams = new SqliteTeamsRepo(adapter);
    const agents = new SqliteAgentsRepo(adapter);
    const queries = new SqliteQueriesRepo(adapter);
    try {
      const teamId = await teams.getOrCreateTeamId('session-upgrade');
      await agents.create({
        team_id: teamId,
        id: 'agent-exact',
        name: 'agent-exact',
        type: 'claude',
        model: 'test',
        status: 'running',
        created_at: 1,
      });
      await adapter.query(
        `INSERT INTO queries
           (team_id, agent_id, query_id, status, prompt, created, completed, session_id, owner_kind, owner_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          teamId,
          'agent-exact',
          'desktop-query',
          'completed',
          'operator turn',
          10,
          20,
          'owned-desktop-session',
          'agent',
          'agent-exact',
        ],
      );
      await adapter.query(
        `INSERT INTO queries
           (team_id, agent_id, query_id, status, prompt, created, completed, session_id, owner_kind, owner_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          teamId,
          'agent-exact',
          'xmtp_historical_external',
          'completed',
          'external turn',
          11,
          21,
          'external-session-must-not-be-owned',
          'agent',
          'agent-exact',
        ],
      );

      await expect(
        queries.listRecentCompletedSessionIds(teamId, 'agent-exact', 500),
      ).resolves.toEqual(['owned-desktop-session']);
    } finally {
      await adapter.close();
    }
  });
});
