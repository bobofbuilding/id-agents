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
import type { AgentRow, TaskRow } from '../../src/db/types.js';

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

function agentRow(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    team_id: 'team-1',
    id: 'agent-1',
    name: 'coder',
    type: 'claude',
    model: 'sonnet',
    port: 4243,
    endpoint: 'http://127.0.0.1:4243',
    working_directory: null,
    status: 'running',
    created_at: 1,
    registry: null,
    metadata: { pid: 12345, runtime: 'codex', processOwner: 'adopted', processParentPid: 1, processInspectedAt: 1000 },
    deleted_at: null,
    runtime: 'codex',
    token_id: null,
    domain: null,
    api_key: null,
    customer_domain: null,
    public_endpoint_url: null,
    internal_endpoint_url: null,
    ssh_target: null,
    last_seen: null,
    last_probed_at: null,
    last_error: null,
    consecutive_failures: 0,
    ...overrides,
  };
}

describe('AgentManagerDb killAgentProcess guards', () => {
  const workDirs: string[] = [];
  const dbs: Array<Awaited<ReturnType<typeof createInMemoryDb>>> = [];

  afterEach(async () => {
    vi.useRealTimers();
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

  it('serializes concurrent spawn attempts for the same local agent', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const starts: string[] = [];
    let firstStarted!: () => void;
    let releaseFirst!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
    const releaseFirstPromise = new Promise<void>((resolve) => { releaseFirst = resolve; });

    let calls = 0;
    (manager as any).spawnLocalAgentProcessUnlocked = vi.fn(async (_teamId: string, _teamName: string, agentData: { name: string }) => {
      calls += 1;
      starts.push(agentData.name);
      if (calls === 1) {
        firstStarted();
        await releaseFirstPromise;
      }
      return { success: true, pid: 5000 + calls, logFile: `/tmp/${agentData.name}.log` };
    });

    const first = (manager as any).spawnLocalAgentProcess('team-1', 'default', {
      name: 'coder-first',
      id: 'agent-1',
      port: 4243,
    });
    await firstStartedPromise;

    const second = (manager as any).spawnLocalAgentProcess('team-1', 'default', {
      name: 'coder-second',
      id: 'agent-1',
      port: 4243,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(starts).toEqual(['coder-first']);

    releaseFirst();
    await Promise.all([first, second]);

    expect(starts).toEqual(['coder-first', 'coder-second']);
  });

  it('does not expose stale PID metadata for stopped local agents', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const stopped = (manager as any).agentToResponse(agentRow({ status: 'stopped' }));
    expect(stopped.pid).toBeNull();
    expect(stopped.processOwner).toBeNull();
    expect(stopped.processParentPid).toBeNull();
    expect(stopped.metadata).not.toHaveProperty('pid');
    expect(stopped.metadata).not.toHaveProperty('processOwner');
    expect(stopped.metadata).not.toHaveProperty('processParentPid');
    expect(stopped.metadata).not.toHaveProperty('processInspectedAt');

    const running = (manager as any).agentToResponse(agentRow({ status: 'running' }));
    expect(running.pid).toBe(12345);
    expect(running.processOwner).toBe('adopted');
    expect(running.processParentPid).toBe(1);
    expect(running.metadata.pid).toBe(12345);
    expect(running.metadata.processOwner).toBe('adopted');
    expect(running.metadata.processParentPid).toBe(1);

    const invalidOwner = (manager as any).agentToResponse(agentRow({
      status: 'running',
      metadata: { pid: 12345, runtime: 'codex', processOwner: 'other', processParentPid: 1 },
    }));
    expect(invalidOwner.processOwner).toBeNull();
  });

  it('clears all local process metadata together', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const teamId = await db.teams.getOrCreateTeamId('default');
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-process-meta',
        metadata: { pid: 43210, processOwner: 'manager-child', processParentPid: process.pid, processInspectedAt: 2000 },
      }),
    });

    await (manager as any).clearAgentPid('agent-process-meta');

    const row = await db.agents.getById('agent-process-meta');
    expect(row?.metadata).not.toHaveProperty('pid');
    expect(row?.metadata).not.toHaveProperty('processOwner');
    expect(row?.metadata).not.toHaveProperty('processParentPid');
    expect(row?.metadata).not.toHaveProperty('processInspectedAt');
  });

  it('reconciles running local process ownership on startup audit', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const teamId = await db.teams.getOrCreateTeamId('default');
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-adopted',
        name: 'coder',
        port: 4101,
        status: 'running',
        metadata: { pid: 22222, runtime: 'codex' },
      }),
    });
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-stale',
        name: 'researcher',
        port: 4102,
        status: 'running',
        metadata: { pid: 33333, runtime: 'codex', processOwner: 'manager-child', processParentPid: process.pid },
      }),
    });

    (manager as any).inspectProcess = vi.fn((pid: number) => {
      if (pid === 22222) {
        return {
          pid,
          ppid: 1,
          argv0: 'node',
          commandLine: 'node dist/local-agent-server.js coder --team default --port 4101',
        };
      }
      return null;
    });

    await (manager as any).reconcileLocalAgentProcessMetadata();

    const adopted = await db.agents.getById('agent-adopted');
    expect(adopted?.metadata?.pid).toBe(22222);
    expect(adopted?.metadata?.processOwner).toBe('adopted');
    expect(adopted?.metadata?.processParentPid).toBe(1);
    expect(typeof adopted?.metadata?.processInspectedAt).toBe('number');

    const stale = await db.agents.getById('agent-stale');
    expect(stale?.status).toBe('offline');
    expect(stale?.metadata).not.toHaveProperty('pid');
    expect(stale?.metadata).not.toHaveProperty('processOwner');
    expect(stale?.metadata).not.toHaveProperty('processParentPid');
  });

  it('does not park a running agent with pending or processing queries', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const teamId = await db.teams.getOrCreateTeamId('default');
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-active-query',
        name: 'coder',
        port: 4109,
        status: 'running',
        metadata: { runtime: 'codex', pid: 55555, processOwner: 'manager-child', processParentPid: process.pid },
      }),
    });
    await db.queries.upsert(teamId, 'agent-active-query', {
      query_id: 'query-active',
      status: 'processing',
      prompt: 'keep working',
      created: Date.now(),
      owner_kind: 'agent',
      owner_id: 'agent-active-query',
    });

    (manager as any).killAgentProcess = vi.fn(async () => ({ killed: true, pids: [55555] }));

    const result = await (manager as any).parkIdleAgents({
      teamId,
      teamName: 'default',
      confirmed: true,
      allTeams: false,
      includeDefault: true,
      includeLeads: false,
      includeScheduled: false,
      includeActiveTeams: false,
    });

    expect(result.result.parked).toBe(0);
    expect(result.result.agents).toEqual([
      { team: 'default', name: 'coder', status: 'skipped', reason: 'has_1_active_query' },
    ]);
    expect((manager as any).killAgentProcess).not.toHaveBeenCalled();

    const query = await db.queries.getByQueryIdForTeam(teamId, 'query-active');
    const agent = await db.agents.getById('agent-active-query');
    expect(query?.status).toBe('processing');
    expect(agent?.status).toBe('running');
  });

  it('does not park idle helpers in teams that still have open work by default', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const teamId = await db.teams.getOrCreateTeamId('research');
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-idle-helper',
        name: 'analyst',
        port: 4110,
        status: 'running',
        metadata: { runtime: 'codex', pid: 55556, processOwner: 'manager-child', processParentPid: process.pid },
      }),
    });
    const now = Date.now();
    await db.tasks.create({
      id: 'task-open-team',
      name: 'open-team-task',
      uuid: 'open-team-task',
      team_id: teamId,
      title: 'Open team work',
      description: null,
      status: 'todo',
      created_by: null,
      owner: null,
      created_at: now,
      updated_at: now,
      completed_at: null,
    } satisfies TaskRow);

    (manager as any).killAgentProcess = vi.fn(async () => ({ killed: true, pids: [55556] }));

    const result = await (manager as any).parkIdleAgents({
      teamId,
      teamName: 'research',
      confirmed: true,
      allTeams: false,
      includeDefault: false,
      includeLeads: false,
      includeScheduled: false,
      includeActiveTeams: false,
    });

    expect(result.result.parked).toBe(0);
    expect(result.result.agents).toEqual([
      { team: 'research', name: 'analyst', status: 'skipped', reason: 'team_has_1_open_task_requires_--include-active-teams' },
    ]);
    expect((manager as any).killAgentProcess).not.toHaveBeenCalled();
    expect((await db.agents.getById('agent-idle-helper'))?.status).toBe('running');
  });

  it('bounds manager shutdown when the HTTP close callback never fires', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const fakeServer = {
      close: vi.fn(),
      closeIdleConnections: vi.fn(),
      closeAllConnections: vi.fn(),
    };
    (manager as any).httpServer = fakeServer;

    vi.useFakeTimers();
    const shutdown = (manager as any).shutdown();
    await vi.advanceTimersByTimeAsync(3_001);
    await shutdown;

    expect(fakeServer.close).toHaveBeenCalledTimes(1);
    expect(fakeServer.closeIdleConnections).toHaveBeenCalledTimes(1);
    expect(fakeServer.closeAllConnections).toHaveBeenCalledTimes(1);
    expect((manager as any).httpServer).toBeNull();
  });
});
