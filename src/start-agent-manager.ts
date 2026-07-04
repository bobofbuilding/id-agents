// SPDX-License-Identifier: MIT
/**
 * Start Agent Manager
 * 
 * Runs the multi-agent manager that can spawn runtime-configured agents on demand
 */

import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentManagerDb } from './agent-manager-db.js';
import { createDb, migrateDb } from './db.js';
import { AgentRestServer } from './agent-rest-server.js';
import { resolveRuntime } from './runtime/registry.js';
import { detectSessionHandoffVars } from './lib/env-hygiene.js';
import { installFatalHandlers } from './lib/fatal-handlers.js';

// Silent-stop incidents had the scheduler die behind a swallowed rejection —
// the process stayed up but the tick loop was dead. Fail loud and exit so the
// supervisor restarts instead of limping. Installed before main() so any
// later async work is covered. See src/lib/fatal-handlers.ts.
installFatalHandlers();

async function main() {
  const agentRole = process.env.AGENT_ROLE || 'manager'; // 'manager' or 'worker'
  const agentId = process.env.AGENT_ID; // For worker agents

  console.log(`🚀 Starting ID Agent (${agentRole})`);

  const handoffVars = detectSessionHandoffVars(process.env);
  if (handoffVars.length > 0) {
    console.warn(
      `⚠️  WARNING: running under a parent Claude Code session — detected ${handoffVars.join(', ')}. ` +
      `Stripping these from child agents to avoid 401 auth failures. ` +
      `If you see weird auth failures, this is why.`
    );
  }

  // Managers can boot without an API key (so the API can come up and you can debug/inspect state).
  // Worker agents require it to actually run Claude (unless using a different harness).
  const harness = resolveRuntime(process.env.ID_HARNESS || process.env.HARNESS || 'claude-agent-sdk');
  const useMaxPlan = process.env.ID_USE_MAX_PLAN === 'true';

  // claude-code-cli and codex use their own auth (CLI login), not ANTHROPIC_API_KEY
  const needsAnthropicKey = harness === 'claude-agent-sdk';

  if (!process.env.ANTHROPIC_API_KEY && needsAnthropicKey) {
    if (agentRole === 'worker') {
      console.error('❌ ANTHROPIC_API_KEY not set');
      console.error('Add it to your .env file');
      process.exit(1);
    } else {
      console.warn('⚠️  ANTHROPIC_API_KEY not set (manager will start, but claude-agent-sdk workers may fail)');
    }
  }

  if (agentRole === 'worker') {
    // Worker agent: Run a single runtime-configured agent
    await startWorkerAgent(agentId);
  } else {
    // Manager agent: Run the manager
    await startManagerAgent();
  }
}

async function startManagerAgent() {
  const managementPort = parseInt(process.env.AGENT_MANAGER_PORT || '4100');
  const workingDir = path.resolve(process.env.AGENT_MANAGER_WORKDIR || path.join(process.cwd(), 'workspace'));
  const allowDuplicateStart = process.env.ID_MANAGER_ALLOW_DUPLICATE_START === 'true';

  const runLock = allowDuplicateStart ? null : await acquireManagerRunLock(managementPort);
  if (!allowDuplicateStart && !runLock) return;

  if (!allowDuplicateStart && await existingManagerHealthy(managementPort)) {
    console.log(`✅ ID Agent Manager is already running on http://127.0.0.1:${managementPort}; not starting a duplicate daemon.`);
    runLock?.release();
    return;
  }

  try {
    // Initialize DB (required for persistence)
    const db = await createDb();
    await migrateDb(db);

    const manager = new AgentManagerDb(workingDir, db);

    try {
      await manager.start(managementPort);
    } catch (err) {
      runLock?.release();
      throw err;
    }

    console.log('🎯 Manager agent ready - can spawn and manage local worker agents');
    console.log('Press Ctrl+C to stop the manager\n');

    // Keep the process alive
    const heartbeat = setInterval(() => {}, 1000 * 60 * 60);

    // Handle shutdown gracefully
    const shutdown = async (signal: string) => {
      console.log(`\n\nShutting down manager agent (${signal})...`);
      clearInterval(heartbeat);
      try {
        await manager.shutdown();
      } catch (err) {
        console.error('Manager shutdown error:', err);
      } finally {
        runLock?.release();
      }
      process.exit(0);
    };
    process.on('exit', () => { runLock?.release(); });
    process.on('SIGINT', () => { void shutdown('SIGINT'); });
    process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  } catch (err) {
    runLock?.release();
    throw err;
  }
}

