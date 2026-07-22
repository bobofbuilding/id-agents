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

  it('persists assignment lineage atomically with a successful claim', async () => {
    const teamId = await teams.getOrCreateTeamId('lineage-team');
    await agents.create({
      team_id: teamId,
      id: 'agent-lineage',
      name: 'agent-lineage',
      type: 'claude',
      model: 'sonnet',
      status: 'running',
      created_at: 1,
    });
    await tasks.create(task({
      team_id: teamId,
      name: 'lineage-task',
      workflow_state: 'queued',
      workflow_contract: { version: 'task-workflow.v1', goal_id: 'goal-1' },
    }));

    const row = await tasks.getByNameForTeam('lineage-task', teamId);
    const claimed = await tasks.claim(row!.id, 'agent-lineage', 100, {
      maxDoingForTeam: 2,
      workflow: {
        assignmentId: 'assignment-1',
        lineage: { version: 'delegation-lineage.v1', route: 'test' },
      },
    });

    expect(claimed).toBe(true);
    const persisted = await tasks.getByNameForTeam('lineage-task', teamId);
    expect(persisted?.status).toBe('doing');
    expect(persisted?.workflow_state).toBe('executing');
    expect(persisted?.assignment_id).toBe('assignment-1');
    expect(persisted?.delegation_lineage).toEqual({ version: 'delegation-lineage.v1', route: 'test' });
    expect(persisted?.workflow_contract).toEqual({ version: 'task-workflow.v1', goal_id: 'goal-1' });
  });

  it('moves a claimed task into executing even without workflow metadata', async () => {
    const teamId = await teams.getOrCreateTeamId('plain-claim-team');
    await agents.create({
      team_id: teamId,
      id: 'plain-agent',
      name: 'plain-agent',
      type: 'claude',
      model: 'sonnet',
      status: 'running',
      created_at: 1,
    });
    await tasks.create(task({
      team_id: teamId,
      name: 'plain-claim',
      workflow_state: 'queued',
      blocked_detail: { version: 'task-blocker.v1', reason: 'old blocker' },
    }));

    const row = await tasks.getByNameForTeam('plain-claim', teamId);
    expect(await tasks.claim(row!.id, 'plain-agent', 100)).toBe(true);

    const claimed = await tasks.getByNameForTeam('plain-claim', teamId);
    expect(claimed).toMatchObject({
      status: 'doing',
      owner: 'plain-agent',
      workflow_state: 'executing',
      lifecycle_updated_at: 100,
      blocked_detail: null,
    });
  });

  it('normalizes terminal status updates and clears stale blockers', async () => {
    const teamId = await teams.getOrCreateTeamId('terminal-team');
    await tasks.create(task({
      team_id: teamId,
      name: 'terminal-task',
      status: 'doing',
      workflow_state: 'executing',
      blocked_detail: { version: 'task-blocker.v1', reason: 'stale blocker' },
    }));

    const row = await tasks.getByNameForTeam('terminal-task', teamId);
    await tasks.updateFields(row!.id, {
      status: 'done',
      completed_at: 120,
      updated_at: 120,
    });

    const completed = await tasks.getByNameForTeam('terminal-task', teamId);
    expect(completed).toMatchObject({
      status: 'done',
      workflow_state: 'validated',
      lifecycle_updated_at: 120,
      blocked_detail: null,
    });
  });

  it('clears stale blockers on an explicit executing transition', async () => {
    const teamId = await teams.getOrCreateTeamId('explicit-executing-team');
    await agents.create({
      team_id: teamId,
      id: 'explicit-worker',
      name: 'explicit-worker',
      type: 'claude',
      model: 'sonnet',
      status: 'running',
      created_at: 1,
    });
    await tasks.create(task({
      team_id: teamId,
      name: 'explicit-executing-task',
      status: 'todo',
      workflow_state: 'blocked',
      blocked_detail: { version: 'task-blocker.v1', reason: 'old transport blocker' },
    }));

    const row = await tasks.getByNameForTeam('explicit-executing-task', teamId);
    await tasks.updateFields(row!.id, {
      status: 'doing',
      workflow_state: 'executing',
      owner: 'explicit-worker',
      updated_at: 130,
    });

    const executing = await tasks.getByNameForTeam('explicit-executing-task', teamId);
    expect(executing).toMatchObject({
      status: 'doing',
      workflow_state: 'executing',
      owner: 'explicit-worker',
      lifecycle_updated_at: 130,
      blocked_detail: null,
    });
  });

  it('releases an unchanged claim after dispatch rejection', async () => {
    const teamId = await teams.getOrCreateTeamId('release-team');
    await agents.create({
      team_id: teamId,
      id: 'agent-release',
      name: 'agent-release',
      type: 'claude',
      model: 'sonnet',
      status: 'running',
      created_at: Math.floor(Date.now() / 1000),
    });
    await tasks.create(task({ team_id: teamId, name: 'release-me' }));

    const row = await tasks.getByNameForTeam('release-me', teamId);
    expect(await tasks.claim(row!.id, 'agent-release', 100)).toBe(true);
    expect(await tasks.releaseClaim(row!.id, 'agent-release', 100, 101)).toBe(true);

    const released = await tasks.getByNameForTeam('release-me', teamId);
    expect(released?.status).toBe('todo');
    expect(released?.owner).toBeNull();
    expect(released?.updated_at).toBe(101);
    expect(released?.workflow_state).toBe('queued');
    expect(released?.assignment_id).toBeNull();
  });

  it('does not release a claim that changed after dispatch', async () => {
    const teamId = await teams.getOrCreateTeamId('changed-release-team');
    await agents.create({
      team_id: teamId,
      id: 'agent-release',
      name: 'agent-release',
      type: 'claude',
      model: 'sonnet',
      status: 'running',
      created_at: Math.floor(Date.now() / 1000),
    });
    await tasks.create(task({ team_id: teamId, name: 'keep-claim' }));

    const row = await tasks.getByNameForTeam('keep-claim', teamId);
    expect(await tasks.claim(row!.id, 'agent-release', 100)).toBe(true);
    await tasks.updateFields(row!.id, { updated_at: 101 });

    expect(await tasks.releaseClaim(row!.id, 'agent-release', 100, 102)).toBe(false);
    const retained = await tasks.getByNameForTeam('keep-claim', teamId);
    expect(retained?.status).toBe('doing');
    expect(retained?.owner).toBe('agent-release');
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

  it('filters workflow state before applying the scan limit', async () => {
    const teamId = await teams.getOrCreateTeamId('workflow-scan-team');
    for (let index = 0; index < 4; index += 1) {
      await tasks.create(task({
        team_id: teamId,
        name: `validated-${index}`,
        status: 'done',
        workflow_state: 'validated',
        updated_at: index + 1,
      }));
    }
    await tasks.create(task({
      team_id: teamId,
      name: 'pending-validation',
      status: 'done',
      workflow_state: 'validation_pending',
      updated_at: 10,
    }));

    const rows = await tasks.list({
      teamId,
      status: 'done',
      workflowState: 'validation_pending',
      order: 'updated_asc',
      limit: 2,
    });

    expect(rows.map((row) => row.name)).toEqual(['pending-validation']);
  });

  it('can select legacy rows with no workflow state', async () => {
    const teamId = await teams.getOrCreateTeamId('legacy-workflow-team');
    await tasks.create(task({
      team_id: teamId,
      name: 'legacy-active',
      status: 'doing',
      workflow_state: null,
    }));
    await tasks.create(task({
      team_id: teamId,
      name: 'modern-active',
      status: 'doing',
      workflow_state: 'executing',
    }));

    const rows = await tasks.list({
      teamId,
      status: 'doing',
      workflowState: null,
    });

    expect(rows.map((row) => row.name)).toEqual(['legacy-active']);
  });
});
