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
