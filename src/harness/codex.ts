// SPDX-License-Identifier: MIT
/**
 * Codex CLI Harness
 *
 * Wraps the OpenAI Codex CLI (`codex exec`) for agents.
 * Supports both API key auth (OPENAI_API_KEY) and OAuth login (codex login).
 *
 * Spawns `codex exec --json --cd <dir> -` and sends each request over stdin.
 * Parses JSONL output and yields HarnessMessage objects.
 *
 * Session support:
 * - Runs each request as a fresh `codex exec` invocation
 * - Ignores resume IDs because the installed Codex CLI does not support
 *   combining `resume` with the non-interactive flags used here
 */

import { ChildProcess } from 'child_process';
import { AgentHarness, HarnessOptions, HarnessMessage, HarnessType, McpServerSpec } from './types.js';
import { reportTurnUsage } from './usage-report.js';
import { terminateChildProcessTree } from './claude-code-cli.js';
import { detectClaudeCliRateLimit } from './rate-limit.js';
import { resolveExecutable } from '../lib/executable-resolution.js';
import { portableSpawn, portableSpawnSync } from '../lib/portable-spawn.js';
import {
  atomicWritePrivateFile,
  ensurePrivateDirectory,
  lstatIfExists,
  stableProfileOwnerKey,
} from '../lib/profile-storage.js';
import {
  materializeCodexProviderEntry,
  captureCodexAuthReconciliation,
  linkCodexProfileSessionDirectory,
  migrateExactLegacyCodexSession,
  reconcileCodexAuthAfterRun,
  removeCodexRunHomeNoFollow,
  removeMaterializedCodexProviderFile,
  type CodexAuthReconciliation,
  type ProviderEntryMaterialization,
  type ProviderSharingMode,
} from './codex-profile-storage.js';
import { randomBytes } from 'node:crypto';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

interface ResolvedCodexExecutable {
  command: string;
  display: string;
  native: boolean;
  managedPackageRoot?: string;
}

export function codexPermissionArgs(input: {
  skipPermissions: boolean;
  resumeId?: string;
  executionPolicy?: HarnessOptions['executionPolicy'];
}): { args: string[]; label: string } {
  if (input.executionPolicy === 'external-text-only') {
    throw new Error(
      'Codex CLI cannot guarantee a zero-local-tool text-only execution policy; refusing to run external content',
    );
  }
  if (input.executionPolicy === 'control-plane-readonly') {
    return {
      args: ['-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"'],
      label: 'read-only control-plane sandbox',
    };
  }
  if (input.skipPermissions) {
    return {
      args: ['--dangerously-bypass-approvals-and-sandbox'],
      label: '--dangerously-bypass-approvals-and-sandbox (default)',
    };
  }
  if (input.resumeId) {
    return { args: [], label: 'resumed session policy (resume has no --full-auto)' };
  }
  return { args: ['--full-auto'], label: '--full-auto (config opt-out)' };
}

export function codexReasoningEffort(raw: string | undefined): 'low' | 'medium' | 'high' | undefined {
  if (!raw || !/^(minimal|low|medium|high|xhigh)$/.test(raw)) return undefined;
  if (raw === 'minimal') return 'low';
  if (raw === 'xhigh') return 'high';
  if (raw === 'low' || raw === 'medium' || raw === 'high') return raw;
  return undefined;
}

export interface CodexStdinInvocation {
  args: string[];
  stdin: string;
}

/** Keep complete prompts on stdin and out of argv/shared temporary files. */
export function codexStdinInvocation(args: string[], prompt: string): CodexStdinInvocation {
  return {
    args: [...args, '-'],
    stdin: prompt,
  };
}

