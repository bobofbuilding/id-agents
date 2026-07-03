// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { SqliteEventsRepo } from '../../src/db/repos/sqlite/events-repo.js';
import { SqliteSubscriptionsRepo } from '../../src/db/repos/sqlite/subscriptions-repo.js';
import { SqliteCheckinsRepo } from '../../src/db/repos/sqlite/checkins-repo.js';
import { SqliteRuntimeLaneCooldownsRepo } from '../../src/db/repos/sqlite/runtime-lane-cooldowns-repo.js';

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
    subscriptions: new SqliteSubscriptionsRepo(adapter),
    checkins: new SqliteCheckinsRepo(adapter),
    runtimeLaneCooldowns: new SqliteRuntimeLaneCooldownsRepo(adapter),
    async close() { await adapter.close(); },
  };
}

async function makeManager() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-wallet-unit-'));
  const db = await createInMemoryDb();
  const manager = new AgentManagerDb(workDir, db as any);
  return { manager, db, workDir };
}

describe('AgentManagerDb wallet helpers', () => {
  const workDirs: string[] = [];
  const dbs: Array<Awaited<ReturnType<typeof createInMemoryDb>>> = [];
  const originalEnv = {
    SKILLMESH_MASTER_KEY: process.env.SKILLMESH_MASTER_KEY,
    ID_AGENTS_SKILLMESH_AUTO_KEYS: process.env.ID_AGENTS_SKILLMESH_AUTO_KEYS,
    ID_AGENTS_SKILLMESH_PROVIDER_ENABLED: process.env.ID_AGENTS_SKILLMESH_PROVIDER_ENABLED,
  };

  afterEach(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    while (dbs.length > 0) {
      await dbs.pop()!.close();
    }
    while (workDirs.length > 0) {
      fs.rmSync(workDirs.pop()!, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('strips provisioned wallet metadata when wallet opt-in is false', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const getOrCreate = vi.fn(() => ({ walletName: 'idchain-coder', address: '0x1234' }));
    (manager as any).getOrCreateAgentWallet = getOrCreate;

    const result = (manager as any).resolveWalletMetadata('idchain', 'coder', {
      name: 'coder',
      wallet: true,
      ows_wallet: 'old-wallet',
      ows_address: '0xold',
    }, false);

    expect(result.wallet).toBeNull();
    expect(result.metadata.wallet).toBe(false);
    expect(result.metadata.ows_wallet).toBeUndefined();
    expect(result.metadata.ows_address).toBeUndefined();
    expect(getOrCreate).not.toHaveBeenCalled();
  });

  it('provisions wallet metadata only when opted in and only then injects OWS_WALLET into spawn env', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);

    const getOrCreate = vi.fn(() => ({ walletName: 'idchain-coder', address: '0x1234' }));
    (manager as any).getOrCreateAgentWallet = getOrCreate;

    const withWallet = (manager as any).resolveWalletMetadata('idchain', 'coder', {
      name: 'coder',
    }, true);
    const envWithWallet = (manager as any).buildLocalAgentEnv('team-idchain', 'idchain', 4101, {
      runtime: 'codex-cli',
      metadata: withWallet.metadata,
    }, 'gpt-5', 'tok-1');
    const envWithoutWallet = (manager as any).buildLocalAgentEnv('team-idchain', 'idchain', 4101, {
      runtime: 'codex-cli',
      metadata: { name: 'coder', wallet: false },
    }, 'gpt-5', 'tok-1');

    expect(getOrCreate).toHaveBeenCalledWith('idchain', 'coder');
    expect(withWallet.metadata.wallet).toBe(true);
    expect(withWallet.metadata.ows_wallet).toBe('idchain-coder');
    expect(withWallet.metadata.ows_address).toBe('0x1234');
    expect(envWithWallet.OWS_WALLET).toBe('idchain-coder');
    expect(envWithoutWallet.OWS_WALLET).toBeUndefined();
  });

  it('derives SkillMesh keys only when the optional provider is enabled', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);
    process.env.SKILLMESH_MASTER_KEY = `0x${'11'.repeat(32)}`;
    delete process.env.ID_AGENTS_SKILLMESH_AUTO_KEYS;
    delete process.env.ID_AGENTS_SKILLMESH_PROVIDER_ENABLED;
    const teamId = await db.teams.getOrCreateTeamId('default');

    await db.agents.create({
      team_id: teamId,
      id: 'agent-neutral',
      name: 'neutral',
      type: 'claude',
      model: 'gpt-5',
      status: 'pending',
      created_at: Date.now(),
      metadata: { name: 'neutral', plugins: [] },
      runtime: 'codex-cli',
    });
    const neutral = await (manager as any).maybeAssignSkillmeshKey('agent-neutral', 'default', {
      name: 'neutral',
      plugins: [],
    });

    await db.agents.create({
      team_id: teamId,
      id: 'agent-skillmesh',
      name: 'skillmesh-enabled',
      type: 'claude',
      model: 'gpt-5',
      status: 'pending',
      created_at: Date.now(),
      metadata: { name: 'skillmesh-enabled', plugins: [{ name: 'skillmesh', path: '/providers/skillmesh' }] },
      runtime: 'codex-cli',
    });
    const enabled = await (manager as any).maybeAssignSkillmeshKey('agent-skillmesh', 'default', {
      name: 'skillmesh-enabled',
      plugins: [{ name: 'skillmesh', path: '/providers/skillmesh' }],
    });
    const stored = await db.agents.getById('agent-skillmesh');

    expect(neutral.skillmesh_private_key).toBeUndefined();
    expect(enabled.skillmesh_address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(enabled.skillmesh_private_key).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(stored?.metadata?.skillmesh_private_key).toBe(enabled.skillmesh_private_key);
  });

  it('injects SkillMesh secrets into child env only for SkillMesh-enabled agents', async () => {
    const { manager, db, workDir } = await makeManager();
    dbs.push(db);
    workDirs.push(workDir);
    const teamId = await db.teams.getOrCreateTeamId('default');
    const staleKey = `0x${'22'.repeat(32)}`;
    const creatorKey = `0x${'33'.repeat(32)}`;

    const neutralEnv = (manager as any).buildLocalAgentEnv(teamId, 'default', 4101, {
      runtime: 'codex-cli',
      metadata: {
        name: 'neutral',
        skillmesh_private_key: staleKey,
        skillmesh_creator_key: creatorKey,
      },
    }, 'gpt-5', 'tok-1');
    const enabledEnv = (manager as any).buildLocalAgentEnv(teamId, 'default', 4102, {
      runtime: 'codex-cli',
      metadata: {
        name: 'skillmesh-enabled',
        plugins: [{ name: 'skillmesh', path: '/providers/skillmesh' }],
        skillmesh_private_key: staleKey,
        skillmesh_creator_key: creatorKey,
      },
    }, 'gpt-5', 'tok-2');

    expect(neutralEnv.SKILLMESH_PRIVATE_KEY).toBeUndefined();
    expect(neutralEnv.SKILLMESH_CREATOR_PRIVATE_KEY).toBeUndefined();
    expect(enabledEnv.SKILLMESH_PRIVATE_KEY).toBe(staleKey);
    expect(enabledEnv.SKILLMESH_CREATOR_PRIVATE_KEY).toBe(creatorKey);
  });
});
