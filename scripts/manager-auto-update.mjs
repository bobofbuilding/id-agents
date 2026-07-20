#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SOURCE = 'https://github.com/bobofbuilding/id-agents.git';
const DEFAULT_SERVICE_LABEL = 'io.bittrees.idagents-manager';
const DEFAULT_INTERVAL_STATE = join(homedir(), '.id-agents', 'manager-update.json');
const DEFAULT_LOCK = join(homedir(), '.id-agents', 'manager-update.lock');
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;

function usage() {
  console.log(`Usage: node scripts/manager-auto-update.mjs [options]

Safely fast-forward a managed ID Agents checkout to the latest tagged release
on its tracked branch, build it, and restart the launchd service once no manager
queries are active.

Options:
  --target <dir>          Manager checkout. Default: this repository.
  --source <url>          Expected origin. Default: ${DEFAULT_SOURCE}
  --branch <name>         Tracked branch. Default: main.
  --manager-url <url>     Health endpoint base. Default: http://127.0.0.1:4100.
  --service-label <name>  launchd label. Default: ${DEFAULT_SERVICE_LABEL}
  --state <file>          Update state file. Default: ${DEFAULT_INTERVAL_STATE}
  --lock <dir>            Single-flight lock directory. Default: ${DEFAULT_LOCK}
  --dry-run               Fetch and validate without changing the checkout.
  --no-restart            Build updates but leave activation pending.
  --help                  Show this help.
`);
}

export function parseArgs(argv, env = process.env) {
  const opts = {
    target: SCRIPT_ROOT,
    source: DEFAULT_SOURCE,
    branch: 'main',
    managerUrl: 'http://127.0.0.1:4100',
    serviceLabel: DEFAULT_SERVICE_LABEL,
    state: DEFAULT_INTERVAL_STATE,
    lock: DEFAULT_LOCK,
    dryRun: false,
    restart: true,
  };
  const valueAfter = (arg, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { ...opts, help: true };
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--no-restart') opts.restart = false;
    else if (arg === '--target') opts.target = valueAfter(arg, i++);
    else if (arg === '--source') opts.source = valueAfter(arg, i++);
    else if (arg === '--branch') opts.branch = valueAfter(arg, i++);
    else if (arg === '--manager-url') opts.managerUrl = valueAfter(arg, i++).replace(/\/+$/, '');
    else if (arg === '--service-label') opts.serviceLabel = valueAfter(arg, i++);
    else if (arg === '--state') opts.state = valueAfter(arg, i++);
    else if (arg === '--lock') opts.lock = valueAfter(arg, i++);
    else throw new Error(`Unknown option: ${arg}`);
  }
  opts.target = resolve(opts.target);
  opts.state = resolve(opts.state);
  opts.lock = resolve(opts.lock);
  return opts;
}

function run(command, args, options = {}) {
  const output = execFileSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
  return typeof output === 'string' ? output.trim() : '';
}

function tryRun(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
}

function normalizeRemote(value) {
  return String(value || '')
    .trim()
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function readState(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

function acquireLock(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(path);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const age = Date.now() - statSync(path).mtimeMs;
    if (age < 2 * 60 * 60 * 1000) return false;
    rmSync(path, { recursive: true, force: true });
    mkdirSync(path);
  }
  writeFileSync(join(path, 'pid'), `${process.pid}\n`);
  return true;
}

export function validateReleaseSnapshot({ version, subject, changelog, tags }) {
  if (!RELEASE_VERSION.test(version)) throw new Error(`Invalid release version: ${version}`);
  if (!subject.startsWith(`v${version}: `)) {
    throw new Error(`Release commit subject must start with v${version}: `);
  }
  if (!changelog.includes(`## [${version}]`)) {
    throw new Error(`CHANGELOG.md has no ## [${version}] entry`);
  }
  if (!tags.includes(`v${version}`)) {
    throw new Error(`Target commit is not tagged v${version}`);
  }
}

function validateTargetRelease(target, ref) {
  const packageJson = JSON.parse(run('git', ['show', `${ref}:package.json`], { cwd: target }));
  const version = String(packageJson.version || '');
  validateReleaseSnapshot({
    version,
    subject: run('git', ['show', '-s', '--format=%s', ref], { cwd: target }),
    changelog: run('git', ['show', `${ref}:CHANGELOG.md`], { cwd: target }),
    tags: run('git', ['tag', '--points-at', ref], { cwd: target }).split(/\s+/).filter(Boolean),
  });
  return version;
}

async function health(managerUrl) {
  try {
    const response = await fetch(`${managerUrl}/health`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return { healthy: false };
    const body = await response.json();
    return {
      healthy: body?.status === 'ok' || body?.ok === true,
      activeQueries: Number.isFinite(Number(body?.activeQueries)) ? Number(body.activeQueries) : undefined,
    };
  } catch {
    return { healthy: false };
  }
}

export async function localActiveQueryCount(env = process.env) {
  if (env.DATABASE_URL) return undefined;
  const databasePath = resolve(env.SQLITE_PATH || join(env.HOME || homedir(), '.id-agents', 'id-agents.db'));
  if (!existsSync(databasePath)) return undefined;
  let database;
  try {
    const { default: Database } = await import('better-sqlite3');
    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    database.pragma('busy_timeout = 100');
    const row = database.prepare(
      `SELECT COUNT(*) AS count
       FROM queries
       WHERE status IN ('pending', 'processing')`,
    ).get();
    return Number(row?.count ?? 0);
  } catch {
    return undefined;
  } finally {
    try { database?.close(); } catch { /* read-only fallback cleanup is best-effort */ }
  }
}

async function waitForHealth(managerUrl, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await health(managerUrl)).healthy) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  return false;
}

