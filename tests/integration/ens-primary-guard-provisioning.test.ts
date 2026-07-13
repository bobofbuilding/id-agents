// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { AgentManagerDb } from '../../src/agent-manager-db.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteNewsRepo } from '../../src/db/repos/sqlite/news-repo.js';
import { SqliteSchedulesRepo } from '../../src/db/repos/sqlite/schedules-repo.js';
import { SqliteTasksRepo } from '../../src/db/repos/sqlite/tasks-repo.js';
import type { DeliverFn } from '../../src/lib/ssh-deliver.js';
import type { IdChainRegisterResult } from '../../src/onchain/idchain-register.js';
import type { PrimaryNameReceipt } from '../../src/onchain/ens-primary-guard.js';

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

describe('ENS primary-naming guard: agent provisioning wiring', () => {
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let manager: AgentManagerDb;
  let workDir: string;
  let baseUrl: string;
  let port: number;
  let gateCalls: Array<{ domain: string; walletAddress: string | null | undefined }>;
  let gateResult: PrimaryNameReceipt;

  beforeEach(async () => {
    port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-ens-guard-int-'));
    db = await createInMemoryDb();
    gateCalls = [];

    const deliverFn: DeliverFn = async () => ({ ok: true });
    const registerOnIdChainFn = async (opts: {
      sublabel?: string;
    }): Promise<IdChainRegisterResult> => ({
      domain: `${opts.sublabel || 'agent'}.ens-guard-test.xid.eth`,
      label: 'agent-ens-guard-test',
      txHash: `0x${'ab'.repeat(32)}`,
      chainId: 8453,
      chain: 'Base',
    });

    const evaluatePrimaryNameGateFn = async (opts: {
      domain: string;
      walletAddress: string | null | undefined;
    }): Promise<PrimaryNameReceipt> => {
      gateCalls.push(opts);
      return gateResult;
    };

    manager = new AgentManagerDb(workDir, db as any, {
      deliverFn,
      registerOnIdChainFn: registerOnIdChainFn as any,
      evaluatePrimaryNameGateFn: evaluatePrimaryNameGateFn as any,
    });
    await manager.start(port);
    await db.teams.getOrCreateTeamId('public');
    process.env.PRIVATE_KEY = '0x' + 'aa'.repeat(32);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.PRIVATE_KEY;
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 1000);
    });
    await db.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  async function registerRemoteAgent(name: string) {
    const resp = await fetch(`${baseUrl}/agents/register`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({
        name,
        runtime: 'public-agent-remote',
        customer_domain: `${name}.example.com`,
        public_endpoint_url: `https://${name}.example.com`,
      }),
    });
    expect(resp.status).toBe(201);
    return resp.json() as Promise<{ id: string; name: string }>;
  }

  it('persists a blocked receipt and never marks identity_primary_status verified without a wallet', async () => {
    gateResult = {
      domain: 'placeholder',
      walletAddress: '',
      status: 'blocked',
      forwardVerified: false,
      reverseVerified: false,
      spendCapWei: null,
      reason: 'no-wallet: agent has no OWS wallet address, forward/reverse records cannot be attributed to it',
      checkedAt: new Date().toISOString(),
    };

    const agent = await registerRemoteAgent('guard-blocked-remote');
    const regResp = await fetch(`${baseUrl}/agents/${agent.id}/onchain/register`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({}),
    });
    expect(regResp.ok).toBe(true);
    expect(gateCalls.length).toBe(1);
    expect(gateCalls[0].domain).toBe('guard-blocked-remote.ens-guard-test.xid.eth');

    const detailResp = await fetch(`${baseUrl}/agents/${agent.id}`, { headers: adminHeaders('public') });
    const detail = await detailResp.json() as any;
    expect(detail.metadata?.identity_primary_status).toBe('blocked');
    expect(detail.metadata?.identity_primary_receipt?.reason).toMatch(/no-wallet/);
  });

  it('propagates a pending receipt (forward-only proof) into agent metadata as the durable queued state', async () => {
    gateResult = {
      domain: 'placeholder',
      walletAddress: '0x2222',
      status: 'pending',
      forwardVerified: true,
      reverseVerified: false,
      spendCapWei: null,
      reason: 'no-reverse-registrar-tooling: id-cli exposes no set-primary-name/reverse-record command',
      checkedAt: new Date().toISOString(),
    };

    const agent = await registerRemoteAgent('guard-pending-remote');
    const regResp = await fetch(`${baseUrl}/agents/${agent.id}/onchain/register`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({}),
    });
    expect(regResp.ok).toBe(true);

    const detailResp = await fetch(`${baseUrl}/agents/${agent.id}`, { headers: adminHeaders('public') });
    const detail = await detailResp.json() as any;
    expect(detail.metadata?.identity_primary_status).toBe('pending');
    expect(detail.metadata?.identity_primary_receipt?.forwardVerified).toBe(true);
    expect(detail.metadata?.identity_primary_receipt?.reverseVerified).toBe(false);
  });

  it('only reaches verified when the gate itself says so, and that decision is persisted as-is', async () => {
    gateResult = {
      domain: 'placeholder',
      walletAddress: '0x3333',
      status: 'verified',
      forwardVerified: true,
      reverseVerified: true,
      spendCapWei: '1000000000000000',
      reason: 'forward and reverse records verified within configured spend cap',
      checkedAt: new Date().toISOString(),
    };

    const agent = await registerRemoteAgent('guard-verified-remote');
    const regResp = await fetch(`${baseUrl}/agents/${agent.id}/onchain/register`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({}),
    });
    expect(regResp.ok).toBe(true);

    const detailResp = await fetch(`${baseUrl}/agents/${agent.id}`, { headers: adminHeaders('public') });
    const detail = await detailResp.json() as any;
    expect(detail.metadata?.identity_primary_status).toBe('verified');
    expect(detail.metadata?.identity_primary_receipt?.spendCapWei).toBe('1000000000000000');
  });
});
