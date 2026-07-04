// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { AgentManagerDb } from '../../src/agent-manager-db.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteNewsRepo } from '../../src/db/repos/sqlite/news-repo.js';
import { SqliteSchedulesRepo } from '../../src/db/repos/sqlite/schedules-repo.js';
import { SqliteTasksRepo } from '../../src/db/repos/sqlite/tasks-repo.js';

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
    async close() { await adapter.close(); },
  };
}

async function makeManager() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-process-guard-unit-'));
  const db = await createInMemoryDb();
  const manager = new AgentManagerDb(workDir, db as any);
  return { manager, db, workDir };
}

describe('AgentManagerDb killAgentProcess guards', () => {
  const workDirs: string[] = [];
  const dbs: Array<Awaited<ReturnType<typeof createInMemoryDb>>> = [];

  afterEach(async () => {
    while (dbs.length > 0) {
      await dbs.pop()!.close();
    }
    while (workDirs.length > 0) {
      fs.rmSync(workDirs.pop()!, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('skips the manager PID when port discovery includes process.pid', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const agentPid = process.pid + 1000;
    (manager as any).listPidsListeningOnPort = vi.fn(() => [process.pid, agentPid]);
    (manager as any).inspectProcess = vi.fn((pid: number) => {
      if (pid === agentPid) {
        return {
          pid,
          ppid: 1,
          argv0: 'node',
          commandLine: 'node dist/local-agent-server.js coder --port 4101',
        };
      }
      return null;
    });

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const result = await (manager as any).killAgentProcess(4101);

    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(agentPid, 'SIGTERM');
    expect(result).toEqual({ killed: true, pids: [agentPid] });
  });

  it('skips PIDs whose command matches the manager signature', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const candidatePid = process.pid + 2000;
    (manager as any).listPidsListeningOnPort = vi.fn(() => [candidatePid]);
    (manager as any).inspectProcess = vi.fn(() => ({
      pid: candidatePid,
      ppid: 1,
      argv0: 'node',
      commandLine: 'node dist/start-agent-manager.js --port 4100',
    }));

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const result = await (manager as any).killAgentProcess(4100);

    expect(killSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ killed: false, pids: [] });
  });

  it('kills daemon-spawned local agent servers even when the manager is their parent', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const agentPid = process.pid + 3000;
    (manager as any).listPidsListeningOnPort = vi.fn(() => [agentPid]);
    (manager as any).inspectProcess = vi.fn(() => ({
      pid: agentPid,
      ppid: process.pid,
      argv0: 'node',
      commandLine: 'node dist/local-agent-server.js cto --port 4106',
    }));

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const result = await (manager as any).killAgentProcess(4106);

    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(agentPid, 'SIGTERM');
    expect(result).toEqual({ killed: true, pids: [agentPid] });
  });

  it('rejects /ask before dispatch when the target agent queue hits the default cap', async () => {
    const saved = process.env.ID_MAX_ACTIVE_QUERIES_PER_AGENT;
    delete process.env.ID_MAX_ACTIVE_QUERIES_PER_AGENT;
    try {
      const { manager, db, workDir } = await makeManager();
      dbs.push(db);
      workDirs.push(workDir);

      const teamId = await db.teams.getOrCreateTeamId('default');
      await db.agents.create({
        team_id: teamId,
        id: 'agent-busy',
        name: 'busy-lead',
        type: 'claude',
        model: 'sonnet',
        status: 'running',
        created_at: Date.now(),
        port: 4112,
        endpoint: 'http://127.0.0.1:4112',
        metadata: { local: true },
      });
      const now = Date.now();
      for (const [idx, status] of ['processing', 'pending', 'pending'].entries()) {
        await db.queries.upsert(teamId, 'agent-busy', {
          query_id: `busy-${idx}`,
          status,
          prompt: `queued work ${idx}`,
          created: now,
          owner_kind: 'agent',
          owner_id: 'agent-busy',
        });
      }
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const result = await (manager as any).executeRemoteCommand('/ask busy-lead do one more thing', teamId, 'default');

      expect(result.ok).toBe(false);
      expect(result.error).toContain('already has 3 active queries');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      if (saved === undefined) delete process.env.ID_MAX_ACTIVE_QUERIES_PER_AGENT;
      else process.env.ID_MAX_ACTIVE_QUERIES_PER_AGENT = saved;
    }
  });
});
