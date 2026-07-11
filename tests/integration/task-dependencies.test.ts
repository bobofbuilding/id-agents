// SPDX-License-Identifier: MIT

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { AgentManagerDb } from '../../src/agent-manager-db.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteCheckinsRepo } from '../../src/db/repos/sqlite/checkins-repo.js';
import { SqliteEventsRepo } from '../../src/db/repos/sqlite/events-repo.js';
import { SqliteNewsRepo } from '../../src/db/repos/sqlite/news-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteRuntimeLaneCooldownsRepo } from '../../src/db/repos/sqlite/runtime-lane-cooldowns-repo.js';
import { SqliteSchedulesRepo } from '../../src/db/repos/sqlite/schedules-repo.js';
import { SqliteSubscriptionsRepo } from '../../src/db/repos/sqlite/subscriptions-repo.js';
import { SqliteTasksRepo } from '../../src/db/repos/sqlite/tasks-repo.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import type { TaskRow } from '../../src/db/types.js';

const TEAM = 'task-dependencies-test';

async function createDb() {
  const adapter = new SqliteAdapter(':memory:');
  await migrateSqlite(adapter);
  return {
    adapter,
    teams: new SqliteTeamsRepo(adapter),
    agents: new SqliteAgentsRepo(adapter),
    queries: new SqliteQueriesRepo(adapter),
    news: new SqliteNewsRepo(adapter),
    schedules: new SqliteSchedulesRepo(adapter),
    tasks: new SqliteTasksRepo(adapter),
    events: new SqliteEventsRepo(adapter),
    subscriptions: new SqliteSubscriptionsRepo(adapter),
    checkins: new SqliteCheckinsRepo(adapter),
    runtimeLaneCooldowns: new SqliteRuntimeLaneCooldownsRepo(adapter),
    async close() { await adapter.close(); },
  };
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      server.close(() => resolve(address.port));
    });
    server.on('error', reject);
  });
}

async function stopManager(manager: AgentManagerDb): Promise<void> {
  await new Promise<void>((resolve) => {
    (manager as any).httpServer?.close(() => resolve());
    setTimeout(resolve, 200);
  });
}

function adminHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Id-Team': TEAM, 'X-Id-Admin': '1' };
}

function task(overrides: Partial<TaskRow> & Pick<TaskRow, 'name' | 'team_id'>): TaskRow {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: `task_${crypto.randomUUID()}`,
    name: overrides.name,
    uuid: crypto.randomUUID(),
    team_id: overrides.team_id,
    title: overrides.name,
    description: null,
    depends_on: [],
    status: 'todo',
    created_by: null,
    owner: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
    ...overrides,
  };
}

async function withBriefValidationOff<T>(fn: () => Promise<T>): Promise<T> {
  const prior = process.env.ID_TASK_BRIEF_VALIDATION;
  process.env.ID_TASK_BRIEF_VALIDATION = 'off';
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env.ID_TASK_BRIEF_VALIDATION;
    else process.env.ID_TASK_BRIEF_VALIDATION = prior;
  }
}

