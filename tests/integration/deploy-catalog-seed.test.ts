// SPDX-License-Identifier: MIT
/**
 * Catalog seed deploy integration test.
 *
 * Proves that:
 *   1. A `catalog:` block in a deploy YAML lands in `agents.metadata.catalog`
 *      on first deploy.
 *   2. A redeploy (sync) preserves runtime PATCHed catalog fields while
 *      filling only absent YAML seed keys, including nullish YAML fields
 *      that must not clear existing live values.
 *
 * Pattern follows tests/integration/wallet-opt-in.test.ts: in-memory SQLite,
 * a real AgentManagerDb, but `spawnLocalAgentProcess` is stubbed so the test
 * never actually forks node child processes — we only care about the DB row
 * the deploy code writes BEFORE spawn.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as net from 'net';
import { namehash } from 'viem/ens';

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
import { SchedulerService } from '../../src/scheduling/scheduler-service.js';
import { heartbeatToSchedule } from '../../src/scheduling/schedule-config.js';

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

const TEST_TEAM = 'catalog-seed-test';
const AGENT_JR = 'jrdev';
const AGENT_AUDITOR = 'auditreviewer';

function firstDeployYaml(jrDir: string, auditorDir: string): string {
  return `version: "1"
team: ${TEST_TEAM}

defaults:
  local: true
  runtime: claude-code-cli
  model: claude-haiku-4-5-20251001

agents:
  - name: ${AGENT_JR}
    description: "Junior dev test seed"
    workingDirectory: ${jrDir}
    catalog:
      role: junior-developer
      description: "Junior dev for low-stakes work."
      expertise: [typescript, simple-refactors]
      costTier: low
      notSuitableFor: [security-key-handling]
      status: available

  - name: ${AGENT_AUDITOR}
    description: "Auditor test seed"
    workingDirectory: ${auditorDir}
    catalog:
      role: auditor
      description: "Reviews code and configs."
      expertise: [audit, review]
      costTier: medium
      status: available
`;
}

function redeployYaml(jrDir: string, auditorDir: string): string {
  return `version: "1"
team: ${TEST_TEAM}

defaults:
  local: true
  runtime: claude-code-cli
  model: claude-haiku-4-5-20251001

agents:
  - name: ${AGENT_JR}
    description: "Junior dev test seed"
    workingDirectory: ${jrDir}
    catalog:
      role: junior-developer
      description: "Updated junior dev blurb."
      expertise: [typescript, simple-refactors, doc-edits]
      costTier: low
      profileStatus: null
      notSuitableFor: [security-key-handling, multi-file-schema-migrations]
      status: available

  - name: ${AGENT_AUDITOR}
    description: "Auditor test seed"
    workingDirectory: ${auditorDir}
    catalog:
      role: auditor
      description: "Reviews code and configs."
      expertise: [audit, review]
      costTier: medium
      status: available
`;
}

function adminHeaders(team: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Id-Team': team,
    'X-Id-Admin': '1',
  };
}

describe('catalog seed deploy integration', () => {
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let manager: AgentManagerDb;
  let workDir: string;
  let baseUrl: string;
  let configDir: string;
  let firstYamlPath: string;
  let redeployYamlPath: string;

  beforeEach(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-seed-int-'));
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-seed-cfg-'));
    const jrDir = path.join(configDir, 'jr-workdir');
    const auditorDir = path.join(configDir, 'auditor-workdir');
    fs.mkdirSync(jrDir);
    fs.mkdirSync(auditorDir);
    firstYamlPath = path.join(configDir, 'first.yaml');
    redeployYamlPath = path.join(configDir, 'redeploy.yaml');
    fs.writeFileSync(firstYamlPath, firstDeployYaml(jrDir, auditorDir));
    fs.writeFileSync(redeployYamlPath, redeployYaml(jrDir, auditorDir));

    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);

    // Stub spawn so the deploy code path doesn't actually fork node children.
    // The DB row is written BEFORE the spawn call, so this is safe — we
    // verify the row, not the process.
    (manager as any).spawnLocalAgentProcess = async () => ({ success: true, pid: 12345, logFile: '/tmp/catalog-seed-test.log' });
    (manager as any).killAgentProcess = async () => ({ success: true });

    // Stub plugin/skill deploy steps that touch the filesystem in arbitrary
    // user paths (the test workdirs above point to /tmp, which is fine, but
    // we don't need real skill files for a metadata-shape assertion).
    (manager as any).deploySkillsToAgent = () => undefined;
    (manager as any).copyPluginsToAgent = () => [];
    (manager as any).ensureRuntimeReady = () => undefined;

    await manager.start(port);
  });

  afterEach(async () => {
    if (manager) await manager.shutdown();
    if (db) await db.close();
    if (workDir) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    if (configDir) {
      try { fs.rmSync(configDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  async function deploy(yamlPath: string) {
    const resp = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: adminHeaders(TEST_TEAM),
      body: JSON.stringify({ command: `/deploy ${yamlPath}` }),
    });
    expect(resp.ok).toBe(true);
    const body = await resp.json() as any;
    if (!body.ok) {
      throw new Error(`/deploy returned not-ok: ${JSON.stringify(body)}`);
    }
    return body.result;
  }

  async function readAgentRowByName(name: string) {
    const teamId = await db.teams.getOrCreateTeamId(TEST_TEAM);
    const row = await db.agents.getByName(teamId, name);
    if (!row) throw new Error(`agent row not found for ${name}`);
    return row;
  }

  it('first deploy seeds metadata.catalog from the YAML block', async () => {
    await deploy(firstYamlPath);

    const jr = await readAgentRowByName(AGENT_JR);
    const cat = (jr.metadata as any)?.catalog;
    expect(cat).toBeDefined();
    expect(cat.role).toBe('junior-developer');
    expect(cat.description).toBe('Junior dev for low-stakes work.');
    expect(cat.expertise).toEqual(['typescript', 'simple-refactors']);
    expect(cat.costTier).toBe('low');
    expect(cat.notSuitableFor).toEqual(['security-key-handling']);
    expect(cat.status).toBe('available');

    const auditor = await readAgentRowByName(AGENT_AUDITOR);
    const auditorCat = (auditor.metadata as any)?.catalog;
    expect(auditorCat?.role).toBe('auditor');
    expect(auditorCat?.costTier).toBe('medium');
    // notSuitableFor was omitted in the auditor's YAML — should be absent
    // from the seed (not coerced to []).
    expect(auditorCat?.notSuitableFor).toBeUndefined();
  });

  it('seeds metadata.catalog from a catalogFile (markdown) alongside inline catalog', async () => {
    // Mixed config: jrdev uses catalogFile (markdown w/ frontmatter), auditor stays inline.
    const mdPath = path.join(configDir, 'catalogs', 'jrdev.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, `---
role: junior-developer
expertise: [typescript, simple-refactors]
costTier: low
notSuitableFor: [security-key-handling]
status: available
---

Junior dev for low-stakes work via catalogFile.
`);

    const jrDir = path.join(configDir, 'jr-workdir');
    const auditorDir = path.join(configDir, 'auditor-workdir');
    const mixedYaml = `version: "1"
team: ${TEST_TEAM}

defaults:
  local: true
  runtime: claude-code-cli
  model: claude-haiku-4-5-20251001

agents:
  - name: ${AGENT_JR}
    description: "Junior dev test seed"
    workingDirectory: ${jrDir}
    catalogFile: catalogs/jrdev.md

  - name: ${AGENT_AUDITOR}
    description: "Auditor test seed"
    workingDirectory: ${auditorDir}
    catalog:
      role: auditor
      description: "Reviews code and configs."
      expertise: [audit, review]
      costTier: medium
      status: available
`;
    const mixedPath = path.join(configDir, 'mixed.yaml');
    fs.writeFileSync(mixedPath, mixedYaml);

    await deploy(mixedPath);

    // catalogFile-driven agent
    const jr = await readAgentRowByName(AGENT_JR);
    const jrCat = (jr.metadata as any)?.catalog;
    expect(jrCat).toBeDefined();
    expect(jrCat.role).toBe('junior-developer');
    expect(jrCat.expertise).toEqual(['typescript', 'simple-refactors']);
    expect(jrCat.costTier).toBe('low');
    expect(jrCat.notSuitableFor).toEqual(['security-key-handling']);
    expect(jrCat.status).toBe('available');
    // body became the description
    expect(jrCat.description).toBe(`Junior dev for low-stakes work via catalogFile.
`);

    // inline catalog still works
    const auditor = await readAgentRowByName(AGENT_AUDITOR);
    const auditorCat = (auditor.metadata as any)?.catalog;
    expect(auditorCat?.role).toBe('auditor');
    expect(auditorCat?.costTier).toBe('medium');

    // GET /catalog round-trip via the manager's per-agent /catalog proxy.
    // Manager exposes the catalog at GET /agents/by-name/:name (metadata.catalog
    // is the single source of truth) — verify via that path so we don't need a
    // running agent server (spawnLocalAgentProcess is stubbed).
    const resp = await fetch(`${baseUrl}/agents/by-name/${AGENT_JR}`, {
      headers: adminHeaders(TEST_TEAM),
    });
    expect(resp.ok).toBe(true);
    const body = await resp.json() as any;
    const apiCat = body?.metadata?.catalog ?? body?.agent?.metadata?.catalog;
    expect(apiCat?.role).toBe('junior-developer');
    expect(apiCat?.costTier).toBe('low');
  });

  it('redeploy preserves live PATCHed catalog keys while filling absent YAML seed keys', async () => {
    // First deploy seeds the original catalog.
    await deploy(firstYamlPath);
    const beforeRow = await readAgentRowByName(AGENT_JR);
    expect((beforeRow.metadata as any).catalog.description).toBe('Junior dev for low-stakes work.');
    const stableIdentity = {
      id: beforeRow.id,
      port: beforeRow.port,
      createdAt: beforeRow.created_at,
      workingDirectory: beforeRow.working_directory,
    };

    // Simulate a runtime PATCH /catalog update — the agent server writes back
    // live catalog fields that are not present in the YAML floor.
    const teamId = await db.teams.getOrCreateTeamId(TEST_TEAM);
    const driftedMeta = {
      ...(beforeRow.metadata as any),
      catalog: {
        role: 'rogue-role',
        description: 'agent rewrote me at runtime',
        expertise: ['nothing'],
        costTier: 'high',
        status: 'busy',
        profileStatus: 'hands-on',
        contributorTitle: 'Runtime principal',
        bittreesLanes: ['engineering', 'architecture'],
        currentTask: 'doing my own thing',
      },
    };
    await db.agents.updateMetadata(beforeRow.id, driftedMeta);
    const drifted = await db.agents.getByName(teamId, AGENT_JR);
    expect((drifted!.metadata as any).catalog.role).toBe('rogue-role');

    // Redeploy with the updated YAML. The YAML floor should only fill absent
    // keys and leave existing live values intact, including nullish seed data.
    await deploy(redeployYamlPath);

    const after = await readAgentRowByName(AGENT_JR);
    expect({
      id: after.id,
      port: after.port,
      createdAt: after.created_at,
      workingDirectory: after.working_directory,
    }).toEqual(stableIdentity);
    const afterCat = (after.metadata as any).catalog;
    expect(afterCat.role).toBe('rogue-role');
    expect(afterCat.description).toBe('agent rewrote me at runtime');
    expect(afterCat.expertise).toEqual(['nothing']);
    expect(afterCat.costTier).toBe('high');
    expect(afterCat.status).toBe('busy');
    expect(afterCat.profileStatus).toBe('hands-on');
    expect(afterCat.contributorTitle).toBe('Runtime principal');
    expect(afterCat.bittreesLanes).toEqual(['engineering', 'architecture']);
    expect(afterCat.currentTask).toBe('doing my own thing');
    expect(afterCat.notSuitableFor).toEqual(['security-key-handling', 'multi-file-schema-migrations']);
  });

  it('leaves the existing identity and durable history intact when redeploy spawn fails', async () => {
    await deploy(firstYamlPath);
    const teamId = await db.teams.getOrCreateTeamId(TEST_TEAM);
    const before = await readAgentRowByName(AGENT_JR);
    await db.queries.create(
      teamId,
      'redeploy-retained-query',
      before.id,
      'durable history',
      Date.now(),
    );
    await db.adapter.query(
      `INSERT INTO wallets (agent_id, team_id, address, private_key, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [before.id, teamId, '0xabc', 'test-only-key', Date.now()],
    );
    (manager as any).spawnLocalAgentProcess = async () => ({
      success: false,
      error: 'synthetic redeploy spawn failure',
    });

    const result = await deploy(redeployYamlPath);
    expect(result.failed).toBeGreaterThan(0);
    const after = await readAgentRowByName(AGENT_JR);
    expect(after.id).toBe(before.id);
    expect(after.port).toBe(before.port);
    expect(after.created_at).toBe(before.created_at);
    expect(after.working_directory).toBe(before.working_directory);
    expect(after.status).toBe('error');
    expect((await db.adapter.query(
      'SELECT COUNT(*) AS count FROM queries WHERE agent_id = ?',
      [before.id],
    )).rows[0]).toMatchObject({ count: 1 });
    expect((await db.adapter.query(
      'SELECT COUNT(*) AS count FROM wallets WHERE agent_id = ?',
      [before.id],
    )).rows[0]).toMatchObject({ count: 1 });
  });

  it('spawn env handoff carries the catalog seed as base64-encoded ID_AGENT_CATALOG', async () => {
    await deploy(firstYamlPath);

    const teamId = await db.teams.getOrCreateTeamId(TEST_TEAM);
    const jrRow = await db.agents.getByName(teamId, AGENT_JR);
    expect(jrRow).toBeTruthy();

    // Reach into the private env-builder used by spawnLocalAgentProcess.
    // This is the spawn-site change at src/agent-manager-db.ts buildLocalAgentEnv:
    // metadata.catalog must be encoded into ID_AGENT_CATALOG so the spawned
    // local-agent-server can seed in-memory /catalog state before binding.
    const env = (manager as any).buildLocalAgentEnv(teamId, TEST_TEAM, 24999, jrRow);
    expect(env.ID_AGENT_CATALOG).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(env.ID_AGENT_CATALOG, 'base64').toString('utf8'));
    expect(decoded.role).toBe('junior-developer');
    expect(decoded.expertise).toEqual(['typescript', 'simple-refactors']);
    expect(decoded.costTier).toBe('low');
    expect(decoded.notSuitableFor).toEqual(['security-key-handling']);
    expect(decoded.status).toBe('available');

    // No catalog on row → no ID_AGENT_CATALOG. Confirms the var is only set
    // when there's something to seed (no empty-string footgun).
    const bareRow = { ...jrRow, metadata: {} as any };
    const bareEnv = (manager as any).buildLocalAgentEnv(teamId, TEST_TEAM, 24999, bareRow);
    expect(bareEnv.ID_AGENT_CATALOG).toBeUndefined();
  });

  it('spawn env resolves configured model aliases before setting CLAUDE_MODEL', async () => {
    await deploy(firstYamlPath);

    const teamId = await db.teams.getOrCreateTeamId(TEST_TEAM);
    const jrRow = await db.agents.getByName(teamId, AGENT_JR);
    expect(jrRow).toBeTruthy();

    const cases: Array<[string, string]> = [
      ['fable', 'claude-fable-5'],
      ['mythos', 'claude-mythos-5'],
      ['haiku', 'claude-haiku-4-5-20251001'],
      ['opus-4.8', 'claude-opus-4-8'],
      ['claude-opus-4-8', 'claude-opus-4-8'],
    ];

    for (const [configuredModel, expectedModel] of cases) {
      const env = (manager as any).buildLocalAgentEnv(
        teamId,
        TEST_TEAM,
        24999,
        jrRow,
        configuredModel,
      );
      expect(env.CLAUDE_MODEL).toBe(expectedModel);
    }
  });
});

describe('direct deploy/sync persistence wiring (no listener)', () => {
  const WORKER_TOKEN_ID = namehash('worker.example.eth');
  const OLD_WORKER_TOKEN_ID = namehash('old.worker.eth');
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let manager: AgentManagerDb;
  let teamId: string;
  let workDir: string;
  let configDir: string;
  let oldAgentDir: string;
  let newAgentDir: string;
  const spawnCalls: Array<Record<string, any>> = [];
  const killCalls: Array<{ port: number; id?: string }> = [];
  const broadcasts: Array<Record<string, any>> = [];

  beforeEach(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-sync-direct-'));
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-sync-config-'));
    oldAgentDir = path.join(configDir, 'old-workspace');
    newAgentDir = path.join(configDir, 'new-workspace');
    fs.mkdirSync(oldAgentDir);
    fs.mkdirSync(newAgentDir);
    db = await createInMemoryDb();
    teamId = await db.teams.getOrCreateTeamId('direct-persistence');
    manager = new AgentManagerDb(workDir, db as any);
    let nextPort = 43150;
    (manager as any).dbNextPort = async () => nextPort++;
    spawnCalls.length = 0;
    killCalls.length = 0;
    broadcasts.length = 0;
    (manager as any).broadcastAgentsChanged = (
      _teamId: string,
      payload: Record<string, any>,
    ) => {
      broadcasts.push(payload);
    };
    (manager as any).spawnLocalAgentProcess = async (
      _teamId: string,
      _teamName: string,
      agentData: Record<string, any>,
    ) => {
      spawnCalls.push({ ...agentData });
      return { success: true, pid: 45678, logFile: '/tmp/deploy-sync-direct.log' };
    };
    (manager as any).killAgentProcess = async (port: number, id?: string) => {
      killCalls.push({ port, id });
      return { success: true };
    };
    (manager as any).deploySkillsToAgent = () => undefined;
    (manager as any).copyPluginsToAgent = () => [];
    (manager as any).ensureRuntimeReady = () => undefined;
    (manager as any).getOrCreateAgentWallet = () => ({
      walletName: 'direct-persistence-worker',
      address: '0x1234',
    });
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  async function remote(command: string) {
    const response = await (manager as any).executeRemoteCommand(
      command,
      teamId,
      'direct-persistence',
    );
    if (!response.ok) {
      throw new Error(`remote command failed: ${JSON.stringify(response)}`);
    }
    return response.result as any;
  }

  function config(options: {
    path: string;
    workingDirectory: string;
    includeIdentity?: boolean;
    wallet?: boolean;
    includePermissiveMetadata?: boolean;
    model?: string;
    includeNewAgent?: boolean;
  }): void {
    const identity = options.includeIdentity
      ? `
    domain: worker.example.eth
    tokenId: "${WORKER_TOKEN_ID}"`
      : '';
    const wallet = options.wallet === undefined
      ? ''
      : `
    wallet: ${options.wallet}`;
    const permissive = options.includePermissiveMetadata
      ? `
    openMode: true
    dangerouslySkipPermissions: false
    mcpServers:
      - name: legacy-module
        transport: stdio
        command: legacy-module`
      : '';
    const newAgent = options.includeNewAgent
      ? `
  - name: new-worker
    runtime: codex
    model: gpt-5
    workingDirectory: ${path.join(configDir, 'new-worker')}`
      : '';
    fs.writeFileSync(options.path, `version: "1"
team: direct-persistence
agents:
  - name: worker
    runtime: codex
    model: ${options.model || 'gpt-5'}
    workingDirectory: ${options.workingDirectory}${identity}${wallet}${permissive}${newAgent}
`);
  }

  function identityConfig(options: {
    path: string;
    agents: Array<{
      name: string;
      identityKey: string;
      workingDirectory: string;
    }>;
  }): void {
    const agents = options.agents.map((agent) => `  - name: ${agent.name}
    identityKey: ${agent.identityKey}
    runtime: codex
    model: gpt-5
    workingDirectory: ${agent.workingDirectory}`).join('\n');
    fs.writeFileSync(options.path, `version: "1"
team: direct-persistence
agents:
${agents}
`);
  }

  it('keeps the same row and durable history across identityKey deploy and sync renames', async () => {
    const initialPath = path.join(configDir, 'identity-initial.yaml');
    const deployRenamePath = path.join(configDir, 'identity-deploy-rename.yaml');
    const syncRenamePath = path.join(configDir, 'identity-sync-rename.yaml');
    identityConfig({
      path: initialPath,
      agents: [{
        name: 'worker',
        identityKey: 'worker-v1',
        workingDirectory: oldAgentDir,
      }],
    });
    identityConfig({
      path: deployRenamePath,
      agents: [{
        name: 'renamed-worker',
        identityKey: 'worker-v1',
        workingDirectory: oldAgentDir,
      }],
    });
    identityConfig({
      path: syncRenamePath,
      agents: [{
        name: 'final-worker',
        identityKey: 'worker-v1',
        workingDirectory: newAgentDir,
      }],
    });

    expect(await remote(`/deploy ${initialPath}`)).toMatchObject({ deployed: 1, failed: 0 });
    const initial = await db.agents.getByName(teamId, 'worker');
    expect(initial).toBeTruthy();
    await db.queries.create(
      teamId,
      'identity-rename-history',
      initial!.id,
      'history follows the stable identity',
      Date.now(),
    );
    const stable = {
      id: initial!.id,
      port: initial!.port,
      createdAt: initial!.created_at,
    };

    expect(await remote(`/deploy ${deployRenamePath}`)).toMatchObject({ deployed: 1, failed: 0 });
    const redeployed = await db.agents.getByName(teamId, 'renamed-worker');
    expect(redeployed).toMatchObject({
      id: stable.id,
      port: stable.port,
      created_at: stable.createdAt,
      name: 'renamed-worker',
    });
    expect((redeployed!.metadata as any).identityKey).toBe('worker-v1');

    const syncedResult = await remote(`/sync ${syncRenamePath}`);
    expect(syncedResult).toMatchObject({
      updated: ['final-worker'],
      removed: [],
      failed: [],
    });
    const synced = await db.agents.getByName(teamId, 'final-worker');
    expect(synced).toMatchObject({
      id: stable.id,
      port: stable.port,
      created_at: stable.createdAt,
      name: 'final-worker',
      working_directory: newAgentDir,
      status: 'running',
    });
    expect((synced!.metadata as any).identityKey).toBe('worker-v1');
    expect((await db.adapter.query(
      'SELECT COUNT(*) AS count FROM queries WHERE agent_id = ?',
      [stable.id],
    )).rows[0]).toMatchObject({ count: 1 });
  });

  it('fails deploy and sync closed when identityKey and name belong to different rows', async () => {
    const initialPath = path.join(configDir, 'identity-collision-initial.yaml');
    const collisionPath = path.join(configDir, 'identity-collision.yaml');
    identityConfig({
      path: initialPath,
      agents: [
        {
          name: 'worker',
          identityKey: 'worker-v1',
          workingDirectory: oldAgentDir,
        },
        {
          name: 'other-worker',
          identityKey: 'other-v1',
          workingDirectory: path.join(configDir, 'other-workspace'),
        },
      ],
    });
    identityConfig({
      path: collisionPath,
      agents: [{
        name: 'other-worker',
        identityKey: 'worker-v1',
        workingDirectory: newAgentDir,
      }],
    });

    expect(await remote(`/deploy ${initialPath}`)).toMatchObject({ deployed: 2, failed: 0 });
    const keyOwner = await db.agents.getByName(teamId, 'worker');
    const nameOwner = await db.agents.getByName(teamId, 'other-worker');
    expect(keyOwner).toBeTruthy();
    expect(nameOwner).toBeTruthy();
    const spawnCount = spawnCalls.length;

    await expect((manager as any).executeRemoteCommand(
      `/deploy ${collisionPath}`,
      teamId,
      'direct-persistence',
    )).rejects.toThrow('Deploy identity conflict');
    expect(spawnCalls).toHaveLength(spawnCount);

    const syncCollision = await (manager as any).executeRemoteCommand(
      `/sync ${collisionPath}`,
      teamId,
      'direct-persistence',
    );
    expect(syncCollision).toMatchObject({ ok: false });
    expect(syncCollision.error).toContain('Sync identity conflict');
    expect(spawnCalls).toHaveLength(spawnCount);

    expect(await db.agents.getByName(teamId, 'worker')).toMatchObject({
      id: keyOwner!.id,
      name: 'worker',
      status: 'running',
    });
    expect(await db.agents.getByName(teamId, 'other-worker')).toMatchObject({
      id: nameOwner!.id,
      name: 'other-worker',
      status: 'running',
    });
  });

  it('never adopts interactive, virtual, remote, or GUI-created rows as YAML identities', async () => {
    const collisions = [
      {
        name: 'interactive-worker',
        type: 'interactive',
        runtime: 'codex',
        endpoint: 'http://localhost:45001',
        metadata: {
          local: true,
          alias: 'interactive-worker',
          runtime: 'codex',
          interactive: true,
        },
      },
      {
        name: 'virtual-worker',
        type: 'virtual',
        runtime: 'virtual',
        endpoint: null,
        metadata: {
          alias: 'virtual-worker',
          local: false,
        },
      },
      {
        name: 'remote-worker',
        type: 'virtual',
        runtime: 'public-agent-remote',
        endpoint: 'https://agents.example.test/remote-worker',
        metadata: {
          alias: 'remote-worker',
          local: false,
          deployment_shape: 'remote-endpoint',
        },
      },
      {
        name: 'gui-local-worker',
        type: 'claude',
        runtime: 'codex',
        endpoint: 'http://localhost:45004',
        metadata: {
          local: true,
          runtime: 'codex',
          service_type: 'REST-AP',
        },
      },
    ] as const;

    for (const [index, collision] of collisions.entries()) {
      const id = `foreign-${index}`;
      const foreignWorkDir = path.join(configDir, `${collision.name}-workspace`);
      fs.mkdirSync(foreignWorkDir, { recursive: true });
      await db.agents.create({
        team_id: teamId,
        id,
        name: collision.name,
        type: collision.type,
        model: 'gpt-5',
        port: 45001 + index,
        endpoint: collision.endpoint,
        working_directory: foreignWorkDir,
        status: 'running',
        created_at: Date.now() + index,
        metadata: collision.metadata,
        runtime: collision.runtime,
      });
      const before = await db.agents.getById(id);
      const configPath = path.join(configDir, `${collision.name}.yaml`);
      fs.writeFileSync(configPath, `version: "1"
team: direct-persistence
agents:
  - name: ${collision.name}
    runtime: codex
    model: gpt-5
    workingDirectory: ${foreignWorkDir}
`);

      const spawnCount = spawnCalls.length;
      const killCount = killCalls.length;
      await expect((manager as any).executeRemoteCommand(
        `/deploy ${configPath}`,
        teamId,
        'direct-persistence',
      )).rejects.toThrow(/non-YAML agent/i);
      const sync = await (manager as any).executeRemoteCommand(
        `/sync ${configPath}`,
        teamId,
        'direct-persistence',
      );
      expect(sync).toMatchObject({ ok: false });
      expect(sync.error).toMatch(/non-YAML agent/i);
      expect(spawnCalls).toHaveLength(spawnCount);
      expect(killCalls).toHaveLength(killCount);
      expect(await db.agents.getById(id)).toEqual(before);
    }
  });

  it('adopts only conservative legacy YAML rows and persists the ownership marker', async () => {
    const keyedDir = path.join(configDir, 'legacy-keyed-workspace');
    const unkeyedDir = path.join(configDir, 'legacy-unkeyed-workspace');
    fs.mkdirSync(keyedDir, { recursive: true });
    fs.mkdirSync(unkeyedDir, { recursive: true });

    await db.agents.create({
      team_id: teamId,
      id: 'legacy-keyed-id',
      name: 'legacy-keyed',
      type: 'claude',
      model: 'gpt-5',
      port: 45101,
      endpoint: 'http://localhost:45101',
      working_directory: keyedDir,
      status: 'running',
      created_at: Date.now(),
      metadata: {
        local: true,
        alias: 'legacy-keyed',
        identityKey: 'legacy-keyed-v1',
        runtime: 'codex',
      },
      runtime: 'codex',
    });
    await db.agents.create({
      team_id: teamId,
      id: 'legacy-unkeyed-id',
      name: 'legacy-unkeyed',
      type: 'claude',
      model: 'gpt-5',
      port: 45102,
      endpoint: 'http://localhost:45102',
      working_directory: unkeyedDir,
      status: 'running',
      created_at: Date.now() + 1,
      metadata: {
        local: true,
        alias: 'legacy-unkeyed',
        runtime: 'codex',
        service_type: 'REST-AP',
      },
      runtime: 'codex',
    });

    const deployPath = path.join(configDir, 'legacy-keyed.yaml');
    fs.writeFileSync(deployPath, `version: "1"
team: direct-persistence
agents:
  - name: renamed-legacy-keyed
    identityKey: legacy-keyed-v1
    runtime: codex
    model: gpt-5
    workingDirectory: ${keyedDir}
`);
    expect(await remote(`/deploy ${deployPath}`)).toMatchObject({ deployed: 1, failed: 0 });
    expect(await db.agents.getById('legacy-keyed-id')).toMatchObject({
      id: 'legacy-keyed-id',
      name: 'renamed-legacy-keyed',
    });
    expect(((await db.agents.getById('legacy-keyed-id'))!.metadata as any).yamlManaged).toBe(true);

    const syncPath = path.join(configDir, 'legacy-unkeyed.yaml');
    fs.writeFileSync(syncPath, `version: "1"
team: direct-persistence
agents:
  - name: legacy-unkeyed
    identityKey: legacy-unkeyed-v1
    runtime: codex
    model: gpt-5
    workingDirectory: ${unkeyedDir}
`);
    const sync = await remote(`/sync ${syncPath} --allow-remove`);
    expect(sync).toMatchObject({
      updated: ['legacy-unkeyed'],
      removed: ['renamed-legacy-keyed'],
      failed: [],
    });
    const adopted = await db.agents.getById('legacy-unkeyed-id');
    expect(adopted).toMatchObject({
      id: 'legacy-unkeyed-id',
      name: 'legacy-unkeyed',
      status: 'running',
    });
    expect((adopted!.metadata as any).identityKey).toBe('legacy-unkeyed-v1');
    expect((adopted!.metadata as any).yamlManaged).toBe(true);
  });

  it('requires a new explicit tokenId when a keyed identity changes domain', async () => {
    const initialPath = path.join(configDir, 'domain-initial.yaml');
    const changedPath = path.join(configDir, 'domain-changed.yaml');
    fs.writeFileSync(initialPath, `version: "1"
team: direct-persistence
agents:
  - name: worker
    identityKey: domain-worker-v1
    domain: old.worker.eth
    tokenId: "${OLD_WORKER_TOKEN_ID}"
    runtime: codex
    model: gpt-5
    workingDirectory: ${oldAgentDir}
`);
    fs.writeFileSync(changedPath, `version: "1"
team: direct-persistence
agents:
  - name: worker
    identityKey: domain-worker-v1
    domain: new.worker.eth
    runtime: codex
    model: gpt-5
    workingDirectory: ${oldAgentDir}
`);

    expect(await remote(`/deploy ${initialPath}`)).toMatchObject({ deployed: 1, failed: 0 });
    await expect((manager as any).executeRemoteCommand(
      `/deploy ${changedPath}`,
      teamId,
      'direct-persistence',
    )).rejects.toThrow(/requires an explicit matching tokenId/i);
    const sync = await (manager as any).executeRemoteCommand(
      `/sync ${changedPath}`,
      teamId,
      'direct-persistence',
    );
    expect(sync).toMatchObject({ ok: false });
    expect(sync.error).toMatch(/requires an explicit matching tokenId/i);
    expect(await db.agents.getByName(teamId, 'old.worker.eth')).toMatchObject({
      domain: 'old.worker.eth',
      token_id: OLD_WORKER_TOKEN_ID,
    });
  });

  it('validates the post-reconcile lead automator after a keyed rename', async () => {
    const initialPath = path.join(configDir, 'lead-initial.yaml');
    const renamedPath = path.join(configDir, 'lead-renamed.yaml');
    fs.writeFileSync(initialPath, `version: "1"
team: direct-persistence
agents:
  - name: lead-automator
    identityKey: durable-lead-v1
    type: automator
    runtime: codex
    model: gpt-5
    workingDirectory: ${oldAgentDir}
`);
    fs.writeFileSync(renamedPath, `version: "1"
team: direct-persistence
agents:
  - name: planner
    identityKey: durable-lead-v1
    type: automator
    runtime: codex
    model: gpt-5
    workingDirectory: ${oldAgentDir}
`);

    expect(await remote(`/deploy ${initialPath}`)).toMatchObject({ deployed: 1, failed: 0 });
    await expect((manager as any).executeRemoteCommand(
      `/deploy ${renamedPath}`,
      teamId,
      'direct-persistence',
    )).rejects.toThrow(/post-deploy.*lead-automator/i);
    const sync = await (manager as any).executeRemoteCommand(
      `/sync ${renamedPath}`,
      teamId,
      'direct-persistence',
    );
    expect(sync).toMatchObject({ ok: false });
    expect(sync.error).toMatch(/post-sync.*lead-automator/i);
    expect(await db.agents.getByName(teamId, 'lead-automator')).toMatchObject({
      type: 'automator',
      status: 'running',
    });
  });

  it('serializes concurrent deploy reconciliations before identity preflight', async () => {
    const firstPath = path.join(configDir, 'concurrent-first.yaml');
    const secondPath = path.join(configDir, 'concurrent-second.yaml');
    identityConfig({
      path: firstPath,
      agents: [{
        name: 'first-name',
        identityKey: 'one-concurrent-owner',
        workingDirectory: oldAgentDir,
      }],
    });
    identityConfig({
      path: secondPath,
      agents: [{
        name: 'second-name',
        identityKey: 'one-concurrent-owner',
        workingDirectory: oldAgentDir,
      }],
    });

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    let spawnCount = 0;
    (manager as any).spawnLocalAgentProcess = async () => {
      spawnCount += 1;
      if (spawnCount === 1) {
        markFirstStarted();
        await firstGate;
      }
      return { success: true, pid: 45678, logFile: '/tmp/concurrent-deploy.log' };
    };

    const first = (manager as any).executeRemoteCommand(
      `/deploy ${firstPath}`,
      teamId,
      'direct-persistence',
    );
    await firstStarted;
    let secondSettled = false;
    const second = (manager as any).executeRemoteCommand(
      `/deploy ${secondPath}`,
      teamId,
      'direct-persistence',
    ).then((value: unknown) => {
      secondSettled = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(secondSettled).toBe(false);

    releaseFirst();
    expect((await first).ok).toBe(true);
    expect((await second as any).ok).toBe(true);
    const rows = await db.agents.list(teamId, true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'second-name' });
    expect((rows[0].metadata as any).identityKey).toBe('one-concurrent-owner');
  });

  it('persists, diffs, updates, and removes the effective declarative worker environment', async () => {
    const initialPath = path.join(configDir, 'env-initial.yaml');
    const changedPath = path.join(configDir, 'env-changed.yaml');
    const removedPath = path.join(configDir, 'env-removed.yaml');
    fs.writeFileSync(initialPath, `version: "1"
team: direct-persistence
defaults:
  env:
    DEFAULT_TOP: "default-top"
    SHARED: "default-top"
  resources:
    env:
      DEFAULT_LEGACY: "default-legacy"
      SHARED: "default-legacy"
agents:
  - name: worker
    identityKey: worker-env-v1
    runtime: claude-agent-sdk
    model: claude-sonnet-5
    workingDirectory: ${oldAgentDir}
    resources:
      env:
        AGENT_LEGACY: "agent-legacy"
        SHARED: "agent-legacy"
    env:
      AGENT_TOP: "agent-top"
      SHARED: "agent-top"
    allowedTools: [Read, Grep]
    openMode: true
`);
    fs.writeFileSync(changedPath, `version: "1"
team: direct-persistence
agents:
  - name: worker
    identityKey: worker-env-v1
    runtime: claude-agent-sdk
    model: claude-sonnet-5
    workingDirectory: ${oldAgentDir}
    env:
      SYNC_ONLY: "sync-value"
      SHARED: "sync-top"
    allowedTools: []
    openMode: false
`);
    fs.writeFileSync(removedPath, `version: "1"
team: direct-persistence
agents:
  - name: worker
    identityKey: worker-env-v1
    runtime: claude-agent-sdk
    model: claude-sonnet-5
    workingDirectory: ${oldAgentDir}
    allowedTools: []
    openMode: false
`);

    expect(await remote(`/deploy ${initialPath}`)).toMatchObject({ deployed: 1, failed: 0 });
    const deployed = await db.agents.getByName(teamId, 'worker');
    expect(deployed).toBeTruthy();
    expect((deployed!.metadata as any).env).toEqual({
      DEFAULT_LEGACY: 'default-legacy',
      DEFAULT_TOP: 'default-top',
      AGENT_LEGACY: 'agent-legacy',
      AGENT_TOP: 'agent-top',
      SHARED: 'agent-top',
    });
    expect(deployed!.metadata).toMatchObject({
      alias: 'worker',
      allowed_tools: ['Read', 'Grep'],
      openMode: true,
    });

    const deployedEnv = (manager as any).buildLocalAgentEnv(
      teamId,
      'direct-persistence',
      deployed!.port,
      deployed,
      deployed!.model,
    );
    expect(deployedEnv).toMatchObject({
      DEFAULT_LEGACY: 'default-legacy',
      DEFAULT_TOP: 'default-top',
      AGENT_LEGACY: 'agent-legacy',
      AGENT_TOP: 'agent-top',
      SHARED: 'agent-top',
      ID_AGENT_NAME: 'worker',
      ID_AGENT_ALIAS: 'worker',
      ID_AGENT_ALLOWED_TOOLS: '["Read","Grep"]',
      XMTP_OPEN_MODE: 'true',
    });

    const changed = await remote(`/sync ${changedPath}`);
    expect(changed).toMatchObject({
      updated: ['worker'],
      failed: [],
    });
    const synced = await db.agents.getByName(teamId, 'worker');
    expect((synced!.metadata as any).env).toEqual({
      SYNC_ONLY: 'sync-value',
      SHARED: 'sync-top',
    });
    expect(synced!.metadata).toMatchObject({
      alias: 'worker',
      allowed_tools: [],
      openMode: false,
    });
    const syncedEnv = (manager as any).buildLocalAgentEnv(
      teamId,
      'direct-persistence',
      synced!.port,
      synced,
      synced!.model,
    );
    expect(syncedEnv.SYNC_ONLY).toBe('sync-value');
    expect(syncedEnv.SHARED).toBe('sync-top');
    expect(syncedEnv.DEFAULT_TOP).toBeUndefined();
    expect(syncedEnv.ID_AGENT_ALLOWED_TOOLS).toBe('[]');
    expect(syncedEnv.XMTP_OPEN_MODE).toBe('false');

    const removed = await remote(`/sync ${removedPath}`);
    expect(removed).toMatchObject({
      updated: ['worker'],
      failed: [],
    });
    const cleared = await db.agents.getByName(teamId, 'worker');
    expect((cleared!.metadata as any).env).toBeUndefined();
    const clearedEnv = (manager as any).buildLocalAgentEnv(
      teamId,
      'direct-persistence',
      cleared!.port,
      cleared,
      cleared!.model,
    );
    expect(clearedEnv.SYNC_ONLY).toBeUndefined();
    expect(clearedEnv.SHARED).toBeUndefined();
  });

  it('blocks destructive sync before mutating team config, rows, or worker state', async () => {
    const initialPath = path.join(configDir, 'atomic-initial.yaml');
    const blockedPath = path.join(configDir, 'atomic-blocked.yaml');
    const preflightBlockedPath = path.join(configDir, 'atomic-preflight-blocked.yaml');
    const secondWorkDir = path.join(configDir, 'atomic-second-workspace');
    fs.mkdirSync(secondWorkDir, { recursive: true });
    fs.writeFileSync(initialPath, `version: "1"
team: direct-persistence
org:
  groups:
    operations:
      description: baseline
runtimeCredentialPool:
  lanes:
    - id: baseline-a
      runtime: codex
      kind: subscription
    - id: baseline-b
      runtime: codex
      kind: subscription
agents:
  - name: worker
    identityKey: atomic-worker-v1
    runtime: codex
    model: gpt-5
    workingDirectory: ${oldAgentDir}
  - name: second-worker
    identityKey: atomic-second-v1
    runtime: codex
    model: gpt-5
    workingDirectory: ${secondWorkDir}
`);
    fs.writeFileSync(blockedPath, `version: "1"
team: direct-persistence
org:
  groups:
    operations:
      description: must-not-apply
runtimeCredentialPool:
  lanes:
    - id: replacement-a
      runtime: codex
      kind: subscription
    - id: replacement-b
      runtime: codex
      kind: subscription
agents:
  - name: worker
    identityKey: atomic-worker-v1
    runtime: codex
    model: gpt-5
    workingDirectory: ${oldAgentDir}
`);
    fs.writeFileSync(preflightBlockedPath, `version: "1"
team: direct-persistence
org:
  groups:
    operations:
      description: must-not-apply-after-preflight-failure
runtimeCredentialPool:
  lanes:
    - id: replacement-a
      runtime: codex
      kind: subscription
    - id: replacement-b
      runtime: codex
      kind: subscription
agents:
  - name: worker
    identityKey: atomic-worker-v1
    runtime: codex
    model: gpt-5-mini
    workingDirectory: ${oldAgentDir}
    skills:
      - definitely-missing-consumer-skill
`);

    expect(await remote(`/deploy ${initialPath}`)).toMatchObject({ deployed: 2, failed: 0 });
    const configBefore = await db.teams.getConfig(teamId);
    const rowsBefore = await db.agents.list(teamId, true);
    const poolBefore = structuredClone(
      (manager as any).runtimeCredentialPoolByTeam.get(teamId),
    );
    const spawnCount = spawnCalls.length;
    const killCount = killCalls.length;
    const broadcastCount = broadcasts.length;

    const blocked = await (manager as any).executeRemoteCommand(
      `/sync ${blockedPath}`,
      teamId,
      'direct-persistence',
    );
    expect(blocked).toMatchObject({ ok: false });
    expect(blocked.error).toMatch(/--allow-remove/);
    expect(await db.teams.getConfig(teamId)).toEqual(configBefore);
    expect((manager as any).runtimeCredentialPoolByTeam.get(teamId)).toEqual(poolBefore);
    expect(await db.agents.list(teamId, true)).toEqual(rowsBefore);
    expect(spawnCalls).toHaveLength(spawnCount);
    expect(killCalls).toHaveLength(killCount);
    expect(broadcasts).toHaveLength(broadcastCount);

    const preflightBlocked = await (manager as any).executeRemoteCommand(
      `/sync ${preflightBlockedPath} --allow-remove`,
      teamId,
      'direct-persistence',
    );
    expect(preflightBlocked).toMatchObject({ ok: false });
    expect(preflightBlocked.error).toMatch(/preflight.*definitely-missing-consumer-skill/i);
    expect(await db.teams.getConfig(teamId)).toEqual(configBefore);
    expect((manager as any).runtimeCredentialPoolByTeam.get(teamId)).toEqual(poolBefore);
    expect(await db.agents.list(teamId, true)).toEqual(rowsBefore);
    expect(spawnCalls).toHaveLength(spawnCount);
    expect(killCalls).toHaveLength(killCount);
    expect(broadcasts).toHaveLength(broadcastCount);
  });

  it('keeps new target teams and directories absent during dry-run and failed preflight', async () => {
    const previewTeam = 'preview-only-target';
    const invalidTeam = 'invalid-preflight-target';
    const previewPath = path.join(configDir, 'new-team-preview.yaml');
    const invalidPath = path.join(configDir, 'new-team-invalid.yaml');
    const previewWorkspace = path.join(configDir, 'preview-target-workspace');
    const invalidWorkspace = path.join(configDir, 'invalid-target-workspace');
    fs.writeFileSync(previewPath, `version: "1"
team: ${previewTeam}
agents:
  - name: worker
    identityKey: preview-worker-v1
    runtime: codex
    model: gpt-5
    workingDirectory: ${previewWorkspace}
`);
    fs.writeFileSync(invalidPath, `version: "1"
team: ${invalidTeam}
agents:
  - name: worker
    identityKey: invalid-worker-v1
    runtime: codex
    model: gpt-5
    workingDirectory: ${invalidWorkspace}
    skills:
      - definitely-missing-consumer-skill
`);

    const preview = await (manager as any).executeRemoteCommand(
      `/deploy ${previewPath} --dry-run`,
      teamId,
      'direct-persistence',
    );
    expect(preview).toMatchObject({
      ok: true,
      result: { dryRun: true, teamName: previewTeam },
    });
    expect(await db.teams.getTeamByName(previewTeam)).toBeNull();
    expect(fs.existsSync(path.join(workDir, 'teams', previewTeam))).toBe(false);
    expect(fs.existsSync(previewWorkspace)).toBe(false);

    await expect((manager as any).executeRemoteCommand(
      `/deploy ${invalidPath}`,
      teamId,
      'direct-persistence',
    )).rejects.toThrow(/definitely-missing-consumer-skill/i);
    expect(await db.teams.getTeamByName(invalidTeam)).toBeNull();
    expect(fs.existsSync(path.join(workDir, 'teams', invalidTeam))).toBe(false);
    expect(fs.existsSync(invalidWorkspace)).toBe(false);
  });

  it('reconciles only the exact YAML heartbeat and preserves manual, calendar, and prefix-neighbor schedules', async () => {
    (manager as any).schedulerService = new SchedulerService(
      db as any,
      async () => null,
    );
    const heartbeatPath = path.join(configDir, 'heartbeat-enabled.yaml');
    const noHeartbeatPath = path.join(configDir, 'heartbeat-disabled.yaml');
    fs.writeFileSync(heartbeatPath, `version: "1"
team: direct-persistence
agents:
  - name: worker
    identityKey: heartbeat-worker-v1
    runtime: codex
    model: gpt-5
    workingDirectory: ${oldAgentDir}
    heartbeat: 120
`);
    fs.writeFileSync(noHeartbeatPath, `version: "1"
team: direct-persistence
agents:
  - name: worker
    identityKey: heartbeat-worker-v1
    runtime: codex
    model: gpt-5
    workingDirectory: ${oldAgentDir}
`);

    expect(await remote(`/deploy ${heartbeatPath}`)).toMatchObject({ deployed: 1, failed: 0 });
    const worker = await db.agents.getByName(teamId, 'worker');
    const { definition } = heartbeatToSchedule(worker!.id, 'worker', 120);
    const retainedSchedules = [
      {
        ...definition,
        id: 'manual-retained',
        source_type: 'manual',
        source_key: `manual:${worker!.id}`,
      },
      {
        ...definition,
        id: 'calendar-retained',
        kind: 'calendar' as const,
        source_type: 'yaml',
        source_key: `calendar:test:${worker!.id}`,
      },
      {
        ...definition,
        id: 'prefix-neighbor-retained',
        source_type: 'yaml',
        source_key: `heartbeat:${worker!.id}-neighbor`,
      },
    ];
    for (const retained of retainedSchedules) {
      await db.schedules.upsertDefinition(retained);
      await db.schedules.replaceTargets(retained.id, [worker!.id]);
    }

    expect(await remote(`/deploy ${noHeartbeatPath}`)).toMatchObject({ deployed: 1, failed: 0 });
    expect((await db.schedules.listSchedulesForAgent(worker!.id)).map((item) => item.id).sort()).toEqual([
      'calendar-retained',
      'manual-retained',
      'prefix-neighbor-retained',
    ]);

    expect(await remote(`/deploy ${heartbeatPath}`)).toMatchObject({ deployed: 1, failed: 0 });
    expect(await remote(`/deploy ${heartbeatPath}`)).toMatchObject({ deployed: 1, failed: 0 });
    expect((await db.schedules.listSchedulesForAgent(worker!.id)).map((item) => item.id).sort()).toEqual([
      'calendar-retained',
      `hb_${worker!.id}`,
      'manual-retained',
      'prefix-neighbor-retained',
    ]);

    expect(await remote(`/sync ${noHeartbeatPath}`)).toMatchObject({
      updated: ['worker'],
      failed: [],
    });
    expect((await db.schedules.listSchedulesForAgent(worker!.id)).map((item) => item.id).sort()).toEqual([
      'calendar-retained',
      'manual-retained',
      'prefix-neighbor-retained',
    ]);

    expect(await remote(`/sync ${heartbeatPath}`)).toMatchObject({
      updated: ['worker'],
      failed: [],
    });
    expect(await remote(`/sync ${heartbeatPath}`)).toMatchObject({
      unchanged: ['worker'],
      failed: [],
    });
    expect((await db.schedules.listSchedulesForAgent(worker!.id)).map((item) => item.id).sort()).toEqual([
      'calendar-retained',
      `hb_${worker!.id}`,
      'manual-retained',
      'prefix-neighbor-retained',
    ]);
  });

  it('keeps identity/history through redeploy and workspace sync while applying explicit security changes', async () => {
    const firstPath = path.join(configDir, 'first.yaml');
    const redeployPath = path.join(configDir, 'redeploy.yaml');
    const syncPath = path.join(configDir, 'sync.yaml');
    config({
      path: firstPath,
      workingDirectory: oldAgentDir,
      includeIdentity: true,
      wallet: true,
      includePermissiveMetadata: true,
    });
    config({
      path: redeployPath,
      workingDirectory: oldAgentDir,
      wallet: false,
    });
    config({
      path: syncPath,
      workingDirectory: newAgentDir,
      wallet: false,
    });

    const firstDeploy = await remote(`/deploy ${firstPath}`);
    if (firstDeploy.failed) throw new Error(JSON.stringify(firstDeploy.agents));
    expect(firstDeploy).toMatchObject({ deployed: 1, failed: 0 });
    const before = await db.agents.getByName(teamId, 'worker');
    expect(before).toBeTruthy();
    await db.queries.create(
      teamId,
      'retained-direct-query',
      before!.id,
      'durable query',
      Date.now(),
    );
    await db.adapter.query(
      `INSERT INTO wallets (agent_id, team_id, address, private_key, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [before!.id, teamId, '0xabc', 'test-only-key', Date.now()],
    );
    await db.agents.updateMetadata(before!.id, {
      ...(before!.metadata as Record<string, unknown>),
      ows_wallet_seed: 'legacy-secret-that-must-be-stripped',
    });
    const stableIdentity = {
      id: before!.id,
      port: before!.port,
      createdAt: before!.created_at,
      domain: before!.domain,
      tokenId: before!.token_id,
    };

    // /deploy must rebuild declarative metadata rather than retaining a prior
    // permissive policy or module, while preserving durable identity fields
    // omitted from the newer YAML.
    await remote(`/deploy ${redeployPath}`);
    const redeployed = await db.agents.getByName(teamId, 'worker');
    expect({
      id: redeployed!.id,
      port: redeployed!.port,
      createdAt: redeployed!.created_at,
      domain: redeployed!.domain,
      tokenId: redeployed!.token_id,
    }).toEqual(stableIdentity);
    expect(redeployed!.name).toBe('worker.example.eth');
    expect(redeployed!.metadata).toMatchObject({ wallet: false });
    expect((redeployed!.metadata as any).openMode).toBeUndefined();
    expect((redeployed!.metadata as any).dangerouslySkipPermissions).toBeUndefined();
    expect((redeployed!.metadata as any).mcpServers).toBeUndefined();
    expect((redeployed!.metadata as any).ows_wallet).toBeUndefined();
    expect((redeployed!.metadata as any).ows_address).toBeUndefined();
    expect((redeployed!.metadata as any).ows_wallet_seed).toBeUndefined();
    expect(spawnCalls.at(-1)?.tokenId).toBe(WORKER_TOKEN_ID);

    // Re-introduce legacy drift to prove /sync also removes it, then move the
    // worker to a different workspace without deleting/recreating the row.
    await db.agents.updateMetadata(redeployed!.id, {
      ...(redeployed!.metadata as Record<string, unknown>),
      wallet: true,
      ows_wallet: 'legacy-wallet',
      ows_address: '0xlegacy',
      ows_wallet_seed: 'legacy-seed',
      openMode: true,
      dangerouslySkipPermissions: false,
      mcpServers: [{ name: 'legacy-module', transport: 'stdio', command: 'legacy-module' }],
    });
    const syncResult = await remote(`/sync ${syncPath}`);
    expect(syncResult.updated).toEqual(['worker']);
    expect(syncResult.failed).toEqual([]);

    const synced = await db.agents.getByName(teamId, 'worker');
    expect({
      id: synced!.id,
      port: synced!.port,
      createdAt: synced!.created_at,
      domain: synced!.domain,
      tokenId: synced!.token_id,
    }).toEqual(stableIdentity);
    expect(synced!.working_directory).toBe(newAgentDir);
    expect(synced!.status).toBe('running');
    expect(synced!.metadata).toMatchObject({ wallet: false });
    expect((synced!.metadata as any).openMode).toBeUndefined();
    expect((synced!.metadata as any).dangerouslySkipPermissions).toBeUndefined();
    expect((synced!.metadata as any).mcpServers).toBeUndefined();
    expect((synced!.metadata as any).ows_wallet).toBeUndefined();
    expect((synced!.metadata as any).ows_address).toBeUndefined();
    expect((synced!.metadata as any).ows_wallet_seed).toBeUndefined();
    expect(spawnCalls.at(-1)).toMatchObject({
      id: stableIdentity.id,
      port: stableIdentity.port,
      workingDirectory: newAgentDir,
      tokenId: WORKER_TOKEN_ID,
    });
    expect((await db.adapter.query(
      'SELECT COUNT(*) AS count FROM queries WHERE agent_id = ?',
      [stableIdentity.id],
    )).rows[0]).toMatchObject({ count: 1 });
    expect((await db.adapter.query(
      'SELECT COUNT(*) AS count FROM wallets WHERE agent_id = ?',
      [stableIdentity.id],
    )).rows[0]).toMatchObject({ count: 1 });
    const env = (manager as any).buildLocalAgentEnv(
      teamId,
      'direct-persistence',
      synced!.port,
      synced,
      synced!.model,
      synced!.token_id || undefined,
    );
    expect(env.ID_AGENT_SKIP_PERMISSIONS).toBe('true');
    expect(env.OWS_WALLET).toBeUndefined();
  });

  it('marks existing restart failures without deleting history and cleans only newly failed rows', async () => {
    const firstPath = path.join(configDir, 'failure-first.yaml');
    const existingDeployFailurePath = path.join(configDir, 'failure-existing-deploy.yaml');
    const changedPath = path.join(configDir, 'failure-changed.yaml');
    const addPath = path.join(configDir, 'failure-add.yaml');
    config({
      path: firstPath,
      workingDirectory: oldAgentDir,
      includeIdentity: true,
    });
    config({
      path: existingDeployFailurePath,
      workingDirectory: oldAgentDir,
      model: 'gpt-4.1',
    });
    config({
      path: changedPath,
      workingDirectory: oldAgentDir,
      model: 'gpt-5-mini',
    });
    config({
      path: addPath,
      workingDirectory: oldAgentDir,
      model: 'gpt-5-mini',
      includeNewAgent: true,
    });

    const firstDeploy = await remote(`/deploy ${firstPath}`);
    if (firstDeploy.failed) throw new Error(JSON.stringify(firstDeploy.agents));
    expect(firstDeploy).toMatchObject({ deployed: 1, failed: 0 });
    const before = await db.agents.getByName(teamId, 'worker');
    await db.queries.create(
      teamId,
      'retained-failure-query',
      before!.id,
      'durable query',
      Date.now(),
    );
    (manager as any).spawnLocalAgentProcess = async () => ({
      success: false,
      error: 'synthetic existing restart failure',
    });

    const failedRedeploy = await remote(`/deploy ${existingDeployFailurePath}`);
    expect(failedRedeploy).toMatchObject({ deployed: 0, failed: 1 });
    const afterFailedRedeploy = await db.agents.getByName(teamId, 'worker');
    expect(afterFailedRedeploy).toMatchObject({
      id: before!.id,
      port: before!.port,
      created_at: before!.created_at,
      status: 'error',
    });
    expect((await db.adapter.query(
      'SELECT COUNT(*) AS count FROM queries WHERE agent_id = ?',
      [before!.id],
    )).rows[0]).toMatchObject({ count: 1 });

    const changedResult = await remote(`/sync ${changedPath}`);
    expect(changedResult.updated).toEqual([]);
    expect(changedResult.failed).toEqual([{
      name: 'worker',
      error: 'synthetic existing restart failure',
    }]);
    const failedExisting = await db.agents.getByName(teamId, 'worker');
    expect(failedExisting).toMatchObject({
      id: before!.id,
      port: before!.port,
      created_at: before!.created_at,
      status: 'error',
    });
    expect((await db.adapter.query(
      'SELECT COUNT(*) AS count FROM queries WHERE agent_id = ?',
      [before!.id],
    )).rows[0]).toMatchObject({ count: 1 });

    (manager as any).spawnLocalAgentProcess = async (
      _teamId: string,
      _teamName: string,
      agentData: Record<string, any>,
    ) => {
      if (agentData.name === 'new-worker') {
        return {
          success: false,
          error: 'synthetic new-row spawn failure',
        };
      }
      return { success: true, pid: 45678, logFile: '/tmp/deploy-sync-direct.log' };
    };
    const broadcastCountBeforeFailedAdds = broadcasts.length;
    const addResult = await remote(`/sync ${addPath}`);
    expect(addResult.failed).toEqual([{
      name: 'new-worker',
      error: 'synthetic new-row spawn failure',
    }]);
    expect(await db.agents.getByName(teamId, 'new-worker')).toBeNull();

    (manager as any).spawnLocalAgentProcess = async (
      _teamId: string,
      _teamName: string,
      agentData: Record<string, any>,
    ) => {
      if (agentData.name === 'new-worker') {
        throw new Error('synthetic new-row exception');
      }
      return { success: true, pid: 45678, logFile: '/tmp/deploy-sync-direct.log' };
    };
    const thrownAddResult = await remote(`/sync ${addPath}`);
    expect(thrownAddResult.failed).toEqual([{
      name: 'new-worker',
      error: 'synthetic new-row exception',
    }]);
    expect(await db.agents.getByName(teamId, 'new-worker')).toBeNull();
    expect(broadcasts).toHaveLength(broadcastCountBeforeFailedAdds);

    const failedDeployPath = path.join(configDir, 'failed-new-deploy.yaml');
    fs.writeFileSync(failedDeployPath, `version: "1"
team: direct-persistence
agents:
  - name: deploy-failed-worker
    runtime: codex
    model: gpt-5
    workingDirectory: ${path.join(configDir, 'failed-deploy-worker')}
`);
    (manager as any).spawnLocalAgentProcess = async () => ({
      success: false,
      error: 'synthetic deploy spawn failure',
    });
    const broadcastCountBeforeFailedDeploy = broadcasts.length;
    const failedDeploy = await remote(`/deploy ${failedDeployPath}`);
    expect(failedDeploy).toMatchObject({ deployed: 0, failed: 1 });
    expect(failedDeploy.agents).toEqual([expect.objectContaining({
      name: 'deploy-failed-worker',
      success: false,
      error: 'synthetic deploy spawn failure',
    })]);
    expect(await db.agents.getByName(teamId, 'deploy-failed-worker')).toBeNull();
    expect(broadcasts).toHaveLength(broadcastCountBeforeFailedDeploy);

    const retainedExisting = await db.agents.getByName(teamId, 'worker');
    expect(retainedExisting!.id).toBe(before!.id);
    expect((await db.adapter.query(
      'SELECT COUNT(*) AS count FROM queries WHERE agent_id = ?',
      [before!.id],
    )).rows[0]).toMatchObject({ count: 1 });
  });

  it('reallocates an invalid persisted port without replacing the agent identity', async () => {
    const configPath = path.join(configDir, 'invalid-port.yaml');
    config({
      path: configPath,
      workingDirectory: oldAgentDir,
    });
    const firstDeploy = await remote(`/deploy ${configPath}`);
    expect(firstDeploy).toMatchObject({ deployed: 1, failed: 0 });
    const before = await db.agents.getByName(teamId, 'worker');
    await db.adapter.query(
      'UPDATE agents SET port = ?, endpoint = ? WHERE id = ?',
      [0, 'http://localhost:0', before!.id],
    );

    const redeploy = await remote(`/deploy ${configPath}`);
    expect(redeploy).toMatchObject({ deployed: 1, failed: 0 });
    const after = await db.agents.getByName(teamId, 'worker');
    expect(after).toMatchObject({
      id: before!.id,
      created_at: before!.created_at,
      port: 43151,
      status: 'running',
    });
    expect(spawnCalls.at(-1)).toMatchObject({
      id: before!.id,
      port: 43151,
    });
  });
});
