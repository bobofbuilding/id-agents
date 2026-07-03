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
import { SqliteEventsRepo } from '../../src/db/repos/sqlite/events-repo.js';
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
    events: new SqliteEventsRepo(adapter),
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

  it('expires stale pending backlog sooner than long-running processing queries', async () => {
    const savedEnv = {
      legacy: process.env.ID_QUERY_EXPIRY_MINUTES,
      pending: process.env.ID_PENDING_QUERY_EXPIRY_MINUTES,
      processing: process.env.ID_PROCESSING_QUERY_EXPIRY_MINUTES,
    };
    delete process.env.ID_QUERY_EXPIRY_MINUTES;
    delete process.env.ID_PENDING_QUERY_EXPIRY_MINUTES;
    delete process.env.ID_PROCESSING_QUERY_EXPIRY_MINUTES;

    try {
      const { manager, db, workDir } = await makeManager();
      dbs.push(db);
      workDirs.push(workDir);

      const teamId = await db.teams.getOrCreateTeamId('ops-team');
      await db.agents.create({
        ...agentRow({
          team_id: teamId,
          id: 'ops-lead-agent',
          name: 'ops-lead',
          port: 4111,
          status: 'running',
        }),
      });

      const now = Date.now();
      await db.queries.upsert(teamId, 'ops-lead-agent', {
        query_id: 'pending-old',
        status: 'pending',
        prompt: 'old queued work',
        created: now - 31 * 60 * 1000,
        owner_kind: 'agent',
        owner_id: 'ops-lead-agent',
      });
      await db.queries.upsert(teamId, 'ops-lead-agent', {
        query_id: 'processing-moderate',
        status: 'processing',
        prompt: 'long but allowed work',
        created: now - 31 * 60 * 1000,
        owner_kind: 'agent',
        owner_id: 'ops-lead-agent',
      });
      await db.queries.upsert(teamId, 'ops-lead-agent', {
        query_id: 'processing-old',
        status: 'processing',
        prompt: 'stuck processing work',
        created: now - 121 * 60 * 1000,
        owner_kind: 'agent',
        owner_id: 'ops-lead-agent',
      });

      await (manager as any).sweepStaleQueries();

      expect((await db.queries.getByQueryIdForTeam(teamId, 'pending-old'))?.status).toBe('expired');
      expect((await db.queries.getByQueryIdForTeam(teamId, 'processing-moderate'))?.status).toBe('processing');
      expect((await db.queries.getByQueryIdForTeam(teamId, 'processing-old'))?.status).toBe('expired');

      const events = await db.events.query({ teamId, topics: ['query:expired'], limit: 10 });
      expect(events.map((event) => event.subject_id).sort()).toEqual(['pending-old', 'processing-old']);
    } finally {
      if (savedEnv.legacy === undefined) delete process.env.ID_QUERY_EXPIRY_MINUTES;
      else process.env.ID_QUERY_EXPIRY_MINUTES = savedEnv.legacy;
      if (savedEnv.pending === undefined) delete process.env.ID_PENDING_QUERY_EXPIRY_MINUTES;
      else process.env.ID_PENDING_QUERY_EXPIRY_MINUTES = savedEnv.pending;
      if (savedEnv.processing === undefined) delete process.env.ID_PROCESSING_QUERY_EXPIRY_MINUTES;
      else process.env.ID_PROCESSING_QUERY_EXPIRY_MINUTES = savedEnv.processing;
    }
  });

  it('rejects /ask before dispatch when the target agent queue is saturated', async () => {
    const saved = process.env.ID_MAX_ACTIVE_QUERIES_PER_AGENT;
    process.env.ID_MAX_ACTIVE_QUERIES_PER_AGENT = '2';
    try {
      const { manager, db, workDir } = await makeManager();
      dbs.push(db);
      workDirs.push(workDir);

      const teamId = await db.teams.getOrCreateTeamId('default');
      await db.agents.create({
        ...agentRow({
          team_id: teamId,
          id: 'agent-busy',
          name: 'busy-lead',
          port: 4112,
          status: 'running',
        }),
      });
      await db.queries.upsert(teamId, 'agent-busy', {
        query_id: 'busy-pending',
        status: 'pending',
        prompt: 'queued work',
        created: Date.now(),
        owner_kind: 'agent',
        owner_id: 'agent-busy',
      });
      await db.queries.upsert(teamId, 'agent-busy', {
        query_id: 'busy-processing',
        status: 'processing',
        prompt: 'current work',
        created: Date.now(),
        owner_kind: 'agent',
        owner_id: 'agent-busy',
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const result = await (manager as any).executeRemoteCommand('/ask busy-lead do one more thing', teamId, 'default');

      expect(result.ok).toBe(false);
      expect(result.error).toContain('already has 2 active queries');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      if (saved === undefined) delete process.env.ID_MAX_ACTIVE_QUERIES_PER_AGENT;
      else process.env.ID_MAX_ACTIVE_QUERIES_PER_AGENT = saved;
    }
  });
});
