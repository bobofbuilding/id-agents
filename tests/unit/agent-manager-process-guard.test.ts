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

  it('does not park a running agent with recent completed query activity', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const teamId = await db.teams.getOrCreateTeamId('default');
    await db.agents.create({
      ...agentRow({
        team_id: teamId,
        id: 'agent-recent-query',
        name: 'researcher',
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
      { team: 'default', name: 'researcher', status: 'skipped', reason: 'recent_query_activity_1_within_10m' },
    ]);
    expect((manager as any).killAgentProcess).not.toHaveBeenCalled();
    expect((await db.agents.getById('agent-recent-query'))?.status).toBe('running');
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

  it('treats task-master style supervisors as lead-like for idle parking', async () => {
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
      includeLeads: false,
      includeScheduled: false,
      includeActiveTeams: true,
    });

    expect(result.result.parked).toBe(0);
    expect(result.result.agents).toEqual([
      { team: 'ops-team', name: 'task-master', status: 'skipped', reason: 'lead_like_requires_--include-leads' },
    ]);
    expect((manager as any).killAgentProcess).not.toHaveBeenCalled();
    expect((await db.agents.getById('agent-task-master'))?.status).toBe('running');
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
        created: now - 121 * 60 * 1000,
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

  it('defaults to a low active-query cap to avoid lead backlog fan-out', async () => {
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
          id: 'agent-default-busy',
          name: 'default-busy-lead',
          port: 4112,
          status: 'running',
        }),
      });
      const now = Date.now();
      for (const [idx, status] of ['processing', 'pending', 'pending'].entries()) {
        await db.queries.upsert(teamId, 'agent-default-busy', {
          query_id: `default-busy-${idx}`,
          status,
          prompt: `queued work ${idx}`,
          created: now,
          owner_kind: 'agent',
          owner_id: 'agent-default-busy',
        });
      }
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const result = await (manager as any).executeRemoteCommand('/ask default-busy-lead do one more thing', teamId, 'default');

      expect(result.ok).toBe(false);
      expect(result.error).toContain('already has 3 active queries');
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

    const result = await (manager as any).sweepStaleQueries();

    expect(result.duplicateTaskAsk).toBe(6);
    expect(result.total).toBe(6);
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
