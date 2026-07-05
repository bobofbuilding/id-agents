// SPDX-License-Identifier: MIT

import { randomUUID } from 'crypto';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteTasksRepo } from '../../src/db/repos/sqlite/tasks-repo.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import type { TaskRow } from '../../src/db/types.js';

function task(overrides: Partial<TaskRow> & { team_id: string; name: string }): TaskRow {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: `task_${overrides.name}`,
    name: overrides.name,
    uuid: randomUUID(),
    team_id: overrides.team_id,
    title: overrides.title ?? overrides.name,
    description: null,
    status: 'todo',
    created_by: null,
    owner: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
    ...overrides,
  };
}

describe('TasksRepository claim doing limit', () => {
  let adapter: SqliteAdapter;
  let agents: SqliteAgentsRepo;
  let teams: SqliteTeamsRepo;
  let tasks: SqliteTasksRepo;

  beforeEach(async () => {
    adapter = new SqliteAdapter(':memory:');
    await migrateSqlite(adapter);
    agents = new SqliteAgentsRepo(adapter);
    teams = new SqliteTeamsRepo(adapter);
    tasks = new SqliteTasksRepo(adapter);
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('leaves a todo task unclaimed when its team is at the doing cap', async () => {
    const teamId = await teams.getOrCreateTeamId('limit-team');
    await agents.create({
      team_id: teamId,
      id: 'agent-c',
      name: 'agent-c',
      type: 'claude',
      model: 'sonnet',
      status: 'running',
      created_at: Math.floor(Date.now() / 1000),
    });

    await tasks.create(task({ team_id: teamId, name: 'doing-a', status: 'doing' }));
    await tasks.create(task({ team_id: teamId, name: 'doing-b', status: 'doing' }));
    await tasks.create(task({ team_id: teamId, name: 'waiting' }));

    const waiting = await tasks.getByNameForTeam('waiting', teamId);
    const claimed = await tasks.claim(waiting!.id, 'agent-c', Math.floor(Date.now() / 1000), {
      maxDoingForTeam: 2,
    });

    expect(claimed).toBe(false);
    const after = await tasks.getByNameForTeam('waiting', teamId);
    expect(after?.status).toBe('todo');
    expect(after?.owner).toBeNull();
  });

  it('counts doing tasks per team when enforcing the cap', async () => {
    const teamA = await teams.getOrCreateTeamId('team-a');
    const teamB = await teams.getOrCreateTeamId('team-b');
    await agents.create({
      team_id: teamB,
      id: 'agent-b',
      name: 'agent-b',
      type: 'claude',
      model: 'sonnet',
      status: 'running',
      created_at: Math.floor(Date.now() / 1000),
    });

    await tasks.create(task({ team_id: teamA, name: 'team-a-doing', status: 'doing' }));
    await tasks.create(task({ team_id: teamB, name: 'team-b-waiting' }));

    const waiting = await tasks.getByNameForTeam('team-b-waiting', teamB);
    const claimed = await tasks.claim(waiting!.id, 'agent-b', Math.floor(Date.now() / 1000), {
      maxDoingForTeam: 1,
    });

    expect(claimed).toBe(true);
    const after = await tasks.getByNameForTeam('team-b-waiting', teamB);
    expect(after?.status).toBe('doing');
    expect(after?.owner).toBe('agent-b');
  });

  it('can list the oldest updated tasks first with a limit', async () => {
    const teamId = await teams.getOrCreateTeamId('scan-team');
    await tasks.create(task({ team_id: teamId, name: 'newest', updated_at: 30 }));
    await tasks.create(task({ team_id: teamId, name: 'oldest', updated_at: 10 }));
    await tasks.create(task({ team_id: teamId, name: 'middle', updated_at: 20 }));

    const rows = await tasks.list({
      teamId,
      status: 'todo',
      order: 'updated_asc',
      limit: 2,
    });

    expect(rows.map((row) => row.name)).toEqual(['oldest', 'middle']);
  });
});
