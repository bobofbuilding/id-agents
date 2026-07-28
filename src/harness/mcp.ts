// SPDX-License-Identifier: MIT
/**
 * Shared MCP helpers used by the Claude harnesses.
 *
 * One normalization function maps our serializable McpServerSpec[] onto the
 * per-server config shape that BOTH the Claude Agent SDK (`Options.mcpServers`)
 * and the Claude CLI (`.mcp.json` → `--mcp-config`) accept — they use the same
 * stdio/http/sse object shapes. Keeping it in one place means the SDK harness,
 * the CLI harness, and the env parser can't drift.
 */

import type { McpServerSpec } from './types.js';

/** name → SDK/.mcp.json server config object. */
export type McpServerRecord = Record<string, Record<string, unknown>>;

const MCP_STDIO_BASE_ENV: ReadonlyArray<{
  output: string;
  inputs: readonly string[];
}> = [
  { output: 'PATH', inputs: ['PATH', 'Path'] },
  { output: 'HOME', inputs: ['HOME'] },
  { output: 'SHELL', inputs: ['SHELL'] },
  { output: 'TMPDIR', inputs: ['TMPDIR'] },
  { output: 'TMP', inputs: ['TMP'] },
  { output: 'TEMP', inputs: ['TEMP'] },
  { output: 'LANG', inputs: ['LANG'] },
  // Windows process launch and npm `.cmd` resolution.
  { output: 'APPDATA', inputs: ['APPDATA'] },
  { output: 'LOCALAPPDATA', inputs: ['LOCALAPPDATA'] },
  { output: 'USERPROFILE', inputs: ['USERPROFILE'] },
  { output: 'SystemRoot', inputs: ['SystemRoot', 'SYSTEMROOT'] },
  { output: 'WINDIR', inputs: ['WINDIR'] },
  { output: 'ComSpec', inputs: ['ComSpec', 'COMSPEC'] },
  { output: 'PATHEXT', inputs: ['PATHEXT'] },
];

/**
 * Build the complete environment for a stdio MCP child. This is deliberately
 * an allowlist rather than `{ ...process.env }`: the harness process may carry
 * provider, database, wallet, admin, and runtime credentials that an attached
 * MCP server has no authority to receive.
 */
