/**
 * Loader Service — a minimal, rock-solid process that can restart the manager.
 *
 * Pure Node.js, zero dependencies from the main codebase.
 * Designed to run as a systemd service with Restart=always.
 *
 * Port: 3100 (configurable via LOADER_PORT env var)
 */

import crypto from 'node:crypto';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { nodeOptionsForManager } from './lib/resource-limits.js';
import { liveOriginalManagerPids, normalizeOriginalManagerPids } from './lib/manager-restart-guard.js';

const LOADER_PORT = parseInt(process.env.LOADER_PORT || '3100');
const MANAGER_PORT = parseInt(process.env.AGENT_MANAGER_PORT || '4100');
// Trusted local setup — no auth
const WORK_DIR = process.env.LOADER_WORK_DIR || process.cwd();
const LOG_FILE = process.env.MANAGER_LOG_FILE || '/tmp/manager.log';
const MANAGER_LAUNCHD_LABEL = process.env.MANAGER_LAUNCHD_LABEL || 'io.bittrees.idagents-manager';
const MANAGER_SHUTDOWN_TIMEOUT_MS = Math.max(5_000, parseInt(process.env.MANAGER_SHUTDOWN_TIMEOUT_MS || '30000'));
const MANAGER_RESTART_COOLDOWN_MS = Math.max(0, parseInt(process.env.MANAGER_RESTART_COOLDOWN_MS || '30000'));

type RestartResult = {
  success: boolean;
  wasRunning: boolean;
  pid?: number;
  mode: 'launchd' | 'detached';
  message: string;
};

let restartInFlight: Promise<RestartResult> | null = null;
let lastRestartCompletedAt = 0;

function log(msg: string) {
  console.log(`[Loader] ${msg}`);
}

