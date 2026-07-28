// SPDX-License-Identifier: MIT
/**
 * Local Agent Server
 *
 * Runs a local runtime-backed agent using the user's existing CLI
 * authentication when applicable. This allows agents to use a logged-in CLI
 * session instead of requiring an API key for CLI-based runtimes.
 *
 * The local agent:
 * - Registers with the manager as a team member
 * - Exposes REST-AP endpoints for inter-agent communication
 * - Uses your configured local runtime for LLM calls
 * - Can participate in multi-agent workflows alongside other local agents
 */

import 'dotenv/config';
import { AgentRestServer } from './agent-rest-server.js';
import { createDb, migrateDb } from './db/index.js';
import type { Db } from './db/db-service.js';
import fetch from 'node-fetch';
import { mkdirSync, existsSync } from 'fs';
import path from 'path';
import net from 'net';
import {
  getDefaultModelForRuntime,
  getRuntimeDisplayName,
  resolveRuntime,
  usesCliLogin,
} from './runtime/registry.js';
import { isDirectEntrypoint } from './lib/direct-entrypoint.js';
import { startParentDeathWatchdog } from './lib/parent-watchdog.js';
import { managerWorkerRequestHeaders } from './manager-worker-auth.js';

interface LocalAgentConfig {
  name: string;
  team?: string;
  port?: number;
  workingDirectory?: string;
  model?: string;
  managerUrl?: string;
  agentId?: string;  // Pre-registered agent ID from manager
  verbose?: boolean; // Enable detailed logging of agent activity
}

/**
 * Parse the Manager-owned allowed-tools envelope. An absent value keeps the
 * server default; malformed values fail closed to an empty tool set.
 */
export function parseManagedAllowedTools(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (
      Array.isArray(parsed)
      && parsed.every(tool => typeof tool === 'string' && tool.trim().length > 0)
    ) {
      return [...new Set(parsed)];
    }
  } catch {
    // Fall through to the fail-closed result.
  }
  return [];
}

export function parseManagedBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value.trim().toLowerCase() === 'true';
}

export interface LocalAgentStopTransitionResult {
  accepted: boolean;
  queryIds: string[];
}

/**
 * Persist one worker shutdown without allowing a late process to mutate its
 * replacement's state. Managed workers first prove their exact generation is
 * still current, then cancel only queries tagged with that generation.
 * Standalone workers retain the historical all-query cancellation only after
 * their PID is confirmed current.
 */
export async function transitionLocalAgentStopState(input: {
  db: Db;
  teamId: string;
  agentId: string;
  processPid: number;
  processGeneration?: string;
  restartAfterManagerStart?: boolean;
  completedAt?: number;
}): Promise<LocalAgentStopTransitionResult> {
  const {
    db,
    teamId,
    agentId,
    processPid,
    processGeneration,
    restartAfterManagerStart = false,
    completedAt = Date.now(),
  } = input;

  let queryIds: string[];
  if (processGeneration) {
    const transitioned = await db.agents.transitionOwnedProcessExit(
      agentId,
      processGeneration,
      restartAfterManagerStart,
    );
    if (!transitioned) return { accepted: false, queryIds: [] };
    queryIds = await db.queries.cancelForProcessGeneration(
      agentId,
      processGeneration,
      completedAt,
    );
  } else {
    const current = await db.agents.getById(agentId);
    const rawCurrentPid = (
      current?.metadata as { pid?: unknown } | null | undefined
    )?.pid;
    const currentPid = typeof rawCurrentPid === 'number'
      ? rawCurrentPid
      : Number(rawCurrentPid);
    if (
      Number.isSafeInteger(currentPid)
      && currentPid > 0
      && currentPid !== processPid
    ) {
      return { accepted: false, queryIds: [] };
    }

    queryIds = await db.queries.cancel(agentId, completedAt);
    const metadata = {
      ...((current?.metadata as Record<string, unknown> | null | undefined) ?? {}),
    };
    if (restartAfterManagerStart) {
      metadata.managerRestartRequested = true;
    }
    delete metadata.pid;
    delete metadata.processOwner;
    delete metadata.processParentPid;
    delete metadata.processInspectedAt;
    await db.agents.updateStatus(
      agentId,
      restartAfterManagerStart ? 'offline' : 'stopped',
      { metadata },
    );
  }

  for (const queryId of queryIds) {
    await db.news.add(teamId, agentId, {
      timestamp: completedAt,
      type: 'query.cancelled',
      message: 'Query cancelled (agent stopped)',
      data: { reason: 'agent_stopped', query_id: queryId },
      query_id: queryId,
    });
  }
  return { accepted: true, queryIds };
}

