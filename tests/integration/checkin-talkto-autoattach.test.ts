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

function adminHeaders(team: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Id-Team': team, 'X-Id-Admin': '1' };
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
        task: { title: 'Build foo widget', name: 'build-foo' },
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

    // Checkin: owner = dispatcher, linked_task = the new task, default 10m.
    const checkins = await db.checkins.list({ teamId });
    expect(checkins).toHaveLength(1);
    expect(checkins[0]).toMatchObject({
      owner_agent_id: dispatcherId,
      created_by_agent_id: dispatcherId,
      linked_task_id: tasks[0].id,
      interval_seconds: 600,
      priority: 'normal',
      status: 'active',
      max_iterations: null,
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
        task: { title: 'Quick fix' },
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
        task: { title: 'Long-running migration' },
        checkin: '30m',
      }),
    });
    expect(res.status).toBe(200);

    const checkins = await db.checkins.list({ teamId });
    expect(checkins).toHaveLength(1);
    expect(checkins[0].interval_seconds).toBe(1800);
    expect(checkins[0].max_iterations).toBeNull();
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
        task: { title: 'Bounded check' },
        checkin: '5m',
        checkin_iters: 3,
      }),
    });
    expect(res.status).toBe(200);

    const checkins = await db.checkins.list({ teamId });
    expect(checkins).toHaveLength(1);
    expect(checkins[0].interval_seconds).toBe(300);
    expect(checkins[0].max_iterations).toBe(3);
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

      const done = await fetch(`${baseUrl}/tasks/close-deployment-task/done`, {
        method: 'POST',
        headers: adminHeaders(TEAM),
        body: JSON.stringify({
          agent_id: 'coder',
          injected_instruction_ids: ['memory:101'],
          used_instruction_ids: ['memory:101'],
          used_source_ids: ['memory:101'],
          brain_context: claimBody.task.brain_context,
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
      expect(received.evals).toHaveLength(1);
      expect(received.evals[0]).toMatchObject({
        route: 'manager.task_completion',
        agent_id: targetId,
        accepted_ids: ['memory:101'],
        volunteered_source_ids: ['memory:101'],
        context_package_id: 77,
        metadata: {
          source_origins: { 'memory:101': ['team_instruction'] },
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
          task: { title: 'Brain-backed query', name: 'brain-backed-query' },
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
      ))).toBe(true);
      expect(received.validations.some((item) => item.eval_feedback?.route === 'manager.dispatch')).toBe(true);
      expect(received.validations.some((item) => item.instruction_feedback?.used_instruction_ids?.includes('memory:101'))).toBe(true);
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
      });
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
