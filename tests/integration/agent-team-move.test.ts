// SPDX-License-Identifier: MIT
/**
 * Control Center agent team reassignment contract.
 *
 * HR Manager merge uses POST /agents/:id/team to move existing local agents.
 * Stable team rename uses PATCH /teams/:name and preserves the team id.
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
import { SqliteRuntimeLaneCooldownsRepo } from '../../src/db/repos/sqlite/runtime-lane-cooldowns-repo.js';
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
    runtimeLaneCooldowns: new SqliteRuntimeLaneCooldownsRepo(adapter),
    async close() { await adapter.close(); },
  };
}

async function insertAgent(
  adapter: SqliteAdapter,
  teamId: string,
  id: string,
  name: string,
  runtime = 'codex',
): Promise<void> {
  await adapter.query(
    `INSERT INTO agents (team_id, id, name, type, model, port, status, created_at, runtime, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [teamId, id, name, 'claude', 'gpt-5', 0, 'stopped', Date.now(), runtime, '{}'],
  );
}

function headers(team: string, admin = true): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Id-Team': team,
    ...(admin ? { 'X-Id-Admin': '1' } : {}),
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
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-move-'));
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

describe('POST /agents/:id/team', () => {
  it('moves a stopped local agent to an existing target team without starting it', async () => {
    const sourceTeamId = await db.teams.getOrCreateTeamId('ops-team');
    const targetTeamId = await db.teams.getOrCreateTeamId('operations-team');
    await insertAgent(db.adapter, sourceTeamId, 'agent_worker', 'worker');

    const res = await fetch(`${baseUrl}/agents/agent_worker/team`, {
      method: 'POST',
      headers: headers('ops-team'),
      body: JSON.stringify({ team: 'operations-team' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; rebuilt?: boolean; warning?: string };
    expect(body.ok).toBe(true);
    expect(body.rebuilt).toBe(false);
    expect(body.warning).toContain('moved while stopped');

    expect(await db.agents.getByName(sourceTeamId, 'worker')).toBeNull();
    const moved = await db.agents.getByName(targetTeamId, 'worker');
    expect(moved?.id).toBe('agent_worker');
    expect(moved?.status).toBe('stopped');
  });

  it('blocks name collisions in the target team', async () => {
    const sourceTeamId = await db.teams.getOrCreateTeamId('research-team');
    const targetTeamId = await db.teams.getOrCreateTeamId('engineering-team');
    await insertAgent(db.adapter, sourceTeamId, 'agent_researcher', 'analyst');
    await insertAgent(db.adapter, targetTeamId, 'agent_engineer', 'analyst');

    const res = await fetch(`${baseUrl}/agents/agent_researcher/team`, {
      method: 'POST',
      headers: headers('research-team'),
      body: JSON.stringify({ team: 'engineering-team' }),
    });

    expect(res.status).toBe(409);
    const body = await res.json() as { error?: string };
    expect(body.error).toContain('already has an agent named "analyst"');
  });

  it('can create an empty target team only when explicitly requested', async () => {
    const sourceTeamId = await db.teams.getOrCreateTeamId('qa-team');
    await insertAgent(db.adapter, sourceTeamId, 'agent_tester', 'tester');

    const missing = await fetch(`${baseUrl}/agents/agent_tester/team`, {
      method: 'POST',
      headers: headers('qa-team'),
      body: JSON.stringify({ team: 'quality-team' }),
    });
    expect(missing.status).toBe(404);
    expect(await db.teams.getTeamByName('quality-team')).toBeNull();

    const res = await fetch(`${baseUrl}/agents/agent_tester/team`, {
      method: 'POST',
      headers: headers('qa-team'),
      body: JSON.stringify({ team: 'quality-team', createTarget: true }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; rebuilt?: boolean; warning?: string };
    expect(body.ok).toBe(true);
    expect(body.rebuilt).toBe(false);

    const targetTeam = await db.teams.getTeamByName('quality-team');
    expect(targetTeam?.name).toBe('quality-team');
    expect(await db.agents.getByName(sourceTeamId, 'tester')).toBeNull();
    const moved = await db.agents.getByName(targetTeam!.id, 'tester');
    expect(moved?.id).toBe('agent_tester');
  });

  it('requires an admin caller', async () => {
    const sourceTeamId = await db.teams.getOrCreateTeamId('legal-team');
    await db.teams.getOrCreateTeamId('compliance-team');
    await insertAgent(db.adapter, sourceTeamId, 'agent_counsel', 'counsel');

    const res = await fetch(`${baseUrl}/agents/agent_counsel/team`, {
      method: 'POST',
      headers: headers('legal-team', false),
      body: JSON.stringify({ team: 'compliance-team' }),
    });

    expect(res.status).toBe(403);
  });
});

describe('stable identity rename routes', () => {
  it('renames the primary team without changing its id or roster ownership', async () => {
    const source = await db.teams.getTeamByName('default');
    expect(source).not.toBeNull();
    await insertAgent(db.adapter, source!.id, 'agent_primary_rename', 'lead');
    await insertAgent(db.adapter, source!.id, 'agent_coder_rename', 'coder');
    await insertAgent(db.adapter, source!.id, 'agent_researcher_rename', 'researcher');

    const renamed = await fetch(`${baseUrl}/teams/default`, {
      method: 'PATCH',
      headers: headers('default'),
      body: JSON.stringify({
        name: 'executive-team',
        orgIdentity: { primary: true, primaryAgent: 'lead', validators: ['coder', 'researcher'] },
      }),
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({
      ok: true,
      previousName: 'default',
      name: 'executive-team',
      identityUpdated: true,
    });

    expect(await db.teams.getTeamByName('default')).toBeNull();
    const target = await db.teams.getTeamByName('executive-team');
    expect(target?.id).toBe(source!.id);
    expect((await db.agents.getByName(target!.id, 'lead'))?.id).toBe('agent_primary_rename');
    expect((await db.teams.getConfig(target!.id)).idacc_org_identity).toEqual({
      primary: true,
      primaryAgent: 'lead',
      validators: ['coder', 'researcher'],
    });

    const staleStarterScope = await fetch(`${baseUrl}/agents`, {
      headers: headers('default'),
    });
    expect(staleStarterScope.status).toBe(200);
    expect((await staleStarterScope.json() as { agents: unknown[] }).agents).toHaveLength(3);
    expect(await db.teams.getTeamByName('default')).toBeNull();

    const restored = await fetch(`${baseUrl}/teams/executive-team`, {
      method: 'PATCH',
      headers: headers('executive-team'),
      body: JSON.stringify({
        name: 'default',
        orgIdentity: { primary: true, primaryAgent: 'lead', validators: ['coder', 'researcher'] },
      }),
    });
    expect(restored.status).toBe(200);
  });

  it('rejects team rename collisions and non-admin callers', async () => {
    await db.teams.getOrCreateTeamId('rename-source');
    await db.teams.getOrCreateTeamId('rename-target');

    const collision = await fetch(`${baseUrl}/teams/rename-source`, {
      method: 'PATCH',
      headers: headers('rename-source'),
      body: JSON.stringify({ name: 'rename-target' }),
    });
    expect(collision.status).toBe(409);

    const unauthorized = await fetch(`${baseUrl}/teams/rename-source`, {
      method: 'PATCH',
      headers: headers('rename-source', false),
      body: JSON.stringify({ name: 'renamed-without-admin' }),
    });
    expect(unauthorized.status).toBe(403);
  });

  it('validates organization identity before changing the team name', async () => {
    const sourceId = await db.teams.getOrCreateTeamId('identity-validation-source');
    await insertAgent(db.adapter, sourceId, 'agent_identity_validation_lead', 'lead');

    const response = await fetch(`${baseUrl}/teams/identity-validation-source`, {
      method: 'PATCH',
      headers: headers('identity-validation-source'),
      body: JSON.stringify({
        name: 'identity-validation-target',
        orgIdentity: { primary: true, primaryAgent: 'missing-lead', validators: [] },
      }),
    });

    expect(response.status).toBe(409);
    expect((await db.teams.getTeamByName('identity-validation-source'))?.id).toBe(sourceId);
    expect(await db.teams.getTeamByName('identity-validation-target')).toBeNull();
  });
});
