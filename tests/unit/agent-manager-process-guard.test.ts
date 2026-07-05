// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import http from 'node:http';
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
import type { AgentRow, ScheduleDefinitionRow, TaskRow } from '../../src/db/types.js';

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

async function startTalkServer(response: Record<string, unknown>) {
  const talkBodies: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/.well-known/restap.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ endpoints: { talk: '/talk' } }));
      return;
    }
    if (req.method === 'POST' && req.url === '/talk') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        talkBodies.push(body);
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify(response));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('talk server failed to bind a loopback port');
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    talkBodies,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

async function startCancelServer(response: Record<string, unknown> = { cancelled: true }) {
  const cancelBodies: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/cancel') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        cancelBodies.push(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(response));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('cancel server failed to bind a loopback port');
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    cancelBodies,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

async function startHealthServer(status = 200) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: status >= 200 && status < 300 ? 'ok' : 'error' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('health server failed to bind a loopback port');
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
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

function taskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  const id = overrides.id || 'task-1';
  return {
    id,
    name: overrides.name || id,
    uuid: overrides.uuid || `${id}-uuid`,
    team_id: overrides.team_id || 'team-1',
    title: overrides.title || 'Task',
    description: overrides.description ?? null,
    status: overrides.status || 'todo',
    created_by: overrides.created_by ?? null,
    owner: overrides.owner ?? null,
    created_at: overrides.created_at ?? 1,
    updated_at: overrides.updated_at ?? 1,
    completed_at: overrides.completed_at ?? null,
  };
}

