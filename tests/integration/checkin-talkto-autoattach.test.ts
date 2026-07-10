// SPDX-License-Identifier: MIT
/**
 * Integration tests for /talk-to auto-attach (slice C5).
 *
 * Boots the real AgentManagerDb against in-memory SQLite, plus a tiny
 * stub HTTP server that pretends to be the target agent's /talk endpoint.
 * Then drives /talk-to with various flag shapes and asserts:
 *
 *   - default auto-attach: task created (owner = target, status = doing) +
 *     checkin (owner = dispatcher, interval 600s, linked_task_id = task.id)
 *     + `checkin:created` event emitted
 *   - --no-checkin (`no_checkin: true`): task is created, no checkin row
 *   - custom duration (`checkin: '30m'`): checkin.interval_seconds = 1800
 *   - default iterations: checkin.max_iterations = 3
 *   - custom iterations (`checkin_iters: 5`): checkin.max_iterations = 5
 *   - no `task` body: legacy /talk-to behavior, no rows created
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import crypto from 'node:crypto';

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
import { SqliteSubscriptionsRepo } from '../../src/db/repos/sqlite/subscriptions-repo.js';
import { SqliteCheckinsRepo } from '../../src/db/repos/sqlite/checkins-repo.js';
import { SqliteRuntimeLaneCooldownsRepo } from '../../src/db/repos/sqlite/runtime-lane-cooldowns-repo.js';
import type { CheckinRow } from '../../src/db/types.js';

const TEAM = 'checkin-autoattach-test';

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
      const addr = server.address() as { port: number };
      server.close(() => resolve(addr.port));
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

/**
 * Tiny stub agent server: every POST returns `{ query_id, status: 'queued' }`
 * — enough for the manager to record a queries row and return 200.
 */
function startStubAgent(port: number, received?: any[]): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        received?.push({ method: req.method, url: req.url, body });
        const queryId = `query_${crypto.randomUUID()}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ query_id: queryId, status: 'queued' }));
      });
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function startStubBrain(port: number, received: { feedback: any[]; validations: any[]; evals: any[]; missing: any[]; edges: any[] }): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};

        if (req.method === 'POST' && url.pathname === '/context/volunteer') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            data: {
              bundles: [{
                entities: [
                  { id: 'agent:coder', name: 'coder', type: 'agent' },
                  { id: 'skill:brain', name: 'Brain', type: 'skill' },
                ],
                textUnits: [{
                  id: 7,
                  title: 'Brain note',
                  content: 'coder uses Brain.',
                }],
              }],
              cited: {
                canonical_source_ids: ['memory:101'],
                entity_ids: ['agent:coder', 'skill:brain'],
                source_origins: { 'memory:101': ['team_instruction'] },
              },
              timelineEventId: 42,
              context_package_id: 77,
            },
          }));
          return;
        }

        if (req.method === 'POST' && url.pathname === '/entity-edges/bulk') {
          const existing = new Set(received.edges.map((edge) => `${edge.kind}:${edge.from}->${edge.to}`));
          for (const edge of body.edges || []) {
            const key = `${edge.kind}:${edge.from}->${edge.to}`;
            if (!existing.has(key)) {
              existing.add(key);
              received.edges.push(edge);
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, upserted: received.edges.length }));
          return;
        }

        if (req.method === 'POST' && url.pathname === '/manager/learning-contract/validate') {
          received.validations.push(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, checked: Object.keys(body).filter((key) => key.endsWith('_context') || key.endsWith('_feedback')) }));
          return;
        }

        if (req.method === 'POST' && url.pathname === '/eval/capture') {
          received.evals.push(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, id: received.evals.length }));
          return;
        }

        if (req.method === 'POST' && url.pathname === '/context/feedback-missing') {
          received.missing.push(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (req.method === 'GET' && url.pathname === '/memory/shared') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            memories: [{
              id: 101,
              agent_id: 'team-instructions',
              mem_key: 'instruction:test',
              content: 'Use the project-specific release checklist before closing deployment tasks.',
              tags: '["team-instruction"]',
              visibility: 'public',
              status: 'active',
              project: url.searchParams.get('project') || '',
              task_id: '',
              session_id: '',
              user_id: '',
              turn_id: '',
            }],
          }));
          return;
        }

        if (req.method === 'POST' && url.pathname === '/instructions/feedback') {
          received.feedback.push(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      });
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function insertAgent(
  db: Awaited<ReturnType<typeof createInMemoryDb>>,
  teamId: string,
  name: string,
  endpoint: string | null,
): Promise<string> {
  const id = `agent_${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ local: true, mesh_member: true });
  await db.adapter.query(
    `INSERT INTO agents (team_id, id, name, type, model, port, endpoint, status, created_at, runtime, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [teamId, id, name, 'persistent', 'claude-opus', 0, endpoint, 'active', Date.now(), 'claude-code', metadata],
  );
  return id;
}

async function getOrInsertAgent(
  db: Awaited<ReturnType<typeof createInMemoryDb>>,
  teamId: string,
  name: string,
  endpoint: string | null,
): Promise<string> {
  const existing = await db.agents.getByName(teamId, name);
  if (existing) return existing.id;
  return insertAgent(db, teamId, name, endpoint);
}

function adminHeaders(team: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Id-Team': team, 'X-Id-Admin': '1' };
}

function validBriefFields() {
  return {
    goal_id: 'goal_mqxibu5r_2k2my',
    expected_output: 'implementation patch and tests',
    acceptance_criteria: ['validates malformed intake', 'preserves completion failure closure'],
    validation_path: { required_default_validators: ['coder', 'researcher'] },
    out_of_scope: ['optional recommendations'],
    backlog_policy: 'Non-required recommendations become backlog candidates.',
    bittrees_relevance: 'medium: improves validator routing reliability for Bittrees contributor work.',
  };
}

async function seedCombinedLeadCapacityBlockers(
  db: Awaited<ReturnType<typeof createInMemoryDb>>,
  teamId: string,
  leadId: string,
  memberId: string,
  prefix: string,
  uuids: { undelegated: string; stalled: string; child: string },
): Promise<{ undelegatedRef: string; stalledRef: string }> {
  const now = Math.floor(Date.now() / 1000);
  const stalledName = `${prefix}-stalled-parent`;

  await db.tasks.create({
    id: `task_${prefix}_undelegated`,
    name: `${prefix}-undelegated-parent`,
    uuid: uuids.undelegated,
    team_id: teamId,
    title: 'Undelegated alpha objective',
    description: 'Lead-owned objective without member-owned child tasks',
    status: 'doing',
    created_by: leadId,
    owner: leadId,
    created_at: now - 4_000,
    updated_at: now - 3_000,
    completed_at: null,
  });
  await db.tasks.create({
    id: `task_${prefix}_stalled`,
    name: stalledName,
    uuid: uuids.stalled,
    team_id: teamId,
    title: 'Stalled beta migration',
    description: 'Lead-owned objective with delegated child work, but no recent activity',
    status: 'doing',
    created_by: leadId,
    owner: leadId,
    created_at: now - 4_000,
    updated_at: now - 3_000,
    completed_at: null,
  });
  await db.tasks.create({
    id: `task_${prefix}_stalled_child`,
    name: `worker-followup-${uuids.child.replace(/-/g, '').slice(0, 8)}`,
    uuid: uuids.child,
    team_id: teamId,
    title: 'Worker follow-up for stalled migration',
    description: `Member-owned child of ${stalledName}`,
    status: 'doing',
    created_by: leadId,
    owner: memberId,
    created_at: now - 3_900,
    updated_at: now - 3_900,
    completed_at: null,
  });

  return {
    undelegatedRef: `#${uuids.undelegated.replace(/-/g, '').slice(0, 8)}`,
    stalledRef: `#${uuids.stalled.replace(/-/g, '').slice(0, 8)}`,
  };
}

function buildCheckinRow(overrides: Partial<CheckinRow> & Pick<CheckinRow, 'id' | 'team_id' | 'owner_agent_id' | 'linked_task_id'>): CheckinRow {
  const now = Date.now();
  return {
    created_by_agent_id: overrides.owner_agent_id,
    interval_seconds: 600,
    priority: 'normal',
    status: 'active',
    close_when: { task_terminal: true },
    max_iterations: null,
    iteration_count: 0,
    next_fire_at: now + 600_000,
    snooze_until: null,
    ttl_expires_at: null,
    last_fire_at: null,
    last_event_seq: null,
    note: null,
    created_at: now,
    updated_at: now,
    closed_at: null,
    closed_reason: null,
    ...overrides,
  };
}

async function withBriefValidationMode<T>(mode: 'off' | 'warn' | 'enforce', fn: () => Promise<T>): Promise<T> {
  const previous = process.env.ID_TASK_BRIEF_VALIDATION;
  process.env.ID_TASK_BRIEF_VALIDATION = mode;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.ID_TASK_BRIEF_VALIDATION;
    else process.env.ID_TASK_BRIEF_VALIDATION = previous;
  }
}