function isExecutable(file: string): boolean {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    if (process.platform === 'win32') return true;
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function codexPlatformTarget(): { packageName: string; triple: string; binary: string } | undefined {
  const binary = process.platform === 'win32' ? 'codex.exe' : 'codex';
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return { packageName: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin', binary };
  }
  if (process.platform === 'darwin' && process.arch === 'x64') {
    return { packageName: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin', binary };
  }
  if (process.platform === 'linux' && process.arch === 'arm64') {
    return { packageName: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl', binary };
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return { packageName: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl', binary };
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    return { packageName: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc', binary };
  }
  return undefined;
}

function nativeCodexFromShim(shimPath: string): ResolvedCodexExecutable | undefined {
  const target = codexPlatformTarget();
  if (!target) return undefined;

  let realShim = shimPath;
  try { realShim = fs.realpathSync(shimPath); } catch { /* best effort */ }
  const packageRoot = path.resolve(path.dirname(realShim), '..');
  const candidates = [
    path.join(packageRoot, 'node_modules', target.packageName, 'vendor', target.triple, 'bin', target.binary),
    path.join(packageRoot, 'vendor', target.triple, 'bin', target.binary),
  ];
  const command = candidates.find(isExecutable);
  if (!command) return undefined;

  return {
    command,
    display: command,
    native: true,
    managedPackageRoot: packageRoot,
  };
}

export function resolveCodexExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ResolvedCodexExecutable {
  const override = env.ID_AGENT_CODEX_BIN || env.CODEX_BIN || env.CODEX_EXECUTABLE;
  if (override) {
    const command = resolveExecutable(override, { env, platform }) || override;
    return {
      command,
      display: command,
      native: path.basename(command).startsWith('codex') && command !== 'codex' && !/\.(?:cmd|bat)$/i.test(command),
    };
  }

  const shim = resolveExecutable('codex', { env, platform });
  if (shim) {
    const native = nativeCodexFromShim(shim);
    if (native) return native;
    return {
      command: shim,
      display: shim,
      native: false,
    };
  }

  return { command: 'codex', display: 'codex', native: false };
}

const MIN_CODEX_VERSION_FOR_GPT56 = '0.144.0';

function parseVersion(raw: string | undefined): [number, number, number] | null {
  const m = String(raw || '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareVersions(a: string | undefined, b: string): number {
  const av = parseVersion(a);
  const bv = parseVersion(b);
  if (!av || !bv) return -1;
  for (let i = 0; i < 3; i++) {
    if (av[i] !== bv[i]) return av[i] > bv[i] ? 1 : -1;
  }
  return 0;
}

export function codexVersion(command: string): string | undefined {
  try {
    // cross-spawn is required here as well as for execution: raw spawnSync
    // cannot launch the npm-generated codex.cmd shim on Windows.
    const out = portableSpawnSync(command, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3000,
      env: process.env,
    });
    return `${out.stdout || ''} ${out.stderr || ''}`.trim();
  } catch {
    return undefined;
  }
}

function cachedCodexModels(): string[] {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.codex', 'models_cache.json'), 'utf8');
    const models = (JSON.parse(raw).models ?? []) as { slug?: string; visibility?: string; priority?: number }[];
    return models
      .filter((m) => m.slug && m.visibility === 'list')
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
      .map((m) => m.slug as string);
  } catch {
    return [];
  }
}

function resolveCodexModelForCli(model: string | undefined, command: string): { model?: string; fallbackReason?: string } {
  if (!model || !/^gpt-5\.6(?:-|$)/i.test(model)) return { model };
  const cache = cachedCodexModels();
  if (cache.includes(model)) return { model };
  const version = codexVersion(command);
  if (compareVersions(version, MIN_CODEX_VERSION_FOR_GPT56) >= 0) return { model };
  const fallback = cache.find((m) => !/^gpt-5\.6(?:-|$)/i.test(m)) || 'gpt-5.5';
  return {
    model: fallback,
    fallbackReason: `${model} requires a newer Codex CLI than ${version || 'the installed version'}; using ${fallback} until Codex is updated or its model cache lists ${model}.`,
  };
}

/** TOML-encode a string scalar. */
function tomlStr(s: string): string {
  let encoded = '"';
  for (const character of s) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      throw new Error('Codex MCP configuration contains an invalid Unicode surrogate');
    }
    switch (character) {
      case '"': encoded += '\\"'; break;
      case '\\': encoded += '\\\\'; break;
      case '\b': encoded += '\\b'; break;
      case '\t': encoded += '\\t'; break;
      case '\n': encoded += '\\n'; break;
      case '\f': encoded += '\\f'; break;
      case '\r': encoded += '\\r'; break;
      default:
        if (
          codePoint <= 0x1f
          || (codePoint >= 0x7f && codePoint <= 0x9f)
        ) {
          encoded += `\\u${codePoint.toString(16).padStart(4, '0')}`;
        } else {
          encoded += character;
        }
    }
  }
  return `${encoded}"`;
}
/** Bare TOML key (no quoting needed). */
function bareKey(k: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(k);
}

/**
 * Render attached MCP servers (Modules view → metadata.mcpServers, delivered via
 * ID_MCP_SERVERS) as a TOML `[mcp_servers.*]` block for codex's config.toml.
 *
 * SECURITY: this is written to a 0600 config FILE (see prepareCodexHome), never
 * passed as `-c …env={…}` on the command line. A codex agent's argv is visible to
 * any local `ps`, so putting a server's secret env (e.g. GITHUB_PERSONAL_ACCESS_TOKEN)
 * there leaked the operator's tokens system-wide. Config-file delivery is verified
 * on codex 0.130 (the spawned stdio server receives its env from the file).
 */
function renderMcpServersToml(servers: McpServerSpec[] | undefined): string {
  if (!servers?.length) return '';
  const blocks: string[] = [];
  for (const s of servers) {
    if (!s?.name) continue;
    if (s.transport === 'sse') {
      throw new Error(
        `Codex MCP server "${s.name}" uses legacy SSE transport, which is not `
        + 'supported by this Codex runtime; configure a streamable HTTP endpoint',
      );
    }
    const key = bareKey(s.name) ? s.name : tomlStr(s.name);
    const lines: string[] = [`[mcp_servers.${key}]`];
    if (s.command) {
      lines.push(`command = ${tomlStr(s.command)}`);
      if (s.args?.length) lines.push(`args = [${s.args.map(tomlStr).join(', ')}]`);
      if (s.env && Object.keys(s.env).length) {
        lines.push(`[mcp_servers.${key}.env]`);
        for (const [k, v] of Object.entries(s.env)) {
          lines.push(`${bareKey(k) ? k : tomlStr(k)} = ${tomlStr(String(v))}`);
        }
      }
    } else if (s.url) {
      lines.push(`url = ${tomlStr(s.url)}`); // streamable HTTP MCP server
      if (s.headers && Object.keys(s.headers).length) {
        lines.push(`[mcp_servers.${key}.http_headers]`);
        for (const [header, value] of Object.entries(s.headers)) {
          lines.push(`${bareKey(header) ? header : tomlStr(header)} = ${tomlStr(String(value))}`);
        }
      }
    } else {
      continue;
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

/**
 * Build a per-agent CODEX_HOME so attached MCP servers can be configured via a
 * PRIVATE config.toml (0600) instead of the command line. Only provider login
 * auth is deliberately bridged from the operator's real ~/.codex. Sessions and
 * all IDACC-generated config, MCP secret env, goals, memories and other local
 * state remain inside the selected IDACC profile and stable agent boundary.
 *
 * Managed IDACC runs throw if the profile-owned overlay cannot be prepared.
 * Standalone runs retain the legacy undefined fallback (no MCP argv secrets).
 */
export interface CodexOverlayContext {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  /** An explicitly configured agent workspace, not an implicit process.cwd(). */
  workingDirectory?: string;
  /** Deterministic copy fallback used by tests and locked-down installations. */
  providerSharing?: ProviderSharingMode;
  /** Test/telemetry seam for bounded provider fallback copying. */
  providerCopyObserver?: (chunkBytes: number, bufferCapacity: number) => void;
  /** Deterministic run identity for focused tests; production always generates one. */
  runId?: string;
  /** Exact previously-minted runtime id requested for this invocation. */
  resumeId?: string;
  /** Provenance assertion from this exact agent's profile-owned session map. */
  resumeAuthorization?: 'agent-owned';
}

/** The sole provider-owned file shared intentionally for subscription login. */
export const CODEX_SHARED_PROVIDER_ENTRIES = Object.freeze([
  'auth.json',
]);
const CODEX_PROVIDER_MANIFEST_VERSION = 1;
const CODEX_PROVIDER_MANIFEST_NAME = '.idacc-provider-sharing-v1.json';
const CODEX_REVOCABLE_PROVIDER_ENTRIES = new Set(['auth.json']);
const CODEX_RUN_PREFIX = 'run-';
const CODEX_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CODEX_RUN_HARD_CAP = 128;

interface PreparedCodexHome {
  home: string;
  runsRoot: string;
  authReconciliation?: CodexAuthReconciliation;
}

export function resolveCodexOverlayRoot(context: CodexOverlayContext = {}): string {
  const env = context.env ?? process.env;
  const profileRoot = env.IDACC_DATA_DIR?.trim();
  if (profileRoot) {
    return path.join(path.resolve(profileRoot), 'manager', 'codex-overlays');
  }

  const configuredWorkspace = context.workingDirectory?.trim();
  if (configuredWorkspace) {
    return path.join(path.resolve(configuredWorkspace), '.idacc', 'codex-overlays');
  }

  if (env.IDACC_MANAGED_SERVICE === '1') {
    throw new Error(
      'Codex MCP overlay storage is not configured for this IDACC profile; '
      + 'set IDACC_DATA_DIR or an explicit workingDirectory',
    );
  }

  // Deliberate standalone compatibility for existing non-IDACC installations.
  return path.join(context.homeDirectory ?? os.homedir(), '.codex-idagents');
}

function resolveCodexOverlayBoundary(context: CodexOverlayContext = {}): string {
  const env = context.env ?? process.env;
  const profileRoot = env.IDACC_DATA_DIR?.trim();
  if (profileRoot) return path.resolve(profileRoot);
  const configuredWorkspace = context.workingDirectory?.trim();
  if (configuredWorkspace) return path.resolve(configuredWorkspace);
  if (env.IDACC_MANAGED_SERVICE === '1') {
    throw new Error('Codex profile boundary is unavailable in managed mode');
  }
  return path.resolve(context.homeDirectory ?? os.homedir());
}

function codexRunDirectoryName(runId?: string): string {
  if (!runId) {
    return `${CODEX_RUN_PREFIX}${Date.now().toString(36)}-${randomBytes(12).toString('hex')}`;
  }
  return `${CODEX_RUN_PREFIX}${stableProfileOwnerKey(undefined, runId, false)}`;
}

function pruneRetainedCodexRuns(runsRoot: string): void {
  const now = Date.now();
  for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith(CODEX_RUN_PREFIX)) continue;
    const candidate = path.join(runsRoot, entry.name);
    const stat = fs.lstatSync(candidate);
    if (now - stat.mtimeMs > CODEX_RUN_RETENTION_MS) {
      removeCodexRunHomeNoFollow(runsRoot, candidate);
    }
  }
  const retained = fs.readdirSync(runsRoot)
    .filter((name) => name.startsWith(CODEX_RUN_PREFIX));
  if (retained.length >= CODEX_RUN_HARD_CAP) {
    throw new Error(
      `Codex retained-run safety cap (${CODEX_RUN_HARD_CAP}) was reached; `
      + 'refusing to create another secret-bearing runtime home',
    );
  }
}

function prepareCodexRunHome(
  servers: McpServerSpec[],
  agentKey: string,
  context: CodexOverlayContext = {},
): PreparedCodexHome | undefined {
  const env = context.env ?? process.env;
  const homeDirectory = context.homeDirectory ?? os.homedir();
  let runHome: string | undefined;
  let runsRoot: string | undefined;
  try {
    const realHome = env.CODEX_HOME || path.join(homeDirectory, '.codex');
    const providerHomePresent = Boolean(lstatIfExists(realHome));
    const safeKey = stableProfileOwnerKey(
      env.ID_AGENT_ID,
      agentKey,
      env.IDACC_MANAGED_SERVICE === '1',
    );
    const overlayRoot = resolveCodexOverlayRoot({
      env,
      homeDirectory,
      workingDirectory: context.workingDirectory,
    });
    const overlayBoundary = resolveCodexOverlayBoundary({
      env,
      homeDirectory,
      workingDirectory: context.workingDirectory,
    });
    const ownerRoot = path.join(overlayRoot, safeKey);
    ensurePrivateDirectory(overlayBoundary, ownerRoot);
    const stableStateHome = path.join(ownerRoot, 'state');
    runsRoot = path.join(ownerRoot, 'runs');
    ensurePrivateDirectory(ownerRoot, stableStateHome);
    ensurePrivateDirectory(ownerRoot, runsRoot);
    pruneRetainedCodexRuns(runsRoot);

    if (
      context.resumeId
      && context.resumeAuthorization === 'agent-owned'
      && providerHomePresent
    ) {
      migrateExactLegacyCodexSession(
        realHome,
        ownerRoot,
        stableStateHome,
        context.resumeId,
        context.resumeAuthorization,
        { onChunk: context.providerCopyObserver },
      );
    }

    runHome = path.join(runsRoot, codexRunDirectoryName(context.runId));
    if (lstatIfExists(runHome)) {
      throw new Error(`Codex run identity already exists: ${path.basename(runHome)}`);
    }
    ensurePrivateDirectory(runsRoot, runHome);

    // Sessions belong to this exact profile/agent. Per-run homes bridge only
    // those stable directories, never the operator's provider-wide history.
    linkCodexProfileSessionDirectory(
      ownerRoot,
      stableStateHome,
      runHome,
      'sessions',
    );
    linkCodexProfileSessionDirectory(
      ownerRoot,
      stableStateHome,
      runHome,
      'archived_sessions',
    );

    // Share only subscription auth. Never mirror provider configuration,
    // sessions, goals, memories, databases, skills, plugins, or arbitrary future
    // CODEX_HOME entries into an IDACC profile implicitly.
    const manifestPath = path.join(runHome, CODEX_PROVIDER_MANIFEST_NAME);
    const currentManifestEntries: Record<string, ProviderEntryMaterialization> = {};
    for (const name of CODEX_SHARED_PROVIDER_ENTRIES) {
      const materialization = providerHomePresent
        ? materializeCodexProviderEntry(
          realHome,
          name,
          runsRoot,
          runHome,
          context.providerSharing,
          { onChunk: context.providerCopyObserver },
        )
        : null;
      if (materialization) {
        currentManifestEntries[name] = materialization;
      } else if (
        env.IDACC_MANAGED_SERVICE === '1'
        && CODEX_REVOCABLE_PROVIDER_ENTRIES.has(name)
      ) {
        removeMaterializedCodexProviderFile(runsRoot, runHome, name);
        delete currentManifestEntries[name];
      }
    }
    atomicWritePrivateFile(
      runsRoot,
      manifestPath,
      `${JSON.stringify({
        version: CODEX_PROVIDER_MANIFEST_VERSION,
        entries: currentManifestEntries,
      }, null, 2)}\n`,
    );

    // Exact per-dispatch config. Provider-global MCP commands, plugins, feature
    // flags and personal settings are deliberately excluded so a neutral app
    // cannot gain hidden capabilities or produce duplicate TOML tables.
    const mcp = renderMcpServersToml(servers);
    const cfgPath = path.join(runHome, 'config.toml');
    atomicWritePrivateFile(
      runsRoot,
      cfgPath,
      mcp ? `${mcp}\n` : '',
    );
    return {
      home: runHome,
      runsRoot,
      authReconciliation: providerHomePresent
        ? captureCodexAuthReconciliation(
          realHome,
          runsRoot,
          runHome,
          { onChunk: context.providerCopyObserver },
        )
        : undefined,
    };
  } catch (e) {
    if (runHome && runsRoot) {
      try { removeCodexRunHomeNoFollow(runsRoot, runHome); } catch { /* retained for startup recovery */ }
    }
    if (env.IDACC_MANAGED_SERVICE === '1') {
      throw new Error(`Codex profile-owned MCP overlay setup failed: ${(e as Error).message}`);
    }
    console.error(`[Codex] prepareCodexHome failed (${(e as Error).message}) — running without attached MCP servers rather than risk leaking secrets on argv`);
    return undefined;
  }
}

export function prepareCodexHome(
  servers: McpServerSpec[],
  agentKey: string,
  context: CodexOverlayContext = {},
): string | undefined {
  return prepareCodexRunHome(servers, agentKey, context)?.home;
}

export interface PreparedCodexRuntimeEnvironment {
  env: NodeJS.ProcessEnv;
  codexHome?: string;
  lifecycle?: PreparedCodexHome;
}

/**
 * Build the exact environment used by a Codex run. Managed workers always
 * receive a profile-owned CODEX_HOME, even when they have no attached modules;
 * standalone callers retain their historical default unless modules require an
 * overlay.
 */
export function prepareCodexRuntimeEnvironment(
  options: HarnessOptions,
  workingDirectory: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): PreparedCodexRuntimeEnvironment {
  const env = { ...baseEnv, ...(options.env || {}) } as NodeJS.ProcessEnv;
  const servers = options.mcpServers ?? [];
  const managed = env.IDACC_MANAGED_SERVICE === '1';
  if (!managed && servers.length === 0) return { env };

  const agentKey = `${env.ID_AGENT_TEAM || 'default'}__${env.ID_AGENT_NAME || path.basename(workingDirectory)}`;
  const lifecycle = prepareCodexRunHome(servers, agentKey, {
    env,
    workingDirectory,
    resumeId: options.resume,
    resumeAuthorization: options.resumeAuthorization,
  });
  const codexHome = lifecycle?.home;
  if (codexHome) env.CODEX_HOME = codexHome;
  return { env, codexHome, lifecycle };
}

// Fail-closed safeguard: a codex agent's argv is world-readable via `ps`, so a
// credential must NEVER appear there. If a secret-shaped token is found in the
// args we refuse to spawn (a regression should surface loudly, not leak silently).
// MCP secrets travel via the 0600 config file (prepareCodexHome); these patterns
// are specific enough that a normal command line won't trip them.
const SECRET_ARGV_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/,            // GitHub PAT / OAuth / refresh tokens
  /github_pat_[A-Za-z0-9_]{20,}/,          // GitHub fine-grained PAT
  /sk-(ant-)?[A-Za-z0-9_-]{20,}/,          // OpenAI / Anthropic API keys
  /AKIA[0-9A-Z]{16}/,                      // AWS access key id
  /xox[baprs]-[A-Za-z0-9-]{10,}/,          // Slack tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,    // PEM private keys
];
function assertNoSecretsInArgv(args: string[]): void {
  const joined = args.join(' ');
  for (const re of SECRET_ARGV_PATTERNS) {
    if (re.test(joined)) {
      throw new Error('refusing to spawn codex: a credential-shaped value was found on the command line — MCP secrets must be passed via the isolated config file, not argv');
    }
  }
}
/** Redact secret-shaped substrings before logging a command line. */
function redactForLog(s: string): string {
  return s
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{4})[A-Za-z0-9]{16,}/g, '$1…')
    .replace(/\b(github_pat_[A-Za-z0-9]{4})[A-Za-z0-9_]{16,}/g, '$1…')
    .replace(/\b(sk-(?:ant-)?[A-Za-z0-9]{4})[A-Za-z0-9_-]{16,}/g, '$1…')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA…')
    .replace(/\b(xox[baprs]-[A-Za-z0-9]{4})[A-Za-z0-9-]{6,}/g, '$1…')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '-----BEGIN PRIVATE KEY (redacted)-----');
}