type ManagerRunLock = {
  release: () => void;
};

function managerRunLockPath(port: number): string {
  return path.join(os.tmpdir(), `id-agents-manager-${port}.lock`);
}

function parseLockPid(raw: string): number | null {
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown };
    const pid = Number(parsed.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    const pid = Number(raw.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExistingManagerHealthy(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await existingManagerHealthy(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function acquireManagerRunLock(port: number): Promise<ManagerRunLock | null> {
  const lockPath = managerRunLockPath(port);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, port, createdAt: Date.now() }));
      fs.closeSync(fd);
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          try {
            const owner = parseLockPid(fs.readFileSync(lockPath, 'utf8'));
            if (owner === process.pid) fs.rmSync(lockPath, { force: true });
          } catch {
            // Lock already removed or unreadable; nothing to release.
          }
        },
      };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'EEXIST') throw err;
      const ownerPid = (() => {
        try { return parseLockPid(fs.readFileSync(lockPath, 'utf8')); }
        catch { return null; }
      })();
      if (ownerPid && pidIsAlive(ownerPid)) {
        if (await existingManagerHealthy(port) || await waitForExistingManagerHealthy(port, 5_000)) {
          console.log(`✅ ID Agent Manager is already running on http://127.0.0.1:${port} (pid ${ownerPid}); not starting a duplicate daemon.`);
          return null;
        }
        console.log(`✅ ID Agent Manager startup is already owned by live pid ${ownerPid}; not starting a duplicate daemon.`);
        return null;
      }
      try { fs.rmSync(lockPath, { force: true }); }
      catch (unlinkErr) {
        console.warn(`⚠️  Could not remove stale manager lock ${lockPath}:`, unlinkErr);
        return null;
      }
    }
  }
  console.log(`✅ ID Agent Manager startup lock is busy for port ${port}; not starting a duplicate daemon.`);
  return null;
}

