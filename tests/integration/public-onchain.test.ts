// SPDX-License-Identifier: MIT
/**
 * Public Onchain Integration Tests — Phase 4
 *
 * Tests the daemon-side on-chain registration routes: identity file staging,
 * SSH delivery, SSH failure non-fatal behavior, and security metadata flags.
 * (CLI-side onchain commands were removed; the daemon routes remain for
 * legacy API compatibility until the daemon-side removal commit. Team
 * boundary and response-redaction coverage moved to mesh-membership and
 * response-redaction suites.)
 *
 * Strategy:
 *   - In-process manager with in-memory SQLite.
 *   - Inject stub SSH delivery function and stub registerOnIdChain function.
 *   - Tiny http.createServer stands in for the remote VPS well-known endpoint.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { AgentManagerDb } from '../../src/agent-manager-db.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteNewsRepo } from '../../src/db/repos/sqlite/news-repo.js';
import { SqliteSchedulesRepo } from '../../src/db/repos/sqlite/schedules-repo.js';
import { SqliteTasksRepo } from '../../src/db/repos/sqlite/tasks-repo.js';
import type { DeliverFn, DeliverResult } from '../../src/lib/ssh-deliver.js';
import type { IdChainRegisterResult } from '../../src/onchain/idchain-register.js';
import { addPublicAgent } from '../../src/cli/public-commands.js';

// ─── DB factory (in-memory) ──────────────────────────────────────────────────

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

// ─── Port helper ─────────────────────────────────────────────────────────────

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

// ─── Admin headers ───────────────────────────────────────────────────────────

function adminHeaders(team: string, extra?: Record<string, string>): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Id-Team': team,
    'X-Id-Admin': '1',
    ...extra,
  };
}

// ─── Mock well-known server ───────────────────────────────────────────────────

function validWellKnown(domain: string, sshTarget?: string): string {
  return JSON.stringify({
    service_type: 'public-agent',
    version: '1.0.0',
    name: domain.split('.')[0],
    endpoints: {
      talk: `https://${domain}/talk`,
      health: `https://${domain}/health`,
    },
    public_url: `https://${domain}`,
    capabilities: ['talk', 'health'],
  });
}

// ─── Stub factories ───────────────────────────────────────────────────────────

interface DeliverCall {
  sshTarget: string;
  localPath: string;
  remotePath: string;
}

function makeDeliverStub(result: DeliverResult): { fn: DeliverFn; calls: DeliverCall[] } {
  const calls: DeliverCall[] = [];
  const fn: DeliverFn = async (sshTarget, localPath, remotePath) => {
    calls.push({ sshTarget, localPath, remotePath });
    return result;
  };
  return { fn, calls };
}

/** Counter so each test gets a unique ENS domain name */
let registerCallCount = 0;

function makeRegisterStub(): {
  fn: typeof import('../../src/onchain/idchain-register.js').registerOnIdChain;
  calls: Array<{ sublabel?: string }>;
} {
  const calls: Array<{ sublabel?: string }> = [];
  const fn = async (opts: {
    sublabel?: string;
    textRecords?: Record<string, string>;
    privateKey?: string;
    wallet?: string;
  }): Promise<IdChainRegisterResult> => {
    calls.push({ sublabel: opts.sublabel });
    registerCallCount += 1;
    const label = `agent-${registerCallCount}`;
    return {
      domain: `${opts.sublabel || label}.test.xid.eth`,
      label,
      txHash: `0x${'ab'.repeat(32)}${String(registerCallCount).padStart(4, '0')}`,
      chainId: 8453,
      chain: 'Base',
    };
  };
  return { fn: fn as any, calls };
}

// ─── Global test state ────────────────────────────────────────────────────────

let mockWkPort: number;
let mockWkServer: http.Server;
let mockWkDomain: string = 'test-onchain.example.com';

let managerPort: number;
let managerBaseUrl: string;
let workDir: string;

// Per-test we create a fresh manager with fresh stubs.
let manager: AgentManagerDb | null = null;
let deliverStub: ReturnType<typeof makeDeliverStub>;
let registerStub: ReturnType<typeof makeRegisterStub>;
let db: Awaited<ReturnType<typeof createInMemoryDb>>;

// Custom fetch that rewrites external URLs to our mock well-known server
let customFetch: typeof globalThis.fetch;
let deps: { managerBaseUrl: string; fetch: typeof globalThis.fetch };

