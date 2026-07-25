// SPDX-License-Identifier: MIT

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
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

  beforeAll(async () => {
    previousAdminToken = process.env.IDACC_ADMIN_TOKEN;
    previousBrainUrl = process.env.BRAIN_URL;
    previousBrainToken = process.env.BRAIN_TOKEN;
    process.env.IDACC_ADMIN_TOKEN = ADMIN_TOKEN;
    process.env.BRAIN_TOKEN = 'brain-agent-compatible';

    const brainPort = await findFreePort();
    process.env.BRAIN_URL = `http://127.0.0.1:${brainPort}`;
    brainServer = http.createServer((req, res) => {
      if (req.url !== '/health') {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, nodes: 0, edges: 0 }));
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

  async function relay(headers: Record<string, string>): Promise<Response> {
    return fetch(`${managerUrl}/control/brain`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Id-Team': TEAM,
        ...headers,
      },
      body: JSON.stringify({ method: 'GET', path: '/health' }),
    });
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
});