async function existingManagerHealthy(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 750);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null) as { status?: unknown } | null;
    return body?.status === 'ok';
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function startWorkerAgent(agentId?: string) {
  if (!agentId) {
    console.error('❌ AGENT_ID not set for worker agent');
    process.exit(1);
  }

  // Worker agents run a single REST-AP AgentRestServer (not the manager API).
  const port = parseInt(process.env.CLAUDE_AGENT_PORT || process.env.AGENT_PORT || '4100');
  const workingDir = process.env.CLAUDE_AGENT_WORKDIR || process.env.AGENT_MANAGER_WORKDIR || `/workspace/agents/${agentId}`;
  // Team name determines the shared directory scope - all agents in a team share files
  const teamName = process.env.ID_TEAM || process.env.ID_PROJECT || 'default';
  const sharedDir = process.env.ID_SHARED_DIR || `/workspace/teams/${teamName}`;
  // Use ID_AGENT_ALIAS for the base name (e.g., "max"), not ID_AGENT_NAME which may be an ENS domain
  const agentAlias = process.env.ID_AGENT_ALIAS || process.env.ID_AGENT_NAME || process.env.AGENT_NAME || agentId;
  const agentTokenId = process.env.ID_AGENT_TOKEN_ID || undefined;
  const managerUrl = process.env.MANAGER_URL || 'http://localhost:4100';

  console.log(`🤖 Starting worker agent: ${agentId} on port ${port}`);

  // Always open the shared DB so queries and news land where the manager daemon
  // at :4100 can serve /query/<id> and /news polling. Memory-only fallback stays
  // for resilience, but manager polling will not find queries in that mode.
  let dbCtx: { db: any; teamId: string; agentId: string } | undefined;
  try {
    const db = await createDb();
    await migrateDb(db);
    const dbAgentId = process.env.ID_DB_AGENT_ID || agentId;
    const dbTeamId = process.env.ID_DB_TEAM_ID || await db.teams.getOrCreateTeamId(teamName);
    dbCtx = { db, teamId: dbTeamId, agentId: dbAgentId };
  } catch (e: any) {
    console.warn(`⚠️ Worker agent DB disabled, running memory-only: ${e?.message || String(e)}`);
    console.warn(`⚠️ Manager daemon polling (GET :4100/query/<id>, /news) will NOT find this agent's queries while memory-only.`);
  }

  // Fetch full identity (including tokenId) from manager
  // Initialize with env vars as fallback (tokenId from ID_AGENT_TOKEN_ID)
  let agentIdentity: { name?: string; team?: string; metadata?: any; tokenId?: string; domain?: string } = {
    name: agentAlias,
    team: teamName,
    tokenId: agentTokenId  // Use env var tokenId as initial fallback
  };

  // Always log what we have from env vars for debugging
  console.log(`🔧 Env vars: ID_AGENT_ALIAS=${agentAlias}, ID_AGENT_TOKEN_ID=${agentTokenId || '(not set)'}`);

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (teamName) {
      headers['X-Id-Team'] = teamName;
    }
    const identityRes = await fetch(`${managerUrl}/agents/${agentId}`, { headers });
    if (identityRes.ok) {
      const agentData = await identityRes.json() as any;
      // Log what manager returned for debugging
      console.log(`🔧 Manager returned: alias=${agentData.alias}, tokenId=${agentData.tokenId}, name=${agentData.name}`);
      // Use alias from response, or fall back to env var alias
      const fetchedAlias = agentData.alias || agentAlias;
      const fetchedTokenId = agentData.tokenId || agentTokenId;
      agentIdentity = {
        name: fetchedAlias,  // Use just the alias, not the displayId (getDisplayId will construct it)
        team: teamName,
        metadata: agentData.metadata,
        tokenId: fetchedTokenId,
        domain: agentData.domain
      };
      console.log(`📋 Loaded identity: ${fetchedAlias}`);
    } else {
      console.warn(`⚠️ Manager fetch failed: ${identityRes.status}`);
      if (agentAlias) {
        console.log(`📋 Using env identity: ${agentAlias}`);
      }
    }
  } catch (e: any) {
    console.warn(`⚠️ Could not fetch identity from manager: ${e?.message || String(e)}`);
    if (agentAlias) {
      console.log(`📋 Using env identity: ${agentAlias}`);
    }
  }

  const server = new AgentRestServer({
    model: process.env.CLAUDE_MODEL,
    workingDirectory: workingDir,
    sharedDirectory: sharedDir,
    agentName: agentAlias,  // Pass the alias, not the full displayId
    agentIdentity,
    db: dbCtx ? { db: dbCtx.db, teamId: dbCtx.teamId, agentId: dbCtx.agentId } : undefined
  });

  await server.start(port);

  console.log(`✅ Worker agent ${agentId} ready on port ${port}`);
  console.log(`📡 Manager: ${managerUrl}`);
  console.log('Press Ctrl+C to stop the agent\n');

  // Keep the process alive
  const heartbeat = setInterval(() => {}, 1000 * 60 * 60);

  // Handle shutdown gracefully
  process.on('SIGINT', () => {
    console.log(`\n\nShutting down worker agent ${agentId}...`);
    clearInterval(heartbeat);
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log(`\n\nShutting down worker agent ${agentId}...`);
    clearInterval(heartbeat);
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