// ─── beforeAll ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Start mock well-known server
  mockWkPort = await findFreePort();
  mockWkServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(validWellKnown(mockWkDomain));
  });
  await new Promise<void>((resolve) => mockWkServer.listen(mockWkPort, '127.0.0.1', resolve));

  managerPort = await findFreePort();
  managerBaseUrl = `http://127.0.0.1:${managerPort}`;
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-onchain-test-'));

  // Set a dummy PRIVATE_KEY so the manager's registration path doesn't throw.
  // The stub intercepts before id-cli is actually called.
  process.env.PRIVATE_KEY = '0x' + 'aa'.repeat(32);

  // Build custom fetch
  const nodeFetch = (await import('node-fetch')).default;
  customFetch = (input: any, init?: any) => {
    let url: string = typeof input === 'string' ? input : (input as any).url ?? String(input);
    if (!url.startsWith('http://127.0.0.1') && !url.startsWith('http://localhost')) {
      url = url.replace(/^https?:\/\/[^/]+/, `http://127.0.0.1:${mockWkPort}`);
    }
    return nodeFetch(url, init) as any;
  };

  deps = { managerBaseUrl, fetch: customFetch };

  // Create initial manager (fresh stubs per test via beforeEach)
  deliverStub = makeDeliverStub({ ok: true });
  registerStub = makeRegisterStub();
  db = await createInMemoryDb();
  manager = new AgentManagerDb(workDir, db as any, {
    deliverFn: deliverStub.fn,
    registerOnIdChainFn: registerStub.fn,
  });
  await manager.start(managerPort);
  await db.teams.getOrCreateTeamId('public');
  await db.teams.getOrCreateTeamId('idchain');
}, 30000);

afterAll(async () => {
  if (manager) {
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 1000);
    });
  }
  await new Promise<void>((resolve, reject) =>
    mockWkServer.close((err) => (err ? reject(err) : resolve())),
  );
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.PRIVATE_KEY;
});

// ─── Helper: register a fresh public agent and return id ─────────────────────

async function registerFreshAgent(domainSuffix: string, opts?: {
  sshTarget?: string;
}): Promise<{ id: string; domain: string; name: string }> {
  const domain = `${domainSuffix}-${Date.now()}.example.com`;
  mockWkDomain = domain;
  const result = await addPublicAgent(domain, { sshTarget: opts?.sshTarget ?? null }, deps);
  if (!result.ok) throw new Error(`Failed to register agent: ${result.error}`);

  // Fetch ID from manager
  const listResp = await customFetch(`${managerBaseUrl}/agents`, {
    headers: adminHeaders('public'),
  }) as any;
  const listBody = await listResp.json() as any;
  const agent = listBody.agents.find((a: any) => a.customer_domain === domain);
  if (!agent) throw new Error(`Agent not found in list after registration`);
  return { id: agent.id, domain, name: agent.name };
}

// ─── 2. Identity file schema ──────────────────────────────────────────────────

describe('2. Identity file schema', () => {
  it('staged identity.json has the correct keys and ISO-8601 registered_at', async () => {
    const domain = `schema-test-${Date.now()}.example.com`;
    mockWkDomain = domain;
    const { id: agentId } = await registerFreshAgent(`schema-test-${Date.now()}`);

    // Trigger on-chain registration
    const regResp = await customFetch(`${managerBaseUrl}/agents/${agentId}/onchain/register`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({}),
    }) as any;
    expect(regResp.ok).toBe(true);

    const stagingDir = path.join(workDir, 'public-agents', agentId, 'staging');
    const identityPath = path.join(stagingDir, 'identity.json');
    expect(fs.existsSync(identityPath)).toBe(true);

    const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
    expect(typeof identity.name).toBe('string');
    expect(typeof identity.ows_address).toBe('string');
    expect(typeof identity.idchain_domain).toBe('string');
    expect(typeof identity.token_id).toBe('string');
    expect(typeof identity.service_endpoint).toBe('string');
    expect(typeof identity.registered_at).toBe('string');

    // ISO-8601 check
    const parsedDate = new Date(identity.registered_at);
    expect(parsedDate.toISOString()).toBe(identity.registered_at);
    expect(parsedDate.getFullYear()).toBeGreaterThanOrEqual(2025);
  });
});