describe('task dependencies', () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createDb>>;
  let baseUrl: string;
  let workDir: string;
  let teamId: string;
  let coderId: string;

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-dependencies-'));
    db = await createDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);

    teamId = await db.teams.getOrCreateTeamId(TEAM);
    coderId = `agent_${crypto.randomUUID()}`;
    await db.agents.create({
      id: coderId,
      team_id: teamId,
      name: 'coder',
      type: 'persistent',
      model: 'test',
      status: 'active',
      created_at: Date.now(),
    });
  });

  afterAll(async () => {
    if (manager) await stopManager(manager);
    await db?.close();
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    await db.adapter.query('DELETE FROM checkins');
    await db.adapter.query('DELETE FROM tasks');
    await db.adapter.query('DELETE FROM event_log');
    await db.adapter.query('DELETE FROM queries');
  });

  it('parses repeated --depends-on values, blocks partial dependencies, then closes after all are done', async () => {
    await withBriefValidationOff(async () => {
      const completed = task({ name: 'completed-dependency', team_id: teamId, status: 'done', completed_at: 1 });
      const open = task({ name: 'open-dependency', team_id: teamId });
      await db.tasks.create(completed);
      await db.tasks.create(open);

      const created = await (manager as any).executeRemoteCommand(
        '/task create "Dependent task" --name dependent-task --depends-on completed-dependency --depends-on open-dependency',
        teamId,
        TEAM,
      );
      expect(created.ok).toBe(true);
      expect(created.result.task.dependsOn).toEqual(['completed-dependency', 'open-dependency']);

      const blockedClaim = await fetch(`${baseUrl}/tasks/dependent-task/claim`, {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ agent_id: 'coder' }),
      });
      expect(blockedClaim.status).toBe(409);
      await expect(blockedClaim.json()).resolves.toMatchObject({
        error: 'task_dependency_incomplete',
        blocking_dependencies: ['open-dependency'],
      });

      const dependentBefore = await db.tasks.getByNameForTeam('dependent-task', teamId);
      expect(dependentBefore?.status).toBe('todo');

      const now = Math.floor(Date.now() / 1000);
      await db.tasks.updateFields(dependentBefore!.id, {
        owner: coderId,
        status: 'doing',
        updated_at: now,
      });
      const blockedDone = await fetch(`${baseUrl}/tasks/dependent-task/done`, {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ agent_id: 'coder', failure_note: 'must remain blocked' }),
      });
      expect(blockedDone.status).toBe(409);
      await expect(blockedDone.json()).resolves.toMatchObject({
        error: 'task_dependency_incomplete',
        blocking_dependencies: ['open-dependency'],
      });

      await db.tasks.updateFields(dependentBefore!.id, {
        owner: null,
        status: 'todo',
        completed_at: null,
        updated_at: now,
      });
      await db.tasks.updateFields(open.id, { status: 'done', completed_at: now, updated_at: now });

      const claimed = await fetch(`${baseUrl}/tasks/dependent-task/claim`, {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ agent_id: 'coder' }),
      });
      expect(claimed.status).toBe(200);

      const done = await fetch(`${baseUrl}/tasks/dependent-task/done`, {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ agent_id: 'coder', failure_note: 'dependency work completed' }),
      });
      expect(done.status).toBe(200);
      expect((await db.tasks.getByNameForTeam('dependent-task', teamId))?.status).toBe('done');
    });
  });

  it('returns a clean dependency error for a removed or nonexistent dependency on both claim and done', async () => {
    await withBriefValidationOff(async () => {
      const blocked = task({
        name: 'missing-dependency-task',
        team_id: teamId,
        depends_on: ['removed-prerequisite'],
      });
      await db.tasks.create(blocked);

      const claim = await fetch(`${baseUrl}/tasks/missing-dependency-task/claim`, {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ agent_id: 'coder' }),
      });
      expect(claim.status).toBe(409);
      await expect(claim.json()).resolves.toMatchObject({
        error: 'task_dependency_incomplete',
        blocking_dependencies: ['removed-prerequisite (missing)'],
      });

      const now = Math.floor(Date.now() / 1000);
      await db.tasks.updateFields(blocked.id, {
        owner: coderId,
        status: 'doing',
        updated_at: now,
      });
      const done = await fetch(`${baseUrl}/tasks/missing-dependency-task/done`, {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ agent_id: 'coder', failure_note: 'should remain blocked' }),
      });
      expect(done.status).toBe(409);
      await expect(done.json()).resolves.toMatchObject({
        error: 'task_dependency_incomplete',
        blocking_dependencies: ['removed-prerequisite (missing)'],
      });
      expect((await db.tasks.getByNameForTeam('missing-dependency-task', teamId))?.status).toBe('doing');
    });
  });
});
