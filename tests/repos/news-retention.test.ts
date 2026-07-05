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

async function createAgent(agents: SqliteAgentsRepo, teamId: string, id: string) {
  await agents.create({
    team_id: teamId,
    id,
    name: id,
    type: 'claude',
    model: 'test-model',
    status: 'running',
    created_at: 1000,
  });
}

describe('news retention repository writes', () => {
  it('prunes old and over-cap news rows per team', async () => {
    const { adapter, agents, news, teams } = await freshRepo();
    try {
      const teamA = await teams.getOrCreateTeamId('team-a');
      const teamB = await teams.getOrCreateTeamId('team-b');
      await createAgent(agents, teamA, 'agent-a');
      await createAgent(agents, teamB, 'agent-b');

      await news.add(teamA, 'agent-a', { timestamp: 1000, type: 'old-a-1' });
      await news.add(teamA, 'agent-a', { timestamp: 2000, type: 'old-a-2' });
      await news.add(teamA, 'agent-a', { timestamp: 3000, type: 'mid-a-1' });
      await news.add(teamA, 'agent-a', { timestamp: 4000, type: 'mid-a-2' });
      await news.add(teamB, 'agent-b', { timestamp: 1000, type: 'old-b' });

      expect(await news.pruneByAge(teamA, 2500)).toBe(2);
      expect(await news.countForTeam(teamA)).toBe(2);
      expect(await news.countForTeam(teamB)).toBe(1);

      await news.add(teamA, 'agent-a', { timestamp: 5000, type: 'new-a-1' });
      await news.add(teamA, 'agent-a', { timestamp: 6000, type: 'new-a-2' });

      expect(await news.pruneByCount(teamA, 2)).toBe(2);
      expect(await news.countForTeam(teamA)).toBe(2);
      expect(await news.countForTeam(teamB)).toBe(1);

      const kept = await news.poll('agent-a', 0);
      expect(kept.map((row) => row.type)).toEqual(['new-a-2', 'new-a-1']);
    } finally {
      await adapter.close();
    }
  });
});
