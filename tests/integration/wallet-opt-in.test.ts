// SPDX-License-Identifier: MIT
//
// Wallet opt-in behavior after the ID Chain removal: provisioning is driven
// entirely by manager-join (POST /agents/register) and the on-demand
// `/agent <name> wallet provision` command. Also pins down that the removed
// onchain/registry surfaces are really gone (404s / unknown command).

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

describe('wallet opt-in manager integration', () => {
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let manager: AgentManagerDb;
  let workDir: string;
  let baseUrl: string;
  let port: number;

  beforeEach(async () => {
    port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-wallet-int-'));
    db = await createInMemoryDb();

    const deliverFn: DeliverFn = async () => ({ ok: true });

    manager = new AgentManagerDb(workDir, db as any, { deliverFn });
    await manager.start(port);
    await db.teams.getOrCreateTeamId('public');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 1000);
    });
    await db.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  async function registerRemoteAgent(name: string, opts?: { wallet?: boolean }) {
    const resp = await fetch(`${baseUrl}/agents/register`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({
        name,
        runtime: 'public-agent-remote',
        customer_domain: `${name}.example.com`,
        public_endpoint_url: `https://${name}.example.com`,
        ...(opts && Object.prototype.hasOwnProperty.call(opts, 'wallet') ? { wallet: opts.wallet } : {}),
      }),
    });
    expect(resp.status).toBe(201);
    return resp.json() as Promise<{ id: string; name: string }>;
  }

  it('does not provision remote wallets at manager-join when wallet is not enabled', async () => {
    const getOrCreate = vi.fn(() => ({ walletName: 'public-walletless-remote', address: '0x1111' }));
    (manager as any).getOrCreateAgentWallet = getOrCreate;

    const agent = await registerRemoteAgent('walletless-remote');
    expect(getOrCreate).not.toHaveBeenCalled();

    const detailResp = await fetch(`${baseUrl}/agents/${agent.id}`, {
      headers: adminHeaders('public'),
    });
    const detail = await detailResp.json() as any;
    expect(detail.metadata?.wallet).toBe(false);
    expect(detail.metadata?.ows_wallet).toBeUndefined();
    expect(detail.metadata?.ows_address).toBeUndefined();
  });

  it('provisions remote wallets at manager-join when wallet is enabled', async () => {
    const getOrCreate = vi.fn(() => ({ walletName: 'public-wallet-enabled-remote', address: '0x2222' }));
    (manager as any).getOrCreateAgentWallet = getOrCreate;

    const agent = await registerRemoteAgent('wallet-enabled-remote', { wallet: true });
    expect(getOrCreate).toHaveBeenCalledWith('public', 'wallet-enabled-remote');
    expect(getOrCreate).toHaveBeenCalledTimes(1);

    const detailResp = await fetch(`${baseUrl}/agents/${agent.id}`, {
      headers: adminHeaders('public'),
    });
    const detail = await detailResp.json() as any;
    expect(detail.metadata?.wallet).toBe(true);
    expect(detail.metadata?.ows_wallet).toBe('public-wallet-enabled-remote');
    expect(detail.metadata?.ows_address).toBe('0x2222');
  });

  it('provisions wallets on demand through the /remote /agent command surface', async () => {
    const agent = await registerRemoteAgent('wallet-command-remote');
    const getOrCreate = vi.fn(() => ({ walletName: 'public-wallet-command-remote', address: '0x3333' }));
    (manager as any).getOrCreateAgentWallet = getOrCreate;

    const remoteResp = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({ command: '/agent wallet-command-remote wallet provision' }),
    });
    expect(remoteResp.ok).toBe(true);
    const remoteBody = await remoteResp.json() as any;
    expect(remoteBody.ok).toBe(true);
    expect(remoteBody.result.status).toBe('provisioned');
    expect(remoteBody.result.ows_wallet).toBe('public-wallet-command-remote');
    expect(getOrCreate).toHaveBeenCalledWith('public', 'wallet-command-remote');

    const againResp = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({ command: '/agent wallet-command-remote wallet provision' }),
    });
    const againBody = await againResp.json() as any;
    expect(againBody.result.status).toBe('already-provisioned');

    const detailResp = await fetch(`${baseUrl}/agents/${agent.id}`, {
      headers: adminHeaders('public'),
    });
    const detail = await detailResp.json() as any;
    expect(detail.metadata?.wallet).toBe(true);
    expect(detail.metadata?.ows_wallet).toBe('public-wallet-command-remote');
    expect(detail.metadata?.ows_address).toBe('0x3333');
  });

  describe('removed onchain/registry surfaces', () => {
    it.each([
      ['POST', '/agents/some-id/onchain/register'],
      ['POST', '/agents/some-id/onchain/redeliver-identity'],
      ['POST', '/agents/by-name/some-name/onchain/register'],
      ['GET', '/registry/default'],
      ['POST', '/registry/default'],
      ['GET', '/registry/registrar'],
      ['POST', '/registry/registrar'],
      ['POST', '/registry/push'],
      ['POST', '/registry/pull'],
    ])('%s %s returns 404', async (method, route) => {
      const resp = await fetch(`${baseUrl}${route}`, {
        method,
        headers: adminHeaders('public'),
        ...(method === 'POST' ? { body: JSON.stringify({}) } : {}),
      });
      expect(resp.status).toBe(404);
    });

    it.each([
      '/register some-agent',
      '/sync-wallets',
      '/registry',
      '/registry push',
    ])('remote command "%s" gets the normal unknown-command response', async (command) => {
      const resp = await fetch(`${baseUrl}/remote`, {
        method: 'POST',
        headers: adminHeaders('public'),
        body: JSON.stringify({ command }),
      });
      const body = await resp.json() as any;
      expect(body.ok).toBe(false);
      expect(String(body.error)).toMatch(/Unknown command/);
      // The advertised command list must no longer mention the removed commands.
      const advertised = String(body.error).split('Available:')[1] ?? '';
      expect(advertised).not.toMatch(/\bregister\b|\bregistry\b|\bsync-wallets\b/);
    });

    it('does not expose removed registry configuration through /projects compatibility output', async () => {
      const resp = await fetch(`${baseUrl}/projects`, {
        headers: adminHeaders('public'),
      });
      expect(resp.ok).toBe(true);
      const body = await resp.json() as { projects: Array<Record<string, unknown>> };
      const publicProject = body.projects.find(project => project.name === 'public');
      expect(publicProject).toBeDefined();
      expect(publicProject).not.toHaveProperty('registry');
    });
  });
});