function serviceTarget(label) {
  if (typeof process.getuid !== 'function') return '';
  return `gui/${process.getuid()}/${label}`;
}

function restartService(label) {
  const target = serviceTarget(label);
  if (!target || !tryRun('launchctl', ['print', target]).ok) return false;
  run('launchctl', ['kickstart', '-k', target]);
  return true;
}

export async function updateManager(opts) {
  if (!existsSync(join(opts.target, '.git'))) throw new Error(`Not a git checkout: ${opts.target}`);
  const origin = run('git', ['remote', 'get-url', 'origin'], { cwd: opts.target });
  if (normalizeRemote(origin) !== normalizeRemote(opts.source)) {
    throw new Error(`Unexpected origin ${origin}; expected ${opts.source}`);
  }
  const branch = run('git', ['branch', '--show-current'], { cwd: opts.target });
  if (branch !== opts.branch) throw new Error(`Checkout is on ${branch || 'detached HEAD'}; expected ${opts.branch}`);
  const trackedStatus = run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: opts.target });
  if (trackedStatus) throw new Error(`Tracked manager files are modified; update refused:\n${trackedStatus}`);

  run('git', ['fetch', 'origin', opts.branch, '--tags', '--prune'], { cwd: opts.target, inherit: true });
  const targetRef = `origin/${opts.branch}`;
  const targetCommit = run('git', ['rev-parse', targetRef], { cwd: opts.target });
  const currentCommit = run('git', ['rev-parse', 'HEAD'], { cwd: opts.target });
  const version = validateTargetRelease(opts.target, targetRef);
  const state = readState(opts.state);

  const needsCheckoutUpdate = targetCommit !== currentCommit;
  const needsBuild = needsCheckoutUpdate || state.commit !== targetCommit;
  if (needsCheckoutUpdate) {
    if (!tryRun('git', ['merge-base', '--is-ancestor', currentCommit, targetCommit], { cwd: opts.target }).ok) {
      throw new Error('Local manager history has diverged; automatic update refused');
    }
    if (opts.dryRun) {
      return { status: 'available', version, currentCommit, targetCommit };
    }
    run('git', ['merge', '--ff-only', targetRef], { cwd: opts.target, inherit: true });
  }
  if (needsBuild) {
    if (opts.dryRun) {
      return { status: needsCheckoutUpdate ? 'available' : 'build-required', version, currentCommit, targetCommit };
    }
    run('npm', ['ci'], { cwd: opts.target, inherit: true });
    run('npm', ['run', 'verify:release-schema'], { cwd: opts.target, inherit: true });
    run('npm', ['run', 'build'], { cwd: opts.target, inherit: true });
    writeState(opts.state, {
      status: 'restart-pending',
      version,
      commit: targetCommit,
      builtAt: new Date().toISOString(),
    });
  } else if (state.status !== 'restart-pending') {
    return { status: 'current', version, commit: targetCommit };
  }

  if (opts.dryRun || !opts.restart) {
    return { status: 'restart-pending', version, commit: targetCommit };
  }
  const readiness = await health(opts.managerUrl);
  if (readiness.activeQueries === undefined) {
    readiness.activeQueries = await localActiveQueryCount();
  }
  if (readiness.activeQueries === undefined) {
    writeState(opts.state, {
      status: 'restart-pending',
      version,
      commit: targetCommit,
      reason: readiness.healthy ? 'active-query-count-unavailable' : 'manager-unavailable',
      deferredAt: new Date().toISOString(),
    });
    return {
      status: 'deferred',
      version,
      commit: targetCommit,
      reason: readiness.healthy ? 'active-query-count-unavailable' : 'manager-unavailable',
    };
  }
  if (readiness.activeQueries > 0) {
    writeState(opts.state, {
      status: 'restart-pending',
      version,
      commit: targetCommit,
      activeQueries: readiness.activeQueries,
      deferredAt: new Date().toISOString(),
    });
    return { status: 'deferred', version, commit: targetCommit, activeQueries: readiness.activeQueries };
  }
  if (!restartService(opts.serviceLabel)) {
    writeState(opts.state, { status: 'restart-pending', version, commit: targetCommit, reason: 'service-not-loaded' });
    return { status: 'restart-pending', version, commit: targetCommit };
  }
  if (!await waitForHealth(opts.managerUrl)) {
    throw new Error(`Manager did not become healthy after activating v${version}`);
  }
  writeState(opts.state, {
    status: 'current',
    version,
    commit: targetCommit,
    activatedAt: new Date().toISOString(),
  });
  return { status: 'updated', version, commit: targetCommit };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }
  if (!acquireLock(opts.lock)) {
    console.log('Manager update already running; skipping this cycle.');
    return;
  }
  try {
    const result = await updateManager(opts);
    console.log(JSON.stringify(result));
  } finally {
    rmSync(opts.lock, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`manager-auto-update: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