// ─── 5. SSH delivery failure — non-fatal ─────────────────────────────────────

describe('5. SSH delivery failure — non-fatal', () => {
  let failManagerPort: number;
  let failManager: AgentManagerDb;
  let failDb: Awaited<ReturnType<typeof createInMemoryDb>>;
  let failDeliverStub: ReturnType<typeof makeDeliverStub>;
  let failRegisterStub: ReturnType<typeof makeRegisterStub>;
  let failWorkDir: string;
  let failBaseUrl: string;

  beforeAll(async () => {
    failManagerPort = await findFreePort();
    failWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-onchain-fail-'));
    failBaseUrl = `http://127.0.0.1:${failManagerPort}`;

    failDeliverStub = makeDeliverStub({ ok: false, error: 'mock_scp_failed', stderr: 'Connection refused' });
    failRegisterStub = makeRegisterStub();
    failDb = await createInMemoryDb();
    failManager = new AgentManagerDb(failWorkDir, failDb as any, {
      deliverFn: failDeliverStub.fn,
      registerOnIdChainFn: failRegisterStub.fn,
    });
    await failManager.start(failManagerPort);
    await failDb.teams.getOrCreateTeamId('public');
  }, 30000);

  afterAll(async () => {
    if (failManager) {
      await new Promise<void>((resolve) => {
        (failManager as any).httpServer?.close(() => resolve());
        setTimeout(resolve, 1000);
      });
    }
    try { fs.rmSync(failWorkDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('on-chain registration succeeds even when SSH delivery fails', async () => {
    const domain = `ssh-fail-${Date.now()}.example.com`;
    mockWkDomain = domain;

    // Register agent in fail manager
    const regResp = await customFetch(`${failBaseUrl}/agents/register`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({
        name: `ssh-fail-${Date.now()}`,
        runtime: 'public-agent-remote',
        customer_domain: domain,
        public_endpoint_url: `https://${domain}`,
        ssh_target: 'deploy@unreachable.example.com',
      }),
    }) as any;
    expect(regResp.status).toBe(201);
    const regBody = await regResp.json() as any;
    const agentId = regBody.id;

    // Trigger on-chain registration — should succeed despite SSH failure
    const onchainResp = await customFetch(`${failBaseUrl}/agents/${agentId}/onchain/register`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({}),
    }) as any;
    expect(onchainResp.ok).toBe(true);
    const onchainBody = await onchainResp.json() as any;
    expect(onchainBody.ok).toBe(true);

    // Agent still has idchain_domain
    const agentResp = await customFetch(`${failBaseUrl}/agents/${agentId}`, {
      headers: adminHeaders('public'),
    }) as any;
    const agentBody = await agentResp.json() as any;
    expect((agentBody.metadata as any)?.idchain_domain).toBeTruthy();

    // Identity file is staged locally
    const stagingPath = path.join(failWorkDir, 'public-agents', agentId, 'staging', 'identity.json');
    expect(fs.existsSync(stagingPath)).toBe(true);

    // SSH delivery was attempted
    expect(failDeliverStub.calls.length).toBeGreaterThan(0);
    expect(failDeliverStub.calls[0].sshTarget).toBe('deploy@unreachable.example.com');
  });
});

// ─── 8. Mesh flags on registered agent ───────────────────────────────────────

describe('8. Mesh flags on registered public-agent-remote', () => {
  it('metadata has exactly the six Phase 4 security flags', async () => {
    const domain = `flags-test-${Date.now()}.example.com`;
    mockWkDomain = domain;
    const { id: agentId } = await registerFreshAgent(`flags-${Date.now()}`);

    // Trigger on-chain registration
    const regResp = await customFetch(`${managerBaseUrl}/agents/${agentId}/onchain/register`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({}),
    }) as any;
    expect(regResp.ok).toBe(true);

    const agentResp = await customFetch(`${managerBaseUrl}/agents/${agentId}`, {
      headers: adminHeaders('public'),
    }) as any;
    const body = await agentResp.json() as any;
    const meta = body.metadata as any;

    expect(meta.mesh_member).toBe(false);
    expect(meta.mesh_reachable).toBe(false);
    expect(meta.public_endpoint).toBe(true);
    expect(meta.dmz).toBe(true);
    expect(meta.allowed_inbound).toEqual(['public_http']);
    expect(meta.allowed_outbound).toEqual(['openrouter']);
  });
});
