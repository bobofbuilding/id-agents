// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import { AgentManagerDb } from '../../src/agent-manager-db.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteNewsRepo } from '../../src/db/repos/sqlite/news-repo.js';
import { SqliteSchedulesRepo } from '../../src/db/repos/sqlite/schedules-repo.js';
import { SqliteTasksRepo } from '../../src/db/repos/sqlite/tasks-repo.js';
import { SqliteEventsRepo } from '../../src/db/repos/sqlite/events-repo.js';
import { SqliteCheckinsRepo } from '../../src/db/repos/sqlite/checkins-repo.js';

async function createInMemoryDb() {
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
    checkins: new SqliteCheckinsRepo(adapter),
    async close() { await adapter.close(); },
  };
}

async function listenOnFreePort(): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test port');
  return { server, port: address.port };
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

describe('AgentManagerDb startup port guard', () => {
  const workDirs: string[] = [];
  const dbs: Array<Awaited<ReturnType<typeof createInMemoryDb>>> = [];

  afterEach(async () => {
    while (dbs.length > 0) {
      await dbs.pop()!.close();
    }
    for (const dir of workDirs.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('rejects occupied manager ports before installing startup services', async () => {
    const { server: blocker, port } = await listenOnFreePort();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-port-guard-'));
    workDirs.push(workDir);
    const manager = new AgentManagerDb(workDir, {} as any, { libraryRoot: null }) as any;
    const reconcileSpy = vi.spyOn(manager, 'reconcileDefaultCoderRuntimeFromConfig');

    try {
      const started = manager.start(port);
      await expect(started).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(manager.schedulerService).toBeNull();
      expect(manager.checkinService).toBeNull();
      expect(reconcileSpy).not.toHaveBeenCalled();
    } finally {
      reconcileSpy.mockRestore();
      await manager.shutdown();
      await closeServer(blocker);
    }
  });

  it('hands the selected Manager port to workers and accepts activity/task callbacks there', async () => {
    const { server: reservation, port } = await listenOnFreePort();
    await closeServer(reservation);
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-worker-port-'));
    workDirs.push(workDir);
    const db = await createInMemoryDb();
    dbs.push(db);
    const manager = new AgentManagerDb(workDir, db as any, { libraryRoot: null }) as any;
    const teamId = await db.teams.getOrCreateTeamId('default');
    const now = Math.floor(Date.now() / 1000);
    await db.agents.create({
      team_id: teamId,
      id: 'callback-worker',
      name: 'callback-worker',
      type: 'interactive',
      model: 'test',
      status: 'active',
      created_at: now,
      metadata: {},
      runtime: 'codex',
    });
    await db.tasks.create({
      id: 'callback-task-id',
      name: 'callback-task',
      uuid: crypto.randomUUID(),
      team_id: teamId,
      title: 'Verify random-port callbacks',
      description: 'Exercise the worker callback URL selected by the Manager.',
      status: 'todo',
      created_by: null,
      owner: null,
      created_at: now,
      updated_at: now,
      completed_at: null,
    });

    try {
      await manager.start(port);
      const env = manager.buildLocalAgentEnv(
        teamId,
        'default',
        port + 1,
        { runtime: 'codex', metadata: {} },
      );

      expect(env.MANAGER_URL).toBe(`http://127.0.0.1:${port}`);
      expect(env.MANAGER_URL).not.toBe('http://127.0.0.1:4100');

      const activity = await fetch(`${env.MANAGER_URL}/activity/record`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agent: 'callback-worker',
          team: 'default',
          summary: 'random-port callback reached the live Manager',
        }),
      });
      expect(activity.status).toBe(200);

      const claim = await fetch(`${env.MANAGER_URL}/tasks/callback-task/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-id-team': 'default' },
        body: JSON.stringify({ agent_id: 'callback-worker' }),
      });
      expect(claim.status).toBe(200);
      expect((await db.tasks.getByNameForTeam('callback-task', teamId))?.owner).toBe('callback-worker');

      const done = await fetch(`${env.MANAGER_URL}/tasks/callback-task/done`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-id-team': 'default' },
        body: JSON.stringify({
          agent_id: 'callback-worker',
          acceptance_coverage: 'activity and task callbacks both reached the selected Manager port',
        }),
      });
      expect(done.status).toBe(200);
      expect((await db.tasks.getByNameForTeam('callback-task', teamId))?.status).toBe('done');
    } finally {
      await manager.shutdown();
    }
  });
});