/**
 * Check if a port is available
 */
async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port);
  });
}

/**
 * Find an available port starting from a given port
 */
async function findAvailablePort(startPort: number, maxAttempts: number = 100): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available ports found in range ${startPort}-${startPort + maxAttempts}`);
}

/**
 * Get port search range for local agents (global sequential allocation, starting at 4101)
 */
async function getPortSearchRange(): Promise<{ portStart: number; portEnd: number }> {
  return { portStart: 4101, portEnd: 65535 };
}

/**
 * Register the local agent with the manager
 */
async function registerWithManager(
  managerUrl: string,
  agentId: string,
  name: string,
  team: string,
  port: number,
  runtime: string
): Promise<void> {
  const endpoint = `http://localhost:${port}`;

  const headers = managerWorkerRequestHeaders({
    'Content-Type': 'application/json',
    'X-Id-Team': team,
  });

  const response = await fetch(`${managerUrl}/agents/register`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      id: agentId,
      name,
      endpoint,
      type: 'claude',  // Mark as claude type since it runs Claude Code
      metadata: {
        name,
        service_type: 'REST-AP',
        service: endpoint,
        runtime,
        local: true,  // Flag to indicate this is a local agent
        pid: process.pid
      }
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to register with manager: ${error}`);
  }

  console.log(`✅ Registered with manager at ${managerUrl}`);
}

// Note: We no longer need an unregister function here.
// The stop() function updates status directly via database.
// Agents persist in the database and can be restarted.

/**
 * Start a local runtime-backed agent server
 */
export async function startLocalAgent(config: LocalAgentConfig): Promise<{
  server: AgentRestServer;
  port: number;
  agentId: string;
  stop: (opts?: { restartAfterManagerStart?: boolean }) => Promise<void>;
}> {
  const runtime = resolveRuntime(process.env.ID_HARNESS || 'claude-code-cli');
  process.env.ID_HARNESS = runtime;

  const {
    name,
    team = process.env.ID_TEAM || 'default',
    port: requestedPort,
    workingDirectory: configWorkDir,
    model = process.env.CLAUDE_MODEL || getDefaultModelForRuntime(runtime),
    managerUrl = process.env.MANAGER_URL || 'http://127.0.0.1:4100',
    agentId: preRegisteredId
  } = config;

  const tokenId = process.env.ID_AGENT_TOKEN_ID;
  const processGeneration = process.env.ID_AGENT_PROCESS_GENERATION?.trim();
  const identityName = process.env.ID_AGENT_NAME?.trim() || name;
  const identityAlias = process.env.ID_AGENT_ALIAS?.trim() || name;
  const managedAllowedTools = parseManagedAllowedTools(process.env.ID_AGENT_ALLOWED_TOOLS);
  const managedOpenMode = parseManagedBoolean(process.env.XMTP_OPEN_MODE);

  // Use pre-registered ID or generate one
  const agentId = preRegisteredId || `local_${name.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}_${Date.now()}`;
  const isPreRegistered = !!preRegisteredId;

  // Set up working directory
  const baseWorkDir = process.env.ID_WORKSPACE_DIR || process.env.WORKSPACE_DIR || '/tmp/id-agents';
  const workingDirectory = configWorkDir || path.join(baseWorkDir, 'local-agents', agentId);
  const sharedDirectory = path.join(baseWorkDir, 'teams', team);

  // Create directories if they don't exist
  if (!existsSync(workingDirectory)) {
    mkdirSync(workingDirectory, { recursive: true });
  }
  if (!existsSync(sharedDirectory)) {
    mkdirSync(sharedDirectory, { recursive: true });
  }

  // Determine port
  let port: number;
  if (requestedPort) {
    if (await isPortAvailable(requestedPort)) {
      port = requestedPort;
    } else {
      throw new Error(`Requested port ${requestedPort} is not available`);
    }
  } else {
    // Find available port using global sequential allocation
    const portRange = await getPortSearchRange();
    port = await findAvailablePort(portRange.portStart, portRange.portEnd - portRange.portStart);
  }

  // Open the shared DB (SQLite default or Postgres via DATABASE_URL). Query and
  // news rows must land in this shared store so the manager daemon at :4100
  // can serve /query/<id> and /news polling. Memory-only fallback remains for
  // resilience, but daemon polling will 404 in that mode.
  let db: Db | undefined;
  let dbTeamId: string | undefined;

  try {
    db = await createDb();
    await migrateDb(db);
    // Use pre-configured team ID if available
    dbTeamId = process.env.ID_DB_TEAM_ID || await db.teams.getOrCreateTeamId(team);

    if (!isPreRegistered) {
      // Register agent in database (standalone mode)
      await db.agents.upsert({
        team_id: dbTeamId,
        id: agentId,
        name,
        type: 'claude',
        model,
        port,
        endpoint: `http://localhost:${port}`,
        working_directory: workingDirectory,
        status: 'running',
        created_at: Date.now(),
        metadata: { name, service_type: 'REST-AP', service: `http://localhost:${port}`, runtime, local: true, pid: process.pid },
      });
      console.log(`📦 Registered in database (team: ${team})`);
    }
  } catch (err) {
    console.warn(`⚠️  Database connection failed, running in memory-only mode: ${err}`);
    console.warn(`⚠️  Manager daemon polling (GET :4100/query/<id>, /news) will NOT find this agent's queries while memory-only.`);
    db = undefined;
    dbTeamId = undefined;
  }

  // For Claude CLI runtimes, prefer the local Claude session over ambient API keys.
  // Codex still supports OPENAI_API_KEY and should inherit it when present.
  if (usesCliLogin(runtime) && runtime !== 'codex' && process.env.ID_AGENT_CLAUDE_BARE !== '1') {
    delete process.env.ANTHROPIC_API_KEY;
  }

  // Set manager URL for AgentRestServer to use
  process.env.MANAGER_URL = managerUrl;
  // Identity for best-effort token-usage attribution (read by harnesses that
  // report local-model usage to the manager's /usage/record endpoint).
  process.env.ID_AGENT_NAME = identityName;
  process.env.ID_AGENT_ALIAS = identityAlias;
  process.env.ID_AGENT_TEAM = team;
  process.env.ID_AGENT_ID = agentId;

  // Enable verbose logging if configured
  if (config.verbose || process.env.ID_AGENT_VERBOSE === 'true') {
    process.env.ID_AGENT_VERBOSE = 'true';
    console.log('📋 Verbose logging enabled - will show tool calls and progress');
  }

  // Stream live tool/file activity to the manager so the control center can show
  // "what the agent is working on" inline in chat. This needs the stream-json
  // parse (verbose) to extract tool steps, so turn it on. Opt out with
  // ID_AGENT_ACTIVITY=false.
  if (process.env.ID_AGENT_ACTIVITY !== 'false') {
    process.env.ID_AGENT_VERBOSE = 'true';
  }

  // Catalog seed handoff: the manager passes the YAML-floored catalog object
  // via ID_AGENT_CATALOG (base64-encoded JSON) so the in-memory /catalog state
  // is correct on the first request — no manual PATCH required.
  let catalogSeed: Record<string, unknown> | undefined;
  const rawCatalog = process.env.ID_AGENT_CATALOG;
  if (rawCatalog) {
    try {
      const decoded = Buffer.from(rawCatalog, 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        catalogSeed = parsed as Record<string, unknown>;
      }
    } catch (err: any) {
      console.warn(`⚠️  Failed to decode ID_AGENT_CATALOG: ${err?.message || err}`);
    }
  }
  const metadataSeed: Record<string, unknown> = {};
  if (catalogSeed) metadataSeed.catalog = catalogSeed;
  metadataSeed.alias = identityAlias;
  if (managedOpenMode !== undefined) metadataSeed.openMode = managedOpenMode;
  if (String(process.env.ID_AGENT_PRIMARY_LEAD || '').toLowerCase() === 'true') {
    metadataSeed.primaryLead = true;
  }

  // Create the server
  const server = new AgentRestServer({
    model,
    workingDirectory,
    sharedDirectory,
    ...(managedAllowedTools !== undefined && { allowedTools: managedAllowedTools }),
    agentName: identityName,
    agentIdentity: {
      name: identityName,
      team,
      ...(tokenId && { tokenId }),
      ...(Object.keys(metadataSeed).length > 0 && { metadata: metadataSeed }),
    },
    ...(db && dbTeamId && { db: { db, teamId: dbTeamId, agentId } })
  });

  // Start the server
  await server.start(port);

  // A pre-registered managed worker may publish "running" only while the
  // generation it was launched with is still current. Do this after the HTTP
  // listener binds so a failed startup never leaves a durable false-positive.
  if (isPreRegistered && db) {
    try {
      let activated = true;
      if (processGeneration) {
        activated = await db.agents.updateOwnedProcessState(
          agentId,
          processGeneration,
          'running',
        );
      } else {
        await db.agents.updateStatus(agentId, 'running');
      }
      if (!activated) {
        throw new Error(
          `stale managed worker generation ${processGeneration} cannot become running`,
        );
      }
      console.log(`📦 Updated status to running in database`);
    } catch (error) {
      await server.stop().catch(() => {});
      await db.close().catch(() => {});
      throw error;
    }
  }

  // Register with manager (only if not pre-registered)
  if (!isPreRegistered) {
    try {
      await registerWithManager(managerUrl, agentId, name, team, port, runtime);
    } catch (err) {
      console.warn(`⚠️  Could not register with manager: ${err}`);
      console.log(`   Agent is running but may not be discoverable by other agents.`);
      console.log(`   Make sure the manager is running at ${managerUrl}`);
    }
  } else {
    console.log(`✅ Agent pre-registered with manager (ID: ${agentId})`);
  }

  // Always publish our process pid to the manager so the TUI / health probes
  // can do per-agent RSS lookups. Pre-registered and self-registered flows
  // both hit this path since the manager-side metadata was written before we
  // existed; without this the pid field stays null forever and memory shows
  // as "—" in the TUI.
  try {
    const metaRes = await fetch(`${managerUrl}/agents/${agentId}/metadata`, {
      method: 'POST',
      headers: managerWorkerRequestHeaders({
        'Content-Type': 'application/json',
        'X-Id-Team': team,
      }),
      body: JSON.stringify({ metadata: { pid: process.pid } }),
    });
    if (metaRes.ok) console.log(`📝 Published pid ${process.pid} to manager`);
  } catch {
    // Non-fatal: memory column will just show "—" until next restart.
  }

  // Create stop function for graceful shutdown
  const stop = async (opts: { restartAfterManagerStart?: boolean } = {}) => {
    console.log('\n🛑 Stopping local agent...');

    // Update database status and cancel only this process's pending queries.
    if (db && dbTeamId) {
      try {
        const transition = await transitionLocalAgentStopState({
          db,
          teamId: dbTeamId,
          agentId,
          processPid: process.pid,
          processGeneration,
          restartAfterManagerStart: opts.restartAfterManagerStart === true,
        });
        if (!transition.accepted) {
          console.log(
            processGeneration
              ? `📦 Skipped stale process exit for generation ${processGeneration}`
              : `📦 Skipped stale process exit for PID ${process.pid}`,
          );
        } else if (transition.queryIds.length > 0) {
          console.log(`📋 Cancelled ${transition.queryIds.length} pending queries`);
        }
      } catch {
        // Ignore errors
      }
    }

    // Stop the server
    await server.stop();

    // Close database connection
    if (db) {
      await db.close();
    }
  };

  return { server, port, agentId, stop };
}

