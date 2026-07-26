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

/**
 * Normalize specs into the record keyed by server name. Only the three
 * serializable transports are emitted (stdio | http | sse); an entry missing
 * the fields its transport requires is skipped so a bad config can't crash the
 * harness rather than silently producing an invalid server.
 */
export function toMcpServerRecord(specs: McpServerSpec[]): McpServerRecord {
  const out: McpServerRecord = {};
  for (const s of specs) {
    if (!s || !s.name) continue;
    const transport = s.transport || 'stdio';
    if (transport === 'stdio') {
      if (!s.command) continue;
      out[s.name] = { type: 'stdio', command: s.command, ...(s.args && { args: s.args }), ...(s.env && { env: s.env }) };
    } else if (transport === 'http' || transport === 'sse') {
      if (!s.url) continue;
      out[s.name] = { type: transport, url: s.url, ...(s.headers && { headers: s.headers }) };
    }
  }
  return out;
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
