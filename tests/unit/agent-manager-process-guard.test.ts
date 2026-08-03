// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import os from 'os';
import path from 'path';

import { AgentManagerDb } from '../../src/agent-manager-db.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { PgAgentsRepo } from '../../src/db/repos/postgres/agents-repo.js';
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

function verifiedSpawnStub(
  db: Awaited<ReturnType<typeof createInMemoryDb>>,
  pid: number,
) {
  return vi.fn(async (
    _teamId: string,
    _teamName: string,
    agentData: { id: string },
  ) => {
    const current = await db.agents.getById(agentData.id);
    if (!current) return { success: false, error: 'agent row missing' };
    const metadata = {
      ...((current.metadata as Record<string, unknown> | null | undefined) ?? {}),
      pid,
      processOwner: 'manager-child',
      processGeneration: `test-generation-${pid}`,
      managerOwnedLaunchIntent: true,
    };
    delete metadata.managerRestartRequested;
    await db.agents.updateStatus(agentData.id, 'running', { metadata });
    return { success: true, pid };
  });
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

async function startHealthServer(status = 200, payload: Record<string, unknown> = {}) {
  let responseStatus = status;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(responseStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        status: responseStatus >= 200 && responseStatus < 300 ? 'ok' : 'error',
        ...payload,
      }));
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
    setStatus(nextStatus: number) {
      responseStatus = nextStatus;
    },
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
    delete process.env.ID_IDLE_PARK_ENABLED;
    delete process.env.ID_PLAN_DECISION_QUERY_EXPIRY_MS;
    delete process.env.IDACC_AGENT_LOG_DIR;
    delete process.env.ELECTRON_RUN_AS_NODE;
    delete process.env.IDACC_ADMIN_TOKEN;
    delete process.env.IDACC_MANAGER_SERVICE_TOKEN;
    delete process.env.IDACC_MANAGED_SERVICE;
    delete process.env.IDACC_MANAGER_RESTART_MARKER_GRACE_MS;
    delete process.env.BRAIN_TOKEN;
    while (dbs.length > 0) {
      await dbs.pop()!.close();
    }
    while (workDirs.length > 0) {
      fs.rmSync(workDirs.pop()!, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('signals the detached Unix worker process group at every Manager termination site', () => {
    const source = fs.readFileSync(new URL('../../src/agent-manager-db.ts', import.meta.url), 'utf8');
    expect(source).toContain('detached: true');
    expect(source.match(/detachedProcessGroup: true/g)?.length).toBeGreaterThanOrEqual(3);
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

    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0) {
        const error = Object.assign(new Error('not running'), { code: 'ESRCH' });
        throw error;
      }
      return true;
    });

    const result = await (manager as any).killAgentProcess(4101);

    expect(killSpy.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([
      [-agentPid, 'SIGTERM'],
      [agentPid, 'SIGTERM'],
    ]);
    expect(result).toEqual({ killed: true, pids: [agentPid] });
  });

  it('allows scheduled assignment sweeps while fleet doing work is stalled so managed triage can run', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);
    const nowMs = 1_700_000_000_000;
    const nowSec = Math.floor(nowMs / 1000);
    vi.spyOn(Date, 'now').mockReturnValue(nowMs);

    const teamId = await db.teams.getOrCreateTeamId('ops-team');
    await db.agents.create(agentRow({ team_id: teamId, id: 'agent-task-master', name: 'task-master' }));
    await db.agents.create(agentRow({ team_id: teamId, id: 'agent-owner', name: 'ops-lead' }));
    await db.queries.upsert(teamId, 'agent-task-master', {
      query_id: 'query-recent-task-master',
      status: 'completed',
      prompt: 'recent task-master digest',
      created: nowMs - 30_000,
      completed: nowMs - 5_000,
      owner_kind: 'agent',
      owner_id: 'agent-task-master',
    });
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

    expect(allowed).toBe(true);
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

    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0) {
        const error = Object.assign(new Error('not running'), { code: 'ESRCH' });
        throw error;
      }
      return true;
    });

    const result = await (manager as any).killAgentProcess(4106);

    expect(killSpy.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([
      [-agentPid, 'SIGTERM'],
      [agentPid, 'SIGTERM'],
    ]);
    expect(result).toEqual({ killed: true, pids: [agentPid] });
  });

  it('never kills an unrelated process just because it owns an agent port', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const unrelatedPid = process.pid + 3100;
    (manager as any).listPidsListeningOnPort = vi.fn(() => [unrelatedPid]);
    (manager as any).inspectProcess = vi.fn(() => ({
      pid: unrelatedPid,
      ppid: 1,
      argv0: 'python',
      commandLine: 'python -m http.server 4107',
    }));
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const result = await (manager as any).killAgentProcess(4107);

    expect(killSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ killed: false, pids: [] });
  });

  it('uses a persisted identity-verified PID when Unix port tools are unavailable', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);
    const teamId = await db.teams.getOrCreateTeamId('default');
    const agentPid = process.pid + 3200;
    await db.agents.create(agentRow({
      team_id: teamId,
      id: 'agent-windows',
      name: 'windows-agent',
      port: 4108,
      metadata: {
        runtime: 'codex',
        pid: agentPid,
        processOwner: 'manager-child',
        processParentPid: process.pid,
      },
    }));

    (manager as any).listPidsListeningOnPort = vi.fn(() => []);
    (manager as any).inspectProcess = vi.fn(() => null);
    (manager as any).processIsAlive = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    (manager as any).probeLocalAgentIdentity = vi.fn(async () => ({ ok: true, attested: true }));
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const result = await (manager as any).killAgentProcess(4108, 'agent-windows');

    expect((manager as any).probeLocalAgentIdentity).toHaveBeenCalledWith(
      4108,
      { id: 'agent-windows', name: 'windows-agent', pid: agentPid },
      { requireAttestation: true },
    );
    expect(killSpy.mock.calls).toEqual([
      [-agentPid, 'SIGTERM'],
      [agentPid, 'SIGTERM'],
    ]);
    expect(result).toEqual({ killed: true, pids: [agentPid] });
  });

  it('refuses kill authority when exact persisted agent attestation is unavailable', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);
    const teamId = await db.teams.getOrCreateTeamId('default');
    const agentPid = process.pid + 3250;
    await db.agents.create(agentRow({
      team_id: teamId,
      id: 'agent-unattested',
      name: 'unattested-agent',
      port: 4109,
      metadata: {
        runtime: 'codex',
        pid: agentPid,
        processOwner: 'manager-child',
        processParentPid: process.pid,
      },
    }));

    (manager as any).listPidsListeningOnPort = vi.fn(() => []);
    (manager as any).inspectProcess = vi.fn(() => null);
    (manager as any).processIsAlive = vi.fn(() => true);
    (manager as any).probeLocalAgentIdentity = vi.fn(async () => ({ ok: true, attested: false }));
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const result = await (manager as any).killAgentProcess(4109, 'agent-unattested');

    expect((manager as any).probeLocalAgentIdentity).toHaveBeenCalledWith(
      4109,
      { id: 'agent-unattested', name: 'unattested-agent', pid: agentPid },
      { requireAttestation: true },
    );
    expect(killSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ killed: false, pids: [] });
  });

  it('refuses lsof-only kill authority when the requested agent has no matching persisted row', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);
    const candidatePid = process.pid + 3260;
    (manager as any).listPidsListeningOnPort = vi.fn(() => [candidatePid]);
    (manager as any).inspectProcess = vi.fn(() => ({
      pid: candidatePid,
      ppid: 1,
      argv0: 'node',
      commandLine: 'node dist/local-agent-server.js impostor --port 4110 --id missing-agent',
    }));
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const result = await (manager as any).killAgentProcess(4110, 'missing-agent');

    expect((manager as any).listPidsListeningOnPort).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ killed: false, pids: [] });
  });

  it('requires the exact persisted --id and --port in command-line ownership evidence', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);
    const teamId = await db.teams.getOrCreateTeamId('default');
    const candidatePid = process.pid + 3270;
    await db.agents.create(agentRow({
      team_id: teamId,
      id: 'agent-exact',
      name: 'exact-agent',
      port: 4111,
      metadata: { runtime: 'codex', pid: candidatePid, processOwner: 'adopted' },
    }));
    (manager as any).listPidsListeningOnPort = vi.fn(() => [candidatePid]);
    (manager as any).inspectProcess = vi.fn(() => ({
      pid: candidatePid,
      ppid: 1,
      argv0: 'node',
      commandLine: 'node dist/local-agent-server.js impostor --port 4111 --id another-agent',
    }));
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const result = await (manager as any).killAgentProcess(4111, 'agent-exact');

    expect(killSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ killed: false, pids: [] });
  });

  it('uses loopback identity readiness instead of lsof', async () => {
    const healthServer = await startHealthServer(200, {
      agent: 'ready-agent',
      agentId: 'agent-ready',
      pid: process.pid,
    });
    try {
      const { manager, db, workDir } = await makeManager();
      dbs.push(db);
      workDirs.push(workDir);
      const proc = Object.assign(new EventEmitter(), { pid: process.pid });
      (manager as any).listPidsListeningOnPort = vi.fn(() => {
        throw new Error('readiness must not invoke lsof');
      });

      const result = await (manager as any).waitForAgentPortToBind(
        proc,
        healthServer.port,
        { id: 'agent-ready', name: 'ready-agent' },
        2_000,
      );

      expect(result).toEqual({ ok: true });
      expect((manager as any).listPidsListeningOnPort).not.toHaveBeenCalled();
    } finally {
      await healthServer.close();
    }
  });

  it('retains a live managed generation across one failed health probe and recovers it', async () => {
    process.env.IDACC_ADMIN_TOKEN = 'managed-health-recovery-admin-token';
    process.env.IDACC_MANAGER_SERVICE_TOKEN = 'managed-health-recovery-service-token-000000000000';
    const healthServer = await startHealthServer(503);
    try {
      const { manager, db, workDir } = await makeManager();
      dbs.push(db);
      workDirs.push(workDir);
      const teamId = await db.teams.getOrCreateTeamId('default');
      const agentId = 'agent-health-recovery';
      const generation = 'health-recovery-generation';
      const pid = 54320;
      await db.agents.create(agentRow({
        team_id: teamId,
        id: agentId,
        name: 'health-recovery',
        port: healthServer.port,
        status: 'running',
        runtime: 'codex',
        metadata: {
          runtime: 'codex',
          pid,
          processOwner: 'manager-child',
          processParentPid: process.pid,
          managerOwnedLaunchIntent: true,
          processGeneration: generation,
          processRuntime: 'codex',
          processRuntimeLane: 'codex:default',
        },
      }));
      const proc = Object.assign(new EventEmitter(), {
        pid,
        exitCode: null,
        signalCode: null,
      });
      (manager as any).ownedAgentProcesses.set(pid, {
        proc,
        agentId,
        agentName: 'health-recovery',
        port: healthServer.port,
        processGeneration: generation,
      });

      await (manager as any).runHealthChecks();
      let row = await db.agents.getById(agentId);
      expect(row?.status).toBe('offline');
      expect(row?.metadata).toMatchObject({
        processGeneration: generation,
        processRuntime: 'codex',
        processRuntimeLane: 'codex:default',
      });

      healthServer.setStatus(200);
      await (manager as any).runHealthChecks();
      row = await db.agents.getById(agentId);
      expect(row?.status).toBe('running');
      expect(row?.metadata?.processGeneration).toBe(generation);
      expect(await (manager as any).hasCurrentManagedWorkerAssignment(
        row,
        generation,
      )).toBe(true);
    } finally {
      await healthServer.close();
    }
  });

  it('spawns with the bundled executable and writes only profile-private logs', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);
    const teamId = await db.teams.getOrCreateTeamId('default');
    await db.agents.create(agentRow({
      team_id: teamId,
      id: 'agent-portable',
      name: '../../Portable Agent',
      port: 4109,
      status: 'pending',
      metadata: { runtime: 'codex' },
    }));
    const logDir = path.join(workDir, 'profile logs', 'agents');
    process.env.IDACC_AGENT_LOG_DIR = logDir;
    process.env.ELECTRON_RUN_AS_NODE = '1';
    process.env.IDACC_ADMIN_TOKEN = 'must-not-leak';
    process.env.BRAIN_TOKEN = 'must-not-leak-either';

    (manager as any).killAgentProcess = vi.fn(async () => ({ killed: false, pids: [] }));
    (manager as any).clearAgentPid = vi.fn(async () => {});
    (manager as any).waitForAgentPortToBind = vi.fn(async () => ({ ok: true }));
    const proc = Object.assign(new EventEmitter(), {
      pid: 54321,
      unref: vi.fn(),
    });
    const spawnSpy = vi.fn(() => proc);
    (manager as any).spawnLocalAgentChild = spawnSpy;

    const result = await (manager as any).spawnLocalAgentProcessUnlocked(
      teamId,
      'default',
      {
        id: 'agent-portable',
        name: '../../Portable Agent',
        port: 4109,
        workingDirectory: path.join(workDir, 'project with spaces'),
      },
    );

    expect(result.success).toBe(true);
    expect(result.logFile).toBe(path.join(logDir, 'agent-agent-portable.log'));
    expect(fs.statSync(logDir).isDirectory()).toBe(true);
    expect(fs.statSync(result.logFile).isFile()).toBe(true);
    const [executable, args, options] = spawnSpy.mock.calls[0];
    expect(executable).toBe(process.execPath);
    expect(args).toContain('../../Portable Agent');
    expect(args).toContain(path.join(workDir, 'project with spaces'));
    expect(options.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(options.env.IDACC_PARENT_PID).toBe(String(process.pid));
    expect(options.env.IDACC_ADMIN_TOKEN).toBeUndefined();
    expect(options.env.BRAIN_TOKEN).toBeUndefined();
    expect(options.detached).toBe(true);
    expect(options.windowsHide).toBe(true);
    expect(proc.unref).toHaveBeenCalledOnce();
  });

  it('durably binds a managed worker generation to the exact runtime lane issued at spawn', async () => {
    process.env.IDACC_ADMIN_TOKEN = 'managed-issued-lane-admin-token';
    process.env.IDACC_MANAGER_SERVICE_TOKEN = 'managed-issued-lane-service-token-000000000000';
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);
    const teamId = await db.teams.getOrCreateTeamId('default');
    await db.agents.create(agentRow({
      team_id: teamId,
      id: 'agent-issued-lane',
      name: 'issued-lane',
      port: 4110,
      status: 'pending',
      runtime: 'codex',
      metadata: {
        runtime: 'codex',
        runtimeCredentialLane: 'codex-subscription-b',
      },
    }));
    (manager as any).runtimeCredentialPoolByTeam.set(teamId, {
      lanes: [
        { id: 'codex-subscription-a', runtime: 'codex', kind: 'subscription' },
        { id: 'codex-subscription-b', runtime: 'codex', kind: 'subscription' },
      ],
    });
    (manager as any).killAgentProcess = vi.fn(async () => ({ killed: false, pids: [] }));
    (manager as any).clearAgentPid = vi.fn(async () => {});
    (manager as any).waitForAgentPortToBind = vi.fn(async () => ({ ok: true }));
    const proc = Object.assign(new EventEmitter(), {
      pid: 54322,
      unref: vi.fn(),
    });
    const spawnSpy = vi.fn(() => proc);
    (manager as any).spawnLocalAgentChild = spawnSpy;

    const result = await (manager as any).spawnLocalAgentProcessUnlocked(
      teamId,
      'default',
      {
        id: 'agent-issued-lane',
        name: 'issued-lane',
        port: 4110,
      },
    );

    expect(result.success).toBe(true);
    const options = spawnSpy.mock.calls[0][2];
    expect(options.env.ID_HARNESS).toBe('codex');
    expect(options.env.ID_RUNTIME_LANE_ID).toBe('codex-subscription-b');
    expect(options.env.IDACC_MANAGER_AGENT_TOKEN).toEqual(expect.any(String));
    const persisted = await db.agents.getById('agent-issued-lane');
    expect(persisted?.metadata).toMatchObject({
      processGeneration: expect.any(String),
      processRuntime: 'codex',
      processRuntimeLane: 'codex-subscription-b',
      pid: 54322,
    });
  });

  it('bounds profile-owned agent logs while retaining their newest tail', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);
    process.env.IDACC_AGENT_LOG_DIR = path.join(workDir, 'logs', 'agents');
    const logFile = (manager as any).localAgentLogFile('agent-retention');
    const content = Buffer.alloc(2_048);
    for (let index = 0; index < content.length; index += 1) content[index] = index % 251;
    fs.writeFileSync(logFile, content, { mode: 0o600 });

    (manager as any).enforceLocalAgentLogRetention(1_024, 256);

    const retained = fs.readFileSync(logFile);
    expect(retained.length).toBe(256);
    expect(retained).toEqual(content.subarray(content.length - 256));
    if (process.platform !== 'win32') {
      expect(fs.statSync(logFile).mode & 0o777).toBe(0o600);
    }
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

  it('skips occupied loopback ports when allocating a consumer agent endpoint', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);
    vi.spyOn(db.agents, 'nextPort').mockResolvedValue(4101);
    const availability = vi.fn(async (port: number) => port === 4102);
    (manager as any).loopbackPortIsAvailable = availability;

    const port = await (manager as any).dbNextPort();

    expect(port).toBe(4102);
    expect(availability).toHaveBeenNthCalledWith(1, 4101);
    expect(availability).toHaveBeenNthCalledWith(2, 4102);
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

  it('derives catalog profileStatus from live status without mutating stored catalog metadata', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const stoppedRow = agentRow({
      status: 'stopped',
      metadata: {
        runtime: 'codex',
        catalog: { role: 'architecture-engineer', profileStatus: 'active' },
      },
    });
    const stopped = (manager as any).agentToResponse(stoppedRow);
    expect(stopped.metadata.catalog.profileStatus).toBe('blocked-runtime-stopped');
    expect((stoppedRow.metadata as any).catalog.profileStatus).toBe('active');

    const runningRow = agentRow({
      status: 'running',
      metadata: {
        pid: 12345,
        runtime: 'codex',
        processOwner: 'adopted',
        processParentPid: 1,
        catalog: { role: 'engineering-lead', profileStatus: 'blocked-runtime-stopped' },
      },
    });
    const running = (manager as any).agentToResponse(runningRow);
    expect(running.metadata.catalog.profileStatus).toBe('active');
    expect((runningRow.metadata as any).catalog.profileStatus).toBe('blocked-runtime-stopped');

    (manager as any).healthStatus.set('team-1:agent-1', { status: 'offline', lastCheck: 123 });
    const offlineHealth = (manager as any).agentToResponse(runningRow);
    expect(offlineHealth.metadata.catalog.profileStatus).toBe('blocked-runtime-stopped');
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
        metadata: {
          pid: 43210,
          processOwner: 'manager-child',
          processParentPid: process.pid,
          processInspectedAt: 2000,
          processGeneration: 'process-meta-generation',
          processRuntime: 'codex',
          processRuntimeLane: 'codex:default',
          allowed_tools: ['Read'],
          mcpServers: [{ name: 'brain', transport: 'stdio' }],
        },
      }),
    });

    await (manager as any).clearAgentPid('agent-process-meta');

    const row = await db.agents.getById('agent-process-meta');
    expect(row?.metadata).not.toHaveProperty('pid');
    expect(row?.metadata).not.toHaveProperty('processOwner');
    expect(row?.metadata).not.toHaveProperty('processParentPid');
    expect(row?.metadata).not.toHaveProperty('processInspectedAt');
    expect(row?.metadata).not.toHaveProperty('processGeneration');
    expect(row?.metadata).not.toHaveProperty('processRuntime');
    expect(row?.metadata).not.toHaveProperty('processRuntimeLane');
    expect(row?.metadata?.allowed_tools).toEqual(['Read']);
    expect(row?.metadata?.mcpServers).toEqual([{ name: 'brain', transport: 'stdio' }]);
  });

  it('marks owned running agents for restoration and stops them during Manager shutdown', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);
    const teamId = await db.teams.getOrCreateTeamId('default');
    const agentPid = 65432;
    await db.agents.create(agentRow({
      team_id: teamId,
      id: 'agent-shutdown-owned',
      name: 'shutdown-owned',
      port: 4111,
      status: 'running',
      metadata: {
        runtime: 'codex',
        pid: agentPid,
        processOwner: 'manager-child',
        processParentPid: process.pid,
      },
    }));
    (manager as any).killAgentProcess = vi.fn(async () => ({ killed: true, pids: [agentPid] }));
    (manager as any).processIsAlive = vi.fn(() => false);

    await (manager as any).stopManagerOwnedAgentsForShutdown();

    expect((manager as any).killAgentProcess).toHaveBeenCalledWith(4111, 'agent-shutdown-owned');
    const row = await db.agents.getById('agent-shutdown-owned');
    expect(row?.status).toBe('offline');
    expect(row?.metadata?.managerRestartRequested).toBe(true);
    expect(row?.metadata).not.toHaveProperty('pid');
  });

  it('restores only agents explicitly marked for Manager restart', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);
    const teamId = await db.teams.getOrCreateTeamId('default');
    await db.agents.create(agentRow({
      team_id: teamId,
      id: 'agent-restore',
      name: 'restore-me',
      port: 4112,
      status: 'stopped',
      metadata: { runtime: 'codex', managerRestartRequested: true },
    }));
    await db.agents.create(agentRow({
      team_id: teamId,
      id: 'agent-stay-stopped',
      name: 'stay-stopped',
      port: 4113,
      status: 'stopped',
      metadata: { runtime: 'codex' },
    }));
    const spawn = verifiedSpawnStub(db, 76543);
    (manager as any).spawnLocalAgentProcessUnlocked = spawn;

    await (manager as any).restoreManagerOwnedAgentsAfterRestart();

    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(teamId, 'default', expect.objectContaining({
      id: 'agent-restore',
      name: 'restore-me',
      port: 4112,
    }));
    const restored = await db.agents.getById('agent-restore');
    expect(restored?.status).toBe('running');
    expect(restored?.metadata).not.toHaveProperty('managerRestartRequested');
    const parked = await db.agents.getById('agent-stay-stopped');
    expect(parked?.status).toBe('stopped');
  });

  it('prioritizes the primary lead, team leads, and default validators before workers', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);
    const row = (name: string, metadata: Record<string, unknown> = {}) => agentRow({
      team_id: 'team-priority',
      id: `agent-${name}`,
      name,
      metadata: { runtime: 'codex', ...metadata },
    });
    expect((manager as any).startupRestorePriority('default', row('lead'))).toBe(0);
    expect((manager as any).startupRestorePriority('engineering-team', row('engineering-lead'))).toBe(1);
    expect((manager as any).startupRestorePriority('custom-team', row('captain', { role: 'Team coordinator' }))).toBe(1);
    expect((manager as any).startupRestorePriority('default', row('coder'))).toBe(2);
    expect((manager as any).startupRestorePriority('engineering-team', row('backend-engineer'))).toBe(10);
  });

  it('starts a stopped local worker before an explicit dispatch', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);
    const teamId = await db.teams.getOrCreateTeamId('engineering-team');
    await db.agents.create(agentRow({
      team_id: teamId,
      id: 'agent-explicit-dispatch',
      name: 'backend-engineer',
      port: 4119,
      status: 'stopped',
      runtime: 'codex',
      metadata: { runtime: 'codex' },
    }));
    const spawn = verifiedSpawnStub(db, 76546);
    (manager as any).spawnLocalAgentProcessUnlocked = spawn;
    const initial = await db.agents.getById('agent-explicit-dispatch');

    const result = await (manager as any).ensureLocalAgentRunningForExplicitDispatch(
      teamId,
      'engineering-team',
      initial,
    );

    expect(result.success).toBe(true);
    expect(result.agent.status).toBe('running');
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('restores a non-provider worker whose parent-watchdog marker lands after the first managed startup scan', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);
    process.env.IDACC_MANAGED_SERVICE = '1';
    process.env.IDACC_MANAGER_RESTART_MARKER_GRACE_MS = '40';
    const teamId = await db.teams.getOrCreateTeamId('default');
    await db.agents.create(agentRow({
      team_id: teamId,
      id: 'agent-late-parent-watchdog',
      name: 'late-parent-watchdog',
      port: 4117,
      status: 'stopped',
      runtime: 'codex',
      metadata: { runtime: 'codex' },
    }));
    const verifiedSpawn = verifiedSpawnStub(db, 76545);
    (manager as any).spawnLocalAgentProcessUnlocked = verifiedSpawn;

    const lateMarker = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        void (async () => {
          const current = await db.agents.getById('agent-late-parent-watchdog');
          await db.agents.updateMetadata('agent-late-parent-watchdog', {
            ...((current?.metadata as Record<string, unknown>) || {}),
            managerRestartRequested: true,
          });
        })().then(resolve, reject);
      }, 10);
    });
    await Promise.all([
      (manager as any).restoreManagerOwnedAgentsAtStartup(),
      lateMarker,
    ]);

    expect(verifiedSpawn).toHaveBeenCalledOnce();
    const restored = await db.agents.getById('agent-late-parent-watchdog');
    expect(restored?.status).toBe('running');
    expect(restored?.metadata).not.toHaveProperty('managerRestartRequested');
  });

  it('migrates a dead legacy Manager child to durable launch intent before stale metadata is cleared', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);
    const teamId = await db.teams.getOrCreateTeamId('default');
    await db.agents.create(agentRow({
      team_id: teamId,
      id: 'agent-windows-job-loss',
      name: 'windows-job-loss',
      port: 4118,
      status: 'running',
      runtime: 'codex',
      metadata: {
        runtime: 'codex',
        pid: 87654,
        processOwner: 'manager-child',
        processParentPid: 76543,
      },
    }));
    (manager as any).inspectProcess = vi.fn(() => null);
    (manager as any).processIsAlive = vi.fn(() => false);

    await (manager as any).reconcileLocalAgentProcessMetadata();

    const awaiting = await db.agents.getById('agent-windows-job-loss');
    expect(awaiting?.status).toBe('offline');
    expect(awaiting?.metadata).toMatchObject({
      managerOwnedLaunchIntent: true,
      managerRestartRequested: true,
    });
    expect(awaiting?.metadata).not.toHaveProperty('pid');

    const verifiedSpawn = verifiedSpawnStub(db, 87655);
    (manager as any).spawnLocalAgentProcessUnlocked = verifiedSpawn;
    await (manager as any).restoreManagerOwnedAgentsAfterRestart();

    const restored = await db.agents.getById('agent-windows-job-loss');
    expect(verifiedSpawn).toHaveBeenCalledOnce();
    expect(restored?.status).toBe('running');
    expect(restored?.metadata?.managerOwnedLaunchIntent).toBe(true);
    expect(restored?.metadata).not.toHaveProperty('managerRestartRequested');
  });

  it('does not adopt a running port without exact PID attestation during restore', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);
    const teamId = await db.teams.getOrCreateTeamId('default');
    await db.agents.create(agentRow({
      team_id: teamId,
      id: 'agent-restore-pid-mismatch',
      name: 'restore-pid-mismatch',
      port: 4120,
      status: 'running',
      runtime: 'codex',
      metadata: {
        runtime: 'codex',
        pid: 91001,
        managerOwnedLaunchIntent: true,
        managerRestartRequested: true,
      },
    }));
    const probe = vi.spyOn(manager as any, 'probeLocalAgentIdentity')
      .mockResolvedValue({ ok: true, attested: false });
    const spawn = verifiedSpawnStub(db, 91002);
    (manager as any).spawnLocalAgentProcessUnlocked = spawn;

    await (manager as any).restoreManagerOwnedAgentsAfterRestart();

    expect(probe).toHaveBeenCalledWith(
      4120,
      { id: 'agent-restore-pid-mismatch', name: 'restore-pid-mismatch', pid: 91001 },
      { requireAttestation: true },
    );
    expect(spawn).toHaveBeenCalledOnce();
    const row = await db.agents.getById('agent-restore-pid-mismatch');
    expect(row?.status).toBe('running');
    expect(row?.metadata?.managerOwnedLaunchIntent).toBe(true);
    expect(row?.metadata).not.toHaveProperty('managerRestartRequested');
  });

  it('uses process-generation CAS so a stale worker cannot stop its replacement', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);
    const teamId = await db.teams.getOrCreateTeamId('default');
    await db.agents.create(agentRow({
      team_id: teamId,
      id: 'agent-generation-cas',
      name: 'generation-cas',
      status: 'running',
      metadata: {
        runtime: 'codex',
        pid: 90002,
        processGeneration: 'replacement-generation',
        processOwner: 'manager-child',
        managerOwnedLaunchIntent: true,
      },
    }));

    expect(await db.agents.transitionOwnedProcessExit(
      'agent-generation-cas',
      'stale-generation',
      false,
    )).toBe(false);
    let row = await db.agents.getById('agent-generation-cas');
    expect(row?.status).toBe('running');
    expect(row?.metadata?.pid).toBe(90002);
    expect(row?.metadata?.processGeneration).toBe('replacement-generation');

    const originalQuery = db.adapter.query.bind(db.adapter);
    let releaseExit!: () => void;
    let signalExitStatement!: () => void;
    const exitStatement = new Promise<void>((resolve) => { signalExitStatement = resolve; });
    const exitGate = new Promise<void>((resolve) => { releaseExit = resolve; });
    (db.adapter as any).query = async (sql: string, params: unknown[] = []) => {
      if (
        sql.includes("json_extract(metadata, '$.processGeneration')")
        && params.at(-1) === 'replacement-generation'
      ) {
        signalExitStatement();
        await exitGate;
      }
      return originalQuery(sql, params);
    };
    const validExit = db.agents.transitionOwnedProcessExit(
      'agent-generation-cas',
      'replacement-generation',
      false,
    );
    await exitStatement;
    const beforeExit = await db.agents.getById('agent-generation-cas');
    await db.agents.updateMetadata('agent-generation-cas', {
      ...((beforeExit?.metadata as Record<string, unknown>) || {}),
      allowed_tools: ['Read'],
      mcpServers: [{ name: 'brain', transport: 'stdio' }],
    });
    releaseExit();
    expect(await validExit).toBe(true);
    (db.adapter as any).query = originalQuery;
    row = await db.agents.getById('agent-generation-cas');
    expect(row?.status).toBe('stopped');
    expect(row?.metadata).not.toHaveProperty('pid');
    expect(row?.metadata).not.toHaveProperty('processGeneration');
    expect(row?.metadata).not.toHaveProperty('managerOwnedLaunchIntent');
    expect(row?.metadata?.allowed_tools).toEqual(['Read']);
    expect(row?.metadata?.mcpServers).toEqual([{ name: 'brain', transport: 'stdio' }]);
  });

  it('uses one PostgreSQL JSONB update so generation exit preserves same-generation metadata', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const adapter = {
      dialect: 'postgres' as const,
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }),
      close: vi.fn(async () => {}),
    };
    const repo = new PgAgentsRepo(adapter);

    expect(await repo.transitionOwnedProcessExit(
      'agent-postgres-generation',
      'current-generation',
      true,
    )).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("COALESCE(metadata, '{}'::jsonb)");
    expect(calls[0].sql).toContain("- 'processGeneration'");
    expect(calls[0].sql).toContain("|| '{\"managerRestartRequested\":true}'::jsonb");
    expect(calls[0].sql).not.toMatch(/SET\s+metadata\s*=\s*\$\d/i);
    expect(calls[0].params).toEqual([
      'agent-postgres-generation',
      'current-generation',
      true,
    ]);
  });

  it('does not resurrect a worker that exits between readiness and startup commit', async () => {
    process.env.IDACC_ADMIN_TOKEN = 'startup-commit-admin-token';
    process.env.IDACC_MANAGER_SERVICE_TOKEN = 'startup-commit-service-token-000000000000';
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);
    const teamId = await db.teams.getOrCreateTeamId('default');
    const agentId = 'agent-startup-commit-race';
    await db.agents.create(agentRow({
      team_id: teamId,
      id: agentId,
      name: 'startup-commit-race',
      port: 4123,
      status: 'offline',
      runtime: 'codex',
      metadata: {
        runtime: 'codex',
        runtimeCredentialLane: 'codex:default',
        managerOwnedLaunchIntent: true,
        managerRestartRequested: true,
      },
    }));

    const proc = Object.assign(new EventEmitter(), {
      pid: 99123,
      exitCode: null,
      signalCode: null,
      unref: vi.fn(),
    });
    vi.spyOn(manager as any, 'spawnLocalAgentChild').mockReturnValue(proc);
    vi.spyOn(manager as any, 'killAgentProcess')
      .mockResolvedValue({ killed: false, pids: [] });
    vi.spyOn(manager as any, 'waitForAgentPortToBind')
      .mockResolvedValue({ ok: true });

    const realCommit = db.agents.updateOwnedProcessState.bind(db.agents);
    vi.spyOn(db.agents, 'updateOwnedProcessState').mockImplementation(
      async (id, generation, status, metadata) => {
        expect(status).toBe('running');
        expect(await db.agents.transitionOwnedProcessExit(
          id,
          generation,
          true,
        )).toBe(true);
        return realCommit(id, generation, status, metadata);
      },
    );

    const result = await (manager as any).spawnLocalAgentProcessUnlocked(
      teamId,
      'default',
      {
        id: agentId,
        name: 'startup-commit-race',
        port: 4123,
      },
    );
    expect(result).toMatchObject({
      success: false,
      error: 'verified worker startup could not be committed durably',
    });
    const row = await db.agents.getById(agentId);
    expect(row?.status).toBe('offline');
    expect(row?.metadata).not.toHaveProperty('pid');
    expect(row?.metadata).not.toHaveProperty('processGeneration');
    expect(row?.metadata?.managerRestartRequested).toBe(true);
  });

  it('drains an in-flight lifecycle gate and rechecks shutdown before creating a child', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);
    const teamId = await db.teams.getOrCreateTeamId('default');
    await db.agents.create(agentRow({
      team_id: teamId,
      id: 'agent-shutdown-spawn-barrier',
      name: 'shutdown-spawn-barrier',
      port: 4119,
      status: 'offline',
      runtime: 'codex',
      metadata: {
        runtime: 'codex',
        managerOwnedLaunchIntent: true,
        managerRestartRequested: true,
      },
    }));
    let releaseKill!: () => void;
    let signalKillStarted!: () => void;
    const killStarted = new Promise<void>((resolve) => { signalKillStarted = resolve; });
    const killGate = new Promise<void>((resolve) => { releaseKill = resolve; });
    (manager as any).killAgentProcess = vi.fn(async () => {
      signalKillStarted();
      await killGate;
      return { killed: false, pids: [] };
    });
    const spawnChild = vi.fn();
    (manager as any).spawnLocalAgentChild = spawnChild;

    const spawn = (manager as any).spawnLocalAgentProcess(teamId, 'default', {
      name: 'shutdown-spawn-barrier',
      id: 'agent-shutdown-spawn-barrier',
      port: 4119,
    });
    await killStarted;
    const shutdown = manager.shutdown();
    releaseKill();
    const [spawnResult] = await Promise.all([spawn, shutdown]);

    expect(spawnResult).toMatchObject({
      success: false,
      error: expect.stringMatching(/shutting down/i),
    });
    expect(spawnChild).not.toHaveBeenCalled();
    const row = await db.agents.getById('agent-shutdown-spawn-barrier');
    expect(row?.metadata).toMatchObject({
      managerOwnedLaunchIntent: true,
      managerRestartRequested: true,
    });
  });

  it('keeps provider agents paused until the new Manager process receives an authenticated binding', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);
    const teamId = await db.teams.getOrCreateTeamId('default');
    await db.agents.create(agentRow({
      team_id: teamId,
      id: 'agent-provider-paused',
      name: 'provider-paused',
      port: 4114,
      status: 'offline',
      runtime: 'provider-api',
      metadata: {
        runtime: 'provider:openrouter',
        providerRuntime: {
          lane: 'provider:openrouter',
          name: 'openrouter',
          kind: 'openai-compatible',
          baseUrl: 'https://openrouter.ai/api/v1',
        },
        managerRestartRequested: true,
      },
    }));
    const spawnChild = vi.fn();
    (manager as any).spawnLocalAgentChild = spawnChild;

    const directStart = await (manager as any).spawnLocalAgentProcess(teamId, 'default', {
      name: 'provider-paused',
      id: 'agent-provider-paused',
      port: 4114,
    });
    expect(directStart).toEqual({
      success: false,
      error: expect.stringMatching(/authenticated IDACC control plane rebinds/i),
    });
    expect(spawnChild).not.toHaveBeenCalled();

    // If the desktop rebind arrives while the startup scan is still walking
    // the fleet, the scan must still leave provider resume to the authenticated
    // route so both paths cannot race into duplicate worker spawns.
    (manager as any).providerRuntimeAssignments.set('agent-provider-paused', {
      lane: 'provider:openrouter',
      name: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'process-local-race-binding',
    });
    const statusWrites = vi.spyOn(db.agents, 'updateStatus');
    await (manager as any).restoreManagerOwnedAgentsAfterRestart();
    expect(spawnChild).not.toHaveBeenCalled();
    expect(statusWrites).not.toHaveBeenCalledWith('agent-provider-paused', 'offline');
    const paused = await db.agents.getById('agent-provider-paused');
    expect(paused?.status).toBe('offline');
    expect(paused?.metadata?.managerRestartRequested).toBe(true);
  });

  it('clears a provider restart marker only after a rebound worker passes verified spawn', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);
    const teamId = await db.teams.getOrCreateTeamId('default');
    const apiKey = 'provider-secret-must-stay-process-local';
    await db.agents.create(agentRow({
      team_id: teamId,
      id: 'agent-provider-resume',
      name: 'provider-resume',
      port: 4115,
      status: 'offline',
      runtime: 'provider-api',
      metadata: {
        runtime: 'provider:openrouter',
        providerRuntime: {
          lane: 'provider:openrouter',
          name: 'openrouter',
          kind: 'openai-compatible',
          baseUrl: 'https://openrouter.ai/api/v1',
        },
        managerRestartRequested: true,
      },
    }));
    (manager as any).providerRuntimeAssignments.set('agent-provider-resume', {
      lane: 'provider:openrouter',
      name: 'openrouter',
      kind: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey,
    });
    const verifiedSpawn = verifiedSpawnStub(db, 76544);
    (manager as any).spawnLocalAgentProcessUnlocked = verifiedSpawn;

    const result = await (manager as any).resumeProviderAgentAfterManagerRestart(
      teamId,
      'default',
      'agent-provider-resume',
    );

    expect(result).toEqual({ success: true });
    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(verifiedSpawn).toHaveBeenCalledOnce();
    const resumed = await db.agents.getById('agent-provider-resume');
    expect(resumed?.status).toBe('running');
    expect(resumed?.metadata).not.toHaveProperty('managerRestartRequested');
    expect(JSON.stringify(resumed?.metadata)).not.toContain(apiKey);
  });

  it('keeps failed provider resume attempts offline and marked for a later secure retry', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);
    const teamId = await db.teams.getOrCreateTeamId('default');
    await db.agents.create(agentRow({
      team_id: teamId,
      id: 'agent-provider-resume-failed',
      name: 'provider-resume-failed',
      port: 4116,
      status: 'offline',
      runtime: 'provider-api',
      metadata: {
        runtime: 'provider:openrouter',
        providerRuntime: {
          lane: 'provider:openrouter',
          name: 'openrouter',
          kind: 'openai-compatible',
          baseUrl: 'https://openrouter.ai/api/v1',
        },
        managerRestartRequested: true,
      },
    }));
    (manager as any).providerRuntimeAssignments.set('agent-provider-resume-failed', {
      lane: 'provider:openrouter',
      name: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'failed-provider-secret',
    });
    (manager as any).spawnLocalAgentProcessUnlocked = vi.fn(async () => ({
      success: false,
      error: 'verified spawn failed',
    }));

    const result = await (manager as any).resumeProviderAgentAfterManagerRestart(
      teamId,
      'default',
      'agent-provider-resume-failed',
    );

    expect(result).toEqual({
      success: false,
      status: 503,
      error: expect.stringMatching(/verified worker startup failed/i),
    });
    const paused = await db.agents.getById('agent-provider-resume-failed');
    expect(paused?.status).toBe('offline');
    expect(paused?.metadata?.managerRestartRequested).toBe(true);
    expect(JSON.stringify(result)).not.toContain('failed-provider-secret');
    expect(JSON.stringify(paused?.metadata)).not.toContain('failed-provider-secret');
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
          commandLine: 'node dist/local-agent-server.js coder --team default --port 4101 --id agent-adopted',
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

  it('does not park a scheduled local agent with recent schedule activity', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);
    const nowMs = 1_700_000_600_000;
    const nowSec = Math.floor(nowMs / 1000);
    vi.spyOn(Date, 'now').mockReturnValue(nowMs);

    const teamId = await db.teams.getOrCreateTeamId('skillmesh');
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-recent-scheduled-worker',
        name: 'skill-discoverer',
        port: 4118,
        status: 'running',
        metadata: { runtime: 'codex', pid: 55573, processOwner: 'manager-child', processParentPid: process.pid },
      }),
    });
    const def = scheduleRow({
      id: 'hb-agent-recent-scheduled-worker',
      source_key: 'heartbeat:agent-recent-scheduled-worker',
    });
    await db.schedules.upsertDefinition(def);
    await db.schedules.replaceTargets(def.id, ['agent-recent-scheduled-worker']);
    await db.schedules.insertRun({
      schedule_id: def.id,
      agent_id: 'agent-recent-scheduled-worker',
      scheduled_key: `heartbeat:${nowSec - 60}`,
      scheduled_at: nowSec - 60,
      fired_at: nowSec - 60,
      status: 'sent',
      error: null,
    });

    (manager as any).killAgentProcess = vi.fn(async () => ({ killed: true, pids: [55573] }));

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
      { team: 'skillmesh', name: 'skill-discoverer', status: 'skipped', reason: 'recent_schedule_activity_1_within_10m' },
    ]);
    expect((manager as any).killAgentProcess).not.toHaveBeenCalled();
    expect((await db.agents.getById('agent-recent-scheduled-worker'))?.status).toBe('running');
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

    (manager as any).spawnLocalAgentProcess = verifiedSpawnStub(db, 55572);

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

  it('does not auto-park agents unless an operator explicitly opts in', async () => {
    vi.useFakeTimers();
    process.env.ID_IDLE_PARK_INTERVAL_MS = '60000';
    process.env.ID_IDLE_PARK_INITIAL_DELAY_MS = '1000';
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const parkIdleAgents = vi.spyOn(manager as any, 'parkIdleAgents');

    (manager as any).startIdleParkingSweeper();

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(parkIdleAgents).not.toHaveBeenCalled();

    await manager.shutdown();
  });

  it('runs idle parking only after an explicit operator opt-in', async () => {
    vi.useFakeTimers();
    process.env.ID_IDLE_PARK_ENABLED = 'true';
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
      expect(events.map((event) => (event.data as any).expiry_reason).sort()).toEqual(['pending_timeout', 'processing_timeout']);
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

  it('refreshes framework instructions during agent rebuild and unwraps a legacy org sidecar fence', async () => {
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

    const teamId = await db.teams.getOrCreateTeamId('default');
    await (manager as any).refreshManagedOverlayForRebuild(teamId, 'default', agentRow({
      team_id: teamId,
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
    expect(out).not.toContain('<!-- BEGIN id-agents org -->');
    expect(out).not.toContain('<!-- END id-agents org -->');
    expect(out).toContain('## user tail');

    await (manager as any).refreshManagedOverlayForRebuild(teamId, 'default', agentRow({
      team_id: teamId,
      id: 'agent-refresh',
      name: 'refresh-agent',
      runtime: 'codex',
      working_directory: agentDir,
    }));
    const secondPass = fs.readFileSync(path.join(agentDir, 'AGENTS.md'), 'utf-8');
    expect(secondPass).toBe(out);
    expect(secondPass.match(/new org text from sidecar/g)).toHaveLength(1);
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

  it('threads caller session ids from /ask into agent /talk and the query row', async () => {
    const saved = process.env.BRAIN_CONTEXT_DISABLED;
    let talkServer: Awaited<ReturnType<typeof startTalkServer>> | null = null;
    process.env.BRAIN_CONTEXT_DISABLED = 'true';
    try {
      const { manager, db, workDir } = await makeManager();
      dbs.push(db);
      workDirs.push(workDir);
      talkServer = await startTalkServer({ query_id: 'session-scoped-query' });

      const teamId = await db.teams.getOrCreateTeamId('default');
      await db.agents.create({
        ...agentRow({
          team_id: teamId,
          id: 'agent-session-lead',
          name: 'lead',
          port: 4112,
          status: 'running',
          endpoint: talkServer.endpoint,
          metadata: { primaryLead: true, runtime: 'codex' },
        }),
      });

      const result = await (manager as any).executeRemoteCommand(
        '/ask lead keep this chat scoped',
        teamId,
        'default',
        'operator',
        'desktop-chat-session-1',
      );

      expect(result.ok).toBe(true);
      expect(result.result?.queryId).toBe('session-scoped-query');
      expect(talkServer.talkBodies).toHaveLength(1);
      expect(JSON.parse(talkServer.talkBodies[0] || '{}')).toMatchObject({
        from: 'remote',
        session_id: 'desktop-chat-session-1',
      });
      const row = await db.queries.getByQueryIdForTeam(teamId, 'session-scoped-query');
      expect(row?.session_id).toBe('desktop-chat-session-1');
    } finally {
      await talkServer?.close();
      if (saved === undefined) delete process.env.BRAIN_CONTEXT_DISABLED;
      else process.env.BRAIN_CONTEXT_DISABLED = saved;
    }
  });

  it('dedupes completed Learn ingest /ask prompts before waking the lead', async () => {
    const saved = process.env.BRAIN_CONTEXT_DISABLED;
    let talkServer: Awaited<ReturnType<typeof startTalkServer>> | null = null;
    process.env.BRAIN_CONTEXT_DISABLED = 'true';
    try {
      const { manager, db, workDir } = await makeManager();
      dbs.push(db);
      workDirs.push(workDir);
      talkServer = await startTalkServer({ query_id: 'learn-duplicate-should-not-run' });

      const teamId = await db.teams.getOrCreateTeamId('default');
      await db.agents.create({
        ...agentRow({
          team_id: teamId,
          id: 'agent-default-lead',
          name: 'lead',
          port: 4112,
          status: 'running',
          endpoint: talkServer.endpoint,
          metadata: { primaryLead: true, runtime: 'codex' },
        }),
      });
      const prompt = [
        'IDACC Learn has ingested new material. You are the PRIMARY lead: coordinate recursive learning against active goals.',
        '',
        'Title: github: graphiti',
        'Source: https://github.com/getzep/graphiti',
      ].join('\n');
      await db.queries.upsert(teamId, 'agent-default-lead', {
        query_id: 'existing-learn-ingest-query',
        status: 'completed',
        prompt,
        created: Date.now() - 60_000,
        completed: Date.now() - 30_000,
        owner_kind: 'agent',
        owner_id: 'agent-default-lead',
      });

      const result = await (manager as any).executeRemoteCommand(`/ask lead ${JSON.stringify(prompt)}`, teamId, 'default');

      expect(result.ok).toBe(true);
      expect(result.result).toMatchObject({
        queryId: 'existing-learn-ingest-query',
        status: 'completed',
        deduped: true,
        reason: 'learn_routing_duplicate',
      });
      expect(talkServer.talkBodies).toHaveLength(0);
    } finally {
      await talkServer?.close();
      if (saved === undefined) delete process.env.BRAIN_CONTEXT_DISABLED;
      else process.env.BRAIN_CONTEXT_DISABLED = saved;
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
      const targetRow = await db.queries.getByQueryIdForTeam(legalTeamId, 'legal-lead-new-query');
      const sourceRow = await db.queries.getByQueryIdForTeam(defaultTeamId, 'legal-lead-new-query');
      expect(targetRow?.agent_id).toBe('agent-legal-general-counsel');
      expect((targetRow?.metadata as any)?.shadow_kind).toBeUndefined();
      expect(sourceRow?.metadata).toMatchObject({
        shadow_of_team_id: legalTeamId,
        shadow_kind: 'cross_team_dispatch',
      });
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

  it('rejects cross-team code validation before dispatch when task workspace context is missing', async () => {
    const savedBrainDisabled = process.env.BRAIN_CONTEXT_DISABLED;
    process.env.BRAIN_CONTEXT_DISABLED = 'true';
    try {
      const { manager, db, workDir } = await makeManager();
      dbs.push(db);
      workDirs.push(workDir);
      const operationsTeamId = await db.teams.getOrCreateTeamId('operations-team');
      const defaultTeamId = await db.teams.getOrCreateTeamId('default');
      await db.agents.create(agentRow({
        team_id: defaultTeamId,
        id: 'agent-default-coder',
        name: 'coder',
        status: 'running',
      }));

      const result = await (manager as any).executeRemoteCommand(
        '/ask default/coder Validate commit and npm test evidence in the repository',
        operationsTeamId,
        'operations-team',
        'ops-lead',
      );

      expect(result).toMatchObject({
        ok: false,
        result: {
          code: 'validation_workspace_context_required',
          required: ['context.task_ref', 'context.project_root'],
        },
      });
    } finally {
      if (savedBrainDisabled === undefined) delete process.env.BRAIN_CONTEXT_DISABLED;
      else process.env.BRAIN_CONTEXT_DISABLED = savedBrainDisabled;
    }
  });

  it('preserves task, actor, and project root across a cross-team validation query', async () => {
    const savedBrainDisabled = process.env.BRAIN_CONTEXT_DISABLED;
    process.env.BRAIN_CONTEXT_DISABLED = 'true';
    let talkServer: Awaited<ReturnType<typeof startTalkServer>> | null = null;
    try {
      const { manager, db, workDir } = await makeManager();
      dbs.push(db);
      workDirs.push(workDir);
      talkServer = await startTalkServer({ query_id: 'capital-validation-query' });
      const operationsTeamId = await db.teams.getOrCreateTeamId('operations-team');
      const defaultTeamId = await db.teams.getOrCreateTeamId('default');
      await db.agents.create(agentRow({
        team_id: operationsTeamId,
        id: 'agent-ops-lead',
        name: 'ops-lead',
        status: 'running',
      }));
      await db.agents.create(agentRow({
        team_id: defaultTeamId,
        id: 'agent-default-coder',
        name: 'coder',
        endpoint: talkServer.endpoint,
        port: Number(new URL(talkServer.endpoint).port),
        status: 'running',
      }));
      const task = {
        ...taskRow({
          id: 'task-capital-remediation',
          uuid: '1234abcd-0000-4000-8000-000000000000',
          team_id: operationsTeamId,
          name: 'remediate-capital-production',
          title: 'Remediate Bittrees Capital production snapshot',
          status: 'done',
          workflow_state: 'validation_pending',
        }),
        assignment_id: 'capital-owner-assignment',
      };
      await db.tasks.create(task);
      const projectRoot = path.join(workDir, 'projects', 'bittrees-capital');
      fs.mkdirSync(projectRoot, { recursive: true });

      const result = await (manager as any).executeRemoteCommand(
        '/ask default/coder Validate commit and npm test evidence in the repository',
        operationsTeamId,
        'operations-team',
        'ops-lead',
        undefined,
        { task_ref: '#1234abcd', project_root: projectRoot },
      );

      expect(result).toMatchObject({ ok: true, result: { queryId: 'capital-validation-query' } });
      expect(talkServer.talkBodies).toHaveLength(1);
      const delivered = JSON.parse(talkServer.talkBodies[0]);
      expect(delivered.message).toContain(`Project root: ${projectRoot}`);
      expect(delivered.message).toContain('Task: #1234abcd (remediate-capital-production)');
      expect(delivered.message).toContain('Do not treat the persistent agent workspace as the target checkout.');

      const targetRow = await db.queries.getByQueryIdForTeam(defaultTeamId, 'capital-validation-query');
      const sourceRow = await db.queries.getByQueryIdForTeam(operationsTeamId, 'capital-validation-query');
      expect(targetRow?.metadata).toMatchObject({
        context: {
          kind: 'task',
          task_id: 'task:1234abcd-0000-4000-8000-000000000000',
          assignment_id: 'validation:1234abcd-0000-4000-8000-000000000000:agent-default-coder',
        },
        actor: { agent_id: 'agent-ops-lead', team_id: operationsTeamId },
        scope: { project_root: projectRoot },
      });
      expect(sourceRow?.metadata).toMatchObject({
        context: { kind: 'task' },
        actor: { agent_id: 'agent-ops-lead', team_id: operationsTeamId },
        shadow_of_team_id: defaultTeamId,
        shadow_kind: 'cross_team_dispatch',
      });
    } finally {
      await talkServer?.close();
      if (savedBrainDisabled === undefined) delete process.env.BRAIN_CONTEXT_DISABLED;
      else process.env.BRAIN_CONTEXT_DISABLED = savedBrainDisabled;
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
    await db.queries.upsert(teamId, 'agent-supervised', {
      query_id: 'processing-lead-kickoff',
      status: 'processing',
      prompt: 'Lead delegation kickoff: task #tm12345 ("Codify validation decisions") is assigned to you as the team coordinator.',
      created: now + 18000,
      owner_kind: 'agent',
      owner_id: 'agent-supervised',
    });
    await db.queries.upsert(teamId, 'agent-supervised', {
      query_id: 'pending-task-manager-assignment',
      status: 'pending',
      prompt: 'Task-manager triage assigned existing legal task #tm12345 (Codify validation decisions) to you. Scope: codify the validator decision rubric.',
      created: now + 19000,
      owner_kind: 'agent',
      owner_id: 'agent-supervised',
    });

    const result = await (manager as any).sweepStaleQueries();

    expect(result.duplicateTaskAsk).toBe(10);
    expect(result.total).toBe(10);
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
    expect((await db.queries.getByQueryIdForTeam(teamId, 'processing-lead-kickoff'))?.status).toBe('processing');
    expect((await db.queries.getByQueryIdForTeam(teamId, 'pending-task-manager-assignment'))?.status).toBe('expired');
    const events = await db.events.query({ teamId, topics: ['query:expired'], limit: 20 });
    expect(events.filter((event) => event.subject_id === 'newer-task-delegation').map((event) => (event.data as any).expiry_reason)).toEqual(['duplicate_task_ask']);
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
    const events = await db.events.query({ teamId, topics: ['query:expired'], limit: 10 });
    expect(events.filter((event) => event.subject_id === 'terminal-lead-kickoff').map((event) => (event.data as any).expiry_reason)).toEqual(['terminal_task_ask']);
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

  it('dedupes task-manager assignment prompts against active lead kickoff by task marker', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const teamId = await db.teams.getOrCreateTeamId('legal');
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-hr-manager',
        name: 'hr-manager',
        port: 4115,
        status: 'running',
        endpoint: 'http://127.0.0.1:9',
      }),
    });
    await db.queries.upsert(teamId, 'agent-hr-manager', {
      query_id: 'existing-lead-kickoff',
      status: 'processing',
      prompt: 'Lead delegation kickoff: task #f7d643d3 ("Codify validation decisions") is assigned to you as the team coordinator.',
      created: Date.now(),
      owner_kind: 'agent',
      owner_id: 'agent-hr-manager',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await (manager as any).executeRemoteCommand(
      '/ask hr-manager Task-manager triage assigned existing legal task #f7d643d3 (Codify validation decisions) to you. Scope: codify the validator decision rubric.',
      teamId,
      'legal',
    );

    expect(result.ok).toBe(true);
    expect(result.result?.queryId).toBe('existing-lead-kickoff');
    expect(result.result?.deduped).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
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
