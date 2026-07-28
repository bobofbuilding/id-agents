// SPDX-License-Identifier: MIT

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket, { type ClientOptions } from 'ws';
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
import { SqliteControlStateRepo } from '../../src/db/repos/sqlite/control-state-repo.js';
import { SqliteRuntimeLaneCooldownsRepo } from '../../src/db/repos/sqlite/runtime-lane-cooldowns-repo.js';
import { deriveManagerAgentToken } from '../../src/manager-worker-auth.js';

const ADMIN_TOKEN = 'integration-admin-session-token';
const SERVICE_TOKEN = 'integration-manager-service-token-00000000000000000000';
const TEAM = 'admin-token-auth';

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
    controlState: new SqliteControlStateRepo(adapter),
    runtimeLaneCooldowns: new SqliteRuntimeLaneCooldownsRepo(adapter),
    async close() { await adapter.close(); },
  };
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
}

async function stopManager(manager: AgentManagerDb): Promise<void> {
  await new Promise<void>((resolve) => {
    (manager as unknown as { httpServer?: http.Server }).httpServer?.close(() => resolve());
    setTimeout(resolve, 500);
  });
}

describe('IDACC Manager admin bearer', () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let managerUrl: string;
  let brainServer: http.Server;
  let workDir: string;
  let previousAdminToken: string | undefined;
  let previousServiceToken: string | undefined;
  let previousBrainUrl: string | undefined;
  let previousBrainToken: string | undefined;
  const brainRequests: Array<{ url: string; authorization: string }> = [];

  beforeAll(async () => {
    previousAdminToken = process.env.IDACC_ADMIN_TOKEN;
    previousServiceToken = process.env.IDACC_MANAGER_SERVICE_TOKEN;
    previousBrainUrl = process.env.BRAIN_URL;
    previousBrainToken = process.env.BRAIN_TOKEN;
    process.env.IDACC_ADMIN_TOKEN = ADMIN_TOKEN;
    process.env.IDACC_MANAGER_SERVICE_TOKEN = SERVICE_TOKEN;
    process.env.BRAIN_TOKEN = 'brain-agent-compatible';

    const brainPort = await findFreePort();
    process.env.BRAIN_URL = `http://127.0.0.1:${brainPort}`;
    brainServer = http.createServer((req, res) => {
      brainRequests.push({
        url: String(req.url || ''),
        authorization: String(req.headers.authorization || ''),
      });
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, nodes: 0, edges: 0 }));
        return;
      }
      if (req.url === '/timeline?type=control%3Atest&limit=2') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({
          events: [{
            id: 7,
            type: 'control:test',
            data: {
              token: 'must-not-leave-manager',
              nested: { api_key: 'must-not-leave-manager', summary: 'visible' },
            },
          }],
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => brainServer.listen(brainPort, '127.0.0.1', resolve));

    const managerPort = await findFreePort();
    managerUrl = `http://127.0.0.1:${managerPort}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idacc-admin-token-'));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as never);
    expect(process.env.IDACC_ADMIN_TOKEN).toBeUndefined();
    expect(process.env.IDACC_MANAGER_SERVICE_TOKEN).toBeUndefined();
    const inherited = spawnSync(process.execPath, ['-e', `
      process.stdout.write(JSON.stringify({
        admin: process.env.IDACC_ADMIN_TOKEN || null,
        managerService: process.env.IDACC_MANAGER_SERVICE_TOKEN || null,
        brain: process.env.BRAIN_TOKEN || null,
      }));
    `], { env: process.env, encoding: 'utf8' });
    expect(JSON.parse(inherited.stdout)).toEqual({
      admin: null,
      managerService: null,
      brain: 'brain-agent-compatible',
    });
    await manager.start(managerPort);
    await db.teams.getOrCreateTeamId(TEAM);
  }, 30_000);

  afterAll(async () => {
    (manager as any)?.ownedAgentProcesses?.clear?.();
    if (manager) await stopManager(manager);
    if (brainServer) await new Promise<void>((resolve) => brainServer.close(() => resolve()));
    if (db) await db.close();
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
    if (previousAdminToken === undefined) delete process.env.IDACC_ADMIN_TOKEN;
    else process.env.IDACC_ADMIN_TOKEN = previousAdminToken;
    if (previousServiceToken === undefined) delete process.env.IDACC_MANAGER_SERVICE_TOKEN;
    else process.env.IDACC_MANAGER_SERVICE_TOKEN = previousServiceToken;
    if (previousBrainUrl === undefined) delete process.env.BRAIN_URL;
    else process.env.BRAIN_URL = previousBrainUrl;
    if (previousBrainToken === undefined) delete process.env.BRAIN_TOKEN;
    else process.env.BRAIN_TOKEN = previousBrainToken;
  });

  async function relay(
    headers: Record<string, string>,
    operation: Record<string, unknown> = { method: 'GET', path: '/health' },
  ): Promise<Response> {
    return fetch(`${managerUrl}/control/brain`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Id-Team': TEAM,
        ...headers,
      },
      body: JSON.stringify(operation),
    });
  }

  function rejectedWebSocket(
    options: ClientOptions = {},
    extraQuery = '',
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const url = managerUrl.replace(/^http/, 'ws')
        + `/ws?team=${encodeURIComponent(TEAM)}${extraQuery}`;
      const ws = new WebSocket(url, options);
      const timeout = setTimeout(() => {
        reject(new Error('timed out waiting for WebSocket upgrade rejection'));
      }, 2_000);
      ws.on('error', () => {});
      ws.once('open', () => {
        clearTimeout(timeout);
        ws.close();
        reject(new Error('unauthorized WebSocket unexpectedly opened'));
      });
      ws.once('unexpected-response', (_request, response) => {
        clearTimeout(timeout);
        response.resume();
        resolve(response.statusCode ?? 0);
      });
    });
  }

  function openAdminWebSocket(): Promise<{
    ws: WebSocket;
    connected: Promise<Record<string, unknown>>;
  }> {
    const url = managerUrl.replace(/^http/, 'ws')
      + `/ws?team=${encodeURIComponent(TEAM)}`;
    const ws = new WebSocket(url, {
      headers: {
        'X-Id-Admin': '1',
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
    });
    const connected = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('timed out waiting for WebSocket connected frame')),
        2_000,
      );
      ws.once('message', (raw) => {
        clearTimeout(timeout);
        try {
          resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
        } catch (error) {
          reject(error);
        }
      });
      ws.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('timed out opening authenticated WebSocket')),
        2_000,
      );
      ws.once('open', () => {
        clearTimeout(timeout);
        resolve({ ws, connected });
      });
      ws.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  async function waitForManagerWebSocketClientCount(expected: number): Promise<void> {
    const clients = (manager as unknown as { wsClients: Set<unknown> }).wsClients;
    const deadline = Date.now() + 1_000;
    while (clients.size !== expected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(clients.size).toBe(expected);
  }

  it('keeps only discovery and minimal readiness health anonymous in managed mode', async () => {
    const discovery = await fetch(`${managerUrl}/.well-known/restap.json`);
    expect(discovery.status).toBe(200);
    expect((await discovery.json() as { agent?: { name?: string } }).agent?.name)
      .toBe('manager');

    const health = await fetch(`${managerUrl}/health`);
    expect(health.status).toBe(200);
    const body = await health.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      status: 'ok',
      ready: true,
      protocolVersion: 'idacc.health.v1',
    });
    expect(body).not.toHaveProperty('team');
    expect(body).not.toHaveProperty('agents');
    expect(body).not.toHaveProperty('activeQueries');
    expect(typeof body.timestamp).toBe('number');
    expect(Object.keys(body).every((key) => [
      'status',
      'ready',
      'service',
      'runtimeVersion',
      'instanceNonce',
      'protocolVersion',
      'timestamp',
    ].includes(key))).toBe(true);

    for (const pathname of [
      `/agents?team=${encodeURIComponent(TEAM)}`,
      `/teams?team=${encodeURIComponent(TEAM)}`,
      `/events?team=${encodeURIComponent(TEAM)}`,
      `/tasks?team=${encodeURIComponent(TEAM)}`,
      `/news?team=${encodeURIComponent(TEAM)}`,
      `/library/agents?team=${encodeURIComponent(TEAM)}`,
      `/logs?team=${encodeURIComponent(TEAM)}`,
    ]) {
      const response = await fetch(`${managerUrl}${pathname}`);
      expect(response.status, pathname).toBe(401);
      expect(await response.json()).toEqual({ error: 'authentication_required' });
    }
  });

  it('gives the Brain service only its exact read allowlist', async () => {
    const serviceHeaders = {
      'X-Id-Team': TEAM,
      'X-Id-Service': 'brain',
      Authorization: `Bearer ${SERVICE_TOKEN}`,
    };
    for (const pathname of [
      '/teams',
      '/agents',
      '/events?since=0&limit=1',
    ]) {
      expect((await fetch(`${managerUrl}${pathname}`, {
        headers: serviceHeaders,
      })).status, pathname).toBe(200);
      expect((await fetch(`${managerUrl}${pathname}`, {
        method: 'HEAD',
        headers: serviceHeaders,
      })).status, `HEAD ${pathname}`).toBe(200);
    }
    for (const method of ['GET', 'HEAD'] as const) {
      expect((await fetch(`${managerUrl}/teams`, {
        method,
        headers: {
          ...serviceHeaders,
          'X-Id-Team': 'team-that-does-not-exist',
        },
      })).status, `${method} global /teams without an existing context team`).toBe(200);
    }

    expect((await fetch(`${managerUrl}/agents/not-allowed`, {
      headers: serviceHeaders,
    })).status).toBe(403);
    expect((await fetch(`${managerUrl}/tasks`, {
      headers: serviceHeaders,
    })).status).toBe(403);
    expect((await fetch(`${managerUrl}/events`, {
      method: 'POST',
      headers: {
        ...serviceHeaders,
        'content-type': 'application/json',
      },
      body: '{}',
    })).status).toBe(403);
    expect((await fetch(`${managerUrl}/agents`, {
      headers: {
        ...serviceHeaders,
        Authorization: 'Bearer wrong',
      },
    })).status).toBe(401);
    expect((await fetch(`${managerUrl}/agents`, {
      headers: {
        'X-Id-Team': TEAM,
        Authorization: `Bearer ${SERVICE_TOKEN}`,
      },
    })).status).toBe(401);
  });

  it('authenticates one current worker generation and denies forgery, cross-team use, and excess routes', async () => {
    const teamId = await db.teams.getOrCreateTeamId(TEAM);
    const otherTeam = 'admin-token-auth-other';
    await db.teams.getOrCreateTeamId(otherTeam);
    const agentId = 'managed-auth-worker';
    const otherAgentId = 'managed-auth-peer';
    const generation = 'managed-auth-worker-generation';
    const workerPid = 45910;
    const peerPid = 45920;
    for (const row of [
      {
        id: agentId,
        name: 'managed-auth-worker',
        metadata: {
          alias: 'managed-auth-worker',
          pid: workerPid,
          processOwner: 'manager-child',
          processParentPid: process.pid,
          managerOwnedLaunchIntent: true,
          processGeneration: generation,
          processRuntime: 'codex',
          processRuntimeLane: 'codex:default',
        },
      },
      {
        id: otherAgentId,
        name: 'managed-auth-peer',
        metadata: {
          alias: 'managed-auth-peer',
          pid: peerPid,
          processOwner: 'manager-child',
          processParentPid: process.pid,
          managerOwnedLaunchIntent: true,
          processGeneration: 'managed-auth-peer-generation',
          processRuntime: 'codex',
          processRuntimeLane: 'codex:default',
        },
      },
    ]) {
      if (!await db.agents.getById(row.id)) {
        await db.agents.create({
          team_id: teamId,
          id: row.id,
          name: row.name,
          type: 'claude',
          runtime: 'codex',
          model: 'gpt-5',
          port: row.id === agentId ? 4591 : 4592,
          status: 'running',
          created_at: Date.now(),
          metadata: row.metadata,
        } as any);
      }
    }
    for (const assignment of [
      {
        pid: workerPid,
        agentId,
        agentName: 'managed-auth-worker',
        port: 4591,
        processGeneration: generation,
      },
      {
        pid: peerPid,
        agentId: otherAgentId,
        agentName: 'managed-auth-peer',
        port: 4592,
        processGeneration: 'managed-auth-peer-generation',
      },
    ]) {
      (manager as any).ownedAgentProcesses.set(assignment.pid, {
        ...assignment,
        proc: Object.assign(new EventEmitter(), {
          pid: assignment.pid,
          exitCode: null,
          signalCode: null,
        }),
      });
    }
    const token = deriveManagerAgentToken(
      ADMIN_TOKEN,
      teamId,
      agentId,
      generation,
    );
    const agentHeaders = {
      'X-Id-Team': TEAM,
      'X-Id-Agent': agentId,
      Authorization: `Bearer ${token}`,
    };

    expect((await fetch(`${managerUrl}/agents`, {
      headers: agentHeaders,
    })).status).toBe(200);
    expect((await fetch(`${managerUrl}/agents/${encodeURIComponent(agentId)}`, {
      headers: agentHeaders,
    })).status).toBe(200);
    expect((await fetch(`${managerUrl}/agents`, {
      headers: {
        'X-Id-Team': TEAM,
        'X-Id-Agent': agentId,
      },
    })).status).toBe(401);
    expect((await fetch(`${managerUrl}/agents`, {
      headers: {
        ...agentHeaders,
        Authorization: 'Bearer forged',
      },
    })).status).toBe(401);
    expect((await fetch(`${managerUrl}/agents`, {
      headers: {
        ...agentHeaders,
        'X-Id-Team': otherTeam,
      },
    })).status).toBe(403);
    expect((await fetch(`${managerUrl}/agents/${encodeURIComponent(otherAgentId)}`, {
      headers: agentHeaders,
    })).status).toBe(403);
    expect((await fetch(`${managerUrl}/agents/${encodeURIComponent(otherAgentId)}/metadata`, {
      method: 'POST',
      headers: {
        ...agentHeaders,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ metadata: { pid: process.pid } }),
    })).status).toBe(403);

    for (const pathname of [
      '/news',
      '/events',
      '/teams',
      '/library/agents',
      '/logs',
    ]) {
      expect((await fetch(`${managerUrl}${pathname}`, {
        headers: agentHeaders,
      })).status, pathname).toBe(403);
    }

    expect((await fetch(`${managerUrl}/talk`, {
      method: 'POST',
      headers: {
        ...agentHeaders,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: 'forged sender',
        from: otherAgentId,
      }),
    })).status).toBe(403);

    const ownQuery = 'managed-auth-own-query';
    const peerQuery = 'managed-auth-peer-query';
    const managerOwnedQuery = 'managed-auth-manager-query';
    await db.queries.create(teamId, ownQuery, agentId, 'own', Date.now());
    await db.queries.create(teamId, peerQuery, otherAgentId, 'peer', Date.now());
    await db.queries.create(
      teamId,
      managerOwnedQuery,
      null,
      'manager',
      Date.now(),
      undefined,
      { owner_kind: 'manager', owner_id: teamId },
    );
    const rateLimitQuery = 'managed-auth-rate-limit-query';
    const modelCapacityQuery = 'managed-auth-model-capacity-query';
    await db.queries.create(
      teamId,
      rateLimitQuery,
      agentId,
      'worker-owned rate-limit query',
      Date.now(),
    );
    await db.queries.create(
      teamId,
      modelCapacityQuery,
      agentId,
      'worker-owned model-capacity query',
      Date.now(),
    );
    const replyHeaders = {
      ...agentHeaders,
      'content-type': 'application/json',
    };

    const peerRateLimit = await fetch(`${managerUrl}/runtime/rate-limit`, {
      method: 'POST',
      headers: replyHeaders,
      body: JSON.stringify({
        agent_id: agentId,
        runtime: 'ollama',
        lane_id: 'peer-controlled-lane',
        query_id: peerQuery,
        rateLimit: {
          isRateLimit: true,
          source: 'text-fallback',
          reason: 'api_rate_limit',
          retryAfterSeconds: 999_999_999,
          message: 'must not replay peer work',
        },
      }),
    });
    expect(peerRateLimit.status).toBe(403);

    const failoverSpy = vi
      .spyOn(manager as any, 'handleRuntimeRateLimitFailover')
      .mockResolvedValueOnce({ attempted: false });
    const modelCapacityRateLimit = await fetch(`${managerUrl}/runtime/rate-limit`, {
      method: 'POST',
      headers: replyHeaders,
      body: JSON.stringify({
        agent_id: agentId,
        runtime: 'ollama',
        lane_id: 'caller-selected-model-lane',
        query_id: modelCapacityQuery,
        rateLimit: {
          isRateLimit: true,
          source: 'text-fallback',
          reason: 'model_capacity',
          message: 'selected model is temporarily at capacity',
        },
      }),
    });
    const modelCapacityBody = await modelCapacityRateLimit.json() as any;
    expect(modelCapacityRateLimit.status).toBe(200);
    expect(modelCapacityBody.cooldown).toMatchObject({
      runtime: 'codex',
      laneId: 'codex:model:gpt-5',
      reason: 'model_capacity',
      queryId: modelCapacityQuery,
    });
    expect(failoverSpy).toHaveBeenCalledWith(
      teamId,
      TEAM,
      expect.objectContaining({
        runtime: 'codex',
        laneId: 'codex:model:gpt-5',
        queryId: modelCapacityQuery,
      }),
    );
    failoverSpy.mockRestore();

    const boundedRateLimitBefore = Date.now();
    const ownRateLimit = await fetch(`${managerUrl}/runtime/rate-limit`, {
      method: 'POST',
      headers: replyHeaders,
      body: JSON.stringify({
        agent_id: agentId,
        runtime: 'ollama',
        lane_id: 'worker-controlled-lane',
        query_id: rateLimitQuery,
        rateLimit: {
          isRateLimit: true,
          source: 'not-a-runtime-source',
          reason: 'not-a-runtime-reason',
          retryAfterSeconds: 999_999_999,
          resetText: 'x'.repeat(2_000),
          message: 'm'.repeat(5_000),
        },
      }),
    });
    const ownRateLimitText = await ownRateLimit.text();
    expect(ownRateLimit.status, ownRateLimitText).toBe(200);
    const ownRateLimitBody = JSON.parse(ownRateLimitText);
    expect(ownRateLimitBody).toMatchObject({
      ok: true,
      cooldown: {
        agentId,
        runtime: 'codex',
        laneId: 'codex:default',
        queryId: rateLimitQuery,
        reason: 'unknown_rate_limit',
      },
      failover: { attempted: false },
    });
    const persistedCooldown = (manager as any).runtimeLaneCooldowns.get(
      (manager as any).runtimeLaneCooldownKey(teamId, 'codex', 'codex:default'),
    );
    expect(persistedCooldown.coolingUntilMs).toBeGreaterThan(boundedRateLimitBefore);
    expect(persistedCooldown.coolingUntilMs).toBeLessThanOrEqual(
      boundedRateLimitBefore + 8 * 24 * 60 * 60_000 + 1_000,
    );
    expect(persistedCooldown.message).toHaveLength(2_000);
    expect(persistedCooldown.resetText).toHaveLength(500);
    expect(
      (manager as any).runtimeLaneCooldowns.get(
        (manager as any).runtimeLaneCooldownKey(teamId, 'ollama', 'worker-controlled-lane'),
      ),
    ).toBeUndefined();

    expect((await fetch(`${managerUrl}/news`, {
      method: 'POST',
      headers: replyHeaders,
      body: JSON.stringify({
        type: 'reply',
        from: agentId,
        in_reply_to: peerQuery,
        message: 'must not complete peer work',
        skip_persist: true,
      }),
    })).status).toBe(403);
    for (const forbiddenQuery of [managerOwnedQuery, 'managed-auth-missing-query']) {
      expect((await fetch(`${managerUrl}/news`, {
        method: 'POST',
        headers: replyHeaders,
        body: JSON.stringify({
          type: 'reply',
          from: agentId,
          in_reply_to: forbiddenQuery,
          message: 'must have exact durable reply ownership',
          skip_persist: true,
        }),
      })).status).toBe(403);
    }
    expect((await fetch(`${managerUrl}/news`, {
      method: 'POST',
      headers: replyHeaders,
      body: JSON.stringify({
        type: 'reply',
        from: agentId,
        in_reply_to: ownQuery,
        message: 'authenticated worker reply',
        skip_persist: true,
      }),
    })).status).toBe(201);
    const completedOwn = await db.queries.getByQueryIdForTeam(teamId, ownQuery);
    expect(completedOwn?.status).toBe('completed');
    expect(completedOwn?.result).toMatchObject({
      from: 'managed-auth-worker',
      authenticated_agent_id: agentId,
      message: 'authenticated worker reply',
    });
    expect((await fetch(`${managerUrl}/query/${ownQuery}`, {
      headers: agentHeaders,
    })).status).toBe(403);
    expect((await fetch(`${managerUrl}/query/${peerQuery}`, {
      headers: agentHeaders,
    })).status).toBe(403);

    const forgedRetry = 'managed-auth-forged-retry';
    await db.queries.create(
      teamId,
      forgedRetry,
      agentId,
      'retry that points at peer work',
      Date.now(),
      undefined,
      undefined,
      { retry_of: peerQuery },
    );
    expect((await fetch(`${managerUrl}/news`, {
      method: 'POST',
      headers: replyHeaders,
      body: JSON.stringify({
        type: 'reply',
        from: agentId,
        in_reply_to: forgedRetry,
        message: 'must complete only the authenticated retry',
        skip_persist: true,
      }),
    })).status).toBe(201);
    expect((await db.queries.getByQueryIdForTeam(teamId, forgedRetry))?.status).toBe('completed');
    expect((await db.queries.getByQueryIdForTeam(teamId, peerQuery))?.status).toBe('pending');

    const ownedOriginal = 'managed-auth-owned-retry-original';
    const ownedRetry = 'managed-auth-owned-retry';
    await db.queries.create(
      teamId,
      ownedOriginal,
      agentId,
      'owned original',
      Date.now(),
    );
    await db.queries.create(
      teamId,
      ownedRetry,
      agentId,
      'owned retry',
      Date.now(),
      undefined,
      undefined,
      { retry_of: ownedOriginal },
    );
    expect((await fetch(`${managerUrl}/news`, {
      method: 'POST',
      headers: replyHeaders,
      body: JSON.stringify({
        type: 'reply',
        from: agentId,
        in_reply_to: ownedRetry,
        message: 'complete the same-owner original',
        skip_persist: true,
      }),
    })).status).toBe(201);
    expect((await db.queries.getByQueryIdForTeam(teamId, ownedRetry))?.status).toBe('completed');
    expect((await db.queries.getByQueryIdForTeam(teamId, ownedOriginal))?.status).toBe('completed');

    const delegatedTask = await fetch(`${managerUrl}/tasks`, {
      method: 'POST',
      headers: {
        ...agentHeaders,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Managed authenticated delegation',
        name: 'managed-authenticated-delegation',
        from: agentId,
        owner: otherAgentId,
        goal_id: 'goal_managed_auth',
        expected_output: 'A bounded evidence packet',
        acceptance_criteria: 'The packet records the exact authenticated owner',
        validation_path: 'The sender reviews the returned evidence',
        out_of_scope: 'No cross-team or privileged action',
        backlog_policy: 'Optional work remains backlog',
        work_relevance: 'medium - verifies managed delegation',
      }),
    });
    expect(delegatedTask.status).toBe(201);
    expect(await delegatedTask.json()).toMatchObject({
      task_receipt: expect.any(String),
      task: {
        name: 'managed-authenticated-delegation',
        ownerName: 'managed-auth-peer',
        status: 'doing',
        delegationLineage: {
          from_agent_id: agentId,
          to_agent_id: otherAgentId,
          route: 'managed_worker_explicit_same_team_owner',
        },
        lifecycle: {
          claim: '/tasks/managed-authenticated-delegation/claim',
          done: '/tasks/managed-authenticated-delegation/done',
        },
      },
      default_owner_routing: {
        owner: 'managed-auth-peer',
        reason: 'managed_worker_explicit_same_team_owner',
      },
    });

    const stoppedTargetId = 'managed-auth-stopped-target';
    await db.agents.create({
      team_id: teamId,
      id: stoppedTargetId,
      name: 'managed-auth-stopped-target',
      type: 'virtual',
      runtime: 'claude-agent-sdk',
      model: 'external',
      port: 0,
      status: 'stopped',
      created_at: Date.now(),
      metadata: {
        processGeneration: 'stopped-target-generation-must-not-sign',
        processRuntime: 'claude-agent-sdk',
        processRuntimeLane: 'claude-agent-sdk:default',
      },
    } as any);
    const stoppedDelegation = await fetch(`${managerUrl}/tasks`, {
      method: 'POST',
      headers: {
        ...agentHeaders,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Stopped target must not receive a task receipt',
        name: 'stopped-target-no-task-receipt',
        from: agentId,
        owner: stoppedTargetId,
        goal_id: 'goal_managed_auth',
        expected_output: 'A durable task without an active delivery capability',
        acceptance_criteria: 'No target-bound receipt is issued for a stopped target',
        validation_path: 'Inspect the task creation response',
        out_of_scope: 'No target process startup',
        backlog_policy: 'Retain the task for later operator recovery',
        work_relevance: 'medium - verifies stopped target delivery safety',
      }),
    });
    expect(stoppedDelegation.status).toBe(201);
    const stoppedDelegationBody = await stoppedDelegation.json() as Record<string, unknown>;
    expect(stoppedDelegationBody).not.toHaveProperty('task_receipt');
    expect(stoppedDelegationBody).toMatchObject({
      task: {
        name: 'stopped-target-no-task-receipt',
        ownerName: 'managed-auth-stopped-target',
        status: 'doing',
      },
      owner_wake: {
        status: 'skipped',
        reason: 'unsupported_lifecycle',
      },
    });

    const peerClaim = await fetch(
      `${managerUrl}/tasks/managed-authenticated-delegation/claim`,
      {
        method: 'POST',
        headers: {
          'X-Id-Team': TEAM,
          'X-Id-Agent': otherAgentId,
          Authorization: `Bearer ${deriveManagerAgentToken(
            ADMIN_TOKEN,
            teamId,
            otherAgentId,
            'managed-auth-peer-generation',
          )}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ agent_id: otherAgentId }),
      },
    );
    expect(peerClaim.status).toBe(200);
    expect(await peerClaim.json()).toMatchObject({
      ok: true,
      already_claimed: true,
      task: {
        name: 'managed-authenticated-delegation',
        ownerName: 'managed-auth-peer',
        status: 'doing',
      },
    });

    const current = await db.agents.getById(agentId);
    const replacementGeneration = 'managed-auth-worker-replacement';
    await db.agents.updateMetadata(agentId, {
      ...(current?.metadata || {}),
      processGeneration: replacementGeneration,
    });
    (manager as any).ownedAgentProcesses.get(workerPid).processGeneration =
      replacementGeneration;
    expect((await fetch(`${managerUrl}/agents`, {
      headers: agentHeaders,
    })).status).toBe(401);
    expect((await fetch(`${managerUrl}/agents`, {
      headers: {
        ...agentHeaders,
        Authorization: `Bearer ${deriveManagerAgentToken(
          ADMIN_TOKEN,
          teamId,
          agentId,
          replacementGeneration,
        )}`,
      },
    })).status).toBe(200);
  });

  it('revokes an exited child bearer without letting a stale exit revoke its replacement', async () => {
    const teamId = await db.teams.getOrCreateTeamId(TEAM);
    const agentId = 'managed-exit-revocation-worker';
    const agentName = 'managed-exit-revocation';
    const port = 4593;
    await db.agents.create({
      team_id: teamId,
      id: agentId,
      name: agentName,
      type: 'claude',
      runtime: 'codex',
      model: 'gpt-5',
      port,
      status: 'pending',
      created_at: Date.now(),
      metadata: {
        runtime: 'codex',
        runtimeCredentialLane: 'codex:default',
      },
    } as any);

    const oldProc = Object.assign(new EventEmitter(), {
      pid: 45930,
      exitCode: null,
      signalCode: null,
      unref: vi.fn(),
    });
    const replacementProc = Object.assign(new EventEmitter(), {
      pid: 45931,
      exitCode: null,
      signalCode: null,
      unref: vi.fn(),
    });
    const spawnChild = vi.spyOn(manager as any, 'spawnLocalAgentChild')
      .mockReturnValueOnce(oldProc)
      .mockReturnValueOnce(replacementProc);
    const kill = vi.spyOn(manager as any, 'killAgentProcess')
      .mockResolvedValue({ killed: false, pids: [] });
    const readiness = vi.spyOn(manager as any, 'waitForAgentPortToBind')
      .mockResolvedValue({ ok: true });

    try {
      expect((await (manager as any).spawnLocalAgentProcessUnlocked(
        teamId,
        TEAM,
        { id: agentId, name: agentName, port },
      )).success).toBe(true);
      const oldGeneration = String(
        (await db.agents.getById(agentId))?.metadata?.processGeneration,
      );
      const oldToken = String(
        spawnChild.mock.calls[0][2].env.IDACC_MANAGER_AGENT_TOKEN,
      );
      const headersFor = (token: string) => ({
        'X-Id-Team': TEAM,
        'X-Id-Agent': agentId,
        Authorization: `Bearer ${token}`,
      });
      expect((await fetch(`${managerUrl}/agents`, {
        headers: headersFor(oldToken),
      })).status).toBe(200);

      expect((await (manager as any).spawnLocalAgentProcessUnlocked(
        teamId,
        TEAM,
        { id: agentId, name: agentName, port },
      )).success).toBe(true);
      const replacementRow = await db.agents.getById(agentId);
      const replacementGeneration = String(
        replacementRow?.metadata?.processGeneration,
      );
      const replacementToken = String(
        spawnChild.mock.calls[1][2].env.IDACC_MANAGER_AGENT_TOKEN,
      );
      expect(replacementGeneration).not.toBe(oldGeneration);

      oldProc.emit('exit', 1, null);
      await vi.waitFor(async () => {
        const current = await db.agents.getById(agentId);
        expect(current?.metadata?.processGeneration).toBe(replacementGeneration);
        expect(current?.status).toBe('starting');
      });
      expect((await fetch(`${managerUrl}/agents`, {
        headers: headersFor(oldToken),
      })).status).toBe(401);
      expect((await fetch(`${managerUrl}/agents`, {
        headers: headersFor(replacementToken),
      })).status).toBe(200);

      replacementProc.emit('exit', 1, null);
      await vi.waitFor(async () => {
        const exited = await db.agents.getById(agentId);
        expect(exited?.status).toBe('offline');
        expect(exited?.metadata).not.toHaveProperty('processGeneration');
        expect(exited?.metadata).not.toHaveProperty('processRuntime');
        expect(exited?.metadata).not.toHaveProperty('processRuntimeLane');
      });
      expect((await fetch(`${managerUrl}/agents`, {
        headers: headersFor(replacementToken),
      })).status).toBe(401);
    } finally {
      spawnChild.mockRestore();
      kill.mockRestore();
      readiness.mockRestore();
      (manager as any).ownedAgentProcesses.delete(oldProc.pid);
      (manager as any).ownedAgentProcesses.delete(replacementProc.pid);
    }
  });

  it('rejects a forged admin header without the bearer', async () => {
    expect((await relay({ 'X-Id-Admin': '1' })).status).toBe(401);
  });

  it('rejects a wrong bearer and a bearer without the admin header', async () => {
    expect((await relay({ 'X-Id-Admin': '1', Authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await relay({ Authorization: `Bearer ${ADMIN_TOKEN}` })).status).toBe(401);
  });

  it('allows the loopback admin header with the exact bearer', async () => {
    const response = await relay({
      'X-Id-Admin': '1',
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { body?: { ok?: boolean } };
    expect(body.body?.ok).toBe(true);
  });

  it('rejects an unauthenticated managed-mode WebSocket upgrade', async () => {
    expect(await rejectedWebSocket()).toBe(401);
    expect(await rejectedWebSocket({
      headers: { 'X-Id-Admin': '1' },
    })).toBe(401);
    expect(await rejectedWebSocket({
      headers: {
        'X-Id-Admin': '1',
        Authorization: 'Bearer wrong',
      },
    })).toBe(401);
    expect(await rejectedWebSocket({
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    })).toBe(401);
    expect(await rejectedWebSocket(
      {},
      `&apiKey=${encodeURIComponent(ADMIN_TOKEN)}`,
    )).toBe(401);
  });

  it('rejects every browser-origin WebSocket in managed mode', async () => {
    expect(await rejectedWebSocket({
      origin: 'https://hostile.example',
      headers: {
        'X-Id-Admin': '1',
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
    })).toBe(403);
  });

  it('allows a native loopback WebSocket with the exact admin bearer', async () => {
    const { ws, connected } = await openAdminWebSocket();
    expect(await connected).toMatchObject({
      type: 'connected',
      team: TEAM,
    });
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    ws.close();
    await closed;
    await waitForManagerWebSocketClientCount(0);
  });

  it('does not retain a client that disconnects during team lookup', async () => {
    const teams = db.teams as typeof db.teams & {
      getTeamByName: (name: string) => ReturnType<typeof db.teams.getTeamByName>;
    };
    const originalGetTeamByName = teams.getTeamByName;
    let releaseLookup!: () => void;
    let signalLookupStarted!: () => void;
    const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
    const lookupStarted = new Promise<void>((resolve) => { signalLookupStarted = resolve; });
    await waitForManagerWebSocketClientCount(0);

    teams.getTeamByName = async (name: string) => {
      signalLookupStarted();
      await lookupGate;
      return originalGetTeamByName.call(teams, name);
    };

    const serverSocket = new Promise<WebSocket>((resolve) => {
      (manager as unknown as {
        wss: { once: (event: 'connection', listener: (socket: WebSocket) => void) => void };
      }).wss.once('connection', resolve);
    });
    const url = managerUrl.replace(/^http/, 'ws')
      + `/ws?team=${encodeURIComponent(TEAM)}`;
    const ws = new WebSocket(url, {
      headers: {
        'X-Id-Admin': '1',
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('timed out opening lookup-race WebSocket')),
          2_000,
        );
        ws.once('open', () => {
          clearTimeout(timeout);
          resolve();
        });
        ws.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      await lookupStarted;
      const acceptedSocket = await serverSocket;
      const clientClosed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
      const serverClosed = new Promise<void>((resolve) => acceptedSocket.once('close', () => resolve()));
      ws.terminate();
      await Promise.all([clientClosed, serverClosed]);
      releaseLookup();
      await waitForManagerWebSocketClientCount(0);
    } finally {
      releaseLookup();
      teams.getTeamByName = originalGetTeamByName;
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    }
  });

  it('relays only bounded timeline reads and redacts the Brain response', async () => {
    const before = brainRequests.length;
    const response = await relay({
      'X-Id-Admin': '1',
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    }, {
      method: 'GET',
      path: '/timeline?type=control%3Atest&limit=2',
    });
    expect(response.status).toBe(200);
    expect(brainRequests).toHaveLength(before + 1);
    expect(brainRequests.at(-1)).toEqual({
      url: '/timeline?type=control%3Atest&limit=2',
      authorization: 'Bearer brain-agent-compatible',
    });
    const body = await response.json() as {
      body?: { events?: Array<{ data?: Record<string, any> }> };
      noStore?: boolean;
    };
    expect(body.noStore).toBe(true);
    expect(body.body?.events?.[0]?.data).toEqual({
      token: '[redacted]',
      nested: { api_key: '[redacted]', summary: 'visible' },
    });
  });

  it('rejects unbounded or expanded timeline reads before contacting Brain', async () => {
    const headers = {
      'X-Id-Admin': '1',
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    };
    const before = brainRequests.length;
    expect((await relay(headers, { method: 'GET', path: '/timeline' })).status).toBe(400);
    expect((await relay(headers, { method: 'GET', path: '/timeline?limit=101' })).status).toBe(400);
    expect((await relay(headers, { method: 'GET', path: '/timeline?limit=2&include=secrets' })).status).toBe(400);
    expect(brainRequests).toHaveLength(before);
  });

  it('requires the exact admin bearer for model/provider runtime changes and rejects hostile keyEnv', async () => {
    const teamId = await db.teams.getOrCreateTeamId(TEAM);
    const agentId = 'admin-runtime-policy-agent';
    if (!await db.agents.getById(agentId)) {
      await db.agents.create({
        team_id: teamId,
        id: agentId,
        name: 'runtime-policy-agent',
        type: 'claude',
        runtime: 'claude-agent-sdk',
        model: 'claude-haiku-4-5-20251001',
        status: 'stopped',
        created_at: Date.now(),
        metadata: {
          name: 'runtime-policy-agent',
          runtime: 'claude-agent-sdk',
          plugins: [],
        },
      } as any);
    }
    const url = `${managerUrl}/agents/${encodeURIComponent(agentId)}/runtime`;
    const body = JSON.stringify({
      runtime: 'provider:hostile',
      provider: {
        name: 'hostile',
        baseUrl: 'https://attacker.example/v1',
        keyEnv: 'BRAIN_TOKEN',
      },
    });
    const baseHeaders = {
      'content-type': 'application/json',
      'X-Id-Team': TEAM,
    };

    const anonymous = await fetch(url, {
      method: 'POST',
      headers: baseHeaders,
      body,
    });
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: 'authentication_required' });

    const forged = await fetch(url, {
      method: 'POST',
      headers: { ...baseHeaders, 'X-Id-Admin': '1' },
      body,
    });
    expect(forged.status).toBe(401);

    const hostile = await fetch(url, {
      method: 'POST',
      headers: {
        ...baseHeaders,
        'X-Id-Admin': '1',
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body,
    });
    expect(hostile.status).toBe(400);
    expect((await hostile.json() as { error?: string }).error).toMatch(/approved model-provider/i);

    const retained = await db.agents.getById(agentId);
    expect(retained?.runtime).toBe('claude-agent-sdk');
    expect((retained?.metadata as any)?.providerRuntime).toBeUndefined();

    const modelAnonymous = await fetch(
      `${managerUrl}/agents/${encodeURIComponent(agentId)}/model`,
      {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({ model: 'attacker-model' }),
      },
    );
    expect(modelAnonymous.status).toBe(401);
  });

  it('blocks managed metadata and registration forgery while allowing only an attested owned pid publish', async () => {
    const teamId = await db.teams.getOrCreateTeamId(TEAM);
    const agentId = 'managed-metadata-guard-agent';
    const agentName = 'managed-metadata-guard';
    const processGeneration = 'managed-metadata-guard-generation';
    const port = 4520;
    await db.agents.create({
      team_id: teamId,
      id: agentId,
      name: agentName,
      type: 'claude',
      runtime: 'codex',
      model: 'gpt-5',
      port,
      status: 'starting',
      created_at: Date.now(),
      metadata: {
        runtime: 'codex',
        plugins: [],
        managerOwnedLaunchIntent: true,
        processGeneration,
        processRuntime: 'codex',
        processRuntimeLane: 'codex:default',
      },
    } as any);
    const baseHeaders = {
      'content-type': 'application/json',
      'X-Id-Team': TEAM,
    };
    const metadataUrl = `${managerUrl}/agents/${encodeURIComponent(agentId)}/metadata`;
    for (const metadata of [
      { managerOwnedLaunchIntent: true },
      { managerRestartRequested: true },
      { providerRuntime: { lane: 'provider:forged' } },
      { allowed_tools: ['*'] },
      { env: { PATH: '/attacker' } },
      { mcpServers: [{ name: 'forged', command: 'forged' }] },
      { plugins: [{ name: 'forged', path: '/tmp/forged' }] },
      { primaryLead: true },
    ]) {
      const response = await fetch(metadataUrl, {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({ metadata }),
      });
      expect(response.status).toBe(401);
    }

    expect((await fetch(
      `${managerUrl}/agents/by-name/${encodeURIComponent(agentName)}/metadata`,
      {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({ metadata: { primaryLead: true } }),
      },
    )).status).toBe(401);
    expect((await fetch(metadataUrl, {
      method: 'PATCH',
      headers: baseHeaders,
      body: JSON.stringify({ wallet: '0x0000000000000000000000000000000000000001' }),
    })).status).toBe(401);
    expect((await fetch(`${managerUrl}/agents/spawn`, {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({ name: 'forged-spawn' }),
    })).status).toBe(401);
    expect((await fetch(`${managerUrl}/agents/register`, {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        id: agentId,
        name: agentName,
        endpoint: `http://127.0.0.1:${port}`,
        metadata: { managerOwnedLaunchIntent: true },
      }),
    })).status).toBe(401);

    const adminInternal = await fetch(metadataUrl, {
      method: 'POST',
      headers: {
        ...baseHeaders,
        'X-Id-Admin': '1',
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ metadata: { managerRestartRequested: true } }),
    });
    expect(adminInternal.status).toBe(403);

    const pid = 45200;
    const proc = Object.assign(new EventEmitter(), {
      pid,
      exitCode: null,
      signalCode: null,
    });
    (manager as any).ownedAgentProcesses.set(pid, {
      proc,
      agentId,
      agentName,
      port,
      processGeneration,
    });
    const identityProbe = vi.spyOn(manager as any, 'probeLocalAgentIdentity')
      .mockResolvedValue({ ok: true, attested: true });
    try {
      const published = await fetch(metadataUrl, {
        method: 'POST',
        headers: {
          ...baseHeaders,
          'X-Id-Agent': agentId,
          Authorization: `Bearer ${deriveManagerAgentToken(
            ADMIN_TOKEN,
            teamId,
            agentId,
            processGeneration,
          )}`,
        },
        body: JSON.stringify({ metadata: { pid } }),
      });
      expect(published.status).toBe(200);
      expect(identityProbe).toHaveBeenCalledWith(
        port,
        { id: agentId, name: agentName, pid },
        { requireAttestation: true },
      );
    } finally {
      identityProbe.mockRestore();
      (manager as any).ownedAgentProcesses.delete(pid);
    }
    const publishedRow = await db.agents.getById(agentId);
    expect(publishedRow?.status).toBe('running');
    expect(publishedRow?.metadata?.pid).toBe(pid);
  });

  it('rebinds and resumes only a marked provider agent without returning or persisting its inline credential', async () => {
    const teamId = await db.teams.getOrCreateTeamId(TEAM);
    const agentId = 'admin-provider-resume-agent';
    const apiKey = 'inline-provider-secret-never-returned';
    await db.agents.create({
      team_id: teamId,
      id: agentId,
      name: 'provider-resume-agent',
      type: 'claude',
      runtime: 'provider-api',
      model: 'provider-model',
      port: 4521,
      status: 'offline',
      created_at: Date.now(),
      metadata: {
        name: 'provider-resume-agent',
        runtime: 'provider:openrouter',
        providerRuntime: {
          lane: 'provider:openrouter',
          name: 'openrouter',
          kind: 'openai-compatible',
          baseUrl: 'https://openrouter.ai/api/v1',
        },
        plugins: [],
      },
    } as any);

    const url = `${managerUrl}/agents/${encodeURIComponent(agentId)}/runtime`;
    const body = JSON.stringify({
      runtime: 'provider:openrouter',
      provider: {
        name: 'openrouter',
        kind: 'openai-compatible',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey,
      },
      resumeAfterManagerRestart: true,
    });
    const baseHeaders = {
      'content-type': 'application/json',
      'X-Id-Team': TEAM,
    };

    const unmarked = await fetch(url, {
      method: 'POST',
      headers: {
        ...baseHeaders,
        'X-Id-Admin': '1',
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body,
    });
    expect(unmarked.status).toBe(409);
    expect(JSON.stringify(await unmarked.json())).not.toContain(apiKey);

    const initial = await db.agents.getById(agentId);
    await db.agents.updateMetadata(agentId, {
      ...((initial?.metadata as Record<string, unknown>) || {}),
      managerRestartRequested: true,
    });
    const anonymous = await fetch(url, {
      method: 'POST',
      headers: baseHeaders,
      body,
    });
    expect(anonymous.status).toBe(401);
    expect(JSON.stringify(await anonymous.json())).not.toContain(apiKey);

    const verifiedSpawn = vi.spyOn(manager as any, 'spawnLocalAgentProcessUnlocked')
      .mockResolvedValue({ success: true, pid: 45210 });
    try {
      const rebound = await fetch(url, {
        method: 'POST',
        headers: {
          ...baseHeaders,
          'X-Id-Admin': '1',
          Authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        body,
      });
      expect(rebound.status).toBe(200);
      const responseText = await rebound.text();
      expect(responseText).not.toContain(apiKey);
      expect(JSON.parse(responseText)).toMatchObject({
        id: agentId,
        runtime: 'provider:openrouter',
        status: 'running',
        resumed: true,
      });
      expect(verifiedSpawn).toHaveBeenCalledOnce();
    } finally {
      verifiedSpawn.mockRestore();
    }

    const resumed = await db.agents.getById(agentId);
    expect(resumed?.status).toBe('running');
    expect(resumed?.metadata).not.toHaveProperty('managerRestartRequested');
    expect(JSON.stringify(resumed?.metadata)).not.toContain(apiKey);
    expect((resumed?.metadata as any)?.providerRuntime?.keyEnv).toBeUndefined();
  });

  it('serializes two provider rebinds and lets only the first marked request spawn', async () => {
    const teamId = await db.teams.getOrCreateTeamId(TEAM);
    const agentId = 'provider-rebind-serialization-agent';
    await db.agents.create({
      team_id: teamId,
      id: agentId,
      name: 'provider-rebind-serialization',
      type: 'claude',
      runtime: 'provider-api',
      model: 'provider-model',
      port: 4522,
      status: 'offline',
      created_at: Date.now(),
      metadata: {
        runtime: 'provider:openrouter',
        providerRuntime: {
          lane: 'provider:openrouter',
          name: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
        },
        managerOwnedLaunchIntent: true,
        managerRestartRequested: true,
      },
    } as any);
    let releaseSpawn!: () => void;
    let signalSpawnStarted!: () => void;
    const spawnStarted = new Promise<void>((resolve) => { signalSpawnStarted = resolve; });
    const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve; });
    const spawn = vi.spyOn(manager as any, 'spawnLocalAgentProcessUnlocked')
      .mockImplementation(async () => {
        signalSpawnStarted();
        await spawnGate;
        return { success: true, pid: 45220 };
      });
    const url = `${managerUrl}/agents/${encodeURIComponent(agentId)}/runtime`;
    const headers = {
      'content-type': 'application/json',
      'X-Id-Team': TEAM,
      'X-Id-Admin': '1',
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    };
    const firstSecret = 'first-serialized-provider-secret';
    const secondSecret = 'second-serialized-provider-secret';
    try {
      const first = fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          runtime: 'provider:openrouter',
          provider: {
            name: 'openrouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            apiKey: firstSecret,
          },
          resumeAfterManagerRestart: true,
        }),
      });
      await spawnStarted;
      const second = fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          runtime: 'provider:openrouter',
          provider: {
            name: 'openrouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            apiKey: secondSecret,
          },
          resumeAfterManagerRestart: true,
        }),
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(spawn).toHaveBeenCalledTimes(1);
      releaseSpawn();
      const [firstResponse, secondResponse] = await Promise.all([first, second]);
      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(409);
      const responseText = JSON.stringify([
        await firstResponse.json(),
        await secondResponse.json(),
      ]);
      expect(responseText).not.toContain(firstSecret);
      expect(responseText).not.toContain(secondSecret);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      releaseSpawn();
      spawn.mockRestore();
      (manager as any).providerRuntimeAssignments.delete(agentId);
    }
    const row = await db.agents.getById(agentId);
    expect(row?.status).toBe('running');
    expect(row?.metadata?.managerOwnedLaunchIntent).toBe(true);
    expect(row?.metadata).not.toHaveProperty('managerRestartRequested');
  });

  it('serializes provider rebind against a normal runtime mutation without mixed Map/DB state', async () => {
    const teamId = await db.teams.getOrCreateTeamId(TEAM);
    const agentId = 'provider-rebind-runtime-race-agent';
    await db.agents.create({
      team_id: teamId,
      id: agentId,
      name: 'provider-rebind-runtime-race',
      type: 'claude',
      runtime: 'provider-api',
      model: 'provider-model',
      port: 4523,
      status: 'offline',
      created_at: Date.now(),
      metadata: {
        runtime: 'provider:openrouter',
        providerRuntime: {
          lane: 'provider:openrouter',
          name: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
        },
        managerOwnedLaunchIntent: true,
        managerRestartRequested: true,
      },
    } as any);
    let releaseSpawn!: () => void;
    let signalSpawnStarted!: () => void;
    const spawnStarted = new Promise<void>((resolve) => { signalSpawnStarted = resolve; });
    const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve; });
    let stateAtSpawn: { runtime?: string; lane?: string } = {};
    const spawn = vi.spyOn(manager as any, 'spawnLocalAgentProcessUnlocked')
      .mockImplementation(async () => {
        const during = await db.agents.getById(agentId);
        stateAtSpawn = {
          runtime: during?.runtime,
          lane: (manager as any).providerRuntimeAssignments.get(agentId)?.lane,
        };
        signalSpawnStarted();
        await spawnGate;
        return { success: true, pid: 45230 };
      });
    const url = `${managerUrl}/agents/${encodeURIComponent(agentId)}/runtime`;
    const headers = {
      'content-type': 'application/json',
      'X-Id-Team': TEAM,
      'X-Id-Admin': '1',
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    };
    let normalSettled = false;
    try {
      const rebind = fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          runtime: 'provider:openrouter',
          provider: {
            name: 'openrouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            apiKey: 'serialized-runtime-secret',
          },
          resumeAfterManagerRestart: true,
        }),
      });
      await spawnStarted;
      const normal = fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ runtime: 'codex' }),
      }).finally(() => { normalSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(normalSettled).toBe(false);
      expect(stateAtSpawn).toEqual({
        runtime: 'provider-api',
        lane: 'provider:openrouter',
      });
      releaseSpawn();
      const [rebindResponse, normalResponse] = await Promise.all([rebind, normal]);
      expect(rebindResponse.status).toBe(200);
      expect(normalResponse.status).toBe(200);
    } finally {
      releaseSpawn();
      spawn.mockRestore();
      (manager as any).providerRuntimeAssignments.delete(agentId);
    }
    const row = await db.agents.getById(agentId);
    expect(row?.runtime).toBe('codex');
    expect(row?.status).toBe('pending');
    expect((row?.metadata as any)?.providerRuntime).toBeUndefined();
  });

  it('serializes provider rebind against the full refresh-kill-spawn rebuild lifecycle', async () => {
    const teamId = await db.teams.getOrCreateTeamId(TEAM);
    const agentId = 'provider-rebind-rebuild-race-agent';
    await db.agents.create({
      team_id: teamId,
      id: agentId,
      name: 'provider-rebind-rebuild-race',
      type: 'claude',
      runtime: 'provider-api',
      model: 'provider-model',
      port: 4524,
      status: 'offline',
      created_at: Date.now(),
      metadata: {
        runtime: 'provider:openrouter',
        providerRuntime: {
          lane: 'provider:openrouter',
          name: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
        },
        managerOwnedLaunchIntent: true,
        managerRestartRequested: true,
        plugins: [],
      },
    } as any);
    let releaseFirstSpawn!: () => void;
    let signalFirstSpawn!: () => void;
    const firstSpawnStarted = new Promise<void>((resolve) => { signalFirstSpawn = resolve; });
    const firstSpawnGate = new Promise<void>((resolve) => { releaseFirstSpawn = resolve; });
    const order: string[] = [];
    let spawnCount = 0;
    const spawn = vi.spyOn(manager as any, 'spawnLocalAgentProcessUnlocked')
      .mockImplementation(async () => {
        spawnCount += 1;
        if (spawnCount === 1) {
          order.push('rebind-spawn-start');
          signalFirstSpawn();
          await firstSpawnGate;
          order.push('rebind-spawn-end');
          return { success: true, pid: 45240 };
        }
        order.push('rebuild-spawn');
        return { success: true, pid: 45241 };
      });
    const refresh = vi.spyOn(manager as any, 'refreshManagedOverlayForRebuild')
      .mockImplementation(async () => { order.push('rebuild-refresh'); });
    const kill = vi.spyOn(manager as any, 'killAgentProcess')
      .mockResolvedValue({ killed: true, pids: [45240] });
    const cancel = vi.spyOn(manager as any, 'cancelPendingQueriesForAgent')
      .mockResolvedValue(0);
    const headers = {
      'content-type': 'application/json',
      'X-Id-Team': TEAM,
      'X-Id-Admin': '1',
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    };
    try {
      const rebind = fetch(
        `${managerUrl}/agents/${encodeURIComponent(agentId)}/runtime`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            runtime: 'provider:openrouter',
            provider: {
              name: 'openrouter',
              baseUrl: 'https://openrouter.ai/api/v1',
              apiKey: 'serialized-rebuild-secret',
            },
            resumeAfterManagerRestart: true,
          }),
        },
      );
      await firstSpawnStarted;
      const initial = await db.agents.getById(agentId);
      const rebuild = (manager as any).rebuildLocalClaudeAgent(teamId, TEAM, initial);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(refresh).not.toHaveBeenCalled();
      releaseFirstSpawn();
      const [rebindResponse, rebuildResult] = await Promise.all([rebind, rebuild]);
      expect(rebindResponse.status).toBe(200);
      expect(rebuildResult.success).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(order).toEqual([
        'rebind-spawn-start',
        'rebind-spawn-end',
        'rebuild-refresh',
        'rebuild-spawn',
      ]);
    } finally {
      releaseFirstSpawn();
      spawn.mockRestore();
      refresh.mockRestore();
      kill.mockRestore();
      cancel.mockRestore();
      (manager as any).providerRuntimeAssignments.delete(agentId);
    }
  });

  it('serializes provider rebind against a cross-team move under the stable agent lifecycle key', async () => {
    const sourceTeamId = await db.teams.getOrCreateTeamId(TEAM);
    const targetTeamName = 'admin-token-move-target';
    const targetTeamId = await db.teams.getOrCreateTeamId(targetTeamName);
    const agentId = 'provider-rebind-team-move-race-agent';
    const agentName = 'provider-rebind-team-move-race';
    await db.agents.create({
      team_id: sourceTeamId,
      id: agentId,
      name: agentName,
      type: 'claude',
      runtime: 'provider-api',
      model: 'provider-model',
      port: 4525,
      status: 'offline',
      created_at: Date.now(),
      metadata: {
        runtime: 'provider:openrouter',
        providerRuntime: {
          lane: 'provider:openrouter',
          name: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
        },
        managerOwnedLaunchIntent: true,
        managerRestartRequested: true,
        plugins: [],
      },
    } as any);
    let releaseFirstSpawn!: () => void;
    let signalFirstSpawn!: () => void;
    const firstSpawnStarted = new Promise<void>((resolve) => { signalFirstSpawn = resolve; });
    const firstSpawnGate = new Promise<void>((resolve) => { releaseFirstSpawn = resolve; });
    const order: string[] = [];
    let spawnCount = 0;
    const spawn = vi.spyOn(manager as any, 'spawnLocalAgentProcessUnlocked')
      .mockImplementation(async (_teamId: string) => {
        spawnCount += 1;
        if (spawnCount === 1) {
          order.push('rebind-spawn-start');
          signalFirstSpawn();
          await firstSpawnGate;
          order.push('rebind-spawn-end');
          return { success: true, pid: 45250 };
        }
        order.push('move-rebuild-spawn');
        return { success: true, pid: 45251 };
      });
    const refresh = vi.spyOn(manager as any, 'refreshManagedOverlayForRebuild')
      .mockImplementation(async () => { order.push('move-rebuild-refresh'); });
    const kill = vi.spyOn(manager as any, 'killAgentProcess')
      .mockResolvedValue({ killed: true, pids: [45250] });
    const cancel = vi.spyOn(manager as any, 'cancelPendingQueriesForAgent')
      .mockResolvedValue(0);
    const headers = {
      'content-type': 'application/json',
      'X-Id-Team': TEAM,
      'X-Id-Admin': '1',
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    };
    let moveSettled = false;
    try {
      const rebind = fetch(
        `${managerUrl}/agents/${encodeURIComponent(agentId)}/runtime`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            runtime: 'provider:openrouter',
            provider: {
              name: 'openrouter',
              baseUrl: 'https://openrouter.ai/api/v1',
              apiKey: 'serialized-team-move-secret',
            },
            resumeAfterManagerRestart: true,
          }),
        },
      );
      await firstSpawnStarted;
      const move = fetch(
        `${managerUrl}/agents/${encodeURIComponent(agentId)}/team`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ team: targetTeamName }),
        },
      ).finally(() => { moveSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(moveSettled).toBe(false);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(refresh).not.toHaveBeenCalled();

      releaseFirstSpawn();
      const [rebindResponse, moveResponse] = await Promise.all([rebind, move]);
      expect(rebindResponse.status).toBe(200);
      expect(moveResponse.status).toBe(200);
      expect(await moveResponse.json()).toMatchObject({
        ok: true,
        id: agentId,
        from: TEAM,
        team: targetTeamName,
        rebuilt: true,
      });
      expect(order).toEqual([
        'rebind-spawn-start',
        'rebind-spawn-end',
        'move-rebuild-refresh',
        'move-rebuild-spawn',
      ]);
      expect(await db.agents.getByName(sourceTeamId, agentName)).toBeNull();
      expect(await db.agents.getByName(targetTeamId, agentName)).toMatchObject({
        id: agentId,
        team_id: targetTeamId,
        status: 'running',
      });
    } finally {
      releaseFirstSpawn();
      spawn.mockRestore();
      refresh.mockRestore();
      kill.mockRestore();
      cancel.mockRestore();
      (manager as any).providerRuntimeAssignments.delete(agentId);
    }
  });

  it('does not report healthy until the bounded managed restart-marker pass finishes', async () => {
    const previousManaged = process.env.IDACC_MANAGED_SERVICE;
    const previousGrace = process.env.IDACC_MANAGER_RESTART_MARKER_GRACE_MS;
    const readinessDb = await createInMemoryDb();
    const readinessWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idacc-manager-readiness-'));
    const readinessManager = new AgentManagerDb(readinessWorkDir, readinessDb as never);
    const readinessPort = await findFreePort();
    const readinessUrl = `http://127.0.0.1:${readinessPort}/health`;
    process.env.IDACC_MANAGED_SERVICE = '1';
    process.env.IDACC_MANAGER_RESTART_MARKER_GRACE_MS = '120';
    try {
      const starting = readinessManager.start(readinessPort);
      let early: Response | null = null;
      const deadline = Date.now() + 1_000;
      while (!early && Date.now() < deadline) {
        try {
          early = await fetch(readinessUrl);
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(early?.status).toBe(503);
      expect(await early?.json()).toMatchObject({
        status: 'starting',
        ready: false,
      });

      await starting;
      const ready = await fetch(readinessUrl);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toMatchObject({ status: 'ok' });
    } finally {
      await readinessManager.shutdown().catch(() => {});
      await readinessDb.close();
      fs.rmSync(readinessWorkDir, { recursive: true, force: true });
      if (previousManaged === undefined) delete process.env.IDACC_MANAGED_SERVICE;
      else process.env.IDACC_MANAGED_SERVICE = previousManaged;
      if (previousGrace === undefined) delete process.env.IDACC_MANAGER_RESTART_MARKER_GRACE_MS;
      else process.env.IDACC_MANAGER_RESTART_MARKER_GRACE_MS = previousGrace;
    }
  });

  it('does not activate automatic schedule dispatch while verified startup restoration is delayed', async () => {
    const schedulerDb = await createInMemoryDb();
    const schedulerWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idacc-manager-scheduler-gate-'));
    const schedulerManager = new AgentManagerDb(schedulerWorkDir, schedulerDb as never);
    const schedulerPort = await findFreePort();
    let releaseRestore!: () => void;
    let signalRestoreStarted!: () => void;
    const restoreStarted = new Promise<void>((resolve) => { signalRestoreStarted = resolve; });
    const restoreGate = new Promise<void>((resolve) => { releaseRestore = resolve; });
    vi.spyOn(schedulerManager as any, 'restoreManagerOwnedAgentsAtStartup')
      .mockImplementation(async () => {
        signalRestoreStarted();
        await restoreGate;
      });
    try {
      const starting = schedulerManager.start(schedulerPort);
      await restoreStarted;
      const service = (schedulerManager as any).schedulerService;
      expect(service).toBeTruthy();
      expect(service.timer).toBeNull();
      releaseRestore();
      await starting;
      expect(service.timer).toBeTruthy();
    } finally {
      releaseRestore();
      await schedulerManager.shutdown().catch(() => {});
      await schedulerDb.close();
      fs.rmSync(schedulerWorkDir, { recursive: true, force: true });
    }
  });

  it('requires compare-and-delete for control state and preserves newer state on conflict', async () => {
    const headers = {
      'content-type': 'application/json',
      'X-Id-Team': TEAM,
      'X-Id-Admin': '1',
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    };
    const stateUrl = `${managerUrl}/control/state/project/release-readiness`;
    const created = await fetch(stateUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ expected_version: 0, value: { status: 'draft' } }),
    });
    expect(created.status).toBe(200);
    expect(((await created.json()) as any).item.version).toBe(1);

    const updated = await fetch(stateUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ expected_version: 1, value: { status: 'ready' } }),
    });
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as any).item.version).toBe(2);

    expect((await fetch(stateUrl, { method: 'DELETE', headers })).status).toBe(400);
    const stale = await fetch(`${stateUrl}?expected_version=1`, { method: 'DELETE', headers });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: 'control_state_version_conflict',
      expected_version: 1,
      current_version: 2,
    });
    const retained = await fetch(stateUrl, { headers });
    expect(retained.status).toBe(200);
    expect(await retained.json()).toMatchObject({
      item: { version: 2, value: { status: 'ready' } },
    });

    const removed = await fetch(stateUrl, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ expected_version: 2 }),
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true, deleted: true });
  });
});
