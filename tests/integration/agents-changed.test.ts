// SPDX-License-Identifier: MIT
/**
 * Agents-changed WebSocket broadcast — cli-registry-refresh.
 *
 * Verifies that the daemon emits a new `agents_changed` WS message after
 * each registry mutation so a running interactive CLI can clear stale
 * per-agent session state and resolve the new agent on the next /ask
 * without restarting.
 *
 * Covers:
 *   - direct broadcast helper (payload shape, team filtering)
 *   - DELETE /agents/by-name/:name end-to-end (mutation -> broadcast)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import WebSocket from 'ws';
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

async function findFreePort(): Promise<number> {
  const { createServer } = await import('net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      server.close(() => resolve(addr.port));
    });
    server.on('error', reject);
  });
}

function adminHeaders(team: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Id-Team': team,
    'X-Id-Admin': '1',
  };
}

function openClient(baseUrl: string, team: string): Promise<{ ws: WebSocket; received: any[] }> {
  const url = baseUrl.replace(/^http/, 'ws') + `/ws?team=${encodeURIComponent(team)}`;
  const ws = new WebSocket(url);
  const received: any[] = [];
  ws.on('message', (raw) => {
    try { received.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, received }));
    ws.once('error', reject);
  });
}

async function waitFor<T>(predicate: () => T | undefined, timeoutMs = 1500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = predicate();
    if (v !== undefined && v !== null && v !== false) return v as T;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('timed out waiting for condition');
}

let port: number;
let manager: AgentManagerDb;
let baseUrl: string;
let workDir: string;
let teamId: string;
let previousAdminToken: string | undefined;

beforeAll(async () => {
  previousAdminToken = process.env.IDACC_ADMIN_TOKEN;
  delete process.env.IDACC_ADMIN_TOKEN;
  port = await findFreePort();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-changed-test-'));
  baseUrl = `http://127.0.0.1:${port}`;

  const db = await createInMemoryDb();
  manager = new AgentManagerDb(workDir, db as any);
  await manager.start(port);

  teamId = await db.teams.getOrCreateTeamId('default');
}, 30000);

afterAll(async () => {
  if (manager) {
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 500);
    });
  }
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  if (previousAdminToken === undefined) delete process.env.IDACC_ADMIN_TOKEN;
  else process.env.IDACC_ADMIN_TOKEN = previousAdminToken;
});

describe('agents_changed WebSocket broadcast', () => {
  it('retains legacy team-scoped WebSocket access without a supervisor token', async () => {
    const client = await openClient(baseUrl, 'default');
    expect(await waitFor(() => client.received.find(m => m.type === 'connected'))).toMatchObject({
      type: 'connected',
      team: 'default',
    });
    client.ws.close();
  });

  it('broadcastAgentsChanged emits to clients on the matching team only', async () => {
    const a = await openClient(baseUrl, 'default');
    // Drain the initial 'connected' frame so subsequent waits only see broadcasts.
    await waitFor(() => a.received.find(m => m.type === 'connected'));

    manager.broadcastAgentsChanged(teamId, {
      reason: 'spawn',
      added: ['copywriter'],
    });

    const msg = await waitFor(() => a.received.find(m => m.type === 'agents_changed'));
    expect(msg).toBeDefined();
    expect(msg.teamId).toBe(teamId);
    expect(msg.change.reason).toBe('spawn');
    expect(msg.change.added).toEqual(['copywriter']);
    expect(msg.change.updated).toEqual([]);
    expect(msg.change.removed).toEqual([]);
    expect(typeof msg.timestamp).toBe('number');

    a.ws.close();
  });

  it('broadcastAgentsChanged does not leak across teams', async () => {
    const otherDb = (manager as any).db;
    const otherTeamId = await otherDb.teams.getOrCreateTeamId('idchain');

    const defaultClient = await openClient(baseUrl, 'default');
    const otherClient = await openClient(baseUrl, 'idchain');
    await waitFor(() => defaultClient.received.find(m => m.type === 'connected'));
    await waitFor(() => otherClient.received.find(m => m.type === 'connected'));

    manager.broadcastAgentsChanged(otherTeamId, {
      reason: 'remove',
      removed: ['ghost'],
    });

    await waitFor(() => otherClient.received.find(m => m.type === 'agents_changed'));
    // Default client must NOT see this broadcast
    await new Promise(r => setTimeout(r, 100));
    const leak = defaultClient.received.find(m => m.type === 'agents_changed' && m.teamId === otherTeamId);
    expect(leak).toBeUndefined();

    defaultClient.ws.close();
    otherClient.ws.close();
  });

  it('DELETE /agents/by-name/:name triggers an agents_changed remove broadcast', async () => {
    // Insert an agent row directly so the DELETE endpoint has a target.
    const agentName = `victim-${randomUUID().slice(0, 8)}`;
    const agentId = `agent-${randomUUID()}`;
    await (manager as any).db.agents.create({
      team_id: teamId,
      id: agentId,
      name: agentName,
      type: 'virtual',
      model: 'sonnet',
      status: 'running',
      created_at: Math.floor(Date.now() / 1000),
      port: 0,
    });

    const client = await openClient(baseUrl, 'default');
    await waitFor(() => client.received.find(m => m.type === 'connected'));

    const resp = await fetch(`${baseUrl}/agents/by-name/${encodeURIComponent(agentName)}`, {
      method: 'DELETE',
      headers: adminHeaders('default'),
    });
    expect(resp.ok).toBe(true);

    const msg = await waitFor(() => client.received.find(
      m => m.type === 'agents_changed' && m.change?.removed?.includes(agentName),
    ));
    expect(msg.change.reason).toBe('remove');

    client.ws.close();
  });

  it('POST /remote /delete <name> hard-deletes the agent row and removes it from listings', async () => {
    const agentName = `remote-victim-${randomUUID().slice(0, 8)}`;
    const agentId = `agent-${randomUUID()}`;
    await (manager as any).db.agents.create({
      team_id: teamId,
      id: agentId,
      name: agentName,
      type: 'virtual',
      model: 'sonnet',
      status: 'running',
      created_at: Math.floor(Date.now() / 1000),
      port: 0,
    });

    const deleteResp = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: adminHeaders('default'),
      body: JSON.stringify({ agent: 'tui', command: `/delete ${agentName}` }),
    });
    expect(deleteResp.ok).toBe(true);
    const deleteBody = await deleteResp.json() as { ok: boolean; result?: { deleted?: string }; error?: string };
    expect(deleteBody).toEqual({ ok: true, result: { deleted: agentName } });

    const row = await (manager as any).db.adapter.query(
      `SELECT id, name, status, deleted_at FROM agents WHERE team_id = $1 AND id = $2`,
      [teamId, agentId],
    );
    expect(row.rows).toHaveLength(0);

    const listResp = await fetch(`${baseUrl}/agents?team=default`, {
      headers: adminHeaders('default'),
    });
    expect(listResp.ok).toBe(true);
    const listBody = await listResp.json() as { agents: Array<{ id: string; name: string }> };
    expect(listBody.agents.find(a => a.id === agentId || a.name === agentName)).toBeUndefined();
  });
});
