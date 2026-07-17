// SPDX-License-Identifier: MIT
/**
 * Integration coverage for `/task assign` (via `POST /remote`) — the
 * atomic assignment + dispatch capability preflight hardening.
 *
 * Boots the real AgentManagerDb against an in-memory SQLite DB and proves:
 *   - a normal assignment succeeds and flips the task to 'doing' with the
 *     target as owner
 *   - assigning to an agent whose declared capabilities have no shell/HTTP
 *     access and no task-lifecycle MCP route fails clearly with
 *     `missing_required_capability: task_write` instead of stranding the
 *     task in 'doing' with an owner that can never act on it
 *   - two concurrent assigns racing the same freshly-read task can only
 *     let one caller win; the loser gets a clear conflict instead of
 *     silently overwriting the winner's ownership
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
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

const TEAM = 'task-assign-atomic-test';

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
    setTimeout(resolve, 500);
  });
}

function adminHeaders(team: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Id-Team': team, 'X-Id-Admin': '1' };
}

async function insertTaskDirect(
  db: Awaited<ReturnType<typeof createInMemoryDb>>,
  teamId: string,
  name: string,
): Promise<{ id: string; name: string; uuid: string }> {
  const id = `task_${crypto.randomUUID()}`;
  const uuid = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await db.adapter.query(
    `INSERT INTO tasks (id, name, uuid, team_id, title, status, owner, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, uuid, teamId, `Title for ${name}`, 'todo', null, now, now],
  );
  return { id, name, uuid };
}

interface RemoteResult {
  ok: boolean;
  error?: string;
  result?: any;
}

async function remote(baseUrl: string, team: string, command: string): Promise<RemoteResult> {
  const res = await fetch(`${baseUrl}/remote`, {
    method: 'POST',
    headers: adminHeaders(team),
    body: JSON.stringify({ command }),
  });
  return res.json() as Promise<RemoteResult>;
}

describe('/task assign — atomic assignment + capability preflight', () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let baseUrl: string;
  let workDir: string;
  let teamId: string;

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-assign-atomic-test-'));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);
    teamId = await db.teams.getOrCreateTeamId(TEAM);

    await db.agents.create({
      team_id: teamId, id: 'agent-capable', name: 'agent-capable',
      type: 'claude', model: 'sonnet', status: 'running',
      created_at: Math.floor(Date.now() / 1000),
    });
    await db.agents.create({
      team_id: teamId, id: 'agent-rival', name: 'agent-rival',
      type: 'claude', model: 'sonnet', status: 'running',
      created_at: Math.floor(Date.now() / 1000),
    });
    await db.agents.create({
      team_id: teamId, id: 'agent-no-shell-http', name: 'agent-no-shell-http',
      type: 'claude', model: 'sonnet', status: 'running',
      created_at: Math.floor(Date.now() / 1000),
      metadata: { capabilities: { shell: false, http: false } },
    });
  }, 30000);

  afterAll(async () => {
    if (manager) await stopManager(manager);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('assigns a todo task to a capable agent and flips it to doing', async () => {
    const t = await insertTaskDirect(db, teamId, 'assignable-task');

    const response = await remote(baseUrl, TEAM, `/task assign ${t.name} agent-capable`);

    expect(response.ok).toBe(true);
    expect(response.result.task.status).toBe('doing');
    expect(response.result.task.ownerName).toBe('agent-capable');
  });

  it('fails clearly with missing_required_capability: task_write instead of stranding the task', async () => {
    const t = await insertTaskDirect(db, teamId, 'incapable-target-task');

    const response = await remote(baseUrl, TEAM, `/task assign ${t.name} agent-no-shell-http`);

    expect(response.ok).toBe(false);
    expect(response.error).toBe('missing_required_capability');
    expect(response.result.missing_required_capability).toBe('task_write');

    // The task must be left untouched — still 'todo', unowned — not
    // silently flipped to 'doing' for an agent that can never act on it.
    const after = await db.tasks.getByNameForTeam(t.name, teamId);
    expect(after?.status).toBe('todo');
    expect(after?.owner).toBeNull();
  });

  it('rejects a stale assign — without mutating anything — when the task changed between resolution and write', async () => {
    // A real OS-level race between two /remote calls isn't reproducible
    // deterministically here (Node's event loop plus a synchronous SQLite
    // driver processes them back-to-back, not interleaved — the CAS race
    // itself is already proven at the repository layer in
    // tests/unit/tasks-repo-assign.test.ts). This test instead simulates the
    // exact race window at the HTTP layer: inject a concurrent claim between
    // the assign handler's initial task read and its later CAS write, and
    // assert the stale assign is rejected instead of silently overwriting
    // the claim that landed in between.
    const t = await insertTaskDirect(db, teamId, 'stale-http-assign-task');

    const originalGetByNameForTeam = db.tasks.getByNameForTeam.bind(db.tasks);
    let intercepted = false;
    db.tasks.getByNameForTeam = (async (name: string, tid: string) => {
      const row = await originalGetByNameForTeam(name, tid);
      if (!intercepted && name === t.name) {
        intercepted = true;
        // Lands strictly between the assign handler's initial read (this
        // call) and its later assignAtomic write — the exact TOCTOU window.
        await db.tasks.claim(row!.id, 'agent-rival', Math.floor(Date.now() / 1000));
      }
      return row;
    }) as typeof db.tasks.getByNameForTeam;

    try {
      const response = await remote(baseUrl, TEAM, `/task assign ${t.name} agent-capable`);
      expect(response.ok).toBe(false);
      expect(response.error).toBe('task_changed_concurrently');
    } finally {
      db.tasks.getByNameForTeam = originalGetByNameForTeam;
    }

    // The concurrent claim must survive untouched — the stale assign must
    // not have stomped it, so nothing is left owned-but-unclaimable.
    const after = await db.tasks.getByNameForTeam(t.name, teamId);
    expect(after?.status).toBe('doing');
    expect(after?.owner).toBe('agent-rival');
  });
});
