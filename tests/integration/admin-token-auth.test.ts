// SPDX-License-Identifier: MIT

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
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

const ADMIN_TOKEN = 'integration-admin-session-token';
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
  let previousBrainUrl: string | undefined;
  let previousBrainToken: string | undefined;
  const brainRequests: Array<{ url: string; authorization: string }> = [];

  beforeAll(async () => {
    previousAdminToken = process.env.IDACC_ADMIN_TOKEN;
    previousBrainUrl = process.env.BRAIN_URL;
    previousBrainToken = process.env.BRAIN_TOKEN;
    process.env.IDACC_ADMIN_TOKEN = ADMIN_TOKEN;
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
    const inherited = spawnSync(process.execPath, ['-e', `
      process.stdout.write(JSON.stringify({
        admin: process.env.IDACC_ADMIN_TOKEN || null,
        brain: process.env.BRAIN_TOKEN || null,
      }));
    `], { env: process.env, encoding: 'utf8' });
    expect(JSON.parse(inherited.stdout)).toEqual({
      admin: null,
      brain: 'brain-agent-compatible',
    });
    await manager.start(managerPort);
    await db.teams.getOrCreateTeamId(TEAM);
  }, 30_000);

  afterAll(async () => {
    if (manager) await stopManager(manager);
    if (brainServer) await new Promise<void>((resolve) => brainServer.close(() => resolve()));
    if (db) await db.close();
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
    if (previousAdminToken === undefined) delete process.env.IDACC_ADMIN_TOKEN;
    else process.env.IDACC_ADMIN_TOKEN = previousAdminToken;
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

  it('rejects a forged admin header without the bearer', async () => {
    expect((await relay({ 'X-Id-Admin': '1' })).status).toBe(403);
  });

  it('rejects a wrong bearer and a bearer without the admin header', async () => {
    expect((await relay({ 'X-Id-Admin': '1', Authorization: 'Bearer wrong' })).status).toBe(403);
    expect((await relay({ Authorization: `Bearer ${ADMIN_TOKEN}` })).status).toBe(403);
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
