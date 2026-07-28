#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const repo = resolve(import.meta.dirname, '..');
const entry = join(repo, 'dist', 'start-agent-manager.js');
const workerAuthEntry = join(repo, 'dist', 'manager-worker-auth.js');
assert.equal(existsSync(entry), true, 'build the Manager before running the lifecycle smoke');
assert.equal(existsSync(workerAuthEntry), true, 'build the Manager before running the lifecycle smoke');
const {
  deriveManagerAgentToken,
  MANAGER_TASK_RECEIPT_SERVICE,
} = await import(pathToFileURL(workerAuthEntry).href);

function reservePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('could not reserve a Manager port'));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitFor(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
}

async function jsonRequest(baseUrl, token, path, options = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method: options.method || 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(options.timeoutMs || 5_000),
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-id-admin': '1',
      'x-id-team': 'default',
      authorization: `Bearer ${token}`,
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  return { status: response.status, body };
}

async function workerHealthRequest(baseUrl, headers = {}) {
  const response = await fetch(new URL('/health', baseUrl), {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
    headers: {
      accept: 'application/json',
      ...headers,
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  return { status: response.status, body };
}

function startManager(env) {
  const child = spawn(process.execPath, [entry], {
    cwd: repo,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', chunk => { output = `${output}${chunk}`.slice(-64 * 1024); });
  child.stderr.on('data', chunk => { output = `${output}${chunk}`.slice(-64 * 1024); });
  return { child, output: () => output };
}

async function stopManager(handle) {
  if (handle.child.exitCode === null && handle.child.signalCode === null) {
    handle.child.kill('SIGTERM');
  }
  await waitFor(
    () => handle.child.exitCode !== null || handle.child.signalCode !== null,
    10_000,
    `Manager did not stop\n${handle.output()}`,
  );
}

const scratch = mkdtempSync(join(tmpdir(), 'idagents-local-lifecycle-'));
const managerPort = await reservePort();
const managerUrl = `http://127.0.0.1:${managerPort}`;
const token = randomBytes(32).toString('base64url');
const workspace = join(scratch, 'workspace with spaces');
const logRoot = join(scratch, 'private logs', 'agents');
mkdirSync(join(scratch, 'manager'), { recursive: true, mode: 0o700 });
const env = {
  ...process.env,
  AGENT_MANAGER_PORT: String(managerPort),
  AGENT_MANAGER_WORKDIR: workspace,
  ID_WORKSPACE_DIR: workspace,
  SQLITE_PATH: join(scratch, 'manager', 'id-agents.db'),
  IDACC_AGENT_LOG_DIR: logRoot,
  IDACC_ADMIN_TOKEN: token,
  IDACC_MANAGER_SERVICE_TOKEN: `${token}-manager-service-separation`,
  ID_MANAGER_ALLOW_DUPLICATE_START: 'true',
  ID_IDLE_PARK_DISABLED: '1',
};

let manager;
let stoppedPid;
let restartPid;
try {
  manager = startManager(env);
  await waitFor(async () => {
    const response = await fetch(`${managerUrl}/health`, { signal: AbortSignal.timeout(500) });
    return response.ok;
  }, 20_000, `Manager did not become healthy\n${manager.output()}`);

  const firstName = `portable-stop-${process.pid}`;
  const first = await jsonRequest(managerUrl, token, '/agents/spawn', {
    method: 'POST',
    timeoutMs: 20_000,
    body: { name: firstName, runtime: 'ollama', local: true, start: true },
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.status, 'running');
  stoppedPid = Number(first.body.pid);
  assert.equal(Number.isInteger(stoppedPid) && stoppedPid > 0, true);
  const firstWorkerUrl = `http://127.0.0.1:${first.body.port}`;
  const anonymousHealth = await workerHealthRequest(firstWorkerUrl);
  assert.equal(anonymousHealth.status, 200);
  assert.deepEqual(anonymousHealth.body, { status: 'ok' });

  const rejectedAdminHealth = await jsonRequest(firstWorkerUrl, token, '/health');
  assert.equal(rejectedAdminHealth.status, 401);
  assert.deepEqual(rejectedAdminHealth.body, { error: 'managed_worker_auth_required' });

  const firstAssignment = await jsonRequest(
    managerUrl,
    token,
    `/agents/${encodeURIComponent(first.body.id)}`,
  );
  assert.equal(firstAssignment.status, 200, JSON.stringify(firstAssignment.body));
  const firstGeneration = firstAssignment.body.metadata?.processGeneration;
  assert.equal(typeof first.body.teamId, 'string');
  assert.equal(typeof first.body.teamName, 'string');
  assert.equal(typeof firstGeneration, 'string');
  assert.equal(firstGeneration.length > 0, true);
  const firstHealth = await workerHealthRequest(firstWorkerUrl, {
    authorization: `Bearer ${deriveManagerAgentToken(
      token,
      first.body.teamId,
      first.body.id,
      firstGeneration,
    )}`,
    'x-id-service': MANAGER_TASK_RECEIPT_SERVICE,
    'x-id-agent': first.body.id,
    'x-id-team': first.body.teamName,
  });
  assert.equal(firstHealth.status, 200, JSON.stringify(firstHealth.body));
  assert.equal(firstHealth.body.agent, firstName);
  assert.equal(firstHealth.body.agentId, first.body.id);
  assert.equal(Number(firstHealth.body.pid), stoppedPid);
  const firstLog = join(logRoot, `agent-${String(first.body.id).toLowerCase()}.log`);
  assert.equal(existsSync(firstLog), true);
  if (process.platform !== 'win32') {
    assert.equal(statSync(firstLog).mode & 0o777, 0o600);
  }
  const stopped = await jsonRequest(managerUrl, token, '/remote', {
    method: 'POST',
    body: { command: `/agent ${firstName} stop` },
  });
  assert.equal(stopped.body.ok, true, JSON.stringify(stopped.body));
  assert.equal(stopped.body.result.pids.includes(stoppedPid), true);
  await waitFor(() => !processAlive(stoppedPid), 5_000, 'explicit stop leaked the local worker');

  const restartName = `portable-restart-${process.pid}`;
  const second = await jsonRequest(managerUrl, token, '/agents/spawn', {
    method: 'POST',
    timeoutMs: 20_000,
    body: { name: restartName, runtime: 'ollama', local: true, start: true },
  });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  restartPid = Number(second.body.pid);
  assert.equal(processAlive(restartPid), true);

  await stopManager(manager);
  await waitFor(() => !processAlive(restartPid), 5_000, 'Manager shutdown leaked its local worker');

  manager = startManager(env);
  await waitFor(async () => {
    const response = await fetch(`${managerUrl}/health`, { signal: AbortSignal.timeout(500) });
    return response.ok;
  }, 20_000, `restarted Manager did not become healthy\n${manager.output()}`);
  const restored = await waitFor(async () => {
    const response = await jsonRequest(managerUrl, token, '/agents');
    const agents = Array.isArray(response.body) ? response.body : response.body.agents;
    return agents?.find(agent => agent.name === restartName && agent.status === 'running');
  }, 15_000, 'Manager did not restore its previously running worker');
  assert.notEqual(Number(restored.pid), restartPid);
  assert.equal(processAlive(Number(restored.pid)), true);

  const finalStop = await jsonRequest(managerUrl, token, '/remote', {
    method: 'POST',
    body: { command: `/agent ${restartName} stop` },
  });
  assert.equal(finalStop.body.ok, true, JSON.stringify(finalStop.body));
  await waitFor(() => !processAlive(Number(restored.pid)), 5_000, 'restored worker did not stop');
  await stopManager(manager);
  manager = undefined;

  const logText = readFileSync(join(logRoot, `agent-${String(second.body.id).toLowerCase()}.log`), 'utf8');
  assert.match(logText, /Listening on http:\/\/localhost:/);
  console.log('local agent packaged-runtime lifecycle smoke: ok');
} finally {
  if (manager) {
    try { await stopManager(manager); } catch {
      try { manager.child.kill('SIGKILL'); } catch {}
    }
  }
  for (const pid of [stoppedPid, restartPid]) {
    if (pid && processAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }
  rmSync(scratch, { recursive: true, force: true });
}