export interface CodexHarnessDependencies {
  spawn?: typeof portableSpawn;
  terminate?: typeof terminateChildProcessTree;
}

interface CodexRunFinalizationState {
  lifecycle?: PreparedCodexHome;
  process?: ChildProcess;
  processClosed?: Promise<void>;
  closed: boolean;
}

const codexResumeTails = new Map<string, Promise<void>>();

function codexResumeSerializationKey(options: HarnessOptions): string | undefined {
  const resumeId = options.resume?.trim();
  if (!resumeId) return undefined;
  const env = { ...process.env, ...(options.env || {}) };
  const storageBoundary = env.IDACC_DATA_DIR?.trim()
    || options.workingDirectory?.trim()
    || env.CODEX_HOME?.trim()
    || os.homedir();
  const agentIdentity = env.ID_AGENT_ID?.trim()
    || `${env.ID_AGENT_TEAM || 'default'}:${env.ID_AGENT_NAME || 'agent'}`;
  return `${path.resolve(storageBoundary)}\0${agentIdentity}\0${resumeId}`;
}

async function acquireCodexResumeSerialization(
  options: HarnessOptions,
): Promise<() => void> {
  const key = codexResumeSerializationKey(options);
  if (!key) return () => {};
  const previous = codexResumeTails.get(key) ?? Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const tail = previous.then(() => gate);
  codexResumeTails.set(key, tail);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseGate();
    if (codexResumeTails.get(key) === tail) codexResumeTails.delete(key);
  };
}

