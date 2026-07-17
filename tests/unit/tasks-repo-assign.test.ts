// SPDX-License-Identifier: MIT
/**
 * Regression coverage for `TasksRepository.assignAtomic` — the CAS-guarded
 * write behind `/task assign` (src/agent-manager-db.ts). Proves a dispatch
 * cannot silently overwrite a task that changed (claimed, completed, or
 * reassigned) since the caller last read it, which is the concrete
 * "stranding by race" scenario the atomic assign path closes.
 */

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

describe('TasksRepository.assignAtomic', () => {
  let adapter: SqliteAdapter;
  let agents: SqliteAgentsRepo;
  let teams: SqliteTeamsRepo;
  let tasks: SqliteTasksRepo;
  let teamId: string;

  beforeEach(async () => {
    adapter = new SqliteAdapter(':memory:');
    await migrateSqlite(adapter);
    agents = new SqliteAgentsRepo(adapter);
    teams = new SqliteTeamsRepo(adapter);
    tasks = new SqliteTasksRepo(adapter);
    teamId = await teams.getOrCreateTeamId('assign-atomic-team');
    for (const name of ['agent-a', 'agent-b']) {
      await agents.create({
        team_id: teamId,
        id: name,
        name,
        type: 'claude',
        model: 'sonnet',
        status: 'running',
        created_at: Math.floor(Date.now() / 1000),
      });
    }
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('assigns a todo task when the expected status/owner still match', async () => {
    await tasks.create(task({ team_id: teamId, name: 'fresh' }));
    const before = await tasks.getByNameForTeam('fresh', teamId);

    const assigned = await tasks.assignAtomic(before!.id, 'agent-a', Math.floor(Date.now() / 1000), {
      status: before!.status,
      owner: before!.owner,
    });

    expect(assigned).toBe(true);
    const after = await tasks.getByNameForTeam('fresh', teamId);
    expect(after?.status).toBe('doing');
    expect(after?.owner).toBe('agent-a');
  });

  it('rejects the assignment without mutating anything when the task changed since it was read', async () => {
    await tasks.create(task({ team_id: teamId, name: 'raced' }));
    const before = await tasks.getByNameForTeam('raced', teamId);

    // Simulate a concurrent claim landing between the caller's read and its
    // assign write — the exact TOCTOU window assignAtomic guards against.
    const claimed = await tasks.claim(before!.id, 'agent-b', Math.floor(Date.now() / 1000));
    expect(claimed).toBe(true);

    const assigned = await tasks.assignAtomic(before!.id, 'agent-a', Math.floor(Date.now() / 1000), {
      status: before!.status, // stale: still 'todo'
      owner: before!.owner, // stale: still null
    });

    expect(assigned).toBe(false);
    const after = await tasks.getByNameForTeam('raced', teamId);
    // Ownership from the concurrent claim must survive untouched — the
    // stale assign must not have stomped it.
    expect(after?.status).toBe('doing');
    expect(after?.owner).toBe('agent-b');
  });

  it('allows reassigning an already-doing task when the expected owner/status match (admin override)', async () => {
    await tasks.create(task({ team_id: teamId, name: 'owned', status: 'doing', owner: 'agent-a' }));
    const before = await tasks.getByNameForTeam('owned', teamId);

    const reassigned = await tasks.assignAtomic(before!.id, 'agent-b', Math.floor(Date.now() / 1000), {
      status: before!.status,
      owner: before!.owner,
    });

    expect(reassigned).toBe(true);
    const after = await tasks.getByNameForTeam('owned', teamId);
    expect(after?.status).toBe('doing');
    expect(after?.owner).toBe('agent-b');
  });

  it('rejects a reassignment guarded by a stale expected owner', async () => {
    await tasks.create(task({ team_id: teamId, name: 'contested', status: 'doing', owner: 'agent-a' }));
    const before = await tasks.getByNameForTeam('contested', teamId);

    // Another assign already moved ownership to agent-b before this caller's
    // (stale) write attempt lands.
    const firstAssign = await tasks.assignAtomic(before!.id, 'agent-b', Math.floor(Date.now() / 1000), {
      status: before!.status,
      owner: before!.owner,
    });
    expect(firstAssign).toBe(true);

    const staleAssign = await tasks.assignAtomic(before!.id, 'agent-a', Math.floor(Date.now() / 1000), {
      status: before!.status, // stale expected owner: 'agent-a', now 'agent-b'
      owner: before!.owner,
    });

    expect(staleAssign).toBe(false);
    const after = await tasks.getByNameForTeam('contested', teamId);
    expect(after?.owner).toBe('agent-b');
  });

  it('only lets one of two concurrent assigns to the same stale read win', async () => {
    await tasks.create(task({ team_id: teamId, name: 'concurrent' }));
    const before = await tasks.getByNameForTeam('concurrent', teamId);

    const [a, b] = await Promise.all([
      tasks.assignAtomic(before!.id, 'agent-a', Math.floor(Date.now() / 1000), {
        status: before!.status,
        owner: before!.owner,
      }),
      tasks.assignAtomic(before!.id, 'agent-b', Math.floor(Date.now() / 1000), {
        status: before!.status,
        owner: before!.owner,
      }),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
    const after = await tasks.getByNameForTeam('concurrent', teamId);
    expect(after?.status).toBe('doing');
    expect(['agent-a', 'agent-b']).toContain(after?.owner);
  });
});