function safeCompare(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function checkAuth(_req: http.IncomingMessage): boolean {
  return true; // Trusted local setup
}

function json(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function pingManager(): Promise<{ ok: boolean; data?: unknown }> {
  try {
    const resp = await fetch(`http://localhost:${MANAGER_PORT}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) return { ok: true, data: await resp.json() };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

function listPidsListeningOnManagerPort(): string[] {
  try {
    const pids = execFileSync('lsof', [`-tiTCP:${MANAGER_PORT}`, '-sTCP:LISTEN'], { encoding: 'utf-8' }).trim();
    return pids.split('\n').map(pid => pid.trim()).filter(Boolean);
  } catch {
    return [];
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

function launchdTarget(): string {
  const uid = process.getuid?.() ?? execFileSync('id', ['-u'], { encoding: 'utf8' }).trim();
  return `gui/${uid}/${MANAGER_LAUNCHD_LABEL}`;
}

function launchdOwnsManager(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('launchctl', ['print', launchdTarget()], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function waitForPidsToExit(pids: number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every(pid => !pidIsAlive(pid))) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return pids.every(pid => !pidIsAlive(pid));
}

async function killManager(): Promise<boolean> {
  const myPid = process.pid;
  const pids = listPidsListeningOnManagerPort();
  if (pids.length === 0) {
    log('No process on manager port');
    return true; // nothing running
  }

  const pidList = normalizeOriginalManagerPids(pids, myPid);
  if (pidList.length === 0) {
    log('No manager process found (only self)');
    return true;
  }

  for (const pid of pidList) {
    log(`Sending SIGTERM to ${pid}`);
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }

  if (await waitForPidsToExit(pidList, MANAGER_SHUTDOWN_TIMEOUT_MS)) return true;

  // Never re-query the port here: launchd may already have placed a healthy
  // replacement on it. A force kill may target only the original process set.
  for (const pid of liveOriginalManagerPids(pidList, pidIsAlive)) {
    log(`Force killing ${pid}`);
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  return true;
}

async function restartLaunchdManager(wasRunning: boolean): Promise<RestartResult> {
  const target = launchdTarget();
  const originalPids = normalizeOriginalManagerPids(listPidsListeningOnManagerPort(), process.pid);

  if (originalPids.length > 0) {
    log(`Requesting graceful launchd restart for ${target} (pid${originalPids.length === 1 ? '' : 's'} ${originalPids.join(', ')})`);
    execFileSync('launchctl', ['kill', 'SIGTERM', target], { stdio: 'ignore' });
    if (!await waitForPidsToExit(originalPids, MANAGER_SHUTDOWN_TIMEOUT_MS)) {
      log('Graceful shutdown timed out; asking launchd to stop its managed service');
      execFileSync('launchctl', ['kill', 'SIGKILL', target], { stdio: 'ignore' });
      await waitForPidsToExit(originalPids, 5_000);
    }
  } else {
    log(`Manager is down; requesting launchd start for ${target}`);
    execFileSync('launchctl', ['kickstart', target], { stdio: 'ignore' });
  }

  const started = await waitForManager();
  const pid = listPidsListeningOnManagerPort()
    .map(value => parseInt(value, 10))
    .find(value => Number.isInteger(value) && value > 0);
  return {
    success: started,
    wasRunning,
    pid,
    mode: 'launchd',
    message: started ? 'Manager restarted successfully' : 'Manager failed to start (check launchd and manager logs)',
  };
}

function startManager(): { pid: number | undefined } {
  const managerScript = path.join(WORK_DIR, 'dist', 'start-agent-manager.js');
  log(`Starting manager script: ${managerScript}`);
  // Load .env file into environment if it exists
  const env = { ...process.env };
  try {
    const envContent = readFileSync(path.join(WORK_DIR, '.env'), 'utf-8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        // Strip surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        env[key] = val;
      }
    }
  } catch {
    // No .env file, that's fine
  }

  const logFd = openSync(LOG_FILE, 'a');
  const child = spawn('node', [managerScript], {
    cwd: WORK_DIR,
    env: {
      ...env,
      NODE_OPTIONS: nodeOptionsForManager(env.NODE_OPTIONS),
    },
    stdio: ['ignore', logFd, logFd],
    detached: true,
  });
  child.unref();
  closeSync(logFd);
  log(`Spawned with pid ${child.pid}`);
  return { pid: child.pid };
}

async function waitForManager(maxAttempts = 30, intervalMs = 1000): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs));
    const { ok } = await pingManager();
    if (ok) return true;
  }
  return false;
}

async function restartManager(): Promise<RestartResult> {
  const wasRunning = (await pingManager()).ok;
  log(`Manager was ${wasRunning ? 'running' : 'down'}`);

  if (launchdOwnsManager()) return restartLaunchdManager(wasRunning);

  await killManager();
  log('Old process stopped');
  const { pid } = startManager();
  const started = await waitForManager();
  return {
    success: started,
    wasRunning,
    pid,
    mode: 'detached',
    message: started ? 'Manager restarted successfully' : 'Manager failed to start (check /logs)',
  };
}

function readLogs(lines = 50): string[] {
  try {
    const content = readFileSync(LOG_FILE, 'utf-8');
    return content.split('\n').slice(-lines).filter(Boolean);
  } catch {
    return ['(no log file found)'];
  }
}

// Catch unhandled errors to prevent crashes
process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err.message}`);
});
process.on('unhandledRejection', (reason) => {
  log(`Unhandled rejection: ${reason}`);
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://localhost:${LOADER_PORT}`);

    // Health — always open
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { status: 'ok', service: 'loader', port: LOADER_PORT });
    }

    // Auth check for everything else
    if (!checkAuth(req)) {
      return json(res, 401, { error: 'unauthorized' });
    }

    // Manager status
    if (req.method === 'GET' && url.pathname === '/manager-status') {
      const result = await pingManager();
      return json(res, 200, { running: result.ok, manager: result.data || null });
    }

    // Manager logs
    if (req.method === 'GET' && url.pathname === '/logs') {
      const lines = parseInt(url.searchParams.get('lines') || '50');
      return json(res, 200, { logs: readLogs(lines) });
    }

    // Restart manager
    if (req.method === 'POST' && url.pathname === '/restart-manager') {
      const now = Date.now();
      if (!restartInFlight && lastRestartCompletedAt > 0 && now - lastRestartCompletedAt < MANAGER_RESTART_COOLDOWN_MS) {
        const manager = await pingManager();
        return json(res, manager.ok ? 200 : 429, {
          success: manager.ok,
          coalesced: true,
          message: manager.ok ? 'Manager was restarted recently and is healthy' : 'Manager restart is cooling down',
        });
      }

      const coalesced = restartInFlight != null;
      if (!restartInFlight) {
        log('Restart requested');
        restartInFlight = restartManager().finally(() => {
          lastRestartCompletedAt = Date.now();
          restartInFlight = null;
        });
      }

      const result = await restartInFlight;
      log(result.success ? 'Manager is up' : 'Manager failed to start');
      return json(res, result.success ? 200 : 503, { ...result, coalesced });
    }

    json(res, 404, { error: 'not found' });
  } catch (err: any) {
    log(`Request error: ${err.message}`);
    json(res, 500, { error: err.message });
  }
});

server.listen(LOADER_PORT, '127.0.0.1', () => {
  log(`Listening on port ${LOADER_PORT}`);
  log(`Manager port: ${MANAGER_PORT}`);
  log(`Work dir: ${WORK_DIR}`);
});