export class CodexHarness implements AgentHarness {
  readonly type: HarnessType = 'codex' as HarnessType;

  private currentProcess: ChildProcess | null = null;
  private cancelled = false;
  private currentQueryId: string | undefined;
  private readonly spawnOverride?: typeof portableSpawn;
  private readonly terminateProcessTree: typeof terminateChildProcessTree;

  constructor(dependencies: CodexHarnessDependencies = {}) {
    this.spawnOverride = dependencies.spawn;
    this.terminateProcessTree = dependencies.terminate ?? terminateChildProcessTree;
  }

  async *run(prompt: string, options: HarnessOptions = {}): AsyncGenerator<HarnessMessage> {
    const finalization: CodexRunFinalizationState = { closed: false };
    const releaseResume = await acquireCodexResumeSerialization(options);
    try {
      yield* this.runInvocation(prompt, options, finalization);
    } finally {
      try {
        await this.finalizeRun(finalization);
      } finally {
        releaseResume();
      }
    }
  }

  private async *runInvocation(
    prompt: string,
    options: HarnessOptions,
    finalization: CodexRunFinalizationState,
  ): AsyncGenerator<HarnessMessage> {
    const workingDir = options.workingDirectory || process.cwd();
    this.currentQueryId = options.queryId;

    console.log(`[Codex] Starting harness`);
    console.log(`[Codex] Working directory: ${workingDir}`);
    const codexExecutable = resolveCodexExecutable();
    const modelResolution = resolveCodexModelForCli(options.model, codexExecutable.command);
    const effectiveModel = modelResolution.model;
    if (options.model) console.log(`[Codex] Model: ${options.model}`);
    if (modelResolution.fallbackReason) {
      console.warn(`[Codex] ${modelResolution.fallbackReason}`);
      yield { type: 'progress', content: modelResolution.fallbackReason };
    }

    const skipPermissions = process.env.ID_AGENT_SKIP_PERMISSIONS !== 'false';
    // A prior thread id (from a previous turn of THIS conversation) → resume it so
    // context carries over. `codex exec resume <id>` is verified on codex-cli 0.130;
    // it needs an explicit -m model (it otherwise defaults to a stale model and 400s)
    // and does NOT accept --cd / --full-auto, so we rely on the spawn cwd and, for the
    // non-bypass case, the resumed session's own recorded sandbox policy.
    const resumeId = options.resume && options.resume.trim() ? options.resume.trim() : undefined;

    // Build arguments for codex exec.
    const args: string[] = ['exec'];
    if (resumeId) {
      args.push('resume', resumeId);
    } else {
      // Working directory (only on a fresh exec; the resume subcommand has no --cd).
      args.push('--cd', workingDir);
    }

    // JSON output for parsing
    args.push('--json');

    // Model override — REQUIRED on resume (see above); harmless on fresh exec.
    if (effectiveModel) {
      args.push('--model', effectiveModel);
    }

    // Default to --dangerously-bypass-approvals-and-sandbox so background
    // agents can act without an interactive shell. The agent's
    // `dangerouslySkipPermissions: false` config opts back into --full-auto
    // (which keeps the workspace-write sandbox and on-request approval policy).
    const permission = codexPermissionArgs({ skipPermissions, resumeId, executionPolicy: options.executionPolicy });
    args.push(...permission.args);
    console.log(`[Codex] Permission mode: ${permission.label}`);

    // Skip git repo check in case working dir isn't a git repo
    args.push('--skip-git-repo-check');

    // Reasoning effort (set per-agent in the Control Center) — fewer reasoning
    // tokens at lower effort. Codex rejects `minimal` when built-in tools like
    // web_search/image_gen are available, so map minimal→low and xhigh→high.
    const eff = codexReasoningEffort(process.env.ID_AGENT_EFFORT);
    if (eff) {
      args.push('-c', `model_reasoning_effort="${eff}"`);
      console.log(`[Codex] Reasoning effort: ${eff}`);
    }

    // Managed workers always use a profile-owned CODEX_HOME, including agents
    // with zero modules. Standalone callers only need an overlay for modules.
    const preparedRuntime = prepareCodexRuntimeEnvironment(options, workingDir);
    finalization.lifecycle = preparedRuntime.lifecycle;
    const codexHome = preparedRuntime.codexHome;
    if (codexHome) {
      const moduleCount = options.mcpServers?.length ?? 0;
      console.log(
        moduleCount > 0
          ? `[Codex] Attached ${moduleCount} MCP server(s) via private profile config (CODEX_HOME=${codexHome})`
          : `[Codex] Using profile-owned runtime home (CODEX_HOME=${codexHome})`,
      );
    }

    if (resumeId) {
      console.log(`[Codex] Resuming thread ${resumeId} for conversation continuity`);
    }

    const invocation = codexStdinInvocation(args, prompt);
    console.log(`[Codex] Prompt transport: stdin (${invocation.stdin.length} chars)`);

    // Fail-closed: never spawn with a credential on the command line.
    assertNoSecretsInArgv(invocation.args);
    console.log(`[Codex] Full command: ${redactForLog(codexExecutable.display)} ${redactForLog(invocation.args.join(' '))}`);
    if (codexExecutable.native) {
      console.log(`[Codex] Using native binary directly; bypassing the Node CLI shim`);
    }

    this.cancelled = false;

    // Issue 4: Merge options.env WITH process.env instead of replacing.
    const mergedEnv = preparedRuntime.env;
    if (codexExecutable.managedPackageRoot) {
      mergedEnv.CODEX_MANAGED_BY_NPM ||= '1';
      mergedEnv.CODEX_MANAGED_PACKAGE_ROOT ||= codexExecutable.managedPackageRoot;
    }

    const spawnOptions = {
      cwd: workingDir,
      env: mergedEnv,
      stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    };
    const proc = this.spawnOverride
      ? this.spawnOverride(codexExecutable.command, invocation.args, spawnOptions)
      : portableSpawn(codexExecutable.command, invocation.args, spawnOptions);

    this.currentProcess = proc;
    finalization.process = proc;
    finalization.processClosed = new Promise<void>((resolve) => {
      proc.once('close', () => {
        finalization.closed = true;
        resolve();
      });
    });

    // Issue 4: Handle spawn errors
    let spawnError: Error | null = null;
    proc.on('error', (err) => {
      console.error(`[Codex] Process error: ${err.message}`);
      spawnError = err;
    });

    console.log(`[Codex] Process spawned, PID: ${proc.pid}`);

    // Deliver the full prompt only over the child stdin pipe.
    proc.stdin?.end(invocation.stdin);

    let lastResult = '';
    let sessionId: string | undefined;
    let turnStartMs = Date.now();
    let buffer = '';

    // Issue 4: Guard stdout/stderr with null checks
    const stdout = proc.stdout;
    const stderr = proc.stderr;

    // Collect stderr for error reporting
    let stderrText = '';
    if (stderr) {
      stderr.on('data', (chunk: Buffer) => {
        stderrText += chunk.toString();
      });
    }

    // Issue 3: Track both stdout end and process exit with a counter
    let completionCount = 0;
    const targetCompletions = 2; // stdout end + process exit
    let exitCode: number | null = null;

    const completionPromise = new Promise<void>((resolve) => {
      const checkDone = () => {
        completionCount++;
        if (completionCount >= targetCompletions) {
          resolve();
        }
      };

      if (stdout) {
        stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const parts = buffer.split('\n');
          buffer = parts.pop() || '';
          for (const line of parts) {
            if (line.trim()) lines.push(line.trim());
          }
        });
        stdout.on('end', () => {
          if (buffer.trim()) lines.push(buffer.trim());
          checkDone();
        });
      } else {
        checkDone(); // No stdout — count it as done
      }

      proc.on('close', (code) => {
        console.log(`[Codex] Process closed with code ${code}`);
        exitCode = code;
        checkDone();
      });
    });

    // Process lines as they arrive
    const lines: string[] = [];
    const processedLines = new Set<number>();
    let done = false;

    completionPromise.then(() => { done = true; });

    // Yield messages as lines arrive
    while (!done || processedLines.size < lines.length) {
      await new Promise(r => setTimeout(r, 100));

      for (let i = processedLines.size; i < lines.length; i++) {
        processedLines.add(i);
        const line = lines[i];

        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          // Not valid JSON — skip.
          continue;
        }

        switch (event.type) {
            case 'thread.started': {
              sessionId = event.thread_id;
              yield {
                type: 'system',
                subtype: 'init',
                session_id: sessionId,
              };
              break;
            }

            // Issue 2: session_configured event
            case 'session_configured': {
              yield {
                type: 'system',
                subtype: 'configured',
                session_id: sessionId,
              };
              break;
            }

            case 'turn.started': {
              turnStartMs = Date.now();
              yield {
                type: 'progress',
                content: 'Processing...',
              };
              break;
            }

            case 'item.completed': {
              const item = event.item;
              if (!item) break;

              switch (item.type) {
                case 'agent_message': {
                  // Issue 5: Track last result but yield as progress, not result
                  lastResult = item.text || '';
                  yield {
                    type: 'progress',
                    subtype: 'agent_message',
                    content: lastResult,
                  };
                  break;
                }

                case 'reasoning': {
                  yield {
                    type: 'thinking',
                    content: item.text || '',
                  };
                  break;
                }

                case 'command_execution': {
                  const status = item.status === 'completed' ? 'completed' : 'running';
                  yield {
                    type: 'tool_use',
                    tool_name: 'bash',
                    subtype: status,
                    content: item.command || '',
                    output: item.aggregated_output?.slice(0, 500) || '',
                    exit_code: item.exit_code,
                  };
                  break;
                }

                case 'file_edit':
                case 'file_create':
                case 'file_read': {
                  yield {
                    type: 'tool_use',
                    tool_name: item.type,
                    content: item.path || item.file || '',
                  };
                  break;
                }

                default: {
                  // Unknown item type — yield as progress
                  if (item.text) {
                    yield {
                      type: 'progress',
                      content: item.text,
                    };
                  }
                  break;
                }
              }
              break;
            }

            case 'item.started': {
              const item = event.item;
              if (item?.type === 'command_execution') {
                yield {
                  type: 'tool_use',
                  tool_name: 'bash',
                  subtype: 'started',
                  content: item.command || '',
                };
              }
              break;
            }

            // Issue 2: exec_command_begin
            case 'exec_command_begin': {
              yield {
                type: 'tool_use',
                tool_name: 'bash',
                subtype: 'started',
                content: event.command || '',
              };
              break;
            }

            // Issue 2: exec_command_output_delta
            case 'exec_command_output_delta': {
              yield {
                type: 'progress',
                subtype: 'command_output',
                content: event.delta || event.output || '',
              };
              break;
            }

            // Issue 2: exec_command_end
            case 'exec_command_end': {
              yield {
                type: 'tool_use',
                tool_name: 'bash',
                subtype: 'completed',
                content: event.command || '',
                exit_code: event.exit_code,
              };
              break;
            }

            // Issue 2: agent_message_delta — streaming text
            case 'agent_message_delta': {
              yield {
                type: 'progress',
                subtype: 'message_delta',
                content: event.delta || event.text || '',
              };
              break;
            }

            // Issue 2: agent_reasoning
            case 'agent_reasoning': {
              yield {
                type: 'thinking',
                content: event.text || event.reasoning || '',
              };
              break;
            }

            // Issue 2: web_search_begin/end
            case 'web_search_begin': {
              yield {
                type: 'tool_use',
                tool_name: 'web_search',
                subtype: 'started',
                content: event.query || '',
              };
              break;
            }
            case 'web_search_end': {
              yield {
                type: 'tool_use',
                tool_name: 'web_search',
                subtype: 'completed',
                content: event.query || '',
              };
              break;
            }

            // Issue 2: patch_apply_begin/end
            case 'patch_apply_begin': {
              yield {
                type: 'tool_use',
                tool_name: 'patch',
                subtype: 'started',
                content: event.path || event.file || '',
              };
              break;
            }
            case 'patch_apply_end': {
              yield {
                type: 'tool_use',
                tool_name: 'patch',
                subtype: 'completed',
                content: event.path || event.file || '',
              };
              break;
            }

            case 'turn.completed': {
              // Per-turn token usage → manager (attributed to this query's task). Codex's
              // turn.completed carries usage.{input_tokens, cached_input_tokens, output_tokens}.
              try {
                const u = event.usage || {};
                // Codex's input_tokens is the FULL prompt and ALREADY includes the cached
                // portion; cached_input_tokens is the re-read session history (often millions
                // of tokens). Count only NEW (non-cached) input so the per-task figure reflects
                // real spend, not the cached context re-counted every turn.
                const input = Math.max(0, (Number(u.input_tokens) || 0) - (Number(u.cached_input_tokens) || 0));
                const output = Number(u.output_tokens) || 0;
                const reasoningOutput = Number(u.reasoning_output_tokens) || 0;
                if ([516, 1034, 1552].includes(reasoningOutput)) {
                  console.warn(
                    `[Codex] Reasoning-token cluster candidate observed: ${reasoningOutput} tokens ` +
                    `(model=${effectiveModel || options.model || process.env.CODEX_MODEL || 'codex'}, query=${this.currentQueryId || 'unknown'})`,
                  );
                }
                reportTurnUsage({
                  runtime: 'codex',
                  model: effectiveModel || options.model || process.env.CODEX_MODEL || 'codex',
                  input: input || null,
                  output: output || null,
                  genMs: Date.now() - turnStartMs,
                  queryId: this.currentQueryId,
                });
              } catch { /* never block the reply */ }
              // Issue 5: Only emit type:result here, on turn.completed
              if (lastResult) {
                yield {
                  type: 'result',
                  result: lastResult,
                  session_id: sessionId,
                };
              }
              break;
            }

            case 'error': {
              const content = event.message || event.error || 'Unknown error';
              const rateLimit = detectClaudeCliRateLimit({ stdout: JSON.stringify(event), stderr: content });
              yield {
                type: 'error',
                content,
                ...(rateLimit ? { rateLimit } : {}),
              };
              break;
            }

            default: {
              // Issue 6: Log unknown event types at debug level
              console.log(`[Codex] Unknown event type: ${event.type}`);
              break;
            }
        }
      }

      if (this.cancelled) {
        this.terminateProcessTree(proc, 'SIGTERM');
        yield { type: 'error', content: 'Cancelled' };
        break;
      }
    }

    // A cancellation may target a child that ignores the first termination
    // request. Do not wait forever here: the outer lifecycle finalizer owns the
    // bounded TERM/KILL/quiescence sequence and deliberately retains the run
    // home if the child never confirms close.
    if (!this.cancelled) {
      // Issue 3: Wait for both stdout end AND process exit.
      await completionPromise;
    }

    // Issue 4: If spawn failed, yield error
    if (spawnError) {
      yield {
        type: 'error',
        content: `Process spawn error: ${(spawnError as Error).message}`,
      };
    }

    // If no result was captured, check stderr
    if (!lastResult && stderrText) {
      const rateLimit = detectClaudeCliRateLimit({ stderr: stderrText, exitCode: exitCode ?? undefined });
      yield {
        type: 'error',
        content: (rateLimit?.message || stderrText).trim().slice(0, 1000),
        ...(rateLimit ? { rateLimit } : {}),
      };
    }

  }

  private async finalizeRun(finalization: CodexRunFinalizationState): Promise<void> {
    const proc = finalization.process;
    if (proc && !finalization.closed) {
      if (proc.exitCode === null && proc.signalCode === null) {
        this.terminateProcessTree(proc, 'SIGTERM');
      }
      const forceTimer = setTimeout(() => {
        if (!finalization.closed && proc.exitCode === null && proc.signalCode === null) {
          this.terminateProcessTree(proc, 'SIGKILL');
        }
      }, 2_000);
      forceTimer.unref?.();

      const quiescent = await Promise.race([
        finalization.processClosed!.then(() => true),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 5_000);
          timer.unref?.();
        }),
      ]);
      clearTimeout(forceTimer);
      if (!quiescent) {
        // Do not read auth or remove the run home while a child might still be
        // writing it. Retention pruning can recover it after the strict age cap.
        throw new Error(
          'Codex child did not confirm termination; retained its private run home for safe recovery',
        );
      }
    }

    if (this.currentProcess === proc) this.currentProcess = null;
    const lifecycle = finalization.lifecycle;
    if (!lifecycle) return;

    try {
      if (lifecycle.authReconciliation) {
        const result = reconcileCodexAuthAfterRun(lifecycle.authReconciliation);
        if (result === 'provider-conflict') {
          console.warn('[Codex] Provider auth changed during the run; preserved the provider generation');
        }
      }
    } finally {
      removeCodexRunHomeNoFollow(lifecycle.runsRoot, lifecycle.home);
    }
  }

  cancel(): boolean {
    if (this.currentProcess && this.currentProcess.exitCode === null && this.currentProcess.signalCode === null) {
      this.cancelled = true;
      const proc = this.currentProcess;
      this.terminateProcessTree(proc, 'SIGTERM');
      setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          this.terminateProcessTree(proc, 'SIGKILL');
        }
      }, 2000).unref?.();
      return true;
    }
    return false;
  }
}