/**
 * CLI entry point
 */
async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let name = args[0];
  let team = process.env.ID_TEAM || 'default';
  let port: number | undefined;
  let workingDirectory: string | undefined;
  let agentId: string | undefined;

  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--team' || args[i] === '-t') {
      team = args[++i];
    } else if (args[i] === '--port' || args[i] === '-p') {
      port = parseInt(args[++i]);
    } else if (args[i] === '--dir' || args[i] === '-d') {
      workingDirectory = args[++i];
    } else if (args[i] === '--id') {
      agentId = args[++i];
    } else if (args[i] === '--verbose' || args[i] === '-v') {
      verbose = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Local Agent Server - Run local agents using your existing CLI authentication

Usage:
  node dist/local-agent-server.js <name> [options]

Options:
  --team, -t <name>    Team name (default: ID_TEAM env or 'default')
  --port, -p <port>    Port to listen on (auto-allocated if not specified)
  --dir, -d <path>     Working directory (auto-created if not specified)
  --id <agent-id>      Pre-registered agent ID (from /deploy)
  --verbose, -v        Enable detailed logging (show tool calls, progress)
  --help, -h           Show this help message

Environment Variables:
  ID_TEAM              Default team name
  MANAGER_URL          Manager URL (default: http://localhost:4100)
  DATABASE_URL         PostgreSQL connection string (optional)
  CLAUDE_MODEL         Default model (default: claude-opus-4-20250514)
Examples:
  node dist/local-agent-server.js my-agent
  node dist/local-agent-server.js coder --team myproject --port 24001
  ID_TEAM=myteam node dist/local-agent-server.js researcher
`);
      process.exit(0);
    } else if (!args[i].startsWith('-') && !name) {
      name = args[i];
    }
  }

  if (!name) {
    console.error('❌ Missing agent name');
    console.error('Usage: node dist/local-agent-server.js <name> [--team <team>] [--port <port>]');
    process.exit(1);
  }

  const bannerName = getRuntimeDisplayName(process.env.ID_HARNESS || 'claude-code-cli');
  const bannerTitle = `🏠 Local ${bannerName} Agent Server`;
  const bannerSubtitle = `Running ${bannerName} with your local authentication`;

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║ ${bannerTitle.padEnd(61)}║
╠═══════════════════════════════════════════════════════════════╣
║ ${bannerSubtitle.padEnd(61)}║
║  Other agents can communicate via REST-AP protocol            ║
╚═══════════════════════════════════════════════════════════════╝
`);

  const { port: actualPort, agentId: finalAgentId, stop } = await startLocalAgent({
    name,
    team,
    port,
    workingDirectory,
    agentId,
    verbose
  });

  console.log(`\n📍 Agent Details:`);
  console.log(`   ID:      ${finalAgentId}`);
  console.log(`   Name:    ${name}`);
  console.log(`   Team:    ${team}`);
  console.log(`   Port:    ${actualPort}`);
  console.log(`   URL:     http://localhost:${actualPort}`);
  console.log(`   REST-AP: http://localhost:${actualPort}/.well-known/restap.json`);
  console.log(`\n🎯 Talk to this agent:`);
  console.log(`   curl -X POST http://localhost:${actualPort}/talk \\`);
  console.log(`     -H "Content-Type: application/json" \\`);
  console.log(`     -d '{"message": "Hello!"}'`);
  console.log('\nPress Ctrl+C to stop the agent\n');

  // Handle shutdown gracefully
  let shuttingDown = false;
  let stopParentWatchdog = () => {};
  const shutdown = async (reason: 'signal' | 'parent-exit' = 'signal') => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopParentWatchdog();
    await stop({ restartAfterManagerStart: reason === 'parent-exit' });
    process.exit(0);
  };

  stopParentWatchdog = startParentDeathWatchdog(() => shutdown('parent-exit'));
  process.on('SIGINT', () => { void shutdown('signal'); });
  process.on('SIGTERM', () => { void shutdown('signal'); });

  // Keep the process alive
  const heartbeat = setInterval(() => {}, 1000 * 60 * 60);
  process.on('exit', () => {
    stopParentWatchdog();
    clearInterval(heartbeat);
  });
}

// Run if called directly
if (isDirectEntrypoint(import.meta.url)) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
