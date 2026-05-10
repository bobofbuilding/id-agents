// SPDX-License-Identifier: MIT
/**
 * Remote `/team delete <name>` support for the TUI command bar.
 *
 * These tests boot the real manager on an ephemeral port and a temp SQLite DB.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentManagerDb } from '../../src/agent-manager-db.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteCheckinsRepo } from '../../src/db/repos/sqlite/checkins-repo.js';
import { SqliteEventsRepo } from '../../src/db/repos/sqlite/events-repo.js';
import { SqliteNewsRepo } from '../../src/db/repos/sqlite/news-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteSchedulesRepo } from '../../src/db/repos/sqlite/schedules-repo.js';
import { SqliteSubscriptionsRepo } from '../../src/db/repos/sqlite/subscriptions-repo.js';
import { SqliteTasksRepo } from '../../src/db/repos/sqlite/tasks-repo.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate port')));
        return;
      }
      server.close(() => resolve(address.port));
    });
    server.on('error', reject);
  });
}

async function createTempSqliteDb(dbPath: string) {
  const adapter = new SqliteAdapter(dbPath);
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

async function insertAgent(adapter: SqliteAdapter, teamId: string, name: string): Promise<void> {
  await adapter.query(
    `INSERT INTO agents (team_id, id, name, type, model, port, status, created_at, runtime, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [teamId, `agent_${name}`, name, 'persistent', 'claude-opus', 0, 'active', Date.now(), 'claude-code', '{}'],
  );
}

function headers(team: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Id-Team': team,
    'X-Id-Admin': '1',
  };
}

let port: number;
let baseUrl: string;
let workDir: string;
let dbPath: string;
let manager: AgentManagerDb;
let db: Awaited<ReturnType<typeof createTempSqliteDb>>;

beforeAll(async () => {
  port = await findFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-delete-remote-'));
  dbPath = path.join(workDir, 'manager.sqlite');
  db = await createTempSqliteDb(dbPath);
  manager = new AgentManagerDb(workDir, db as any);
  await manager.start(port);
}, 30000);

afterAll(async () => {
  if (manager) {
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 500);
    });
  }
  if (db) await db.close();
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('POST /remote /team', () => {
  it('returns a YAML-anchored error instead of creating a missing team', async () => {
    await db.teams.getOrCreateTeamId('idchain');

    const res = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: headers('idchain'),
      body: JSON.stringify({ agent: 'tui', command: '/team skunkworks' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe(
      'Team skunkworks not found. Create configs/skunkworks.yaml and run :deploy skunkworks, or :sync skunkworks to materialize an existing YAML.',
    );
    expect(await db.teams.getTeamByName('skunkworks')).toBeNull();
    expect(fs.existsSync(path.join(workDir, 'teams', 'skunkworks'))).toBe(false);
  });

  it('switches to an existing team', async () => {
    await db.teams.getOrCreateTeamId('idchain');
    const targetTeamId = await db.teams.getOrCreateTeamId('switchable-team');

    const res = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: headers('idchain'),
      body: JSON.stringify({ agent: 'tui', command: '/team switchable-team' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      result?: { id?: string; name?: string; agentCount?: number; switched?: boolean; created?: boolean };
    };
    expect(body.ok).toBe(true);
    expect(body.result).toMatchObject({
      id: targetTeamId,
      name: 'switchable-team',
      agentCount: 0,
      switched: true,
    });
    expect(body.result).not.toHaveProperty('created');
  });

  it('refuses to delete a team that still has agents', async () => {
    await db.teams.getOrCreateTeamId('idchain');
    const teamId = await db.teams.getOrCreateTeamId('occupied-team');
    await insertAgent(db.adapter, teamId, 'worker');

    const res = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: headers('idchain'),
      body: JSON.stringify({ agent: 'tui', command: '/team delete occupied-team' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('still has 1 agent(s)');
    expect(body.error).toContain('/delete --team occupied-team');
  });

  it('deletes an empty inactive team', async () => {
    await db.teams.getOrCreateTeamId('idchain');
    await db.teams.getOrCreateTeamId('empty-team');

    const res = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: headers('idchain'),
      body: JSON.stringify({ agent: 'tui', command: '/team delete empty-team' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; result?: { message?: string; name?: string } };
    expect(body.ok).toBe(true);
    expect(body.result?.name).toBe('empty-team');
    expect(body.result?.message).toBe('Team "empty-team" deleted');

    const deleted = await db.teams.getTeamByName('empty-team');
    expect(deleted).toBeNull();
  });

  it('cascades /delete --team through agent removal and team-row deletion', async () => {
    const teamName = 'cascade-delete-team';
    const teamId = await db.teams.getOrCreateTeamId(teamName);
    await insertAgent(db.adapter, teamId, 'lead');
    await insertAgent(db.adapter, teamId, 'scout');
    await insertAgent(db.adapter, teamId, 'dev');

    const res = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: headers(teamName),
      body: JSON.stringify({ agent: 'tui', command: `/delete --team ${teamName}` }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      result?: { deleted?: string[]; count?: number; team?: string; teamDeleted?: boolean; message?: string };
    };
    expect(body.ok).toBe(true);
    expect(body.result).toMatchObject({
      count: 3,
      team: teamName,
      teamDeleted: true,
    });
    expect(body.result?.deleted?.sort()).toEqual(['dev', 'lead', 'scout']);

    const remainingAgents = await db.adapter.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM agents WHERE team_id = ?`,
      [teamId],
    );
    expect(Number(remainingAgents.rows[0]?.count ?? 0)).toBe(0);
    expect(await db.teams.getTeamByName(teamName)).toBeNull();
  });
});
