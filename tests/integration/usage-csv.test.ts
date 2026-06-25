// SPDX-License-Identifier: MIT

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import { AgentManagerDb } from '../../src/agent-manager-db.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteNewsRepo } from '../../src/db/repos/sqlite/news-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteSchedulesRepo } from '../../src/db/repos/sqlite/schedules-repo.js';
import { SqliteTasksRepo } from '../../src/db/repos/sqlite/tasks-repo.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';

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
  await new Promise<void>(resolve => {
    (manager as any).httpServer?.close(() => resolve());
    setTimeout(resolve, 500);
  });
}

function adminHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Id-Team': 'default',
    'X-Id-Admin': '1',
  };
}

describe('usage CSV exports', () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let baseUrl: string;
  let workDir: string;

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-csv-test-'));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);
  }, 15000);

  afterAll(async () => {
    if (manager) await stopManager(manager);
    if (db) await db.close();
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('exports aggregate usage as CSV without changing JSON behavior', async () => {
    const recorded = await fetch(`${baseUrl}/usage/record`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({
        runtime: 'codex',
        model: 'gpt-test',
        agent: 'csv-agent',
        team: 'default',
        input: 10,
        output: 5,
        genMs: 1000,
        tps: 5,
      }),
    });
    expect(recorded.status).toBe(200);

    const json = await fetch(`${baseUrl}/usage`, { headers: adminHeaders() });
    expect(json.headers.get('content-type')).toContain('application/json');
    const jsonBody = await json.json() as { day: { total: number } };
    expect(jsonBody.day.total).toBe(15);

    const csv = await fetch(`${baseUrl}/usage?format=csv`, { headers: adminHeaders() });
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.headers.get('content-disposition')).toContain('usage.csv');
    const text = await csv.text();
    expect(text).toContain('window,kind,key,count,input,output,total,avg_per_query,avg_tps,generated_at');
    expect(text).toContain('day,summary,all,1,10,5,15,15,5');
    expect(text).toContain('day,agent,csv-agent,1,10,5,15,,5');
    expect(text).toContain('day,model,gpt-test,1,10,5,15,,5');
  });

  it('exports per-task usage as CSV', async () => {
    const csv = await fetch(`${baseUrl}/usage/by-task?format=csv`, {
      headers: adminHeaders(),
    });
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.headers.get('content-disposition')).toContain('usage-by-task.csv');
    expect(await csv.text()).toBe('empty\n');
  });
});