function scheduleRow(overrides: Partial<ScheduleDefinitionRow> = {}): ScheduleDefinitionRow {
  return {
    id: 'schedule-1',
    kind: 'heartbeat',
    title: 'Heartbeat: worker',
    description: null,
    active: true,
    message: 'Heartbeat: review your checklist and act on anything that needs attention.',
    sender: 'heartbeat',
    delivery_mode: 'internal',
    timezone: null,
    catch_up_policy: 'skip',
    dedupe_window_seconds: 60,
    interval_seconds: 3600,
    anchor_at: 1_700_000_000,
    max_runs: null,
    expires_at: null,
    local_time_seconds: null,
    local_date: null,
    days_of_week: null,
    source_type: 'yaml',
    source_key: 'heartbeat:agent-1',
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

describe('AgentManagerDb killAgentProcess guards', () => {
  const workDirs: string[] = [];
  const dbs: Array<Awaited<ReturnType<typeof createInMemoryDb>>> = [];

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env.ID_IDLE_PARK_INTERVAL_MS;
    delete process.env.ID_IDLE_PARK_INITIAL_DELAY_MS;
    delete process.env.ID_IDLE_PARK_DISABLED;
    delete process.env.ID_PLAN_DECISION_QUERY_EXPIRY_MS;
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

  it('holds scheduled assignment sweeps while fleet doing work is stalled', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);
    const nowMs = 1_700_000_000_000;
    const nowSec = Math.floor(nowMs / 1000);
    vi.spyOn(Date, 'now').mockReturnValue(nowMs);

    const teamId = await db.teams.getOrCreateTeamId('ops-team');
    await db.agents.create(agentRow({ team_id: teamId, id: 'agent-task-master', name: 'task-master' }));
    await db.agents.create(agentRow({ team_id: teamId, id: 'agent-owner', name: 'ops-lead' }));
    await db.tasks.create(taskRow({
      team_id: teamId,
      id: 'task-stalled',
      name: 'stalled-parent-work',
      title: 'Stalled parent work',
      status: 'doing',
      owner: 'agent-owner',
      created_at: nowSec - 90 * 60,
      updated_at: nowSec - 60 * 60,
    }));

    const allowed = await (manager as any).canDispatchAutomatedWake('agent-task-master', {
      source: 'schedule',
      scheduleKind: 'heartbeat',
      scheduleMessage: 'Task assignment sweep: inspect unassigned todo tasks across all teams.',
    });

    expect(allowed).toBe(false);
  });

  it('triages stalled work instead of assigning unowned tasks during managed assignment sweeps', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    await db.teams.getOrCreateTeamId('ops-team');
    const triageSpy = vi.spyOn(manager as any, 'triageStalledOwnerBacklogs').mockResolvedValue({
      stallMinutes: 30,
      limit: 5,
      scannedTeams: 1,
      scannedOwners: 1,
      triagedOwners: 1,
      skippedOwners: [],
      items: [{
        team: 'ops-team',
        owner: 'ops-lead',
        ownerStatus: 'running',
        message: 'stalled_task_backlog: ops-team/ops-lead already has 1 stalled active task (#abc123).',
        blockers: ['#abc123'],
        triage: { status: 'sent_owner', taskRef: '#abc123', actor: 'ops-lead' },
      }],
    });
    const assignSpy = vi.spyOn(manager as any, 'assignUnownedTodoTasks').mockResolvedValue({
      scannedTeams: 1,
      scannedTasks: 1,
      considered: 1,
      assignedCount: 1,
      skippedCount: 0,
      tooFresh: 0,
      checkinSupervised: 0,
      items: [],
    });

    const result = await (manager as any).dispatchManagedSchedule(
      {
        id: 'agent-task-master',
        name: 'task-master',
        endpoint: 'http://127.0.0.1:4100',
        talkPath: '/talk',
        schedulePath: null,
        status: 'running',
      },
      scheduleRow({
        id: 'assignment-sweep',
        title: 'Task assignment sweep',
        message: 'Task assignment sweep: inspect unassigned todo tasks across all teams.',
      }),
      {
        scheduleId: 'assignment-sweep',
        scheduledKey: 'interval:1700000000',
        scheduledAt: 1_700_000_000,
        kind: 'heartbeat',
      },
    );

    expect(result).toMatchObject({
      scheduleId: 'assignment-sweep',
      agentId: 'agent-task-master',
      scheduledKey: 'interval:1700000000',
      success: true,
    });
    expect(triageSpy).toHaveBeenCalledWith(expect.objectContaining({
      limit: 5,
      teams: [expect.objectContaining({ name: 'ops-team' })],
    }));
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it('does not apply stalled-backlog assignment gating to ordinary heartbeats', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);
    const nowMs = 1_700_000_000_000;
    const nowSec = Math.floor(nowMs / 1000);
    vi.spyOn(Date, 'now').mockReturnValue(nowMs);

    const teamId = await db.teams.getOrCreateTeamId('ops-team');
    await db.agents.create(agentRow({ team_id: teamId, id: 'agent-task-master', name: 'task-master' }));
    await db.agents.create(agentRow({ team_id: teamId, id: 'agent-owner', name: 'ops-lead' }));
    await db.tasks.create(taskRow({
      team_id: teamId,
      id: 'task-stalled',
      name: 'stalled-parent-work',
      title: 'Stalled parent work',
      status: 'doing',
      owner: 'agent-owner',
      created_at: nowSec - 90 * 60,
      updated_at: nowSec - 60 * 60,
    }));

    const allowed = await (manager as any).canDispatchAutomatedWake('agent-task-master', {
      source: 'schedule',
      scheduleKind: 'heartbeat',
      scheduleMessage: 'Heartbeat: review your checklist and act on anything that needs attention.',
    });

    expect(allowed).toBe(true);
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

  it('persists successful local health probes for restart-stable status surfaces', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);
    const healthServer = await startHealthServer();
    try {
      const nowMs = 1_700_000_123_000;
      vi.spyOn(Date, 'now').mockReturnValue(nowMs);

      const teamId = await db.teams.getOrCreateTeamId('default');
      await db.agents.create(agentRow({
        team_id: teamId,
        id: 'agent-local-health',
        name: 'local-health',
        port: healthServer.port,
        status: 'running',
        metadata: { runtime: 'codex', pid: 12345, processOwner: 'adopted', processParentPid: 1 },
      }));

      await (manager as any).runHealthChecks();

      const row = await db.agents.getById('agent-local-health');
      expect(row?.last_seen).toBe(Math.floor(nowMs / 1000));
      expect(row?.last_probed_at).toBe(Math.floor(nowMs / 1000));
      expect(row?.last_error).toBeNull();
      expect(row?.consecutive_failures).toBe(0);

      const response = (manager as any).agentToResponse(row);
      expect(response.health).toBe('online');
      expect(response.lastHealthCheck).toBe(nowMs);
      expect(response.last_seen).toBe(Math.floor(nowMs / 1000));
      expect(response.last_probed_at).toBe(Math.floor(nowMs / 1000));
    } finally {
      await healthServer.close();
    }
  });

  it('does not probe stopped local agents on the periodic health loop', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const teamId = await db.teams.getOrCreateTeamId('default');
    await db.agents.create(agentRow({
      team_id: teamId,
      id: 'agent-stopped-health',
      name: 'stopped-health',
      port: 49999,
      status: 'stopped',
      metadata: { runtime: 'codex' },
    }));

    await (manager as any).runHealthChecks();

    expect(fetchSpy).not.toHaveBeenCalled();
    const row = await db.agents.getById('agent-stopped-health');
    expect(row?.last_probed_at).toBeNull();
    expect((manager as any).agentToResponse(row).health).toBe('unknown');
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
        name: 'worker',
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
      { team: 'default', name: 'worker', status: 'skipped', reason: 'has_1_active_query' },
    ]);
    expect((manager as any).killAgentProcess).not.toHaveBeenCalled();

    const query = await db.queries.getByQueryIdForTeam(teamId, 'query-active');
    const agent = await db.agents.getById('agent-active-query');
    expect(query?.status).toBe('processing');
    expect(agent?.status).toBe('running');
  });

  it('does not park a running agent with recent completed query activity', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const teamId = await db.teams.getOrCreateTeamId('default');
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-recent-query',
        name: 'analyst',
        port: 4118,
        status: 'running',
        metadata: { runtime: 'codex', pid: 55558, processOwner: 'manager-child', processParentPid: process.pid },
      }),
    });
    await db.queries.upsert(teamId, 'agent-recent-query', {
      query_id: 'query-recent-completed',
      status: 'completed',
      prompt: 'recently handled work',
      created: Date.now() - 30_000,
      completed: Date.now() - 5_000,
      owner_kind: 'agent',
      owner_id: 'agent-recent-query',
    });

    (manager as any).killAgentProcess = vi.fn(async () => ({ killed: true, pids: [55558] }));

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
      { team: 'default', name: 'analyst', status: 'skipped', reason: 'recent_query_activity_1_within_10m' },
    ]);
    expect((manager as any).killAgentProcess).not.toHaveBeenCalled();
    expect((await db.agents.getById('agent-recent-query'))?.status).toBe('running');
  });

  it('parks idle wakeable local agents even when they have active schedules', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const teamId = await db.teams.getOrCreateTeamId('skillmesh');
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-scheduled-worker',
        name: 'skill-discoverer',
        port: 4118,
        status: 'running',
        metadata: { runtime: 'codex', pid: 55570, processOwner: 'manager-child', processParentPid: process.pid },
      }),
    });
    const def = scheduleRow({
      id: 'hb-agent-scheduled-worker',
      source_key: 'heartbeat:agent-scheduled-worker',
    });
    await db.schedules.upsertDefinition(def);
    await db.schedules.replaceTargets(def.id, ['agent-scheduled-worker']);

    (manager as any).killAgentProcess = vi.fn(async () => ({ killed: true, pids: [55570] }));

    const result = await (manager as any).parkIdleAgents({
      teamId,
      teamName: 'skillmesh',
      confirmed: true,
      allTeams: false,
      includeDefault: false,
      includeLeads: false,
      includeScheduled: false,
      includeActiveTeams: true,
    });

    expect(result.result.parked).toBe(1);
    expect(result.result.agents).toEqual([
      { team: 'skillmesh', name: 'skill-discoverer', status: 'parked', reason: 'idle', pids: [55570] },
    ]);
    expect((manager as any).killAgentProcess).toHaveBeenCalledTimes(1);
    expect((await db.agents.getById('agent-scheduled-worker'))?.status).toBe('stopped');
  });

  it('keeps scheduled agents running when their lifecycle cannot be restarted on demand', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const teamId = await db.teams.getOrCreateTeamId('skillmesh');
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-scheduled-no-port',
        name: 'external-scheduled-worker',
        port: 0,
        endpoint: null,
        status: 'running',
        metadata: { runtime: 'codex', pid: 55571, processOwner: 'manager-child', processParentPid: process.pid },
      }),
    });
    const def = scheduleRow({
      id: 'hb-agent-scheduled-no-port',
      source_key: 'heartbeat:agent-scheduled-no-port',
    });
    await db.schedules.upsertDefinition(def);
    await db.schedules.replaceTargets(def.id, ['agent-scheduled-no-port']);

    (manager as any).killAgentProcess = vi.fn(async () => ({ killed: true, pids: [55571] }));

    const result = await (manager as any).parkIdleAgents({
      teamId,
      teamName: 'skillmesh',
      confirmed: true,
      allTeams: false,
      includeDefault: false,
      includeLeads: false,
      includeScheduled: false,
      includeActiveTeams: true,
    });

    expect(result.result.parked).toBe(0);
    expect(result.result.agents).toEqual([
      { team: 'skillmesh', name: 'external-scheduled-worker', status: 'skipped', reason: 'has_1_active_schedule_requires_live_runtime' },
    ]);
    expect((manager as any).killAgentProcess).not.toHaveBeenCalled();
    expect((await db.agents.getById('agent-scheduled-no-port'))?.status).toBe('running');
  });

  it('wakes stopped local schedule targets just in time for scheduler dispatch', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const teamId = await db.teams.getOrCreateTeamId('skillmesh');
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-stopped-scheduled-worker',
        name: 'skill-discoverer',
        port: 4119,
        endpoint: 'http://127.0.0.1:4119',
        status: 'stopped',
        metadata: { runtime: 'codex' },
      }),
    });
    const def = scheduleRow({
      id: 'hb-agent-stopped-scheduled-worker',
      source_key: 'heartbeat:agent-stopped-scheduled-worker',
    });

    (manager as any).spawnLocalAgentProcess = vi.fn(async () => ({
      success: true,
      pid: 55572,
      logFile: '/tmp/skill-discoverer.log',
    }));

    const target = await (manager as any).prepareScheduledDispatchTarget(
      {
        id: 'agent-stopped-scheduled-worker',
        name: 'skill-discoverer',
        endpoint: 'http://127.0.0.1:4119',
        talkPath: '/talk',
        schedulePath: null,
        status: 'stopped',
      },
      def,
      { scheduleId: def.id, scheduledKey: 'interval:1700000300', scheduledAt: 1_700_000_300, kind: 'heartbeat' },
    );

    expect(target).toEqual(expect.objectContaining({
      id: 'agent-stopped-scheduled-worker',
      name: 'skill-discoverer',
      status: 'running',
      endpoint: 'http://127.0.0.1:4119',
    }));
    expect((manager as any).spawnLocalAgentProcess).toHaveBeenCalledOnce();
    expect((await db.agents.getById('agent-stopped-scheduled-worker'))?.status).toBe('running');

    const { rows } = await db.adapter.query<{ topic: string; data: string }>(
      `SELECT topic, data FROM event_log WHERE subject_id = ?`,
      ['agent-stopped-scheduled-worker'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.topic).toBe('agent:started');
    expect(JSON.parse(rows[0]!.data)).toEqual(expect.objectContaining({
      agent: 'skill-discoverer',
      schedule_id: def.id,
      scheduled_key: 'interval:1700000300',
      reason: 'schedule-dispatch',
      pid: 55572,
    }));
  });

  it('runs an initial idle parking sweep shortly after startup', async () => {
    vi.useFakeTimers();
    process.env.ID_IDLE_PARK_INTERVAL_MS = String(10 * 60 * 1000);
    process.env.ID_IDLE_PARK_INITIAL_DELAY_MS = '1000';
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const parkIdleAgents = vi.spyOn(manager as any, 'parkIdleAgents').mockResolvedValue({
      ok: true,
      result: {
        action: 'agents-park-idle',
        dryRun: false,
        scope: 'all-teams',
        parked: 0,
        skipped: 0,
        failed: 0,
        agents: [],
      },
    });

    (manager as any).startIdleParkingSweeper();

    await vi.advanceTimersByTimeAsync(999);
    expect(parkIdleAgents).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(parkIdleAgents).toHaveBeenCalledTimes(1);
    expect(parkIdleAgents).toHaveBeenCalledWith(expect.objectContaining({
      confirmed: true,
      allTeams: true,
      includeLeads: false,
      includeInactiveLeads: true,
      includeScheduled: false,
      includeActiveTeams: true,
    }));

    await vi.advanceTimersByTimeAsync(60_000);
    expect(parkIdleAgents).toHaveBeenCalledTimes(1);

    await manager.shutdown();
  });

  it('parks dormant lead-like agents only when inactive-lead parking is enabled and the team has no open work', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const inactiveTeamId = await db.teams.getOrCreateTeamId('engineering-team');
    await db.agents.create({
      ...agentRow({
        team_id: inactiveTeamId,
        id: 'agent-engineering-lead',
        name: 'engineering-lead',
        port: 4110,
        status: 'running',
        metadata: { runtime: 'codex', pid: 55556, processOwner: 'manager-child', processParentPid: process.pid },
      }),
    });

    const activeTeamId = await db.teams.getOrCreateTeamId('legal');
    await db.agents.create({
      ...agentRow({
        team_id: activeTeamId,
        id: 'agent-general-counsel',
        name: 'general-counsel',
        port: 4111,
        status: 'running',
        metadata: {
          runtime: 'codex',
          pid: 55557,
          processOwner: 'manager-child',
          processParentPid: process.pid,
          catalog: { role: 'General Counsel coordinates legal team delegation.' },
        },
      }),
    });
    const now = Date.now();
    await db.tasks.create({
      id: 'task-open-legal',
      name: 'open-legal-task',
      uuid: 'open-legal-task',
      team_id: activeTeamId,
      title: 'Open legal work',
      description: null,
      status: 'todo',
      created_by: null,
      owner: null,
      created_at: now,
      updated_at: now,
      completed_at: null,
    } satisfies TaskRow);

    (manager as any).killAgentProcess = vi.fn(async (port: number) => ({ killed: true, pids: [port] }));

    const result = await (manager as any).parkIdleAgents({
      teamId: '',
      teamName: 'all-teams',
      confirmed: true,
      allTeams: true,
      includeDefault: false,
      includeLeads: false,
      includeInactiveLeads: true,
      includeScheduled: false,
      includeActiveTeams: true,
    });

    expect(result.result.parked).toBe(1);
    expect(result.result.agents).toEqual(expect.arrayContaining([
      { team: 'engineering-team', name: 'engineering-lead', status: 'parked', reason: 'idle', pids: [4110] },
      { team: 'legal', name: 'general-counsel', status: 'skipped', reason: 'lead_like_team_has_1_open_task_requires_--include-leads' },
    ]));
    expect((manager as any).killAgentProcess).toHaveBeenCalledTimes(1);
    expect((await db.agents.getById('agent-engineering-lead'))?.status).toBe('stopped');
    expect((await db.agents.getById('agent-general-counsel'))?.status).toBe('running');
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

  it('parks idle helpers in active teams when includeActiveTeams is enabled', async () => {
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
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-task-owner',
        name: 'writer',
        port: 4111,
        status: 'running',
        metadata: { runtime: 'codex', pid: 55557, processOwner: 'manager-child', processParentPid: process.pid },
      }),
    });
    const now = Date.now();
    await db.tasks.create({
      id: 'task-open-owned',
      name: 'open-owned-task',
      uuid: 'open-owned-task',
      team_id: teamId,
      title: 'Open owned work',
      description: null,
      status: 'doing',
      created_by: null,
      owner: 'agent-task-owner',
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
      includeActiveTeams: true,
    });

    expect(result.result.parked).toBe(1);
    expect(result.result.agents).toEqual(expect.arrayContaining([
      { team: 'research', name: 'analyst', status: 'parked', reason: 'idle', pids: [55556] },
      { team: 'research', name: 'writer', status: 'skipped', reason: 'owns_1_open_task' },
    ]));
    expect((manager as any).killAgentProcess).toHaveBeenCalledTimes(1);
    expect((await db.agents.getById('agent-idle-helper'))?.status).toBe('stopped');
    expect((await db.agents.getById('agent-task-owner'))?.status).toBe('running');
  });

  it('protects task-master style supervisors from idle parking even in broad cleanup', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const teamId = await db.teams.getOrCreateTeamId('ops-team');
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-task-master',
        name: 'task-master',
        port: 4112,
        status: 'running',
        metadata: { runtime: 'claude-code-cli', pid: 55559, processOwner: 'manager-child', processParentPid: process.pid },
      }),
    });

    (manager as any).killAgentProcess = vi.fn(async () => ({ killed: true, pids: [55559] }));

    const result = await (manager as any).parkIdleAgents({
      teamId,
      teamName: 'ops-team',
      confirmed: true,
      allTeams: false,
      includeDefault: false,
      includeLeads: true,
      includeScheduled: false,
      includeActiveTeams: true,
    });

    expect(result.result.parked).toBe(0);
    expect(result.result.agents).toEqual([
      { team: 'ops-team', name: 'task-master', status: 'skipped', reason: 'idle_parking_protected' },
    ]);
    expect((manager as any).killAgentProcess).not.toHaveBeenCalled();
    expect((await db.agents.getById('agent-task-master'))?.status).toBe('running');
  });

  it('protects default validation pair from idle parking during broad cleanup', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const teamId = await db.teams.getOrCreateTeamId('default');
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-default-coder',
        name: 'coder',
        port: 4113,
        status: 'running',
        metadata: { runtime: 'codex', pid: 55560, processOwner: 'manager-child', processParentPid: process.pid },
      }),
    });
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-default-researcher',
        name: 'researcher',
        port: 4114,
        status: 'running',
        metadata: { runtime: 'codex', pid: 55561, processOwner: 'manager-child', processParentPid: process.pid },
      }),
    });

    (manager as any).killAgentProcess = vi.fn(async () => ({ killed: true, pids: [55560] }));

    const result = await (manager as any).parkIdleAgents({
      teamId,
      teamName: 'default',
      confirmed: true,
      allTeams: false,
      includeDefault: true,
      includeLeads: true,
      includeScheduled: false,
      includeActiveTeams: true,
    });

    expect(result.result.parked).toBe(0);
    expect(result.result.agents).toEqual([
      { team: 'default', name: 'coder', status: 'skipped', reason: 'idle_parking_protected' },
      { team: 'default', name: 'researcher', status: 'skipped', reason: 'idle_parking_protected' },
    ]);
    expect((manager as any).killAgentProcess).not.toHaveBeenCalled();
    expect((await db.agents.getById('agent-default-coder'))?.status).toBe('running');
    expect((await db.agents.getById('agent-default-researcher'))?.status).toBe('running');
  });

  it('parks idle specialist counsels while protecting the configured legal coordinator', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const teamId = await db.teams.getOrCreateTeamId('legal');
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-contracts-counsel',
        name: 'contracts-counsel',
        port: 4115,
        status: 'running',
        created_at: 10,
        metadata: {
          runtime: 'codex',
          pid: 55562,
          processOwner: 'manager-child',
          processParentPid: process.pid,
          catalog: {
            role: 'Contract drafting and review',
            description: 'Drafts, reviews, and redlines contracts and partnership agreements.',
          },
        },
      }),
    });
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-general-counsel',
        name: 'general-counsel',
        port: 4116,
        status: 'running',
        created_at: 11,
        metadata: {
          runtime: 'claude-code-cli',
          pid: 55563,
          processOwner: 'manager-child',
          processParentPid: process.pid,
          catalog: {
            role: 'General Counsel: coordinates the legal team and delegates to specialist counsels.',
            expertise: ['team-coordination', 'orchestration'],
          },
        },
      }),
    });

    (manager as any).killAgentProcess = vi.fn(async (port: number) => ({ killed: true, pids: [port] }));

    const result = await (manager as any).parkIdleAgents({
      teamId,
      teamName: 'legal',
      confirmed: true,
      allTeams: false,
      includeDefault: false,
      includeLeads: false,
      includeScheduled: false,
      includeActiveTeams: true,
    });

    expect(result.result.parked).toBe(1);
    expect(result.result.agents).toEqual(expect.arrayContaining([
      { team: 'legal', name: 'contracts-counsel', status: 'parked', reason: 'idle', pids: [4115] },
      { team: 'legal', name: 'general-counsel', status: 'skipped', reason: 'lead_like_requires_--include-leads' },
    ]));
    expect((manager as any).killAgentProcess).toHaveBeenCalledTimes(1);
    expect((await db.agents.getById('agent-contracts-counsel'))?.status).toBe('stopped');
    expect((await db.agents.getById('agent-general-counsel'))?.status).toBe('running');
  });

  it('parks idle specialist manager/master agents while protecting the team lead', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const teamId = await db.teams.getOrCreateTeamId('skillmesh');
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-marketplace-manager',
        name: 'marketplace-manager',
        port: 4117,
        status: 'running',
        created_at: 10,
        metadata: {
          runtime: 'ollama',
          pid: 55564,
          processOwner: 'manager-child',
          processParentPid: process.pid,
          catalog: {
            role: 'manager',
            description: 'Maintains marketplace health: listings, pricing, demand analysis, and inventory optimization.',
            expertise: ['marketplace', 'pricing', 'inventory'],
          },
        },
      }),
    });
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-skill-master',
        name: 'skill-master',
        port: 4118,
        status: 'running',
        created_at: 11,
        metadata: {
          runtime: 'claude-code-cli',
          pid: 55565,
          processOwner: 'manager-child',
          processParentPid: process.pid,
          catalog: {
            role: 'developer',
            description: 'Skill catalog growth, validation, and publishing.',
            expertise: ['skill-design', 'catalog-growth'],
          },
        },
      }),
    });
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-skillmesh-lead',
        name: 'skillmesh-ops-lead',
        port: 4119,
        status: 'running',
        created_at: 12,
        metadata: {
          runtime: 'claude-code-cli',
          pid: 55566,
          processOwner: 'manager-child',
          processParentPid: process.pid,
          catalog: {
            role: 'Coordinates the skillmesh team and delegates work across marketplace operations.',
            expertise: ['team-coordination', 'orchestration'],
          },
        },
      }),
    });

    (manager as any).killAgentProcess = vi.fn(async (port: number) => ({ killed: true, pids: [port] }));

    const result = await (manager as any).parkIdleAgents({
      teamId,
      teamName: 'skillmesh',
      confirmed: true,
      allTeams: false,
      includeDefault: false,
      includeLeads: false,
      includeScheduled: false,
      includeActiveTeams: true,
    });

    expect(result.result.parked).toBe(2);
    expect(result.result.agents).toEqual(expect.arrayContaining([
      { team: 'skillmesh', name: 'marketplace-manager', status: 'parked', reason: 'idle', pids: [4117] },
      { team: 'skillmesh', name: 'skill-master', status: 'parked', reason: 'idle', pids: [4118] },
      { team: 'skillmesh', name: 'skillmesh-ops-lead', status: 'skipped', reason: 'lead_like_requires_--include-leads' },
    ]));
    expect((manager as any).killAgentProcess).toHaveBeenCalledTimes(2);
    expect((await db.agents.getById('agent-marketplace-manager'))?.status).toBe('stopped');
    expect((await db.agents.getById('agent-skill-master'))?.status).toBe('stopped');
    expect((await db.agents.getById('agent-skillmesh-lead'))?.status).toBe('running');
  });

  it('prunes only stale generated unassigned todo backlog and archives applied removals', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-04T04:00:00Z'));
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const teamId = await db.teams.getOrCreateTeamId('default');
    await db.agents.create(agentRow({ team_id: teamId, id: 'agent-1', name: 'coder' }));
    const old = Math.floor(Date.now() / 1000) - 8 * 3600;
    const recent = Math.floor(Date.now() / 1000) - 30 * 60;
    await db.tasks.create(taskRow({
      id: 'old-generated',
      name: 'old-generated',
      uuid: '11111111-1111-4111-8111-111111111111',
      team_id: teamId,
      title: 'Old generated task',
      description: '[goal:goal_1] Generated task',
      created_at: old,
      updated_at: old,
    }));
    await db.tasks.create(taskRow({
      id: 'old-owned-generated',
      name: 'old-owned-generated',
      uuid: '22222222-2222-4222-8222-222222222222',
      team_id: teamId,
      title: 'Old owned generated task',
      description: '[goal:goal_1] Owned task',
      owner: 'agent-1',
      created_at: old,
      updated_at: old,
    }));
    await db.tasks.create(taskRow({
      id: 'old-manual',
      name: 'old-manual',
      uuid: '33333333-3333-4333-8333-333333333333',
      team_id: teamId,
      title: 'Old manual task',
      description: 'Manual operator backlog',
      created_at: old,
      updated_at: old,
    }));
    await db.tasks.create(taskRow({
      id: 'recent-generated',
      name: 'recent-generated',
      uuid: '44444444-4444-4444-8444-444444444444',
      team_id: teamId,
      title: 'Recent generated task',
      description: 'Goal ID: goal_1\nRecent generated task',
      created_at: recent,
      updated_at: recent,
    }));

    const dryRun = await (manager as any).pruneBacklogTasks({
      teams: [{ id: teamId, name: 'default' }],
      apply: false,
      minAgeHours: 6,
      match: 'generated',
      limit: 100,
    });
    expect(dryRun.totals).toMatchObject({ candidates: 1, pruned: 0 });
    expect(await db.tasks.getByNameForTeam('old-generated', teamId)).toBeTruthy();

    const applied = await (manager as any).pruneBacklogTasks({
      teams: [{ id: teamId, name: 'default' }],
      apply: true,
      minAgeHours: 6,
      match: 'generated',
      limit: 100,
    });
    expect(applied.totals).toMatchObject({ candidates: 1, pruned: 1, skippedChanged: 0 });
    const archivePath = applied.teams[0].archivePath;
    expect(typeof archivePath).toBe('string');
    expect(fs.existsSync(archivePath)).toBe(true);
    expect(await db.tasks.getByNameForTeam('old-generated', teamId)).toBeNull();
    expect(await db.tasks.getByNameForTeam('old-owned-generated', teamId)).toBeTruthy();
    expect(await db.tasks.getByNameForTeam('old-manual', teamId)).toBeTruthy();
    expect(await db.tasks.getByNameForTeam('recent-generated', teamId)).toBeTruthy();
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

    let cancelServer: Awaited<ReturnType<typeof startCancelServer>> | null = null;
    try {
      const { manager, db, workDir } = await makeManager();
      dbs.push(db);
      workDirs.push(workDir);
      cancelServer = await startCancelServer();

      const teamId = await db.teams.getOrCreateTeamId('ops-team');
      await db.agents.create({
        ...agentRow({
          team_id: teamId,
          id: 'ops-lead-agent',
          name: 'ops-lead',
          port: 4111,
          endpoint: cancelServer.endpoint,
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
        created: now - 46 * 60 * 1000,
        owner_kind: 'agent',
        owner_id: 'ops-lead-agent',
      });

      await (manager as any).sweepStaleQueries();

      expect((await db.queries.getByQueryIdForTeam(teamId, 'pending-old'))?.status).toBe('expired');
      expect((await db.queries.getByQueryIdForTeam(teamId, 'processing-moderate'))?.status).toBe('processing');
      expect((await db.queries.getByQueryIdForTeam(teamId, 'processing-old'))?.status).toBe('expired');
      expect(cancelServer.cancelBodies).toHaveLength(1);

      const events = await db.events.query({ teamId, topics: ['query:expired'], limit: 10 });
      expect(events.map((event) => event.subject_id).sort()).toEqual(['pending-old', 'processing-old']);
    } finally {
      await cancelServer?.close();
      if (savedEnv.legacy === undefined) delete process.env.ID_QUERY_EXPIRY_MINUTES;
      else process.env.ID_QUERY_EXPIRY_MINUTES = savedEnv.legacy;
      if (savedEnv.pending === undefined) delete process.env.ID_PENDING_QUERY_EXPIRY_MINUTES;
      else process.env.ID_PENDING_QUERY_EXPIRY_MINUTES = savedEnv.pending;
      if (savedEnv.processing === undefined) delete process.env.ID_PROCESSING_QUERY_EXPIRY_MINUTES;
      else process.env.ID_PROCESSING_QUERY_EXPIRY_MINUTES = savedEnv.processing;
    }
  });

  it('refreshes framework instructions during agent rebuild without duplicating stale org sidecar text', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const agentDir = path.join(workDir, 'agent-refresh');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'AGENTS.md'),
      `# user notes

<!-- BEGIN id-agents framework -->
## Scheduling

old protocol body

### When to read
Load relevant memories at the start of any non-trivial task. Verify file paths and symbols in memories are still current before acting on them.

## Team coordination
keep this role-specific coordination text

<!-- BEGIN id-agents org -->
old org text that should be replaced
<!-- END id-agents org -->
<!-- END id-agents framework -->

## user tail
preserve me
`,
    );
    fs.writeFileSync(
      path.join(agentDir, '.id-instructions.md'),
      `<!-- BEGIN id-agents org -->
new org text from sidecar
<!-- END id-agents org -->
`,
    );

    (manager as any).refreshPersonalityFileForRebuild(agentRow({
      id: 'agent-refresh',
      name: 'refresh-agent',
      runtime: 'codex',
      working_directory: agentDir,
    }));

    const out = fs.readFileSync(path.join(agentDir, 'AGENTS.md'), 'utf-8');
    expect(out).toContain('# user notes');
    expect(out).toContain('## Shell And Resource Discipline');
    expect(out).toContain('keep this role-specific coordination text');
    expect(out).toContain('new org text from sidecar');
    expect(out).not.toContain('old protocol body');
    expect(out).not.toContain('old org text that should be replaced');
    expect(out).toContain('## user tail');
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
          name: 'busy-worker',
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

      const result = await (manager as any).executeRemoteCommand('/ask busy-worker do one more thing', teamId, 'default');

      expect(result.ok).toBe(false);
      expect(result.error).toContain('already has 2 active queries');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      if (saved === undefined) delete process.env.ID_MAX_ACTIVE_QUERIES_PER_AGENT;
      else process.env.ID_MAX_ACTIVE_QUERIES_PER_AGENT = saved;
    }
  });

  it('allows lead-like agents to receive multiple active /ask queries by default', async () => {
    const savedEnv = {
      maxActive: process.env.ID_MAX_ACTIVE_QUERIES_PER_AGENT,
      leadMaxActive: process.env.ID_MAX_ACTIVE_QUERIES_PER_LEAD,
      brainDisabled: process.env.BRAIN_CONTEXT_DISABLED,
    };
    let talkServer: Awaited<ReturnType<typeof startTalkServer>> | null = null;
    process.env.ID_MAX_ACTIVE_QUERIES_PER_AGENT = '1';
    delete process.env.ID_MAX_ACTIVE_QUERIES_PER_LEAD;
    process.env.BRAIN_CONTEXT_DISABLED = 'true';
    try {
      const { manager, db, workDir } = await makeManager();
      dbs.push(db);
      workDirs.push(workDir);
      talkServer = await startTalkServer({ query_id: 'lead-new-query' });

      const teamId = await db.teams.getOrCreateTeamId('default');
      await db.agents.create({
        ...agentRow({
          team_id: teamId,
          id: 'agent-default-lead',
          name: 'lead',
          port: 4112,
          status: 'running',
          endpoint: talkServer.endpoint,
          metadata: {
            primaryLead: true,
            runtime: 'codex',
            maxActiveQueries: 3,
            queryConcurrency: 1,
          },
        }),
      });
      await db.queries.upsert(teamId, 'agent-default-lead', {
        query_id: 'lead-existing-processing',
        status: 'processing',
        prompt: 'current work',
        created: Date.now(),
        owner_kind: 'agent',
        owner_id: 'agent-default-lead',
      });
      for (let i = 2; i <= 5; i++) {
        await db.queries.upsert(teamId, 'agent-default-lead', {
          query_id: `lead-existing-processing-${i}`,
          status: 'processing',
          prompt: `current work ${i}`,
          created: Date.now(),
          owner_kind: 'agent',
          owner_id: 'agent-default-lead',
        });
      }

      const result = await (manager as any).executeRemoteCommand('/ask lead do one more thing', teamId, 'default');

      expect(result.ok).toBe(true);
      expect(result.result?.queryId).toBe('lead-new-query');
      expect(talkServer.talkBodies).toHaveLength(1);
    } finally {
      await talkServer?.close();
      if (savedEnv.maxActive === undefined) delete process.env.ID_MAX_ACTIVE_QUERIES_PER_AGENT;
      else process.env.ID_MAX_ACTIVE_QUERIES_PER_AGENT = savedEnv.maxActive;
      if (savedEnv.leadMaxActive === undefined) delete process.env.ID_MAX_ACTIVE_QUERIES_PER_LEAD;
      else process.env.ID_MAX_ACTIVE_QUERIES_PER_LEAD = savedEnv.leadMaxActive;
      if (savedEnv.brainDisabled === undefined) delete process.env.BRAIN_CONTEXT_DISABLED;
      else process.env.BRAIN_CONTEXT_DISABLED = savedEnv.brainDisabled;
    }
  });

  it('honors lead-specific metadata caps without inheriting worker caps', async () => {
    const savedEnv = {
      maxActive: process.env.ID_MAX_ACTIVE_QUERIES_PER_AGENT,
      leadMaxActive: process.env.ID_MAX_ACTIVE_QUERIES_PER_LEAD,
      brainDisabled: process.env.BRAIN_CONTEXT_DISABLED,
    };
    let talkServer: Awaited<ReturnType<typeof startTalkServer>> | null = null;
    process.env.ID_MAX_ACTIVE_QUERIES_PER_AGENT = '1';
    delete process.env.ID_MAX_ACTIVE_QUERIES_PER_LEAD;
    process.env.BRAIN_CONTEXT_DISABLED = 'true';
    try {
      const { manager, db, workDir } = await makeManager();
      dbs.push(db);
      workDirs.push(workDir);
      talkServer = await startTalkServer({ query_id: 'lead-should-not-run' });

      const teamId = await db.teams.getOrCreateTeamId('default');
      await db.agents.create({
        ...agentRow({
          team_id: teamId,
          id: 'agent-default-lead',
          name: 'lead',
          port: 4112,
          status: 'running',
          endpoint: talkServer.endpoint,
          metadata: { primaryLead: true, runtime: 'codex', leadMaxActiveQueries: 2 },
        }),
      });
      for (let i = 1; i <= 2; i++) {
        await db.queries.upsert(teamId, 'agent-default-lead', {
          query_id: `lead-existing-processing-${i}`,
          status: 'processing',
          prompt: `current work ${i}`,
          created: Date.now(),
          owner_kind: 'agent',
          owner_id: 'agent-default-lead',
        });
      }

      const result = await (manager as any).executeRemoteCommand('/ask lead do one more thing', teamId, 'default');

      expect(result.ok).toBe(false);
      expect(result.error).toContain('already has 2 active queries');
      expect(result.error).toContain('limit 2');
      expect(talkServer.talkBodies).toHaveLength(0);
    } finally {
      await talkServer?.close();
      if (savedEnv.maxActive === undefined) delete process.env.ID_MAX_ACTIVE_QUERIES_PER_AGENT;
      else process.env.ID_MAX_ACTIVE_QUERIES_PER_AGENT = savedEnv.maxActive;
      if (savedEnv.leadMaxActive === undefined) delete process.env.ID_MAX_ACTIVE_QUERIES_PER_LEAD;
      else process.env.ID_MAX_ACTIVE_QUERIES_PER_LEAD = savedEnv.leadMaxActive;
      if (savedEnv.brainDisabled === undefined) delete process.env.BRAIN_CONTEXT_DISABLED;
      else process.env.BRAIN_CONTEXT_DISABLED = savedEnv.brainDisabled;
    }
  });

  it('uses the target team when applying cross-team lead query caps', async () => {
    const savedEnv = {
      maxActive: process.env.ID_MAX_ACTIVE_QUERIES_PER_AGENT,
      leadMaxActive: process.env.ID_MAX_ACTIVE_QUERIES_PER_LEAD,
      brainDisabled: process.env.BRAIN_CONTEXT_DISABLED,
    };
    let talkServer: Awaited<ReturnType<typeof startTalkServer>> | null = null;
    process.env.ID_MAX_ACTIVE_QUERIES_PER_AGENT = '1';
    delete process.env.ID_MAX_ACTIVE_QUERIES_PER_LEAD;
    process.env.BRAIN_CONTEXT_DISABLED = 'true';
    try {
      const { manager, db, workDir } = await makeManager();
      dbs.push(db);
      workDirs.push(workDir);
      talkServer = await startTalkServer({ query_id: 'legal-lead-new-query' });

      const defaultTeamId = await db.teams.getOrCreateTeamId('default');
      const legalTeamId = await db.teams.getOrCreateTeamId('legal');
      await db.agents.create({
        ...agentRow({
          team_id: legalTeamId,
          id: 'agent-legal-general-counsel',
          name: 'general-counsel',
          port: 4113,
          status: 'running',
          endpoint: talkServer.endpoint,
          metadata: { runtime: 'codex', maxActiveQueries: 1, queryConcurrency: 1 },
        }),
      });
      await db.queries.upsert(legalTeamId, 'agent-legal-general-counsel', {
        query_id: 'legal-lead-existing-processing',
        status: 'processing',
        prompt: 'current legal lead work',
        created: Date.now(),
        owner_kind: 'agent',
        owner_id: 'agent-legal-general-counsel',
      });

      const result = await (manager as any).executeRemoteCommand('/ask legal/general-counsel review this plan', defaultTeamId, 'default');

      expect(result.ok).toBe(true);
      expect(result.result?.queryId).toBe('legal-lead-new-query');
      expect(talkServer.talkBodies).toHaveLength(1);
    } finally {
      await talkServer?.close();
      if (savedEnv.maxActive === undefined) delete process.env.ID_MAX_ACTIVE_QUERIES_PER_AGENT;
      else process.env.ID_MAX_ACTIVE_QUERIES_PER_AGENT = savedEnv.maxActive;
      if (savedEnv.leadMaxActive === undefined) delete process.env.ID_MAX_ACTIVE_QUERIES_PER_LEAD;
      else process.env.ID_MAX_ACTIVE_QUERIES_PER_LEAD = savedEnv.leadMaxActive;
      if (savedEnv.brainDisabled === undefined) delete process.env.BRAIN_CONTEXT_DISABLED;
      else process.env.BRAIN_CONTEXT_DISABLED = savedEnv.brainDisabled;
    }
  });

  it('keeps non-lead agents capped at one active /ask query by default', async () => {
    const saved = process.env.ID_MAX_ACTIVE_QUERIES_PER_AGENT;
    delete process.env.ID_MAX_ACTIVE_QUERIES_PER_AGENT;
    try {
      const { manager, db, workDir } = await makeManager();
      dbs.push(db);
      workDirs.push(workDir);

      const teamId = await db.teams.getOrCreateTeamId('default');
      await db.agents.create({
        ...agentRow({
          team_id: teamId,
          id: 'agent-default-worker',
          name: 'default-worker',
          port: 4112,
          status: 'running',
        }),
      });
      await db.queries.upsert(teamId, 'agent-default-worker', {
        query_id: 'default-worker-processing',
        status: 'processing',
        prompt: 'current work',
        created: Date.now(),
        owner_kind: 'agent',
        owner_id: 'agent-default-worker',
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const result = await (manager as any).executeRemoteCommand('/ask default-worker do one more thing', teamId, 'default');

      expect(result.ok).toBe(false);
      expect(result.error).toContain('already has 1 active query');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      if (saved === undefined) delete process.env.ID_MAX_ACTIVE_QUERIES_PER_AGENT;
      else process.env.ID_MAX_ACTIVE_QUERIES_PER_AGENT = saved;
    }
  });

  it('expires stale target queries before applying the /ask saturation guard', async () => {
    const savedEnv = {
      maxActive: process.env.ID_MAX_ACTIVE_QUERIES_PER_AGENT,
      brainDisabled: process.env.BRAIN_CONTEXT_DISABLED,
      pending: process.env.ID_PENDING_QUERY_EXPIRY_MINUTES,
    };
    let talkServer: Awaited<ReturnType<typeof startTalkServer>> | null = null;
    process.env.ID_MAX_ACTIVE_QUERIES_PER_AGENT = '2';
    process.env.BRAIN_CONTEXT_DISABLED = 'true';
    delete process.env.ID_PENDING_QUERY_EXPIRY_MINUTES;
    try {
      const { manager, db, workDir } = await makeManager();
      dbs.push(db);
      workDirs.push(workDir);
      talkServer = await startTalkServer({ query_id: 'new-query' });

      const teamId = await db.teams.getOrCreateTeamId('default');
      await db.agents.create({
        ...agentRow({
          team_id: teamId,
          id: 'agent-stale-busy',
          name: 'stale-busy-lead',
          port: 4113,
          status: 'running',
          endpoint: talkServer.endpoint,
        }),
      });
      const now = Date.now();
      await db.queries.upsert(teamId, 'agent-stale-busy', {
        query_id: 'stale-pending',
        status: 'pending',
        prompt: 'stale queued work',
        created: now - 16 * 60 * 1000,
        owner_kind: 'agent',
        owner_id: 'agent-stale-busy',
      });
      await db.queries.upsert(teamId, 'agent-stale-busy', {
        query_id: 'fresh-processing',
        status: 'processing',
        prompt: 'fresh current work',
        created: now,
        owner_kind: 'agent',
        owner_id: 'agent-stale-busy',
      });

      const result = await (manager as any).executeRemoteCommand('/ask stale-busy-lead do one more thing', teamId, 'default');

      expect(result.ok).toBe(true);
      expect(result.result?.queryId).toBe('new-query');
      expect((await db.queries.getByQueryIdForTeam(teamId, 'stale-pending'))?.status).toBe('expired');
      expect(talkServer.talkBodies).toHaveLength(1);
    } finally {
      await talkServer?.close();
      if (savedEnv.maxActive === undefined) delete process.env.ID_MAX_ACTIVE_QUERIES_PER_AGENT;
      else process.env.ID_MAX_ACTIVE_QUERIES_PER_AGENT = savedEnv.maxActive;
      if (savedEnv.brainDisabled === undefined) delete process.env.BRAIN_CONTEXT_DISABLED;
      else process.env.BRAIN_CONTEXT_DISABLED = savedEnv.brainDisabled;
      if (savedEnv.pending === undefined) delete process.env.ID_PENDING_QUERY_EXPIRY_MINUTES;
      else process.env.ID_PENDING_QUERY_EXPIRY_MINUTES = savedEnv.pending;
    }
  });

  it('expires duplicate active managed task asks while preserving one active task ask', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const teamId = await db.teams.getOrCreateTeamId('default');
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-supervised',
        name: 'supervised-lead',
        port: 4114,
        status: 'running',
      }),
    });
    const now = Date.now();
    await db.queries.upsert(teamId, 'agent-supervised', {
      query_id: 'older-pending-supervision',
      status: 'pending',
      prompt: 'Supervision: task #abc12345 ("Profile workflow needs") has been in progress 73m with no completion (probe 1/3).',
      created: now,
      owner_kind: 'agent',
      owner_id: 'agent-supervised',
    });
    await db.queries.upsert(teamId, 'agent-supervised', {
      query_id: 'active-processing-supervision',
      status: 'processing',
      prompt: 'Supervision: task #abc12345 ("Profile workflow needs") has been in progress 79m with no completion (probe 1/3).',
      created: now + 1000,
      owner_kind: 'agent',
      owner_id: 'agent-supervised',
    });
    await db.queries.upsert(teamId, 'agent-supervised', {
      query_id: 'other-task-supervision',
      status: 'pending',
      prompt: 'Supervision: task #def67890 ("Different task") has been in progress 79m with no completion (probe 1/3).',
      created: now + 2000,
      owner_kind: 'agent',
      owner_id: 'agent-supervised',
    });
    await db.queries.upsert(teamId, 'agent-supervised', {
      query_id: 'older-task-delegation',
      status: 'pending',
      prompt: 'TASK DELEGATION from primary lead: You are assigned task #ghi99999 (Design the workflow), part of parent #jkl11111.',
      created: now + 3000,
      owner_kind: 'agent',
      owner_id: 'agent-supervised',
    });
    await db.queries.upsert(teamId, 'agent-supervised', {
      query_id: 'newer-task-delegation',
      status: 'pending',
      prompt: 'TASK DELEGATION from primary lead: You are assigned task #ghi99999 (Design the workflow), part of parent #jkl11111.',
      created: now + 4000,
      owner_kind: 'agent',
      owner_id: 'agent-supervised',
    });
    await db.queries.upsert(teamId, 'agent-supervised', {
      query_id: 'older-supervision-routing',
      status: 'pending',
      prompt: 'SUPERVISION ROUTING: Task #f0b7515a (pull-heartbeat-evidence-075b8199) in ops-team has been unclaimed for 72m. Please claim and execute.',
      created: now + 5000,
      owner_kind: 'agent',
      owner_id: 'agent-supervised',
    });
    await db.queries.upsert(teamId, 'agent-supervised', {
      query_id: 'newer-supervision-routing',
      status: 'pending',
      prompt: 'SUPERVISION ROUTING: Task #f0b7515a (pull-heartbeat-evidence-075b8199) in ops-team has been unclaimed 72m. Please claim and execute.',
      created: now + 6000,
      owner_kind: 'agent',
      owner_id: 'agent-supervised',
    });
    await db.queries.upsert(teamId, 'agent-supervised', {
      query_id: 'older-resume-task',
      status: 'pending',
      prompt: 'Resume and complete task #rst12345: Produce tracking hooks implementation plan. When finished: /task done #rst12345.',
      created: now + 7000,
      owner_kind: 'agent',
      owner_id: 'agent-supervised',
    });
    await db.queries.upsert(teamId, 'agent-supervised', {
      query_id: 'newer-resume-task',
      status: 'pending',
      prompt: 'Resume and complete task #rst12345: Produce tracking hooks implementation plan. When finished: /task done #rst12345.',
      created: now + 8000,
      owner_kind: 'agent',
      owner_id: 'agent-supervised',
    });
    await db.queries.upsert(teamId, 'agent-supervised', {
      query_id: 'older-urgent-delegation-probe',
      status: 'pending',
      prompt: 'URGENT delegation probe: task #urg12345 has no child tasks after 15m. Create child tasks NOW.',
      created: now + 9000,
      owner_kind: 'agent',
      owner_id: 'agent-supervised',
    });
    await db.queries.upsert(teamId, 'agent-supervised', {
      query_id: 'processing-urgent-delegation-probe',
      status: 'processing',
      prompt: 'URGENT delegation probe: task #urg12345 has no child tasks after 18m. Create child tasks NOW.',
      created: now + 10000,
      owner_kind: 'agent',
      owner_id: 'agent-supervised',
    });
    await db.queries.upsert(teamId, 'agent-supervised', {
      query_id: 'older-manager-supervision-probe',
      status: 'pending',
      prompt: 'Supervision probe from manager: task #mgr12345 has been in doing status for 12+ minutes with NO member-owned child tasks.',
      created: now + 11000,
      owner_kind: 'agent',
      owner_id: 'agent-supervised',
    });
    await db.queries.upsert(teamId, 'agent-supervised', {
      query_id: 'processing-manager-supervision-probe',
      status: 'processing',
      prompt: 'Supervision probe from manager: task #mgr12345 has been in doing status for 15+ minutes with NO member-owned child tasks.',
      created: now + 12000,
      owner_kind: 'agent',
      owner_id: 'agent-supervised',
    });
    await db.queries.upsert(teamId, 'agent-supervised', {
      query_id: 'processing-backlog-guard',
      status: 'processing',
      prompt: 'Backlog guard: task #bg123456 ("Inventory Brain facts") has been active 57m with no progress update.',
      created: now + 13000,
      owner_kind: 'agent',
      owner_id: 'agent-supervised',
    });
    await db.queries.upsert(teamId, 'agent-supervised', {
      query_id: 'pending-backlog-guard',
      status: 'pending',
      prompt: 'Backlog guard: task #bg123456 ("Inventory Brain facts") has been active 63m with no progress update.',
      created: now + 14000,
      owner_kind: 'agent',
      owner_id: 'agent-supervised',
    });
    await db.queries.upsert(teamId, 'agent-supervised', {
      query_id: 'processing-sweep-ack',
      status: 'processing',
      prompt: 'Ack on the sweep. One flag: map-provenance-integrations -> onchain-systems-architect landed on an offline agent.',
      created: now + 15000,
      owner_kind: 'agent',
      owner_id: 'agent-supervised',
    });
    await db.queries.upsert(teamId, 'agent-supervised', {
      query_id: 'pending-sweep-ack',
      status: 'pending',
      prompt: 'Ack on the sweep. One flag: map-provenance-integrations -> onchain-systems-architect landed on an offline agent.',
      created: now + 16000,
      owner_kind: 'agent',
      owner_id: 'agent-supervised',
    });
    await db.queries.upsert(teamId, 'agent-supervised', {
      query_id: 'pending-sweep-reworded',
      status: 'pending',
      prompt: 'Re your assignment sweep: map-provenance-integrations -> onchain-systems-architect landed on an agent that is currently stopped/offline.',
      created: now + 17000,
      owner_kind: 'agent',
      owner_id: 'agent-supervised',
    });

    const result = await (manager as any).sweepStaleQueries();

    expect(result.duplicateTaskAsk).toBe(9);
    expect(result.total).toBe(9);
    expect((await db.queries.getByQueryIdForTeam(teamId, 'older-pending-supervision'))?.status).toBe('expired');
    expect((await db.queries.getByQueryIdForTeam(teamId, 'active-processing-supervision'))?.status).toBe('processing');
    expect((await db.queries.getByQueryIdForTeam(teamId, 'other-task-supervision'))?.status).toBe('pending');
    expect((await db.queries.getByQueryIdForTeam(teamId, 'older-task-delegation'))?.status).toBe('pending');
    expect((await db.queries.getByQueryIdForTeam(teamId, 'newer-task-delegation'))?.status).toBe('expired');
    expect((await db.queries.getByQueryIdForTeam(teamId, 'older-supervision-routing'))?.status).toBe('pending');
    expect((await db.queries.getByQueryIdForTeam(teamId, 'newer-supervision-routing'))?.status).toBe('expired');
    expect((await db.queries.getByQueryIdForTeam(teamId, 'older-resume-task'))?.status).toBe('pending');
    expect((await db.queries.getByQueryIdForTeam(teamId, 'newer-resume-task'))?.status).toBe('expired');
    expect((await db.queries.getByQueryIdForTeam(teamId, 'older-urgent-delegation-probe'))?.status).toBe('expired');
    expect((await db.queries.getByQueryIdForTeam(teamId, 'processing-urgent-delegation-probe'))?.status).toBe('processing');
    expect((await db.queries.getByQueryIdForTeam(teamId, 'older-manager-supervision-probe'))?.status).toBe('expired');
    expect((await db.queries.getByQueryIdForTeam(teamId, 'processing-manager-supervision-probe'))?.status).toBe('processing');
    expect((await db.queries.getByQueryIdForTeam(teamId, 'processing-backlog-guard'))?.status).toBe('processing');
    expect((await db.queries.getByQueryIdForTeam(teamId, 'pending-backlog-guard'))?.status).toBe('expired');
    expect((await db.queries.getByQueryIdForTeam(teamId, 'processing-sweep-ack'))?.status).toBe('processing');
    expect((await db.queries.getByQueryIdForTeam(teamId, 'pending-sweep-ack'))?.status).toBe('expired');
    expect((await db.queries.getByQueryIdForTeam(teamId, 'pending-sweep-reworded'))?.status).toBe('expired');
  });

  it('expires active control prompts that reference already done tasks', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const teamId = await db.teams.getOrCreateTeamId('default');
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-supervised',
        name: 'supervised-lead',
        port: 4114,
        status: 'running',
      }),
    });

    const now = Date.now();
    await db.tasks.create(taskRow({
      id: 'done-task',
      name: 'done-task',
      uuid: 'abc12345-0000-4000-8000-000000000000',
      team_id: teamId,
      status: 'done',
      owner: 'agent-supervised',
      completed_at: Math.floor(now / 1000),
    }));
    await db.tasks.create(taskRow({
      id: 'doing-task',
      name: 'doing-task',
      uuid: 'def67890-0000-4000-8000-000000000000',
      team_id: teamId,
      status: 'doing',
      owner: 'agent-supervised',
    }));
    await db.queries.upsert(teamId, 'agent-supervised', {
      query_id: 'terminal-lead-kickoff',
      status: 'processing',
      prompt: 'Lead delegation kickoff: task #abc12345 ("Finished coordination") is assigned to you as the team coordinator.',
      created: now,
      owner_kind: 'agent',
      owner_id: 'agent-supervised',
    });
    await db.queries.upsert(teamId, 'agent-supervised', {
      query_id: 'active-backlog-guard',
      status: 'processing',
      prompt: 'Backlog guard: task #def67890 ("Still active") has been active 57m with no progress update.',
      created: now + 1000,
      owner_kind: 'agent',
      owner_id: 'agent-supervised',
    });
    await db.queries.upsert(teamId, 'agent-supervised', {
      query_id: 'normal-done-task-mention',
      status: 'processing',
      prompt: 'Please write a summary that mentions #abc12345 for the release note.',
      created: now + 2000,
      owner_kind: 'agent',
      owner_id: 'agent-supervised',
    });

    const result = await (manager as any).sweepStaleQueries();

    expect(result.terminalTaskAsk).toBe(1);
    expect(result.total).toBe(1);
    expect((await db.queries.getByQueryIdForTeam(teamId, 'terminal-lead-kickoff'))?.status).toBe('expired');
    expect((await db.queries.getByQueryIdForTeam(teamId, 'active-backlog-guard'))?.status).toBe('processing');
    expect((await db.queries.getByQueryIdForTeam(teamId, 'normal-done-task-mention'))?.status).toBe('processing');
  });

  it('expires stale Work Plans decision prompts without touching normal lead work', async () => {
    process.env.ID_PLAN_DECISION_QUERY_EXPIRY_MS = String(5 * 60 * 1000);
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const teamId = await db.teams.getOrCreateTeamId('default');
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-lead',
        name: 'lead',
        port: 4115,
        status: 'running',
      }),
    });

    const now = Date.now();
    await db.queries.upsert(teamId, 'agent-lead', {
      query_id: 'stale-plan-decision',
      status: 'processing',
      prompt: 'Decision on "agent.bittrees.org". You asked: Work > Plans could not complete the blocker preflight for "agent.bittrees.org". Delegation will continue, but retry should not stack.',
      created: now - 10 * 60 * 1000,
      owner_kind: 'agent',
      owner_id: 'agent-lead',
    });
    await db.queries.upsert(teamId, 'agent-lead', {
      query_id: 'fresh-plan-decision',
      status: 'processing',
      prompt: 'Decision on "agent.bittrees.org". You asked: Work > Plans could not complete the audit preflight for "agent.bittrees.org".',
      created: now - 30 * 1000,
      owner_kind: 'agent',
      owner_id: 'agent-lead',
    });
    await db.queries.upsert(teamId, 'agent-lead', {
      query_id: 'normal-lead-research',
      status: 'processing',
      prompt: 'Decision on "agent.bittrees.org". You asked: Review the site copy and produce a source-grounded summary.',
      created: now - 10 * 60 * 1000,
      owner_kind: 'agent',
      owner_id: 'agent-lead',
    });

    const result = await (manager as any).sweepStaleQueries();

    expect(result.stalePlanDecision).toBe(1);
    expect(result.total).toBe(1);
    expect((await db.queries.getByQueryIdForTeam(teamId, 'stale-plan-decision'))?.status).toBe('expired');
    expect((await db.queries.getByQueryIdForTeam(teamId, 'fresh-plan-decision'))?.status).toBe('processing');
    expect((await db.queries.getByQueryIdForTeam(teamId, 'normal-lead-research'))?.status).toBe('processing');
  });

  it('preserves a fresh active delegation query while its assigned agent finishes replying after task completion', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const teamId = await db.teams.getOrCreateTeamId('skillmesh');
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-skill-discoverer',
        name: 'skill-discoverer',
        port: 4157,
        status: 'running',
      }),
    });

    const now = Date.now();
    await db.tasks.create(taskRow({
      id: 'done-by-active-delegation',
      name: 'done-by-active-delegation',
      uuid: 'abc12345-0000-4000-8000-000000000000',
      team_id: teamId,
      status: 'done',
      owner: 'agent-skill-discoverer',
      completed_at: Math.floor(now / 1000),
    }));
    await db.queries.upsert(teamId, 'agent-skill-discoverer', {
      query_id: 'active-delegation-finishing-reply',
      status: 'processing',
      prompt: 'TASK DELEGATION from manager: You are assigned task #abc12345 ("Map overlap and consolidation").',
      created: now - 45_000,
      owner_kind: 'agent',
      owner_id: 'agent-skill-discoverer',
    });

    const result = await (manager as any).sweepStaleQueries();

    expect(result.terminalTaskAsk).toBe(0);
    expect(result.total).toBe(0);
    expect((await db.queries.getByQueryIdForTeam(teamId, 'active-delegation-finishing-reply'))?.status).toBe('processing');
  });

  it('expires active control prompts that duplicate a recent completed equivalent', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const teamId = await db.teams.getOrCreateTeamId('ops-team');
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-task-master',
        name: 'task-master',
        port: 4118,
        status: 'running',
        endpoint: 'http://127.0.0.1:9',
      }),
    });

    const now = Date.now();
    await db.queries.upsert(teamId, 'agent-task-master', {
      query_id: 'completed-sweep-ack',
      status: 'completed',
      prompt: 'Ack on the sweep. One flag: map-provenance-integrations -> onchain-systems-architect landed on an offline agent.',
      created: now - 20 * 60 * 1000,
      completed: now - 5 * 60 * 1000,
      owner_kind: 'agent',
      owner_id: 'agent-task-master',
    });
    await db.queries.upsert(teamId, 'agent-task-master', {
      query_id: 'processing-sweep-reworded',
      status: 'processing',
      prompt: 'Re your assignment sweep: map-provenance-integrations -> onchain-systems-architect landed on an agent that is currently stopped/offline.',
      created: now - 10 * 60 * 1000,
      owner_kind: 'agent',
      owner_id: 'agent-task-master',
    });

    const result = await (manager as any).sweepStaleQueries();

    expect(result.duplicateTaskAsk).toBe(1);
    expect((await db.queries.getByQueryIdForTeam(teamId, 'completed-sweep-ack'))?.status).toBe('completed');
    expect((await db.queries.getByQueryIdForTeam(teamId, 'processing-sweep-reworded'))?.status).toBe('expired');
  });

  it('keeps fresh control prompts created after a completed equivalent', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const teamId = await db.teams.getOrCreateTeamId('engineering-team');
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-architect',
        name: 'architecture-engineer',
        port: 4119,
        status: 'running',
        endpoint: 'http://127.0.0.1:9',
      }),
    });
    await db.tasks.create(taskRow({
      id: 'audit-hooks',
      name: 'audit-task-data-hooks',
      uuid: '451758d2-0000-4000-8000-000000000000',
      team_id: teamId,
      status: 'doing',
      owner: 'agent-architect',
    }));

    const now = Date.now();
    await db.queries.upsert(teamId, 'agent-architect', {
      query_id: 'completed-backlog-guard',
      status: 'completed',
      prompt: 'Backlog guard: task #451758d2 ("Audit task data hooks") has been active 47m with no progress update.',
      created: now - 20 * 60 * 1000,
      completed: now - 10 * 60 * 1000,
      owner_kind: 'agent',
      owner_id: 'agent-architect',
    });
    await db.queries.upsert(teamId, 'agent-architect', {
      query_id: 'fresh-backlog-guard',
      status: 'processing',
      prompt: 'Backlog guard: task #451758d2 ("Audit task data hooks") has been active 60m with no progress update.',
      created: now - 30 * 1000,
      owner_kind: 'agent',
      owner_id: 'agent-architect',
    });

    const result = await (manager as any).sweepStaleQueries();

    expect(result.duplicateTaskAsk).toBe(0);
    expect(result.total).toBe(0);
    expect((await db.queries.getByQueryIdForTeam(teamId, 'completed-backlog-guard'))?.status).toBe('completed');
    expect((await db.queries.getByQueryIdForTeam(teamId, 'fresh-backlog-guard'))?.status).toBe('processing');
  });

  it('dedupes active task delegation /ask prompts before dispatching', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const teamId = await db.teams.getOrCreateTeamId('default');
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-task-delegate',
        name: 'task-delegate-lead',
        port: 4115,
        status: 'running',
        endpoint: 'http://127.0.0.1:9',
      }),
    });
    await db.queries.upsert(teamId, 'agent-task-delegate', {
      query_id: 'existing-task-delegation',
      status: 'pending',
      prompt: 'TASK DELEGATION from primary lead: You are assigned task #abc12345 (Design the model), part of parent #def67890.',
      created: Date.now(),
      owner_kind: 'agent',
      owner_id: 'agent-task-delegate',
    });

    const result = await (manager as any).executeRemoteCommand(
      '/ask task-delegate-lead TASK DELEGATION from primary lead: You are assigned task #abc12345 (Design the model), part of parent #def67890.',
      teamId,
      'default',
    );

    expect(result.ok).toBe(true);
    expect(result.result?.queryId).toBe('existing-task-delegation');
    expect(result.result?.deduped).toBe(true);
  });

  it('dedupes exact active assignment-sweep /ask prompts before dispatching', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const teamId = await db.teams.getOrCreateTeamId('ops-team');
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-task-master',
        name: 'task-master',
        port: 4116,
        status: 'running',
        endpoint: 'http://127.0.0.1:9',
      }),
    });
    const prompt = 'Ack on the sweep. One flag: map-provenance-integrations -> onchain-systems-architect landed on an offline agent.';
    await db.queries.upsert(teamId, 'agent-task-master', {
      query_id: 'existing-sweep-ack',
      status: 'processing',
      prompt,
      created: Date.now(),
      owner_kind: 'agent',
      owner_id: 'agent-task-master',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await (manager as any).executeRemoteCommand(
      '/ask task-master Re your assignment sweep: map-provenance-integrations -> onchain-systems-architect landed on an agent that is currently stopped/offline.',
      teamId,
      'ops-team',
    );

    expect(result.ok).toBe(true);
    expect(result.result?.queryId).toBe('existing-sweep-ack');
    expect(result.result?.deduped).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('dedupes active validation /ask prompts by task marker before dispatching', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const teamId = await db.teams.getOrCreateTeamId('legal');
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-legal-researcher',
        name: 'legal-researcher',
        port: 4116,
        status: 'running',
        endpoint: 'http://127.0.0.1:9',
      }),
    });
    await db.queries.upsert(teamId, 'agent-legal-researcher', {
      query_id: 'existing-validation-ask',
      status: 'processing',
      prompt: 'Please validate output/legal-routing-policy-8da84377.md against task #8da84377.',
      created: Date.now(),
      owner_kind: 'agent',
      owner_id: 'agent-legal-researcher',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await (manager as any).executeRemoteCommand(
      '/ask legal-researcher Please validate output/legal-routing-policy-retry.md against task #8da84377.',
      teamId,
      'legal',
    );

    expect(result.ok).toBe(true);
    expect(result.result?.queryId).toBe('existing-validation-ask');
    expect(result.result?.deduped).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('dedupes active validation-request /ask prompts by task marker before dispatching', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const teamId = await db.teams.getOrCreateTeamId('default');
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-researcher',
        name: 'researcher',
        port: 4116,
        status: 'running',
        endpoint: 'http://127.0.0.1:9',
      }),
    });
    await db.queries.upsert(teamId, 'agent-researcher', {
      query_id: 'existing-validation-request',
      status: 'processing',
      prompt: 'Validation request for run-baseline-cycle (#784ff464), goal goal_mr4khc5x_lf68y. Read the artifact and reply PASS or FAIL.',
      created: Date.now(),
      owner_kind: 'agent',
      owner_id: 'agent-researcher',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await (manager as any).executeRemoteCommand(
      '/ask researcher Validation request for run-baseline-cycle (#784ff464), goal goal_mr4khc5x_lf68y. Retry with concise findings.',
      teamId,
      'default',
    );

    expect(result.ok).toBe(true);
    expect(result.result?.queryId).toBe('existing-validation-request');
    expect(result.result?.deduped).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('dedupes exact active auto-release verification prompts before dispatching', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const teamId = await db.teams.getOrCreateTeamId('ops-team');
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-ops-lead',
        name: 'ops-lead',
        port: 4116,
        status: 'running',
        endpoint: 'http://127.0.0.1:9',
      }),
    });
    const prompt = 'AUTO-RELEASE shipped v0.1.585 (outstanding IDACC code released). Please verify the asset + self-update smoke.';
    await db.queries.upsert(teamId, 'agent-ops-lead', {
      query_id: 'existing-auto-release',
      status: 'pending',
      prompt,
      created: Date.now(),
      owner_kind: 'agent',
      owner_id: 'agent-ops-lead',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await (manager as any).executeRemoteCommand(
      `/ask ops-lead ${prompt}`,
      teamId,
      'ops-team',
    );

    expect(result.ok).toBe(true);
    expect(result.result?.queryId).toBe('existing-auto-release');
    expect(result.result?.deduped).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('dedupes active supervision routing /ask prompts before dispatching', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const teamId = await db.teams.getOrCreateTeamId('ops-team');
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-ops-lead',
        name: 'ops-lead',
        port: 4116,
        status: 'running',
        endpoint: 'http://127.0.0.1:9',
      }),
    });
    await db.queries.upsert(teamId, 'agent-ops-lead', {
      query_id: 'existing-supervision-routing',
      status: 'pending',
      prompt: 'SUPERVISION ROUTING: Task #f0b7515a (pull-heartbeat-evidence-075b8199) in ops-team has been unclaimed for 72m. Please claim and execute.',
      created: Date.now(),
      owner_kind: 'agent',
      owner_id: 'agent-ops-lead',
    });

    const result = await (manager as any).executeRemoteCommand(
      '/ask ops-lead SUPERVISION ROUTING: Task #f0b7515a (pull-heartbeat-evidence-075b8199) in ops-team has been unclaimed 72m. Please claim and execute.',
      teamId,
      'ops-team',
    );

    expect(result.ok).toBe(true);
    expect(result.result?.queryId).toBe('existing-supervision-routing');
    expect(result.result?.deduped).toBe(true);
  });

  it('dedupes active urgent delegation probe /ask prompts before dispatching', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const teamId = await db.teams.getOrCreateTeamId('engineering-team');
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-engineering-lead',
        name: 'engineering-lead',
        port: 4117,
        status: 'running',
        endpoint: 'http://127.0.0.1:9',
      }),
    });
    await db.queries.upsert(teamId, 'agent-engineering-lead', {
      query_id: 'existing-urgent-delegation-probe',
      status: 'processing',
      prompt: 'URGENT delegation probe: task #0776b1f6 has no child tasks after 15m. Create child tasks NOW.',
      created: Date.now(),
      owner_kind: 'agent',
      owner_id: 'agent-engineering-lead',
    });

    const result = await (manager as any).executeRemoteCommand(
      '/ask engineering-lead URGENT delegation probe: task #0776b1f6 has no child tasks after 18m. Create child tasks NOW.',
      teamId,
      'engineering-team',
    );

    expect(result.ok).toBe(true);
    expect(result.result?.queryId).toBe('existing-urgent-delegation-probe');
    expect(result.result?.deduped).toBe(true);
  });

  it('dedupes active manager supervision probe /ask prompts before dispatching', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const teamId = await db.teams.getOrCreateTeamId('engineering-team');
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-engineering-lead',
        name: 'engineering-lead',
        port: 4118,
        status: 'running',
        endpoint: 'http://127.0.0.1:9',
      }),
    });
    await db.queries.upsert(teamId, 'agent-engineering-lead', {
      query_id: 'existing-manager-supervision-probe',
      status: 'pending',
      prompt: 'Supervision probe from manager: task #0776b1f6 has been in doing status for 12+ minutes with NO member-owned child tasks.',
      created: Date.now(),
      owner_kind: 'agent',
      owner_id: 'agent-engineering-lead',
    });

    const result = await (manager as any).executeRemoteCommand(
      '/ask engineering-lead Supervision probe from manager: task #0776b1f6 has been in doing status for 15+ minutes with NO member-owned child tasks.',
      teamId,
      'engineering-team',
    );

    expect(result.ok).toBe(true);
    expect(result.result?.queryId).toBe('existing-manager-supervision-probe');
    expect(result.result?.deduped).toBe(true);
  });

  it('dedupes active resume-task /ask prompts before dispatching', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const teamId = await db.teams.getOrCreateTeamId('engineering-team');
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-engineering-lead',
        name: 'engineering-lead',
        port: 4117,
        status: 'running',
        endpoint: 'http://127.0.0.1:9',
      }),
    });
    await db.queries.upsert(teamId, 'agent-engineering-lead', {
      query_id: 'existing-resume-task',
      status: 'processing',
      prompt: 'Resume and complete task #fec58ec6: Produce tracking hooks implementation plan. When finished: /task done #fec58ec6.',
      created: Date.now(),
      owner_kind: 'agent',
      owner_id: 'agent-engineering-lead',
    });

    const result = await (manager as any).executeRemoteCommand(
      '/ask engineering-lead Resume and complete task #fec58ec6: Produce tracking hooks implementation plan. When finished: /task done #fec58ec6.',
      teamId,
      'engineering-team',
    );

    expect(result.ok).toBe(true);
    expect(result.result?.queryId).toBe('existing-resume-task');
    expect(result.result?.deduped).toBe(true);
  });

  it('supports /tasks as a remote alias for /task list', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const teamId = await db.teams.getOrCreateTeamId('default');
    await db.tasks.create({
      ...taskRow({
        team_id: teamId,
        id: 'task-alias-1',
        uuid: '11111111-1111-4111-8111-111111111111',
        name: 'alias-visible',
        title: 'Alias visible task',
        status: 'todo',
        owner: null,
      }),
    });

    const all = await (manager as any).executeRemoteCommand('/tasks', teamId, 'default');
    const todo = await (manager as any).executeRemoteCommand('/tasks todo', teamId, 'default');

    expect(all.ok).toBe(true);
    expect(all.result.tasks.map((t: any) => t.name)).toContain('alias-visible');
    expect(todo.ok).toBe(true);
    expect(todo.result.tasks.map((t: any) => t.name)).toContain('alias-visible');
  });

  it('returns a concise 400 for malformed manager JSON requests', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const server = http.createServer((manager as any).managementApp);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      expect(port).toBeGreaterThan(0);

      const res = await fetch(`http://127.0.0.1:${port}/remote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"command":"bad\njson"}',
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body).toMatchObject({ ok: false, error: 'Invalid JSON' });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[Manager] Invalid JSON on POST /remote:'));
    } finally {
      warn.mockRestore();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
