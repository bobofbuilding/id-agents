// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteNewsRepo } from '../../src/db/repos/sqlite/news-repo.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';

async function freshRepo() {
  const adapter = new SqliteAdapter(':memory:');
  await migrateSqlite(adapter);
  return {
    adapter,
    agents: new SqliteAgentsRepo(adapter),
    news: new SqliteNewsRepo(adapter),
    teams: new SqliteTeamsRepo(adapter),
  };
}

describe('news summary repository reads', () => {
  it('returns bounded metadata without hydrating data payloads', async () => {
    const { adapter, agents, news, teams } = await freshRepo();
    try {
      const teamId = await teams.getOrCreateTeamId('team-1');
      await agents.create({
        team_id: teamId,
        id: 'agent-1',
        name: 'agent-1',
        type: 'claude',
        model: 'test-model',
        status: 'running',
        created_at: 1000,
      });
      await news.add(teamId, 'agent-1', {
        timestamp: 1000,
        type: 'query.completed',
        message: 'x'.repeat(500),
        data: { blob: 'y'.repeat(10000) },
        query_id: 'query_big',
      });

      const rows = await news.pollSummary('agent-1', 0, {
        limit: 1,
        messagePreviewChars: 24,
      });

      expect(rows).toHaveLength(1);
      expect(rows[0].message).toHaveLength(24);
      expect(rows[0].message_length).toBe(500);
      expect(rows[0].has_data).toBe(true);
      expect(rows[0].data_length).toBeGreaterThan(1000);
      expect('data' in rows[0]).toBe(false);
    } finally {
      await adapter.close();
    }
  });
});