export function mcpStdioProcessEnv(
  explicit: Record<string, string> | undefined,
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { output, inputs } of MCP_STDIO_BASE_ENV) {
    const value = inputs
      .map((key) => inherited[key])
      .find((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
    if (value !== undefined) out[output] = value;
  }
  if (explicit) {
    for (const [key, value] of Object.entries(explicit)) {
      out[key] = String(value);
    }
  }
  return out;
}

/**
 * Normalize specs into the record keyed by server name. Only the three
 * serializable transports are emitted (stdio | http | sse); an entry missing
 * the fields its transport requires is skipped so a bad config can't crash the
 * harness rather than silently producing an invalid server.
 */
export function toMcpServerRecord(
  specs: McpServerSpec[],
  inherited: NodeJS.ProcessEnv = process.env,
): McpServerRecord {
  const out: McpServerRecord = {};
  for (const s of specs) {
    if (!s || !s.name) continue;
    const transport = s.transport || 'stdio';
    if (transport === 'stdio') {
      if (!s.command) continue;
      out[s.name] = {
        type: 'stdio',
        command: s.command,
        ...(s.args && { args: s.args }),
        // Always provide an explicit complete env so vendor SDK/CLI launchers
        // cannot fall back to inheriting the credential-rich harness process.
        env: mcpStdioProcessEnv(s.env, inherited),
      };
    } else if (transport === 'http' || transport === 'sse') {
      if (!s.url) continue;
      out[s.name] = { type: transport, url: s.url, ...(s.headers && { headers: s.headers }) };
    }
  }
  return out;
}

/**
 * Claude exposes MCP tools as `mcp__<server>__<tool>`. When an exact tool
 * boundary is configured, attach only servers that own at least one named
 * allowed tool. Tool-level permission enforcement remains necessary because
 * an attached server may publish additional, unlisted tools.
 */
export function filterMcpServersForAllowedTools(
  specs: McpServerSpec[] | undefined,
  allowedTools: string[] | undefined,
): McpServerSpec[] {
  const servers = specs || [];
  if (allowedTools === undefined) return [...servers];
  return servers.filter((server) => {
    const prefix = `mcp__${server.name}__`;
    return allowedTools.some((tool) => (
      typeof tool === 'string'
      && tool.startsWith(prefix)
      && tool.length > prefix.length
    ));
  });
}

export function isNamespacedMcpTool(toolName: string): boolean {
  if (!toolName.startsWith('mcp__')) return false;
  const separator = toolName.indexOf('__', 'mcp__'.length);
  return separator > 'mcp__'.length && separator < toolName.length - 2;
}

const WHOLE_TOOL_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Exact boundaries operate on whole tool identifiers only. Claude's
 * parameterized permission syntax (for example `Bash(git:*)`) is a rule
 * expression, not a callable tool name, and cannot be enforced consistently
 * across SDK and CLI runtimes.
 */
export function exactWholeToolNames(tools: string[]): string[] {
  return tools.map((tool) => {
    if (
      typeof tool !== 'string'
      || tool !== tool.trim()
      || !WHOLE_TOOL_NAME.test(tool)
    ) {
      throw new Error(
        `Exact allowedTools entries must be whole tool names; unsupported entry: "${String(tool)}"`,
      );
    }
    return tool;
  });
}

/**
 * Parse the ID_MCP_SERVERS env value (JSON array of McpServerSpec) that the
 * manager injects at spawn. Tolerant: a malformed or non-array value yields
 * undefined (MCP disabled for the run) rather than throwing.
 */
export function parseMcpServersEnv(raw: string | undefined): McpServerSpec[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as McpServerSpec[];
  } catch {
    /* malformed → disabled */
  }
  return undefined;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
    );
  }
  return value;
}

/**
 * Compare an MCP list against the exact snapshot a caller reviewed. Object-key
 * ordering is irrelevant, while server/argument ordering and every connection
 * value remain significant.
 */
export function sameMcpServerSnapshot(
  expected: McpServerSpec[],
  current: McpServerSpec[],
): boolean {
  return JSON.stringify(canonicalJsonValue(expected))
    === JSON.stringify(canonicalJsonValue(current));
}

/**
 * Parse the bundled Brain MCP argv without shell syntax or whitespace
 * splitting. JSON is the canonical transport because an application path may
 * contain spaces on every supported desktop platform.
 *
 * A legacy BRAIN_MCP_ARGS value is retained as one literal argument only. That
 * is intentionally fail-safe: callers that need multiple arguments must move
 * to BRAIN_MCP_ARGS_JSON instead of relying on ambiguous shell tokenization.
 */
export function parseBrainMcpArgs(
  json: string | undefined,
  legacy: string | undefined,
  defaultScript: string,
): string[] | null {
  if (json !== undefined) {
    try {
      const parsed = JSON.parse(json);
      if (
        !Array.isArray(parsed)
        || parsed.length < 1
        || parsed.length > 32
        || parsed.some((value) => (
          typeof value !== 'string'
          || !value
          || value.length > 16_384
          || value.includes('\0')
        ))
      ) return null;
      return parsed;
    } catch {
      return null;
    }
  }
  if (legacy?.trim()) return [legacy.trim()];
  return [defaultScript];
}

/** Environment intentionally carried by the auto-attached bundled Brain MCP. */
export function brainMcpProcessEnv(
  baseUrl: string,
  token: string | undefined,
): Record<string, string> {
  return {
    BRAIN_MCP_BASE_URL: baseUrl,
    // The desktop uses Electron's executable as its pinned Node runtime.
    // Agent launchers sanitize their environment, so never rely on inheriting
    // this flag from the Manager process.
    ELECTRON_RUN_AS_NODE: '1',
    ...(token ? { BRAIN_TOKEN: token } : {}),
  };
}