describe('/talk-to auto-attach', () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let baseUrl: string;
  let workDir: string;
  let teamId: string;
  let dispatcherId: string;
  let targetId: string;
  let stubAgent: http.Server;

  beforeAll(async () => {
    const managerPort = await findFreePort();
    const stubPort = await findFreePort();
    baseUrl = `http://127.0.0.1:${managerPort}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-autoattach-'));

    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(managerPort);

    teamId = await db.teams.getOrCreateTeamId(TEAM);
    dispatcherId = await insertAgent(db, teamId, 'manager', null);
    targetId = await insertAgent(db, teamId, 'coder', `http://127.0.0.1:${stubPort}`);

    stubAgent = await startStubAgent(stubPort);
  }, 30000);

  afterAll(async () => {
    if (manager) await stopManager(manager);
    if (stubAgent) await new Promise<void>((r) => stubAgent.close(() => r()));
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    // Each test starts from a clean checkin/task slate.
    await db.adapter.query(`DELETE FROM checkins`);
    await db.adapter.query(`DELETE FROM tasks`);
    await db.adapter.query(`DELETE FROM event_log`);
    await db.adapter.query(`DELETE FROM queries`);
  });

  it('auto-attaches a checkin with a 600s default interval when /talk-to creates a task', async () => {
    const res = await fetch(`${baseUrl}/talk-to`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        to: 'coder',
        from: 'manager',
        message: 'build the foo widget',
        wait: false,
        task: { title: 'Build foo widget', name: 'build-foo', ...validBriefFields() },
      }),
    });
    expect(res.status).toBe(200);

    // Task: created with owner = target, status = 'doing'.
    const tasks = await db.tasks.list({ teamId });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      name: 'build-foo',
      title: 'Build foo widget',
      status: 'doing',
      owner: targetId,
      created_by: dispatcherId,
      team_id: teamId,
    });

    // Checkin: linked to the new task with the current manager-selected owner and default 10m cadence.
    const checkins = await db.checkins.list({ teamId });
    expect(checkins).toHaveLength(1);
    expect(checkins[0]).toMatchObject({
      owner_agent_id: targetId,
      created_by_agent_id: dispatcherId,
      linked_task_id: tasks[0].id,
      interval_seconds: 600,
      priority: 'normal',
      status: 'active',
      max_iterations: 3,
    });
    expect(checkins[0].next_fire_at).toBeGreaterThan(Date.now() - 1000);
    expect(checkins[0].last_event_seq).not.toBeNull();

    // Event: checkin:created landed in event_log.
    const events = await db.events.query({ teamId, topics: ['checkin:created'] });
    expect(events).toHaveLength(1);
    expect(events[0].subject_id).toBe(checkins[0].id);
  });

  it('skips the checkin when no_checkin: true (task is still created)', async () => {
    const res = await fetch(`${baseUrl}/talk-to`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        to: 'coder',
        from: 'manager',
        message: 'no need to watch this one',
        wait: false,
        task: { title: 'Quick fix', ...validBriefFields() },
        no_checkin: true,
      }),
    });
    expect(res.status).toBe(200);

    const tasks = await db.tasks.list({ teamId });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Quick fix');

    const checkins = await db.checkins.list({ teamId });
    expect(checkins).toHaveLength(0);

    const events = await db.events.query({ teamId, topics: ['checkin:created'] });
    expect(events).toHaveLength(0);
  });

  it('honors --checkin <duration> override', async () => {
    const res = await fetch(`${baseUrl}/talk-to`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        to: 'coder',
        from: 'manager',
        message: 'longer cadence please',
        wait: false,
        task: { title: 'Long-running migration', ...validBriefFields() },
        checkin: '30m',
      }),
    });
    expect(res.status).toBe(200);

    const checkins = await db.checkins.list({ teamId });
    expect(checkins).toHaveLength(1);
    expect(checkins[0].interval_seconds).toBe(1800);
    expect(checkins[0].max_iterations).toBe(3);
  });

  it('honors --checkin-iters <N> override', async () => {
    const res = await fetch(`${baseUrl}/talk-to`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        to: 'coder',
        from: 'manager',
        message: 'cap follow-ups',
        wait: false,
        task: { title: 'Bounded check', ...validBriefFields() },
        checkin: '5m',
        checkin_iters: 5,
      }),
    });
    expect(res.status).toBe(200);

    const checkins = await db.checkins.list({ teamId });
    expect(checkins).toHaveLength(1);
    expect(checkins[0].interval_seconds).toBe(300);
    expect(checkins[0].max_iterations).toBe(5);
  });

  it('rejects an invalid checkin duration with 400', async () => {
    const res = await fetch(`${baseUrl}/talk-to`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        to: 'coder',
        from: 'manager',
        message: 'bad flag',
        wait: false,
        task: { title: 'Will not be created' },
        checkin: 'not-a-duration',
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid_checkin_duration');

    // Task and checkin both stay un-created on validation failure.
    expect(await db.tasks.list({ teamId })).toHaveLength(0);
    expect(await db.checkins.list({ teamId })).toHaveLength(0);
  });

  it('rejects trigger:true auto-attach before task/checkin creation when the brief is malformed', async () => {
    await withBriefValidationMode('warn', async () => {
      const res = await fetch(`${baseUrl}/talk-to`, {
        method: 'POST',
        headers: adminHeaders(TEAM),
        body: JSON.stringify({
          to: 'coder',
          from: 'manager',
          message: 'execute a malformed delegated task',
          wait: false,
          trigger: true,
          task: { title: 'Malformed delegated task', name: 'malformed-delegated-task' },
        }),
      });
      expect(res.status).toBe(422);
      const body = await res.json() as { error: string; brief_validation?: { dispatch_ready: boolean; missing: string[] } };
      expect(body.error).toBe('task_brief_not_dispatch_ready');
      expect(body.brief_validation?.dispatch_ready).toBe(false);
      expect(body.brief_validation?.missing).toEqual(expect.arrayContaining([
        'goal_id',
        'expected_output',
        'acceptance_criteria',
        'validation_path',
        'out_of_scope',
        'backlog_policy',
      ]));

      expect(await db.tasks.list({ teamId })).toHaveLength(0);
      expect(await db.checkins.list({ teamId })).toHaveLength(0);
    });
  });

  it('allows trigger:true auto-attach when the brief is dispatch-ready', async () => {
    await withBriefValidationMode('warn', async () => {
      const res = await fetch(`${baseUrl}/talk-to`, {
        method: 'POST',
        headers: adminHeaders(TEAM),
        body: JSON.stringify({
          to: 'coder',
          from: 'manager',
          message: 'execute a validated delegated task',
          wait: false,
          trigger: true,
          task: {
            title: 'Validated delegated task',
            name: 'validated-delegated-task',
            ...validBriefFields(),
          },
        }),
      });
      expect(res.status).toBe(200);
      const tasks = await db.tasks.list({ teamId });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ name: 'validated-delegated-task', status: 'doing', owner: targetId });
      expect(tasks[0].description).toContain('Goal ID: goal_mqxibu5r_2k2my');
      expect(await db.checkins.list({ teamId })).toHaveLength(1);
    });
  });

  it('does not create any rows when /talk-to has no `task` field (legacy path unchanged)', async () => {
    const res = await fetch(`${baseUrl}/talk-to`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        to: 'coder',
        from: 'manager',
        message: 'just a ping',
        wait: false,
      }),
    });
    expect(res.status).toBe(200);

    expect(await db.tasks.list({ teamId })).toHaveLength(0);
    expect(await db.checkins.list({ teamId })).toHaveLength(0);
  });

  it('enforces task brief validation on POST /tasks and triages malformed legacy claims', async () => {
    await withBriefValidationMode('enforce', async () => {
      const rejected = await fetch(`${baseUrl}/tasks`, {
        method: 'POST',
        headers: adminHeaders(TEAM),
        body: JSON.stringify({
          title: 'Malformed task',
          name: 'malformed-task',
          description: 'Missing required brief metadata',
          from: 'manager',
        }),
      });
      expect(rejected.status).toBe(422);
      expect(await db.tasks.list({ teamId })).toHaveLength(0);

      const accepted = await fetch(`${baseUrl}/tasks`, {
        method: 'POST',
        headers: adminHeaders(TEAM),
        body: JSON.stringify({
          title: 'Ready task',
          name: 'ready-task',
          description: 'Has structured brief fields',
          from: 'manager',
          ...validBriefFields(),
        }),
      });
      expect(accepted.status).toBe(201);
      const body = await accepted.json() as { brief_validation?: { ok: boolean } };
      expect(body.brief_validation?.ok).toBe(true);

      const now = Math.floor(Date.now() / 1000);
      await db.tasks.create({
        id: `task_${Date.now()}_legacy`,
        name: 'legacy-malformed-task',
        uuid: crypto.randomUUID(),
        team_id: teamId,
        title: 'Legacy malformed task',
        description: 'Old row without a full brief',
        status: 'todo',
        created_by: null,
        owner: null,
        created_at: now,
        updated_at: now,
        completed_at: null,
      });

      const claim = await fetch(`${baseUrl}/tasks/legacy-malformed-task/claim`, {
        method: 'POST',
        headers: adminHeaders(TEAM),
        body: JSON.stringify({ agent_id: 'coder' }),
      });
      expect(claim.status).toBe(409);
      const claimBody = await claim.json() as { error: string; brief_validation?: { dispatch_ready: boolean } };
      expect(claimBody.error).toBe('task_brief_not_dispatch_ready');
      expect(claimBody.brief_validation?.dispatch_ready).toBe(false);
    });
  });

  it('routes ownerless REST and CLI task creation to the configured team lead when available', async () => {
    await withBriefValidationMode('enforce', async () => {
      const restRoutingTeam = `owner-routing-rest-${Date.now()}`;
      const restRoutingTeamId = await db.teams.getOrCreateTeamId(restRoutingTeam);
      await insertAgent(db, restRoutingTeamId, 'engineering-lead', null);

      const restCreate = await fetch(`${baseUrl}/tasks`, {
        method: 'POST',
        headers: adminHeaders(restRoutingTeam),
        body: JSON.stringify({
          title: 'REST default lead owner task',
          name: `rest-default-lead-owner-${Date.now()}`,
          from: 'manager',
          ...validBriefFields(),
        }),
      });
      expect(restCreate.status).toBe(201);
      const restBody = await restCreate.json() as {
        task?: { ownerName?: string | null; status?: string };
        default_owner_routing?: { owner?: string; reason?: string };
      };
      expect(restBody.task?.ownerName).toBe('engineering-lead');
      expect(restBody.task?.status).toBe('doing');
      expect(restBody.default_owner_routing).toMatchObject({
        owner: 'engineering-lead',
        reason: 'configured_team_lead',
      });

      const cliRoutingTeam = `owner-routing-cli-${Date.now()}`;
      const cliRoutingTeamId = await db.teams.getOrCreateTeamId(cliRoutingTeam);
      await insertAgent(db, cliRoutingTeamId, 'engineering-lead', null);

      const cliCreate = await fetch(`${baseUrl}/remote`, {
        method: 'POST',
        headers: adminHeaders(cliRoutingTeam),
        body: JSON.stringify({
          from: 'manager',
          command: '/task create "CLI default lead owner task" --name cli-default-lead-owner --goal goal_mqxibu5r_2k2my --expected-output "implementation patch and tests" --acceptance "covers CLI default lead owner" --validation-path "coder and researcher" --out-of-scope "optional recommendations" --recommendation-routing "Non-required recommendations become backlog candidates." --bittrees-relevance "medium: improves manager delegation reliability for Bittrees contributor work."',
        }),
      });
      expect(cliCreate.status).toBe(200);
      const cliBody = await cliCreate.json() as {
        ok: boolean;
        result?: { task?: { ownerName?: string | null; status?: string } };
      };
      expect(cliBody.ok).toBe(true);
      expect(cliBody.result?.task?.ownerName).toBe('engineering-lead');
      expect(cliBody.result?.task?.status).toBe('doing');
    });
  });

  it('requires acceptance coverage or an explicit failure note before successful done in enforce mode', async () => {
    await withBriefValidationMode('enforce', async () => {
      const created = await fetch(`${baseUrl}/tasks`, {
        method: 'POST',
        headers: adminHeaders(TEAM),
        body: JSON.stringify({
          title: 'Completion packet task',
          name: 'completion-packet-task',
          from: 'manager',
          ...validBriefFields(),
        }),
      });
      expect(created.status).toBe(201);

      const claimed = await fetch(`${baseUrl}/tasks/completion-packet-task/claim`, {
        method: 'POST',
        headers: adminHeaders(TEAM),
        body: JSON.stringify({ agent_id: 'coder' }),
      });
      expect(claimed.status).toBe(200);

      const rejected = await fetch(`${baseUrl}/tasks/completion-packet-task/done`, {
        method: 'POST',
        headers: adminHeaders(TEAM),
        body: JSON.stringify({ agent_id: 'coder' }),
      });
      expect(rejected.status).toBe(422);
      const rejectedBody = await rejected.json() as { error: string };
      expect(rejectedBody.error).toBe('task_completion_packet_required');
      const stillDoing = await db.tasks.getByNameForTeam('completion-packet-task', teamId);
      expect(stillDoing?.status).toBe('doing');

      const done = await fetch(`${baseUrl}/tasks/completion-packet-task/done`, {
        method: 'POST',
        headers: adminHeaders(TEAM),
        body: JSON.stringify({
          agent_id: 'coder',
          failure_note: 'closed with explicit failure note for validation',
        }),
      });
      expect(done.status).toBe(200);
      const finished = await db.tasks.getByNameForTeam('completion-packet-task', teamId);
      expect(finished?.status).toBe('done');

      const coverageCreated = await fetch(`${baseUrl}/tasks`, {
        method: 'POST',
        headers: adminHeaders(TEAM),
        body: JSON.stringify({
          title: 'Coverage completion packet task',
          name: 'coverage-completion-packet-task',
          from: 'manager',
          ...validBriefFields(),
        }),
      });
      expect(coverageCreated.status).toBe(201);

      const coverageClaimed = await fetch(`${baseUrl}/tasks/coverage-completion-packet-task/claim`, {
        method: 'POST',
        headers: adminHeaders(TEAM),
        body: JSON.stringify({ agent_id: 'coder' }),
      });
      expect(coverageClaimed.status).toBe(200);

      const coverageDone = await fetch(`${baseUrl}/tasks/coverage-completion-packet-task/done`, {
        method: 'POST',
        headers: adminHeaders(TEAM),
        body: JSON.stringify({
          agent_id: 'coder',
          acceptance_coverage: ['validated done success via acceptance coverage'],
        }),
      });
      expect(coverageDone.status).toBe(200);
      const coverageFinished = await db.tasks.getByNameForTeam('coverage-completion-packet-task', teamId);
      expect(coverageFinished?.status).toBe('done');
    });
  });

  it('allows configured team leads to complete advisory tasks with no_delegation_reason', async () => {
    const engTeamId = await db.teams.getOrCreateTeamId('engineering-team');
    const leadId = await getOrInsertAgent(db, engTeamId, 'engineering-lead', null);
    const memberId = await getOrInsertAgent(db, engTeamId, 'implementation-engineer', null);

    const created = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: adminHeaders('engineering-team'),
      body: JSON.stringify({
        title: 'Advisory manager query',
        name: 'advisory-manager-query',
        from: 'engineering-lead',
        ...validBriefFields(),
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { task?: { ownerName?: string | null; status?: string } };
    expect(createdBody.task?.ownerName).toBe('engineering-lead');
    expect(createdBody.task?.status).toBe('doing');

    const rejected = await fetch(`${baseUrl}/tasks/advisory-manager-query/done`, {
      method: 'POST',
      headers: adminHeaders('engineering-team'),
      body: JSON.stringify({
        agent_id: 'engineering-lead',
        failure_note: 'advisory query produced no child implementation tasks',
      }),
    });
    expect(rejected.status).toBe(409);
    const rejectedBody = await rejected.json() as { error: string };
    expect(rejectedBody.error).toContain('delegated_task_names');

    const done = await fetch(`${baseUrl}/tasks/advisory-manager-query/done`, {
      method: 'POST',
      headers: adminHeaders('engineering-team'),
      body: JSON.stringify({
        agent_id: 'engineering-lead',
        failure_note: 'advisory query produced no child implementation tasks',
        no_delegation_reason: 'advisory_query: manager asked for guardrail analysis, not delegated child execution',
      }),
    });
    expect(done.status).toBe(200);
    const finished = await db.tasks.getByNameForTeam('advisory-manager-query', engTeamId);
    expect(finished?.status).toBe('done');

    const now = Math.floor(Date.now() / 1000);
    await db.tasks.create({
      id: 'task_fresh_parent',
      name: 'fresh-lead-objective',
      uuid: '44444444-4444-4444-8444-444444444444',
      team_id: engTeamId,
      title: 'Fresh lead objective',
      description: 'Parent objective still inside the delegation grace window',
      status: 'doing',
      created_by: leadId,
      owner: leadId,
      created_at: now - 120,
      updated_at: now - 120,
      completed_at: null,
    });
    const freshAudit = await fetch(`${baseUrl}/tasks/fresh-lead-objective`, {
      headers: adminHeaders('engineering-team'),
    });
    expect(freshAudit.status).toBe(200);
    const freshAuditBody = await freshAudit.json() as { task: { delegationAudit?: { status?: string; childTaskRefs?: string[]; childTasks?: unknown[] } } };
    expect(freshAuditBody.task.delegationAudit?.status).toBe('pending-delegation');
    expect(freshAuditBody.task.delegationAudit?.childTaskRefs).toEqual([]);
    expect(freshAuditBody.task.delegationAudit?.childTasks).toEqual([]);

    await db.tasks.create({
      id: 'task_old_child',
      name: 'old-child-work',
      uuid: '11111111-1111-4111-8111-111111111111',
      team_id: engTeamId,
      title: 'Old child work',
      description: 'Mentions new lead objective but predates it',
      status: 'done',
      created_by: leadId,
      owner: memberId,
      created_at: now - 1_200,
      updated_at: now - 1_150,
      completed_at: now - 1_150,
    });
    await db.tasks.create({
      id: 'task_new_parent',
      name: 'new-lead-objective',
      uuid: '22222222-2222-4222-8222-222222222222',
      team_id: engTeamId,
      title: 'New lead objective',
      description: 'Parent objective that still needs delegation',
      status: 'doing',
      created_by: leadId,
      owner: leadId,
      created_at: now - 900,
      updated_at: now - 900,
      completed_at: null,
    });

    const staleAudit = await fetch(`${baseUrl}/tasks/new-lead-objective`, {
      headers: adminHeaders('engineering-team'),
    });
    expect(staleAudit.status).toBe(200);
    const staleAuditBody = await staleAudit.json() as { task: { delegationAudit?: { status?: string; childTaskRefs?: string[]; childTasks?: unknown[] } } };
    expect(staleAuditBody.task.delegationAudit?.status).toBe('needs-delegation');
    expect(staleAuditBody.task.delegationAudit?.childTaskRefs).toEqual([]);
    expect(staleAuditBody.task.delegationAudit?.childTasks).toEqual([]);

    await db.tasks.create({
      id: 'task_new_child',
      name: 'new-child-work',
      uuid: '33333333-3333-4333-8333-333333333333',
      team_id: engTeamId,
      title: 'New child work',
      description: 'Real child for new-lead-objective',
      status: 'done',
      created_by: leadId,
      owner: memberId,
      created_at: now - 800,
      updated_at: now - 700,
      completed_at: now - 700,
    });

    const delegatedAudit = await fetch(`${baseUrl}/tasks/new-lead-objective`, {
      headers: adminHeaders('engineering-team'),
    });
    expect(delegatedAudit.status).toBe(200);
    const delegatedAuditBody = await delegatedAudit.json() as {
      task: {
        delegationAudit?: {
          status?: string;
          childTaskRefs?: string[];
          childTasks?: Array<{ ref?: string; title?: string; status?: string; ownerName?: string | null }>;
        };
      };
    };
    expect(delegatedAuditBody.task.delegationAudit?.status).toBe('ok');
    expect(delegatedAuditBody.task.delegationAudit?.childTaskRefs).toEqual(['#33333333']);
    expect(delegatedAuditBody.task.delegationAudit?.childTasks).toEqual([
      expect.objectContaining({
        ref: '#33333333',
        title: 'New child work',
        status: 'done',
        ownerName: 'implementation-engineer',
      }),
    ]);
  });

  it('blocks team leads from accepting another parent objective until current lead work is delegated', async () => {
    // Pinned to a concurrency limit of 1 so this test keeps exercising the
    // "any undelegated objective blocks the next one" edge case. The
    // manager's default LEAD_MAX_PARALLEL_OBJECTIVES (3) intentionally lets
    // a lead hold several concurrent objectives before this gate fires —
    // see the dedicated concurrency-limit regression tests below.
    const previousLeadMaxParallel = process.env.LEAD_MAX_PARALLEL_OBJECTIVES;
    process.env.LEAD_MAX_PARALLEL_OBJECTIVES = '1';
    try {
    const engTeamId = await db.teams.getOrCreateTeamId('engineering-team');
    const leadId = await getOrInsertAgent(db, engTeamId, 'engineering-lead', null);
    const memberId = await getOrInsertAgent(db, engTeamId, 'implementation-engineer', null);
    const now = Math.floor(Date.now() / 1000);

    await db.tasks.create({
      id: 'task_existing_parent',
      name: 'existing-lead-parent',
      uuid: '55555555-5555-4555-8555-555555555555',
      team_id: engTeamId,
      title: 'Existing lead parent',
      description: 'Lead-owned parent objective that must be decomposed',
      status: 'doing',
      created_by: leadId,
      owner: leadId,
      created_at: now - 900,
      updated_at: now - 900,
      completed_at: null,
    });

    const created = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: adminHeaders('engineering-team'),
      body: JSON.stringify({
        title: 'Second lead parent',
        name: 'second-lead-parent',
        from: 'engineering-lead',
        ...validBriefFields(),
      }),
    });
    expect(created.status).toBe(201);

    const blockedClaim = await fetch(`${baseUrl}/tasks/second-lead-parent/claim`, {
      method: 'POST',
      headers: adminHeaders('engineering-team'),
      body: JSON.stringify({ agent_id: 'engineering-lead' }),
    });
    expect(blockedClaim.status).toBe(409);
    const blockedBody = await blockedClaim.json() as { error: string; blocking_tasks?: string[] };
    expect(blockedBody.error).toBe('lead_delegation_backlog');
    expect(blockedBody.blocking_tasks).toContain('#55555555');
    const stillQueued = await db.tasks.getByNameForTeam('second-lead-parent', engTeamId);
    expect(stillQueued?.status).toBe('todo');
    expect(stillQueued?.owner).toBeNull();

    await db.tasks.create({
      id: 'task_existing_child',
      name: 'existing-child-work',
      uuid: '66666666-6666-4666-8666-666666666666',
      team_id: engTeamId,
      title: 'Existing child work',
      description: 'Member-owned child for existing-lead-parent',
      status: 'doing',
      created_by: leadId,
      owner: memberId,
      created_at: now - 800,
      updated_at: now - 700,
      completed_at: null,
    });

    const allowedClaim = await fetch(`${baseUrl}/tasks/second-lead-parent/claim`, {
      method: 'POST',
      headers: adminHeaders('engineering-team'),
      body: JSON.stringify({ agent_id: 'engineering-lead' }),
    });
    expect(allowedClaim.status).toBe(200);
    const claimed = await db.tasks.getByNameForTeam('second-lead-parent', engTeamId);
    expect(claimed?.status).toBe('doing');
    expect(claimed?.owner).toBe(leadId);

    const cliBlocked = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: adminHeaders('engineering-team'),
      body: JSON.stringify({
        from: 'engineering-lead',
        command: '/task create "CLI blocked lead parent" --name cli-blocked-lead-parent --owner engineering-lead --goal goal_mqxibu5r_2k2my --expected-output "implementation patch and tests" --acceptance "covers CLI lead backlog guard" --validation-path "coder and researcher" --out-of-scope "optional recommendations" --backlog-policy "Non-required recommendations become backlog candidates." --bittrees-relevance "medium: improves manager delegation reliability for Bittrees contributor work."',
      }),
    });
    expect(cliBlocked.status).toBe(200);
    const cliBlockedBody = await cliBlocked.json() as {
      ok: boolean;
      error?: string;
      result?: { message?: string; blocking_tasks?: string[] };
    };
    expect(cliBlockedBody).toMatchObject({ ok: false, error: 'lead_delegation_backlog' });
    expect(cliBlockedBody.result?.message).toContain('lead_delegation_backlog');
    expect(cliBlockedBody.result?.blocking_tasks).toBeDefined();
    expect(await db.tasks.getByNameForTeam('cli-blocked-lead-parent', engTeamId)).toBeNull();
    } finally {
      if (previousLeadMaxParallel === undefined) delete process.env.LEAD_MAX_PARALLEL_OBJECTIVES;
      else process.env.LEAD_MAX_PARALLEL_OBJECTIVES = previousLeadMaxParallel;
    }
  });

  it('lets a lead hold concurrent parent objectives up to the configured limit, then blocks with the full blocker list', async () => {
    const engTeamId = await db.teams.getOrCreateTeamId('engineering-team');
    const leadId = await getOrInsertAgent(db, engTeamId, 'engineering-lead', null);
    const now = Math.floor(Date.now() / 1000);

    // Two recent lead-owned objectives, still inside the delegation grace
    // window (not stalled) and without children yet — this used to block
    // any further claim by itself (count=1). With the default
    // LEAD_MAX_PARALLEL_OBJECTIVES=3, holding two of these is fine.
    for (const suffix of ['a', 'b']) {
      await db.tasks.create({
        id: `task_concurrency_${suffix}`,
        name: `concurrency-parent-${suffix}`,
        uuid: `2222222${suffix}-2222-4222-8222-222222222222`,
        team_id: engTeamId,
        title: `Concurrency parent ${suffix}`,
        description: 'Recent lead-owned objective, no children yet',
        status: 'doing',
        created_by: leadId,
        owner: leadId,
        created_at: now - 30,
        updated_at: now - 30,
        completed_at: null,
      });
    }

    // A third concurrent objective is still within the limit (2 held + 1 == 3).
    const thirdCreate = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: adminHeaders('engineering-team'),
      body: JSON.stringify({
        title: 'Third concurrent parent',
        name: 'concurrency-parent-c',
        from: 'engineering-lead',
        ...validBriefFields(),
      }),
    });
    expect(thirdCreate.status).toBe(201);
    const thirdBody = await thirdCreate.json() as { task?: { ownerName?: string | null; status?: string } };
    expect(thirdBody.task?.ownerName).toBe('engineering-lead');
    expect(thirdBody.task?.status).toBe('doing');

    // A fourth would exceed the limit (3 held + 1 == 4 > 3) — blocked, and
    // the block reports the full set of held-but-undelegated objectives in
    // one shot instead of one blocker at a time.
    const fourthCreate = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: adminHeaders('engineering-team'),
      body: JSON.stringify({
        title: 'Fourth concurrent parent',
        name: 'concurrency-parent-d',
        from: 'engineering-lead',
        ...validBriefFields(),
      }),
    });
    expect(fourthCreate.status).toBe(201);
    const fourthBody = await fourthCreate.json() as {
      task?: { ownerName?: string | null; status?: string };
      default_owner_routing?: { warning?: string };
    };
    expect(fourthBody.task?.ownerName).toBeNull();
    expect(fourthBody.task?.status).toBe('todo');
    expect(fourthBody.default_owner_routing?.warning).toContain('lead_delegation_backlog');
  });

  it('does not block an under-limit lead merely because one objective is past delegation grace', async () => {
    const previousLeadMaxParallel = process.env.LEAD_MAX_PARALLEL_OBJECTIVES;
    process.env.LEAD_MAX_PARALLEL_OBJECTIVES = '3';
    try {
      const engTeamId = await db.teams.getOrCreateTeamId('engineering-team');
      const leadId = await getOrInsertAgent(db, engTeamId, 'engineering-lead', null);
      const now = Math.floor(Date.now() / 1000);

      await db.tasks.create({
        id: 'task_under_limit_grace_parent',
        name: 'under-limit-grace-parent',
        uuid: '22222220-2222-4222-8222-222222222222',
        team_id: engTeamId,
        title: 'Under-limit grace parent',
        description: 'Past delegation grace but not idle long enough for stalled_task_backlog',
        status: 'doing',
        created_by: leadId,
        owner: leadId,
        created_at: now - 900,
        updated_at: now - 900,
        completed_at: null,
      });

      const created = await fetch(`${baseUrl}/tasks`, {
        method: 'POST',
        headers: adminHeaders('engineering-team'),
        body: JSON.stringify({
          title: 'Second under-limit objective',
          name: 'second-under-limit-objective',
          from: 'engineering-lead',
          ...validBriefFields(),
        }),
      });

      expect(created.status).toBe(201);
      const body = await created.json() as { task?: { ownerName?: string | null; status?: string } };
      expect(body.task?.ownerName).toBe('engineering-lead');
      expect(body.task?.status).toBe('doing');
    } finally {
      if (previousLeadMaxParallel === undefined) delete process.env.LEAD_MAX_PARALLEL_OBJECTIVES;
      else process.env.LEAD_MAX_PARALLEL_OBJECTIVES = previousLeadMaxParallel;
    }
  });

  it('returns blockers from both capacity gates in a single claim response instead of one at a time', async () => {
    const engTeamId = await db.teams.getOrCreateTeamId('engineering-team');
    const leadId = await getOrInsertAgent(db, engTeamId, 'engineering-lead', null);
    const memberId = await getOrInsertAgent(db, engTeamId, 'implementation-engineer', null);
    const now = Math.floor(Date.now() / 1000);

    // Blocker #1: an undelegated lead objective idle past the stalled-task
    // threshold (genuinely needs delegation now, not just over the fresh
    // delegation grace).
    await db.tasks.create({
      id: 'task_transparency_undelegated',
      name: 'transparency-undelegated-parent',
      uuid: '33333331-3333-4333-8333-333333333333',
      team_id: engTeamId,
      title: 'Transparency undelegated parent',
      description: 'Lead-owned parent objective without child tasks, past grace',
      status: 'doing',
      created_by: leadId,
      owner: leadId,
      created_at: now - 4000,
      updated_at: now - 3000,
      completed_at: null,
    });

    // Blocker #2: a *different*, fully-delegated lead objective (has a
    // member-owned child, so it is not a lead_delegation_backlog blocker)
    // that is nonetheless stalled — idle well past the 45-minute default
    // stall threshold — so it trips stalled_task_backlog independently.
    await db.tasks.create({
      id: 'task_transparency_stalled',
      name: 'transparency-stalled-parent',
      uuid: '33333332-3333-4333-8333-333333333333',
      team_id: engTeamId,
      title: 'Transparency stalled parent',
      description: 'Lead-owned parent objective with a delegated child, but stalled',
      status: 'doing',
      created_by: leadId,
      owner: leadId,
      created_at: now - 4000,
      updated_at: now - 3000,
      completed_at: null,
    });
    await db.tasks.create({
      id: 'task_transparency_stalled_child',
      name: 'transparency-stalled-child',
      uuid: '33333333-3333-4333-8333-333333333333',
      team_id: engTeamId,
      title: 'Transparency stalled parent: delegated child work',
      description: 'Member-owned child of transparency-stalled-parent',
      status: 'doing',
      created_by: leadId,
      owner: memberId,
      created_at: now - 3900,
      updated_at: now - 3900,
      completed_at: null,
    });

    const thirdCreate = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: adminHeaders('engineering-team'),
      body: JSON.stringify({
        title: 'Transparency third parent',
        name: 'transparency-third-parent',
        from: 'manager',
        ...validBriefFields(),
      }),
    });
    expect(thirdCreate.status).toBe(201);

    const claim = await fetch(`${baseUrl}/tasks/transparency-third-parent/claim`, {
      method: 'POST',
      headers: adminHeaders('engineering-team'),
      body: JSON.stringify({ agent_id: 'engineering-lead' }),
    });
    expect(claim.status).toBe(409);
    const claimBody = await claim.json() as { error: string; message?: string; blocking_tasks?: string[] };
    expect(claimBody.error).toBe('lead_delegation_backlog');
    // Both blockers show up together — no need to retry after fixing one
    // to discover the other.
    expect(claimBody.blocking_tasks).toContain('#33333331');
    expect(claimBody.blocking_tasks).toContain('#33333332');
    expect(claimBody.message).toContain('lead_delegation_backlog');
    expect(claimBody.message).toContain('stalled_task_backlog');
  });

  it('returns both capacity blocker types from /talk-to auto-attach in one 409 response', async () => {
    const engTeamId = await db.teams.getOrCreateTeamId('engineering-team');
    const leadId = await getOrInsertAgent(db, engTeamId, 'engineering-lead', null);
    const memberId = await getOrInsertAgent(db, engTeamId, 'implementation-engineer', null);
    await getOrInsertAgent(db, engTeamId, 'manager', null);
    const refs = await seedCombinedLeadCapacityBlockers(db, engTeamId, leadId, memberId, 'talkto-capacity', {
      undelegated: '71000001-0000-4000-8000-000000000001',
      stalled: '71000002-0000-4000-8000-000000000002',
      child: '71000003-0000-4000-8000-000000000003',
    });

    const response = await fetch(`${baseUrl}/talk-to`, {
      method: 'POST',
      headers: adminHeaders('engineering-team'),
      body: JSON.stringify({
        to: 'engineering-lead',
        from: 'manager',
        message: 'Create another lead objective',
        wait: false,
        task: {
          title: 'Talk-to combined-capacity objective',
          name: 'talkto-combined-capacity-objective',
          ...validBriefFields(),
        },
      }),
    });

    expect(response.status).toBe(409);
    const body = await response.json() as {
      error: string;
      message?: string;
      blocking_tasks?: string[];
      triage?: Record<string, unknown> | null;
    };
    expect(body.error).toBe('lead_delegation_backlog');
    expect(body.message).toContain('lead_delegation_backlog');
    expect(body.message).toContain('stalled_task_backlog');
    expect(body.blocking_tasks).toEqual(expect.arrayContaining([refs.undelegatedRef, refs.stalledRef]));
    expect(await db.tasks.getByNameForTeam('talkto-combined-capacity-objective', engTeamId)).toBeNull();
    expect(await db.checkins.list({ teamId: engTeamId })).toHaveLength(0);
  });

  it('returns both capacity blocker types from remote owner-targeted task creation in one response', async () => {
    const engTeamId = await db.teams.getOrCreateTeamId('engineering-team');
    const leadId = await getOrInsertAgent(db, engTeamId, 'engineering-lead', null);
    const memberId = await getOrInsertAgent(db, engTeamId, 'implementation-engineer', null);
    await getOrInsertAgent(db, engTeamId, 'manager', null);
    const refs = await seedCombinedLeadCapacityBlockers(db, engTeamId, leadId, memberId, 'remote-capacity', {
      undelegated: '72000001-0000-4000-8000-000000000001',
      stalled: '72000002-0000-4000-8000-000000000002',
      child: '72000003-0000-4000-8000-000000000003',
    });

    const response = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: adminHeaders('engineering-team'),
      body: JSON.stringify({
        from: 'manager',
        command: '/task create "Remote combined-capacity objective" --name remote-combined-capacity-objective --owner engineering-lead --goal goal_mr4khc5x_lf68y --expected-output "implementation patch and tests" --acceptance "returns both blocker types" --validation-path "coder and researcher" --out-of-scope "unrelated guard refactors" --backlog-policy "Non-required follow-ups become backlog candidates." --bittrees-relevance "medium: improves manager delegation reliability for Bittrees contributor work."',
      }),
    });

    // /remote keeps its established HTTP-200 command-envelope contract;
    // the task-create operation itself returns the capacity conflict.
    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      error?: string;
      result?: {
        message?: string;
        blocking_tasks?: string[];
        triage?: Record<string, unknown> | null;
      };
    };
    expect(body).toMatchObject({ ok: false, error: 'lead_delegation_backlog' });
    expect(body.result?.message).toContain('lead_delegation_backlog');
    expect(body.result?.message).toContain('stalled_task_backlog');
    expect(body.result?.blocking_tasks).toEqual(expect.arrayContaining([refs.undelegatedRef, refs.stalledRef]));
    expect(await db.tasks.getByNameForTeam('remote-combined-capacity-objective', engTeamId)).toBeNull();
  });

  it('lets the pre-assigned owner claim a dead-state todo task (owner set, status still todo)', async () => {
    const engTeamId = await db.teams.getOrCreateTeamId('engineering-team');
    const ownerId = await getOrInsertAgent(db, engTeamId, 'implementation-engineer', null);
    await getOrInsertAgent(db, engTeamId, 'qa-engineer', null);
    const now = Math.floor(Date.now() / 1000);

    await db.tasks.create({
      id: 'task_dead_state',
      name: 'dead-state-preassigned',
      uuid: '44444440-4444-4444-8444-444444444444',
      team_id: engTeamId,
      title: 'Dead state preassigned task',
      description: 'Owner set by auto-routing, but status never flipped to doing',
      status: 'todo',
      created_by: ownerId,
      owner: ownerId,
      created_at: now - 1200,
      updated_at: now - 1200,
      completed_at: null,
    });

    // A different agent must not be able to steal someone else's
    // pre-assigned task.
    const otherAttempt = await fetch(`${baseUrl}/tasks/dead-state-preassigned/claim`, {
      method: 'POST',
      headers: adminHeaders('engineering-team'),
      body: JSON.stringify({ agent_id: 'qa-engineer' }),
    });
    expect(otherAttempt.status).toBe(409);

    // The pre-assigned owner CAN claim it — this used to dead-end because
    // claim() required owner IS NULL even when the caller *was* the owner.
    const ownerAttempt = await fetch(`${baseUrl}/tasks/dead-state-preassigned/claim`, {
      method: 'POST',
      headers: adminHeaders('engineering-team'),
      body: JSON.stringify({ agent_id: 'implementation-engineer' }),
    });
    expect(ownerAttempt.status).toBe(200);
    const flipped = await db.tasks.getByNameForTeam('dead-state-preassigned', engTeamId);
    expect(flipped?.status).toBe('doing');
    expect(flipped?.owner).toBe(ownerId);
  });

  it('accepts a cross-team delegated_task_names ref as completion evidence instead of hard-failing', async () => {
    const engTeamId = await db.teams.getOrCreateTeamId('engineering-team');
    const otherTeamId = await db.teams.getOrCreateTeamId('cross-team-evidence-team');
    const leadId = await getOrInsertAgent(db, engTeamId, 'engineering-lead', null);
    const otherTeamWorkerId = await getOrInsertAgent(db, otherTeamId, 'other-team-worker', null);
    const now = Math.floor(Date.now() / 1000);

    const parentUuid = '55555550-5555-4555-8555-555555555555';
    await db.tasks.create({
      id: 'task_crossteam_parent',
      name: 'crossteam-evidence-parent',
      uuid: parentUuid,
      team_id: engTeamId,
      title: 'Cross-team evidence parent',
      description: 'Lead-owned parent objective completed with a cross-team child as evidence',
      status: 'doing',
      created_by: leadId,
      owner: leadId,
      created_at: now - 120,
      updated_at: now - 120,
      completed_at: null,
    });

    const childUuid = '55555551-5555-4555-8555-555555555555';
    await db.tasks.create({
      id: 'task_crossteam_child',
      name: 'crossteam-evidence-child',
      uuid: childUuid,
      team_id: otherTeamId,
      title: 'Cross-team evidence child',
      description: 'Done in a different team, used as completion evidence for the engineering-team parent',
      status: 'done',
      created_by: otherTeamWorkerId,
      owner: otherTeamWorkerId,
      created_at: now - 100,
      updated_at: now - 60,
      completed_at: now - 60,
    });
    const childShortId = `#${childUuid.replace(/-/g, '').slice(0, 8)}`;

    const done = await fetch(`${baseUrl}/tasks/crossteam-evidence-parent/done`, {
      method: 'POST',
      headers: adminHeaders('engineering-team'),
      body: JSON.stringify({
        agent_id: 'engineering-lead',
        acceptance_coverage: ['validated via cross-team delegated evidence'],
        delegated_task_names: childShortId,
      }),
    });
    expect(done.status).toBe(200);
    const doneBody = await done.json() as { task?: { status?: string }; delegation_warnings?: string[] };
    expect(doneBody.task?.status).toBe('done');
    expect(doneBody.delegation_warnings?.some((w) => w.includes('cross-team'))).toBe(true);

    const finished = await db.tasks.getByNameForTeam('crossteam-evidence-parent', engTeamId);
    expect(finished?.status).toBe('done');
  });

  it('reports and requeues existing lead-owned delegation backlog with linked checkin cleanup', async () => {
    const engTeamId = await db.teams.getOrCreateTeamId('engineering-team');
    const leadId = await getOrInsertAgent(db, engTeamId, 'engineering-lead', null);
    const now = Math.floor(Date.now() / 1000);
    const parents = [
      { id: 'task_backlog_a', name: 'backlog-parent-a', uuid: '77777777-7777-4777-8777-777777777777', created_at: now - 1_200 },
      { id: 'task_backlog_b', name: 'backlog-parent-b', uuid: '88888888-8888-4888-8888-888888888888', created_at: now - 1_100 },
      { id: 'task_backlog_c', name: 'backlog-parent-c', uuid: '99999999-9999-4999-8999-999999999999', created_at: now - 1_000 },
    ];

    for (const parent of parents) {
      await db.tasks.create({
        id: parent.id,
        name: parent.name,
        uuid: parent.uuid,
        team_id: engTeamId,
        title: parent.name,
        description: 'Lead-owned parent objective without delegated child tasks',
        status: 'doing',
        created_by: leadId,
        owner: leadId,
        created_at: parent.created_at,
        updated_at: parent.created_at,
        completed_at: null,
      });
    }
    await db.checkins.create(buildCheckinRow({
      id: 'chk_backlog_b',
      team_id: engTeamId,
      owner_agent_id: leadId,
      linked_task_id: 'task_backlog_b',
    }));
    await db.checkins.create(buildCheckinRow({
      id: 'chk_backlog_c',
      team_id: engTeamId,
      owner_agent_id: leadId,
      linked_task_id: 'task_backlog_c',
    }));

    const dryRun = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: adminHeaders('engineering-team'),
      body: JSON.stringify({
        from: 'manager',
        command: '/task lead-backlog --team engineering-team --keep-active 1',
      }),
    });
    expect(dryRun.status).toBe(200);
    const dryBody = await dryRun.json() as {
      ok: boolean;
      result?: {
        dryRun?: boolean;
        totals?: { blockers?: number; kept?: number; requeued?: number; checkinsClosed?: number };
      };
    };
    expect(dryBody.ok).toBe(true);
    expect(dryBody.result?.dryRun).toBe(true);
    expect(dryBody.result?.totals).toMatchObject({ blockers: 3, kept: 1, requeued: 2, checkinsClosed: 0 });
    expect((await db.tasks.getByNameForTeam('backlog-parent-b', engTeamId))?.status).toBe('doing');
    expect((await db.checkins.get('chk_backlog_b', engTeamId))?.status).toBe('active');

    const apply = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: adminHeaders('engineering-team'),
      body: JSON.stringify({
        from: 'manager',
        command: '/task lead-backlog --team engineering-team --keep-active 1 --apply',
      }),
    });
    expect(apply.status).toBe(200);
    const applyBody = await apply.json() as {
      ok: boolean;
      result?: {
        dryRun?: boolean;
        totals?: { blockers?: number; kept?: number; requeued?: number; checkinsClosed?: number };
      };
    };
    expect(applyBody.ok).toBe(true);
    expect(applyBody.result?.dryRun).toBe(false);
    expect(applyBody.result?.totals).toMatchObject({ blockers: 3, kept: 1, requeued: 2, checkinsClosed: 2 });

    const kept = await db.tasks.getByNameForTeam('backlog-parent-a', engTeamId);
    const requeuedB = await db.tasks.getByNameForTeam('backlog-parent-b', engTeamId);
    const requeuedC = await db.tasks.getByNameForTeam('backlog-parent-c', engTeamId);
    expect(kept?.status).toBe('doing');
    expect(kept?.owner).toBe(leadId);
    expect(requeuedB?.status).toBe('todo');
    expect(requeuedB?.owner).toBeNull();
    expect(requeuedC?.status).toBe('todo');
    expect(requeuedC?.owner).toBeNull();

    const checkinB = await db.checkins.get('chk_backlog_b', engTeamId);
    const checkinC = await db.checkins.get('chk_backlog_c', engTeamId);
    expect(checkinB?.status).toBe('closed');
    expect(checkinB?.closed_reason).toBe('lead_delegation_backlog_requeued');
    expect(checkinC?.status).toBe('closed');
    expect(checkinC?.closed_reason).toBe('lead_delegation_backlog_requeued');

    const triageEvents = await db.events.query({ teamId: engTeamId, topics: ['task:triaged'] });
    expect(triageEvents.filter((event) => event.data?.reason === 'lead_delegation_backlog_requeued')).toHaveLength(2);
    const checkinEvents = await db.events.query({ teamId: engTeamId, topics: ['checkin:closed'] });
    expect(checkinEvents.filter((event) => event.data?.reason === 'lead_delegation_backlog_requeued')).toHaveLength(2);
  });

  it('rejects duplicate validator children for the same parent and purpose', async () => {
    const first = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        title: 'Validate parent alpha coder',
        name: 'validate-parent-alpha-coder',
        from: 'manager',
        parent_task: 'parent-alpha',
        validation_purpose: 'coder technical validation',
        ...validBriefFields(),
      }),
    });
    expect(first.status).toBe(201);

    const duplicate = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        title: 'Review parent alpha coder again',
        name: 'review-parent-alpha-coder-again',
        from: 'manager',
        parent_task: 'parent-alpha',
        validation_purpose: 'coder technical validation',
        ...validBriefFields(),
      }),
    });
    expect(duplicate.status).toBe(409);
    const duplicateBody = await duplicate.json() as { error: string; existing_task?: string };
    expect(duplicateBody.error).toBe('duplicate_validator_child_task');
    expect(duplicateBody.existing_task).toBe('validate-parent-alpha-coder');
  });

  it('rejects duplicate goal tasks by title overlap when no target is provided', async () => {
    const releaseBrief = {
      ...validBriefFields(),
      goal_id: 'goal_release_id_agents_v0_1_100',
      expected_output: 'id-agents v0.1.100 pushed to bobofbuilding/id-agents remote and GitHub release tag v0.1.100 published with release notes',
      acceptance_criteria: [
        'git tag v0.1.100 exists on bobofbuilding/id-agents',
        'GitHub release page shows v0.1.100 with the release commits',
      ],
      backlog_policy: 'Block duplicate release work until the release is verified.',
      bittrees_relevance: 'high: ships core ID Agents infrastructure.',
    };

    const first = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        title: 'Publish id-agents v0.1.100',
        name: 'publish-id-agents-v0-1-100',
        from: 'manager',
        ...releaseBrief,
      }),
    });
    expect(first.status).toBe(201);

    const sameGoalDifferentObjective = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        title: 'Write release notes for id-agents v0.1.100',
        name: 'write-release-notes-id-agents-v0-1-100',
        from: 'manager',
        ...releaseBrief,
        expected_output: 'release notes draft for id-agents v0.1.100',
        acceptance_criteria: ['release notes summarize the shipped commits'],
      }),
    });
    expect(sameGoalDifferentObjective.status).toBe(201);

    const duplicate = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        title: 'Push and publish id-agents v0.1.100 [release-id-agents-bd661c7-6db1769]',
        name: 'push-publish-id-agents-v0-1-100',
        from: 'manager',
        ...releaseBrief,
      }),
    });
    expect(duplicate.status).toBe(409);
    const duplicateBody = await duplicate.json() as {
      error: string;
      existing_task?: string;
      existing_task_ref?: string;
      existing_status?: string;
      duplicate_scope?: string;
      duplicate_state?: string;
      suggested_action?: string;
    };
    expect(duplicateBody.error).toBe('existing_task_found');
    expect(duplicateBody.existing_task).toBe('publish-id-agents-v0-1-100');
    expect(duplicateBody.existing_task_ref).toMatch(/^#[a-f0-9]{8}$/);
    expect(duplicateBody.existing_status).toBe('todo');
    expect(duplicateBody.duplicate_scope).toBe('goal+title');
    expect(duplicateBody.duplicate_state).toBe('open');
    expect(duplicateBody.suggested_action).toBe('status-check');

    const remoteDuplicate = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        from: 'manager',
        command: '/task create "Push and publish id-agents v0.1.100 [release-id-agents-bd661c7-6db1769]" --name push-publish-id-agents-v0-1-100-remote --goal goal_release_id_agents_v0_1_100 --expected-output "id-agents v0.1.100 pushed to bobofbuilding/id-agents remote; GitHub release v0.1.100 published." --acceptance "git tag v0.1.100 on bobofbuilding/id-agents remote; GitHub release page shows v0.1.100" --validation-path "coder and researcher" --out-of-scope "npm publish" --backlog-policy "block duplicate release work" --bittrees-relevance "high: release shipping work"',
      }),
    });
    expect(remoteDuplicate.status).toBe(200);
    const remoteDuplicateBody = await remoteDuplicate.json() as {
      ok: boolean;
      error?: string;
      result?: {
        existing_task?: string;
        existing_status?: string;
        duplicate_scope?: string;
        duplicate_state?: string;
        suggested_action?: string;
      };
    };
    expect(remoteDuplicateBody.ok).toBe(false);
    expect(remoteDuplicateBody.error).toBe('existing_task_found');
    expect(remoteDuplicateBody.result?.existing_task).toBe('publish-id-agents-v0-1-100');
    expect(remoteDuplicateBody.result?.existing_status).toBe('todo');
    expect(remoteDuplicateBody.result?.duplicate_scope).toBe('goal+title');
    expect(remoteDuplicateBody.result?.duplicate_state).toBe('open');
    expect(remoteDuplicateBody.result?.suggested_action).toBe('status-check');
  });

  it('rejects duplicate goal tasks by target signature even when titles differ', async () => {
    const targetBrief = {
      ...validBriefFields(),
      goal_id: 'goal_ground_agent_bittrees_page',
      target: 'https://agent.bittrees.org/docs/launch?ref=ops',
      expected_output: 'Grounded launch copy and CTA shipped to agent.bittrees.org/docs/launch',
      acceptance_criteria: [
        'Launch page copy is updated in the target document',
        'Review links point at the same target page',
      ],
      backlog_policy: 'Block duplicate edits to the same target page until the owner reports status.',
      bittrees_relevance: 'high: protects a live Bittrees page workflow from duplicate churn.',
    };

    const first = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        title: 'Refresh launch copy for agent.bittrees.org docs',
        name: 'refresh-agent-bittrees-launch-copy',
        from: 'manager',
        ...targetBrief,
      }),
    });
    expect(first.status).toBe(201);

    const duplicate = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        title: 'QA launch CTA links before publish',
        name: 'qa-agent-bittrees-launch-cta-links',
        from: 'manager',
        ...targetBrief,
        target_url: 'agent.bittrees.org/docs/launch?ref=ops',
        expected_output: 'CTA link audit for the same launch page',
        acceptance_criteria: ['CTA links are verified on the target page'],
      }),
    });
    expect(duplicate.status).toBe(409);
    const duplicateBody = await duplicate.json() as {
      error: string;
      existing_task?: string;
      existing_status?: string;
      existing_target?: string;
      duplicate_scope?: string;
      duplicate_state?: string;
      suggested_action?: string;
    };
    expect(duplicateBody.error).toBe('existing_task_found');
    expect(duplicateBody.existing_task).toBe('refresh-agent-bittrees-launch-copy');
    expect(duplicateBody.existing_status).toBe('todo');
    expect(duplicateBody.existing_target).toBe('url:https://agent.bittrees.org/docs/launch?ref=ops');
    expect(duplicateBody.duplicate_scope).toBe('goal+target');
    expect(duplicateBody.duplicate_state).toBe('open');
    expect(duplicateBody.suggested_action).toBe('status-check');
  });

  it('rejects duplicate goal target tasks during /talk-to auto-attach before creating a second task or checkin', async () => {
    const targetBrief = {
      ...validBriefFields(),
      goal_id: 'goal_agent_bittrees_legal_review',
      target: 'https://agent.bittrees.org/legal/launch',
      expected_output: 'Legal signoff for the agent.bittrees.org launch page',
      acceptance_criteria: ['Legal review is complete for the target page'],
      backlog_policy: 'Send status checks to the current owner instead of opening duplicate legal reviews.',
      bittrees_relevance: 'medium: reduces duplicate legal-team dispatches for Bittrees launch work.',
    };

    const first = await fetch(`${baseUrl}/talk-to`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        to: 'coder',
        from: 'manager',
        message: 'Review the launch page legal copy.',
        wait: false,
        task: {
          title: 'Review agent.bittrees.org launch legal copy',
          name: 'review-agent-bittrees-legal-copy',
          ...targetBrief,
        },
      }),
    });
    expect(first.status).toBe(200);

    const duplicate = await fetch(`${baseUrl}/talk-to`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        to: 'coder',
        from: 'manager',
        message: 'Open another legal review for the same launch page.',
        wait: false,
        task: {
          title: 'Check agent.bittrees.org launch disclaimers',
          name: 'check-agent-bittrees-launch-disclaimers',
          ...targetBrief,
          target_url: 'agent.bittrees.org/legal/launch',
          expected_output: 'Second legal pass for the same target page',
        },
      }),
    });
    expect(duplicate.status).toBe(409);
    const duplicateBody = await duplicate.json() as {
      error: string;
      existing_task?: string;
      existing_status?: string;
      existing_owner?: string;
      existing_owner_id?: string;
      duplicate_scope?: string;
      duplicate_state?: string;
      suggested_action?: string;
    };
    expect(duplicateBody.error).toBe('existing_task_found');
    expect(duplicateBody.existing_task).toBe('review-agent-bittrees-legal-copy');
    expect(duplicateBody.existing_status).toBe('doing');
    expect(duplicateBody.existing_owner).toBe('coder');
    expect(duplicateBody.existing_owner_id).toBe(targetId);
    expect(duplicateBody.duplicate_scope).toBe('goal+target');
    expect(duplicateBody.duplicate_state).toBe('open');
    expect(duplicateBody.suggested_action).toBe('status-check');
    expect(await db.tasks.list({ teamId })).toHaveLength(1);
    expect(await db.checkins.list({ teamId })).toHaveLength(1);
  });

  it('rejects duplicate goal target tasks when the existing task is recently done', async () => {
    const now = Math.floor(Date.now() / 1000);
    await db.tasks.create({
      id: 'task_recent_done_agent_bittrees_guard',
      name: 'completed-agent-bittrees-launch-review',
      uuid: '12345678-1234-4234-9234-123456789abc',
      team_id: teamId,
      title: 'Completed agent.bittrees.org launch review',
      description: [
        'Goal ID: goal_agent_bittrees_recent_review',
        'Target: https://agent.bittrees.org/legal/launch',
        'Expected output: completed launch review',
        'Acceptance criteria: review complete',
        'Validation path: coder and researcher',
        'Out of scope: duplicate review creation',
        'Backlog policy: status-check recent owner before reopening',
        'Bittrees relevance: medium: avoids duplicate review loops',
      ].join('\n'),
      status: 'done',
      created_by: dispatcherId,
      owner: targetId,
      created_at: now - 180,
      updated_at: now - 60,
      completed_at: now - 60,
    });

    const duplicate = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        title: 'Reopen agent.bittrees.org legal launch review',
        name: 'reopen-agent-bittrees-legal-launch-review',
        from: 'manager',
        ...validBriefFields(),
        goal_id: 'goal_agent_bittrees_recent_review',
        target: 'agent.bittrees.org/legal/launch',
        expected_output: 'duplicate follow-up on the same recently reviewed target',
        acceptance_criteria: ['duplicate would have created a new review task'],
        backlog_policy: 'status-check the recent owner instead of reopening',
        bittrees_relevance: 'medium: avoids duplicate legal-team dispatches.',
      }),
    });
    expect(duplicate.status).toBe(409);
    const duplicateBody = await duplicate.json() as {
      error: string;
      existing_task?: string;
      existing_status?: string;
      existing_owner?: string;
      existing_owner_id?: string;
      duplicate_scope?: string;
      duplicate_state?: string;
      suggested_action?: string;
    };
    expect(duplicateBody.error).toBe('existing_task_found');
    expect(duplicateBody.existing_task).toBe('completed-agent-bittrees-launch-review');
    expect(duplicateBody.existing_status).toBe('done');
    expect(duplicateBody.existing_owner).toBe('coder');
    expect(duplicateBody.existing_owner_id).toBe(targetId);
    expect(duplicateBody.duplicate_scope).toBe('goal+target');
    expect(duplicateBody.duplicate_state).toBe('recent_done');
    expect(duplicateBody.suggested_action).toBe('status-check');
    expect(await db.tasks.list({ teamId })).toHaveLength(1);
  });

  it('rejects validator children created after the parent task is terminal', async () => {
    const now = Math.floor(Date.now() / 1000);
    await db.tasks.create({
      id: 'task_terminal_parent',
      name: 'terminal-parent',
      uuid: '12345678-1234-4234-8234-123456789abc',
      team_id: teamId,
      title: 'Terminal parent',
      description: 'Parent already closed',
      status: 'done',
      created_by: dispatcherId,
      owner: dispatcherId,
      created_at: now - 120,
      updated_at: now - 60,
      completed_at: now - 60,
    });

    const child = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        title: 'Validate terminal parent coder',
        name: 'validate-terminal-parent-coder',
        from: 'manager',
        parent_task: 'terminal-parent',
        validation_purpose: 'coder technical validation',
        ...validBriefFields(),
      }),
    });
    expect(child.status).toBe(409);
    const childBody = await child.json() as { error: string };
    expect(childBody.error).toBe('validator_child_post_terminal_blocked');

    const childByShortId = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        title: 'Validate terminal parent by id coder',
        name: 'validate-terminal-parent-by-id-coder',
        from: 'manager',
        parent_task: '#12345678',
        validation_purpose: 'coder technical validation',
        ...validBriefFields(),
      }),
    });
    expect(childByShortId.status).toBe(409);
    const childByShortIdBody = await childByShortId.json() as { error: string };
    expect(childByShortIdBody.error).toBe('validator_child_post_terminal_blocked');
  });

  it('blocks validators from creating validator tasks and routes low-relevance live dispatch to backlog', async () => {
    const recursive = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        title: 'Validate parent beta coder',
        name: 'validate-parent-beta-coder',
        from: 'coder',
        parent_task: 'parent-beta',
        validation_purpose: 'coder technical validation',
        ...validBriefFields(),
      }),
    });
    expect(recursive.status).toBe(409);
    const recursiveBody = await recursive.json() as { error: string };
    expect(recursiveBody.error).toBe('validator_task_recursion_blocked');

    const lowRelevance = await fetch(`${baseUrl}/talk-to`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        to: 'coder',
        from: 'manager',
        message: 'do generic validator tuning now',
        wait: false,
        task: {
          title: 'Generic validator tuning',
          name: 'generic-validator-tuning',
          ...validBriefFields(),
          bittrees_relevance: 'low/backlog: generic validator tuning without direct Bittrees contributor relevance.',
        },
      }),
    });
    expect(lowRelevance.status).toBe(422);
    const lowBody = await lowRelevance.json() as { error: string; brief_validation?: { reason_codes?: string[] } };
    expect(lowBody.error).toBe('task_brief_not_dispatch_ready');
    expect(lowBody.brief_validation?.reason_codes).toContain('low_bittrees_relevance_live_dispatch');
    expect(await db.tasks.getByNameForTeam('generic-validator-tuning', teamId)).toBeNull();
  });

  it('keeps /remote task CLI validation behavior aligned with REST task intake', async () => {
    await withBriefValidationMode('enforce', async () => {
      const malformedCreate = await fetch(`${baseUrl}/remote`, {
        method: 'POST',
        headers: adminHeaders(TEAM),
        body: JSON.stringify({
          from: 'manager',
          command: '/task create "CLI malformed task" --name cli-malformed-task --owner coder',
        }),
      });
      expect(malformedCreate.status).toBe(200);
      const malformedCreateBody = await malformedCreate.json() as { ok: boolean; error?: string; result?: { brief_validation?: { dispatch_ready: boolean } } };
      expect(malformedCreateBody.ok).toBe(false);
      expect(malformedCreateBody.error).toBe('task_brief_not_dispatch_ready');
      expect(malformedCreateBody.result?.brief_validation?.dispatch_ready).toBe(false);

      const validCreate = await fetch(`${baseUrl}/remote`, {
        method: 'POST',
        headers: adminHeaders(TEAM),
        body: JSON.stringify({
          from: 'manager',
          command: '/task create "CLI ready task" --name cli-ready-task --goal goal_mqxibu5r_2k2my --expected-output "implementation patch and tests" --acceptance "covers CLI create" --validation-path "coder and researcher" --out-of-scope "optional recommendations" --recommendation-routing "Non-required recommendations become backlog candidates." --bittrees-relevance "medium: improves validator routing reliability for Bittrees contributor work."',
        }),
      });
      expect(validCreate.status).toBe(200);
      const validCreateBody = await validCreate.json() as { ok: boolean; result?: { brief_validation?: { ok: boolean } } };
      expect(validCreateBody.ok).toBe(true);
      expect(validCreateBody.result?.brief_validation?.ok).toBe(true);

      const now = Math.floor(Date.now() / 1000);
      await db.tasks.create({
        id: `task_${Date.now()}_cli_legacy`,
        name: 'cli-legacy-malformed-task',
        uuid: crypto.randomUUID(),
        team_id: teamId,
        title: 'CLI legacy malformed task',
        description: 'Old CLI row without a full brief',
        status: 'todo',
        created_by: null,
        owner: null,
        created_at: now,
        updated_at: now,
        completed_at: null,
      });

      const malformedClaim = await fetch(`${baseUrl}/remote`, {
        method: 'POST',
        headers: adminHeaders(TEAM),
        body: JSON.stringify({
          from: 'coder',
          command: '/task claim cli-legacy-malformed-task',
        }),
      });
      expect(malformedClaim.status).toBe(200);
      const malformedClaimBody = await malformedClaim.json() as { ok: boolean; error?: string; result?: { brief_validation?: { dispatch_ready: boolean } } };
      expect(malformedClaimBody.ok).toBe(false);
      expect(malformedClaimBody.error).toBe('task_brief_not_dispatch_ready');
      expect(malformedClaimBody.result?.brief_validation?.dispatch_ready).toBe(false);

      const claim = await fetch(`${baseUrl}/remote`, {
        method: 'POST',
        headers: adminHeaders(TEAM),
        body: JSON.stringify({
          from: 'coder',
          command: '/task claim cli-ready-task',
        }),
      });
      expect(claim.status).toBe(200);
      const claimBody = await claim.json() as { ok: boolean };
      expect(claimBody.ok).toBe(true);

      const rejectedDone = await fetch(`${baseUrl}/remote`, {
        method: 'POST',
        headers: adminHeaders(TEAM),
        body: JSON.stringify({
          from: 'coder',
          command: '/task done cli-ready-task',
        }),
      });
      expect(rejectedDone.status).toBe(200);
      const rejectedDoneBody = await rejectedDone.json() as { ok: boolean; error?: string; result?: { completion_validation?: { ok: boolean } } };
      expect(rejectedDoneBody.ok).toBe(false);
      expect(rejectedDoneBody.error).toBe('task_completion_packet_required');
      expect(rejectedDoneBody.result?.completion_validation?.ok).toBe(false);

      const done = await fetch(`${baseUrl}/remote`, {
        method: 'POST',
        headers: adminHeaders(TEAM),
        body: JSON.stringify({
          from: 'coder',
          command: '/task done cli-ready-task --failure-note "closed with explicit CLI failure note"',
        }),
      });
      expect(done.status).toBe(200);
      const doneBody = await done.json() as { ok: boolean; result?: { completion_validation?: { ok: boolean } } };
      expect(doneBody.ok).toBe(true);
      expect(doneBody.result?.completion_validation?.ok).toBe(true);
      const finished = await db.tasks.getByNameForTeam('cli-ready-task', teamId);
      expect(finished?.status).toBe('done');
    });
  });

  it('injects Brain team instructions on task claim and reports completion feedback', async () => {
    const brainPort = await findFreePort();
    const received = { feedback: [] as any[], validations: [] as any[], evals: [] as any[], missing: [] as any[], edges: [] as any[] };
    const brain = await startStubBrain(brainPort, received);
    const previousBrainUrl = process.env.BRAIN_URL;
    const previousDisabled = process.env.BRAIN_CONTEXT_DISABLED;
    process.env.BRAIN_URL = `http://127.0.0.1:${brainPort}`;
    delete process.env.BRAIN_CONTEXT_DISABLED;

    try {
      const created = await fetch(`${baseUrl}/tasks`, {
        method: 'POST',
        headers: adminHeaders(TEAM),
        body: JSON.stringify({
          title: 'Close deployment task',
          name: 'close-deployment-task',
          description: 'Finish release validation',
          from: 'manager',
          ...validBriefFields(),
        }),
      });
      expect(created.status).toBe(201);

      const claimed = await fetch(`${baseUrl}/tasks/close-deployment-task/claim`, {
        method: 'POST',
        headers: adminHeaders(TEAM),
        body: JSON.stringify({ agent_id: 'coder' }),
      });
      expect(claimed.status).toBe(200);
      const claimBody = await claimed.json() as { task: { brain_context?: { instructions?: any[] } } };
      expect(claimBody.task.brain_context?.instructions).toHaveLength(1);
      expect(claimBody.task.brain_context?.instructions?.[0]).toMatchObject({
        source_id: 'memory:101',
        memory_id: 101,
        key: 'instruction:test',
      });
      const claimEvents = await db.events.query({ teamId, topics: ['task:claimed'] });
      expect(claimEvents.at(-1)?.data).toMatchObject({
        volunteered_source_ids: ['memory:101'],
        brain_context: {
          cited: {
            canonical_source_ids: ['memory:101'],
            source_origins: { 'memory:101': ['team_instruction'] },
          },
          timelineEventId: 42,
          context_package_id: 77,
        },
      });

      const done = await fetch(`${baseUrl}/tasks/close-deployment-task/done`, {
        method: 'POST',
        headers: adminHeaders(TEAM),
        body: JSON.stringify({
          agent_id: 'coder',
          injected_instruction_ids: ['memory:101'],
          used_instruction_ids: ['memory:101'],
          used_source_ids: ['memory:101'],
          acceptance_coverage: {
            'deployment release validation': 'Covered by cited release checklist evidence.',
          },
          brain_context: claimBody.task.brain_context,
          learning_loop: {
            gap_type: 'source_recovery',
            save_back_decision: 'save',
            source_recovery: {
              required_source_ids: ['memory:101'],
              available_source_ids: ['memory:101'],
              recovery_state: 'recovered',
            },
            backlog_rule: {
              candidate_refs: ['backlog:deployment-followup'],
            },
          },
          learned_artifact: {
            summary: 'Deployment task closure requires the project release checklist.',
            sources: [{
              kind: 'task-result',
              source_id: 'task-result:deployment-checklist',
              content: 'The release checklist was used as the accepted evidence for closing deployment tasks.',
            }],
            facts: [{
              entity_id: 'project:deployment',
              field: 'release_checklist_required',
              value: true,
              confidence: 0.9,
            }],
          },
        }),
      });
      expect(done.status).toBe(200);
      expect(received.feedback).toHaveLength(1);
      expect(received.feedback[0]).toMatchObject({
        agent_id: targetId,
        ignored_instruction_ids: [],
        used_instruction_ids: ['memory:101'],
        harmful_instruction_ids: [],
      });
      expect(String(received.feedback[0].task_id)).toMatch(/^task:/);
      expect(received.validations.some((item) => item.dispatch_context?.task_id && item.dispatch_context?.agent_id === targetId)).toBe(true);
      expect(received.validations.some((item) => item.instruction_feedback?.used_instruction_ids?.includes('memory:101'))).toBe(true);
      expect(received.validations.some((item) => item.eval_feedback?.accepted_ids?.includes('memory:101'))).toBe(true);
      expect(received.validations.some((item) => item.learned_artifact?.gap?.gap_type === 'source_recovery')).toBe(true);
      expect(received.evals).toHaveLength(1);
      expect(received.evals[0]).toMatchObject({
        route: 'manager.task_completion',
        agent_id: targetId,
        accepted_ids: ['memory:101'],
        volunteered_source_ids: ['memory:101'],
        context_package_id: 77,
        metadata: {
          source_origins: { 'memory:101': ['team_instruction'] },
          learning_loop: {
            schema: 'brain.learning_loop_capture.v1',
            gap: { gap_type: 'source_recovery' },
            owner: { owner_team: TEAM, owner_agent_id: targetId },
            source_recovery: { recovery_state: 'recovered' },
            backlog_rule: { candidate_refs: ['backlog:deployment-followup'] },
          },
        },
      });
      expect(received.missing).toHaveLength(0);
      expect(received.edges).toEqual(expect.arrayContaining([
        { from: 'agent:coder', to: 'skill:brain', kind: 'mentions' },
        { from: 'agent:coder', to: 'skill:brain', kind: 'uses' },
      ]));

      const events = await db.events.query({ teamId, topics: ['task:completed'] });
      expect(events.at(-1)?.data).toMatchObject({
        used_source_ids: ['memory:101'],
        volunteered_source_ids: ['memory:101'],
        learning_loop: {
          schema: 'brain.learning_loop_capture.v1',
          gap: { gap_type: 'source_recovery' },
          owner: { owner_team: TEAM },
          save_back: { decision: 'save' },
        },
        learned_artifact: {
          summary: 'Deployment task closure requires the project release checklist.',
          facts: [{
            entity_id: 'project:deployment',
            field: 'release_checklist_required',
            value: true,
          }],
        },
      });
    } finally {
      if (previousBrainUrl === undefined) delete process.env.BRAIN_URL;
      else process.env.BRAIN_URL = previousBrainUrl;
      if (previousDisabled === undefined) delete process.env.BRAIN_CONTEXT_DISABLED;
      else process.env.BRAIN_CONTEXT_DISABLED = previousDisabled;
      await new Promise<void>((r) => brain.close(() => r()));
    }
  });

  it('recovers volunteered task sources from durable Brain ledger when claim response context is lost', async () => {
    const brainPort = await findFreePort();
    const received = { feedback: [] as any[], validations: [] as any[], evals: [] as any[], missing: [] as any[], edges: [] as any[] };
    const brain = await startStubBrain(brainPort, received);
    const previousBrainUrl = process.env.BRAIN_URL;
    const previousDisabled = process.env.BRAIN_CONTEXT_DISABLED;
    process.env.BRAIN_URL = `http://127.0.0.1:${brainPort}`;
    delete process.env.BRAIN_CONTEXT_DISABLED;

    try {
      const created = await fetch(`${baseUrl}/tasks`, {
        method: 'POST',
        headers: adminHeaders(TEAM),
        body: JSON.stringify({
          title: 'Recover claim context task',
          name: 'recover-claim-context-task',
          description: 'Completion should not depend on claim response survival',
          from: 'manager',
          ...validBriefFields(),
        }),
      });
      expect(created.status).toBe(201);

      const claimed = await fetch(`${baseUrl}/tasks/recover-claim-context-task/claim`, {
        method: 'POST',
        headers: adminHeaders(TEAM),
        body: JSON.stringify({ agent_id: 'coder' }),
      });
      expect(claimed.status).toBe(200);

      const claimEvents = await db.events.query({ teamId, topics: ['task:claimed'] });
      expect(claimEvents.at(-1)?.data).toMatchObject({
        volunteered_source_ids: ['memory:101'],
        brain_context: {
          cited: { canonical_source_ids: ['memory:101'] },
          timelineEventId: 42,
        },
      });

      const done = await fetch(`${baseUrl}/tasks/recover-claim-context-task/done`, {
        method: 'POST',
        headers: adminHeaders(TEAM),
        body: JSON.stringify({
          agent_id: 'coder',
          used_source_ids: ['memory:101'],
          acceptance_coverage: {
            'claim context recovery': 'Covered by durable task:claimed Brain context.',
          },
        }),
      });
      expect(done.status).toBe(200);

      expect(received.evals).toHaveLength(1);
      expect(received.evals[0]).toMatchObject({
        route: 'manager.task_completion',
        accepted_ids: ['memory:101'],
        volunteered_source_ids: ['memory:101'],
      });
    } finally {
      if (previousBrainUrl === undefined) delete process.env.BRAIN_URL;
      else process.env.BRAIN_URL = previousBrainUrl;
      if (previousDisabled === undefined) delete process.env.BRAIN_CONTEXT_DISABLED;
      else process.env.BRAIN_CONTEXT_DISABLED = previousDisabled;
      await new Promise<void>((r) => brain.close(() => r()));
    }
  });

  it('captures Brain eval feedback when a dispatched query is delivered', async () => {
    const brainPort = await findFreePort();
    const received = { feedback: [] as any[], validations: [] as any[], evals: [] as any[], missing: [] as any[], edges: [] as any[] };
    const brain = await startStubBrain(brainPort, received);
    const previousBrainUrl = process.env.BRAIN_URL;
    const previousDisabled = process.env.BRAIN_CONTEXT_DISABLED;
    process.env.BRAIN_URL = `http://127.0.0.1:${brainPort}`;
    delete process.env.BRAIN_CONTEXT_DISABLED;

    try {
      const delegated = await fetch(`${baseUrl}/talk-to`, {
        method: 'POST',
        headers: adminHeaders(TEAM),
        body: JSON.stringify({
          to: 'coder',
          from: 'manager',
          message: 'coder uses Brain evidence and reports what helped',
          wait: false,
          task: { title: 'Brain-backed query', name: 'brain-backed-query', ...validBriefFields() },
        }),
      });
      expect(delegated.status).toBe(200);
      const delegatedBody = await delegated.json() as { query_id: string; brain_context?: any };
      expect(delegatedBody.query_id).toMatch(/^query_/);
      expect(delegatedBody.brain_context?.cited?.canonical_source_ids).toEqual(['memory:101']);

      const reply = await fetch(`${baseUrl}/news`, {
        method: 'POST',
        headers: adminHeaders(TEAM),
        body: JSON.stringify({
          from: 'coder',
          type: 'reply',
          message: 'Completed with cited Brain source.',
          in_reply_to: delegatedBody.query_id,
          data: {
            used_source_ids: ['memory:101'],
            used_instruction_ids: ['memory:101'],
            learning_loop: {
              gap_type: 'validation_feedback_missing',
              save_back_decision: 'record-backlog',
              backlog_rule: {
                candidate_refs: ['backlog:brain-backed-query'],
              },
              source_recovery: {
                missing_source_ids: ['memory:404'],
              },
            },
            learned_artifact: {
              summary: 'Brain-backed query completions can write validated findings back as facts.',
              sources: [{
                kind: 'query-result',
                source_id: 'query-result:brain-backed-query',
                content: 'The cited Brain source was used to ground the completed query result.',
              }],
              facts: [{
                entity_id: 'project:brain',
                field: 'query_completion_write_back_supported',
                value: true,
                confidence: 0.86,
              }],
            },
          },
        }),
      });
      expect(reply.status).toBe(201);

      expect(received.evals.some((item) => (
        item.route === 'manager.dispatch'
        && item.accepted_ids?.includes('memory:101')
        && item.volunteered_source_ids?.includes('memory:101')
        && item.context_package_id === 77
        && item.metadata?.source_origins?.['memory:101']?.includes('team_instruction')
        && item.metadata?.learning_loop?.gap?.gap_type === 'validation_feedback_missing'
        && item.metadata?.learning_loop?.backlog_rule?.candidate_refs?.includes('backlog:brain-backed-query')
      ))).toBe(true);
      expect(received.validations.some((item) => item.eval_feedback?.route === 'manager.dispatch')).toBe(true);
      expect(received.validations.some((item) => item.instruction_feedback?.used_instruction_ids?.includes('memory:101'))).toBe(true);
      expect(received.validations.some((item) => item.learned_artifact?.subject?.ref === `query:${delegatedBody.query_id}`)).toBe(true);
      expect(received.missing).toHaveLength(0);
      expect(received.edges.filter((edge) => edge.from === 'agent:coder' && edge.to === 'skill:brain')).toEqual([
        { from: 'agent:coder', to: 'skill:brain', kind: 'mentions' },
        { from: 'agent:coder', to: 'skill:brain', kind: 'uses' },
      ]);

      const queryEvents = await db.events.query({ teamId, topics: ['query:delivered'] });
      expect(queryEvents.at(-1)?.data).toMatchObject({
        query_id: delegatedBody.query_id,
        used_source_ids: ['memory:101'],
        volunteered_source_ids: ['memory:101'],
        learning_loop: {
          schema: 'brain.learning_loop_capture.v1',
          gap: { gap_type: 'validation_feedback_missing' },
          save_back: { decision: 'record-backlog' },
          source_recovery: {
            missing_source_ids: ['memory:404'],
            recovery_state: 'partial',
          },
        },
        learned_artifact: {
          summary: 'Brain-backed query completions can write validated findings back as facts.',
          facts: [{
            entity_id: 'project:brain',
            field: 'query_completion_write_back_supported',
            value: true,
          }],
        },
      });
      const completedQuery = await db.queries.getByQueryIdForTeam(teamId, delegatedBody.query_id);
      expect((completedQuery?.result as any)?.learning_loop).toMatchObject({
        schema: 'brain.learning_loop_capture.v1',
        subject: { ref: `query:${delegatedBody.query_id}` },
        gap: { gap_type: 'validation_feedback_missing' },
      });
    } finally {
      if (previousBrainUrl === undefined) delete process.env.BRAIN_URL;
      else process.env.BRAIN_URL = previousBrainUrl;
      if (previousDisabled === undefined) delete process.env.BRAIN_CONTEXT_DISABLED;
      else process.env.BRAIN_CONTEXT_DISABLED = previousDisabled;
      await new Promise<void>((r) => brain.close(() => r()));
    }
  });

  it('records feedback-missing when a dispatched query reply omits used source ids', async () => {
    const brainPort = await findFreePort();
    const received = { feedback: [] as any[], validations: [] as any[], evals: [] as any[], missing: [] as any[], edges: [] as any[] };
    const brain = await startStubBrain(brainPort, received);
    const previousBrainUrl = process.env.BRAIN_URL;
    const previousDisabled = process.env.BRAIN_CONTEXT_DISABLED;
    process.env.BRAIN_URL = `http://127.0.0.1:${brainPort}`;
    delete process.env.BRAIN_CONTEXT_DISABLED;

    try {
      const delegated = await fetch(`${baseUrl}/talk-to`, {
        method: 'POST',
        headers: adminHeaders(TEAM),
        body: JSON.stringify({
          to: 'coder',
          from: 'manager',
          message: 'coder receives Brain context but forgets citations',
          wait: false,
          task: { title: 'Brain-backed missing feedback query', name: 'brain-backed-missing-feedback-query', ...validBriefFields() },
        }),
      });
      expect(delegated.status).toBe(200);
      const delegatedBody = await delegated.json() as { query_id: string; brain_context?: any };
      expect(delegatedBody.query_id).toMatch(/^query_/);
      expect(delegatedBody.brain_context?.cited?.canonical_source_ids).toEqual(['memory:101']);

      const reply = await fetch(`${baseUrl}/news`, {
        method: 'POST',
        headers: adminHeaders(TEAM),
        body: JSON.stringify({
          from: 'coder',
          type: 'reply',
          message: 'Completed without citing what helped.',
          in_reply_to: delegatedBody.query_id,
          data: {},
        }),
      });
      expect(reply.status).toBe(201);

      expect(received.validations.some((item) => item.eval_feedback?.route === 'manager.dispatch')).toBe(true);
      expect(received.evals.some((item) => (
        item.route === 'manager.dispatch'
        && item.accepted_ids?.length === 0
        && item.volunteered_source_ids?.includes('memory:101')
        && item.context_package_id === 77
        && item.metadata?.query_id === delegatedBody.query_id
      ))).toBe(true);
      expect(received.missing).toHaveLength(1);
      expect(received.missing[0]).toMatchObject({
        query_id: delegatedBody.query_id,
        agent_id: targetId,
        volunteered_source_ids: ['memory:101'],
        route: 'manager.dispatch',
      });
      expect(received.missing[0].query_text).toContain('coder receives Brain context');

      const queryEvents = await db.events.query({ teamId, topics: ['query:delivered'] });
      expect(queryEvents.at(-1)?.data).toMatchObject({
        query_id: delegatedBody.query_id,
        volunteered_source_ids: ['memory:101'],
      });
      expect(queryEvents.at(-1)?.data?.used_source_ids ?? null).toBe(null);
    } finally {
      if (previousBrainUrl === undefined) delete process.env.BRAIN_URL;
      else process.env.BRAIN_URL = previousBrainUrl;
      if (previousDisabled === undefined) delete process.env.BRAIN_CONTEXT_DISABLED;
      else process.env.BRAIN_CONTEXT_DISABLED = previousDisabled;
      await new Promise<void>((r) => brain.close(() => r()));
    }
  });

  it('appends Brain volunteered context and stores query metadata for /ask dispatch', async () => {
    const brainPort = await findFreePort();
    const received = { feedback: [] as any[], validations: [] as any[], evals: [] as any[], missing: [] as any[], edges: [] as any[] };
    const brain = await startStubBrain(brainPort, received);
    const previousBrainUrl = process.env.BRAIN_URL;
    const previousDisabled = process.env.BRAIN_CONTEXT_DISABLED;
    process.env.BRAIN_URL = `http://127.0.0.1:${brainPort}`;
    delete process.env.BRAIN_CONTEXT_DISABLED;

    try {
      const response = await fetch(`${baseUrl}/remote`, {
        method: 'POST',
        headers: adminHeaders(TEAM),
        body: JSON.stringify({
          command: '/ask coder check deployment evidence',
          from: 'manager',
          session_id: 'session-ask-context',
        }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { result?: { queryId?: string; brain_context?: any } };
      const queryId = body.result?.queryId;
      expect(queryId).toMatch(/^query_/);
      expect(body.result?.brain_context?.cited?.canonical_source_ids).toEqual(['memory:101']);

      const row = await db.queries.getByQueryIdForTeam(teamId, queryId!);
      expect(row?.prompt).toContain('Brain context:');
      expect((row?.metadata as any)?.brain_context?.cited?.canonical_source_ids).toEqual(['memory:101']);
      expect(received.validations.some((item) => (
        item.dispatch_context?.agent_id === targetId
        && item.dispatch_context?.session_id === 'session-ask-context'
      ))).toBe(true);
    } finally {
      if (previousBrainUrl === undefined) delete process.env.BRAIN_URL;
      else process.env.BRAIN_URL = previousBrainUrl;
      if (previousDisabled === undefined) delete process.env.BRAIN_CONTEXT_DISABLED;
      else process.env.BRAIN_CONTEXT_DISABLED = previousDisabled;
      await new Promise<void>((r) => brain.close(() => r()));
    }
  });
});
