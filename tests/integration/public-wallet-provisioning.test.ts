// SPDX-License-Identifier: MIT
//
// Commit-1 (remove-idchain) coverage: OWS wallet provisioning for
// public-agent-remote rows is triggered by manager-join (POST /agents/register),
// not by onchain registration. Verifies:
//   - wallet-disabled join never invokes OWS
//   - wallet-enabled join provisions, persists, and returns metadata in the 201
//   - DMZ/mesh security flags are stamped immediately at manager-join
//   - wallet identity delivery (staging + SCP) carries no onchain fields
//   - OWS and SSH failures are non-fatal
//   - the on-demand `/agent <name> wallet provision` path also delivers

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

const DMZ_FLAGS = {
  mesh_member: false,
  mesh_reachable: false,
  public_endpoint: true,
  dmz: true,
  allowed_inbound: ['public_http'],
  allowed_outbound: ['openrouter'],
};

describe('public-agent-remote wallet provisioning at manager-join', () => {
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let manager: AgentManagerDb;
  let workDir: string;
  let baseUrl: string;
  let port: number;
  let deliverCalls: Array<{ sshTarget: string; localPath: string; remotePath: string }>;
  let deliverResult: { ok: boolean; error?: string };

  beforeEach(async () => {
    port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-pub-wallet-'));
    db = await createInMemoryDb();
    deliverCalls = [];
    deliverResult = { ok: true };

    const deliverFn: DeliverFn = async (sshTarget, localPath, remotePath) => {
      deliverCalls.push({ sshTarget, localPath, remotePath });
      return deliverResult;
    };

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

  async function joinRemoteAgent(name: string, extra: Record<string, unknown> = {}) {
    const resp = await fetch(`${baseUrl}/agents/register`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({
        name,
        runtime: 'public-agent-remote',
        customer_domain: `${name}.example.com`,
        public_endpoint_url: `https://${name}.example.com`,
        ...extra,
      }),
    });
    return { status: resp.status, body: await resp.json() as any };
  }

  async function agentDetail(id: string) {
    const resp = await fetch(`${baseUrl}/agents/${id}`, { headers: adminHeaders('public') });
    return resp.json() as Promise<any>;
  }

  it('stamps all DMZ/mesh security flags immediately at manager-join', async () => {
    const { status, body } = await joinRemoteAgent('dmz-flags');
    expect(status).toBe(201);
    expect(body.metadata).toMatchObject(DMZ_FLAGS);

    const detail = await agentDetail(body.id);
    expect(detail.metadata).toMatchObject(DMZ_FLAGS);
  });

  it('never invokes OWS when wallet is not enabled at join', async () => {
    const getOrCreate = vi.fn(() => ({ walletName: 'public-no-wallet', address: '0x9999' }));
    (manager as any).getOrCreateAgentWallet = getOrCreate;

    const { status, body } = await joinRemoteAgent('no-wallet');
    expect(status).toBe(201);
    expect(getOrCreate).not.toHaveBeenCalled();
    expect(body.metadata.wallet).toBe(false);
    expect(body.metadata.ows_wallet).toBeUndefined();
    expect(body.metadata.ows_address).toBeUndefined();
    expect(deliverCalls.length).toBe(0);
  });

  it('provisions at join when wallet is enabled; persists and returns wallet metadata', async () => {
    const getOrCreate = vi.fn(() => ({ walletName: 'public-with-wallet', address: '0x4444' }));
    (manager as any).getOrCreateAgentWallet = getOrCreate;

    const { status, body } = await joinRemoteAgent('with-wallet', { wallet: true });
    expect(status).toBe(201);
    expect(getOrCreate).toHaveBeenCalledWith('public', 'with-wallet');
    expect(body.metadata.wallet).toBe(true);
    expect(body.metadata.ows_wallet).toBe('public-with-wallet');
    expect(body.metadata.ows_address).toBe('0x4444');
    expect(body.metadata).toMatchObject(DMZ_FLAGS);

    const detail = await agentDetail(body.id);
    expect(detail.metadata.wallet).toBe(true);
    expect(detail.metadata.ows_wallet).toBe('public-with-wallet');
    expect(detail.metadata.ows_address).toBe('0x4444');
  });

  it('delivers a wallet-only identity file with no onchain fields', async () => {
    (manager as any).getOrCreateAgentWallet =
      vi.fn(() => ({ walletName: 'public-deliver', address: '0x5555' }));

    const { status, body } = await joinRemoteAgent('deliver', {
      wallet: true,
      ssh_target: 'deploy@203.0.113.5',
    });
    expect(status).toBe(201);

    expect(deliverCalls.length).toBe(1);
    expect(deliverCalls[0].sshTarget).toBe('deploy@203.0.113.5');
    expect(deliverCalls[0].remotePath).toBe('/opt/public-agent/identity.json');

    const stagedPath = path.join(workDir, 'public-agents', body.id, 'staging', 'identity.json');
    expect(fs.existsSync(stagedPath)).toBe(true);
    const identity = JSON.parse(fs.readFileSync(stagedPath, 'utf8'));
    expect(identity.name).toBe('deliver');
    expect(identity.ows_address).toBe('0x5555');
    expect(identity.service_endpoint).toBe('https://deliver.example.com');
    expect(typeof identity.registered_at).toBe('string');
    expect(new Date(identity.registered_at).toISOString()).toBe(identity.registered_at);
    expect(identity).not.toHaveProperty('idchain_domain');
    expect(identity).not.toHaveProperty('token_id');
  });

  it('does not stage or deliver when wallet provisioning is disabled, even with ssh_target', async () => {
    const { status, body } = await joinRemoteAgent('no-delivery', {
      ssh_target: 'deploy@203.0.113.6',
    });
    expect(status).toBe(201);
    expect(deliverCalls.length).toBe(0);
    const stagedPath = path.join(workDir, 'public-agents', body.id, 'staging', 'identity.json');
    expect(fs.existsSync(stagedPath)).toBe(false);
  });

  it('join succeeds when OWS is unavailable (non-fatal provisioning failure)', async () => {
    (manager as any).getOrCreateAgentWallet = vi.fn(() => null);

    const { status, body } = await joinRemoteAgent('ows-down', { wallet: true });
    expect(status).toBe(201);
    expect(body.metadata.wallet).toBe(true);
    expect(body.metadata.ows_wallet).toBeUndefined();
    expect(body.metadata.ows_address).toBeUndefined();
    expect(deliverCalls.length).toBe(0);
  });

  it('join succeeds when SSH delivery fails (non-fatal delivery failure)', async () => {
    (manager as any).getOrCreateAgentWallet =
      vi.fn(() => ({ walletName: 'public-ssh-fail', address: '0x6666' }));
    deliverResult = { ok: false, error: 'connection refused' };

    const { status, body } = await joinRemoteAgent('ssh-fail', {
      wallet: true,
      ssh_target: 'deploy@203.0.113.7',
    });
    expect(status).toBe(201);
    expect(deliverCalls.length).toBe(1);
    expect(body.metadata.ows_wallet).toBe('public-ssh-fail');

    const detail = await agentDetail(body.id);
    expect(detail.metadata.ows_wallet).toBe('public-ssh-fail');
  });

  it('on-demand wallet provision delivers the wallet-only identity for remote agents', async () => {
    const { body } = await joinRemoteAgent('on-demand', {
      ssh_target: 'deploy@203.0.113.8',
    });
    expect(deliverCalls.length).toBe(0);

    (manager as any).checkOwsInstalled = vi.fn(() => true);
    (manager as any).getOrCreateAgentWallet =
      vi.fn(() => ({ walletName: 'public-on-demand', address: '0x7777' }));

    const remoteResp = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: adminHeaders('public'),
      body: JSON.stringify({ command: '/agent on-demand wallet provision' }),
    });
    const remoteBody = await remoteResp.json() as any;
    expect(remoteBody.ok).toBe(true);
    expect(remoteBody.result.status).toBe('provisioned');

    expect(deliverCalls.length).toBe(1);
    expect(deliverCalls[0].sshTarget).toBe('deploy@203.0.113.8');

    const stagedPath = path.join(workDir, 'public-agents', body.id, 'staging', 'identity.json');
    const identity = JSON.parse(fs.readFileSync(stagedPath, 'utf8'));
    expect(identity.ows_address).toBe('0x7777');
    expect(identity).not.toHaveProperty('idchain_domain');
    expect(identity).not.toHaveProperty('token_id');
  });
});
