// SPDX-License-Identifier: MIT
/**
 * McpToolHub — connect to attached MCP servers, expose their tools as a flat
 * catalog, and call them. Runtime-agnostic so any *local* harness (today: ollama)
 * can drive an agentic tool-calling loop against MCP servers — the same capability
 * the Claude/Codex runtimes get for free from their vendor CLI's built-in client.
 *
 * Transport plumbing reuses the official @modelcontextprotocol/sdk Client (do NOT
 * hand-roll JSON-RPC). The agentic loop lives in the ollama harness; the OpenAI
 * tool-schema translation + model capability detection live here.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerSpec } from './types.js';
import { exactWholeToolNames, mcpStdioProcessEnv } from './mcp.js';

export interface HubTool {
  /** MCP server this tool came from. */
  server: string;
  /** Tool name as the MCP server knows it. */
  name: string;
  /** Sanitized, namespaced name exposed to the model (`<server>__<tool>`). */
  exposed: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface OpenAiTool {
  type: 'function';
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}
export interface OpenAiToolCall {
  id?: string;
  function: { name: string; arguments: string };
}

const STARTUP_TIMEOUT_MS = Number(process.env.MCP_STARTUP_TIMEOUT_MS ?? 15000);
const CALL_TIMEOUT_MS = Number(process.env.MCP_CALL_TIMEOUT_MS ?? 60000);

/** Reject a promise if it doesn't settle within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** OpenAI/Ollama tool names must match ^[a-zA-Z0-9_-]{1,64}$. */
function sanitizeName(n: string): string {
  return (n.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)) || 'tool';
}

/** Flatten MCP content parts to a single string (text parts concatenated; other
 *  parts JSON-stringified) for feeding back to the model. */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  const parts: string[] = [];
  for (const c of content as Array<Record<string, unknown>>) {
    if (c && c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else parts.push(JSON.stringify(c));
  }
  return parts.join('\n');
}

export class McpToolHub {
  private clients: Array<{ server: string; client: Client }> = [];
  private tools: HubTool[] = [];
  private byExposed = new Map<string, HubTool>();

  /** Connect each spec (best-effort: a server that fails to start is logged and
   *  skipped, never fatal) and build the flat, de-duplicated tool catalog. */
  static async connect(specs: McpServerSpec[]): Promise<McpToolHub> {
    const hub = new McpToolHub();
    const used = new Set<string>();
    for (const spec of specs) {
      try {
        const client = new Client({ name: 'idagents-local', version: '1.0.0' });
        await withTimeout(client.connect(hub.makeTransport(spec)), STARTUP_TIMEOUT_MS, `connect ${spec.name}`);
        const listed = await withTimeout(client.listTools(), STARTUP_TIMEOUT_MS, `listTools ${spec.name}`) as { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> };
        hub.clients.push({ server: spec.name, client });
        for (const t of (listed.tools || [])) {
          let exposed = sanitizeName(`${spec.name}__${t.name}`);
          if (used.has(exposed)) { let i = 2; while (used.has(`${exposed}_${i}`)) i++; exposed = `${exposed}_${i}`; }
          used.add(exposed);
          const tool: HubTool = {
            server: spec.name, name: t.name, exposed,
            description: t.description,
            inputSchema: (t.inputSchema && typeof t.inputSchema === 'object') ? t.inputSchema as Record<string, unknown> : {},
          };
          hub.tools.push(tool);
          hub.byExposed.set(exposed, tool);
        }
        console.log(`[MCP] connected "${spec.name}" — ${(listed.tools || []).length} tool(s)`);
      } catch (e) {
        console.warn(`[MCP] server "${spec.name}" unavailable, skipped: ${(e as Error)?.message || e}`);
      }
    }
    return hub;
  }

  private makeTransport(spec: McpServerSpec) {
    const transport = spec.transport || (spec.url ? 'http' : 'stdio');
    if (transport === 'stdio') {
      if (!spec.command) throw new Error(`stdio server "${spec.name}" missing command`);
      return new StdioClientTransport({
        command: spec.command,
        args: spec.args || [],
        env: mcpStdioProcessEnv(spec.env),
      });
    }
    if (!spec.url) throw new Error(`${transport} server "${spec.name}" missing url`);
    const url = new URL(spec.url);
    const opts = spec.headers ? { requestInit: { headers: spec.headers } } : undefined;
    return transport === 'sse' ? new SSEClientTransport(url, opts) : new StreamableHTTPClientTransport(url, opts);
  }

  listTools(): HubTool[] { return this.tools; }

  /** Call a tool by its exposed (namespaced) name. Never throws — a failure is
   *  returned as `{ isError: true, text }` so the loop can feed it back to the
   *  model. `signal` (the agent's cancel signal) aborts an in-flight call promptly
   *  instead of waiting out CALL_TIMEOUT_MS. */
  async callTool(exposed: string, args: unknown, signal?: AbortSignal): Promise<{ text: string; isError: boolean }> {
    const tool = this.byExposed.get(exposed);
    if (!tool) return { text: `Unknown tool "${exposed}"`, isError: true };
    const entry = this.clients.find((c) => c.server === tool.server);
    if (!entry) return { text: `MCP server "${tool.server}" is not connected`, isError: true };
    try {
      const res = await withTimeout(
        entry.client.callTool(
          { name: tool.name, arguments: (args && typeof args === 'object') ? args as Record<string, unknown> : {} },
          undefined,
          signal ? { signal } : undefined,
        ),
        CALL_TIMEOUT_MS, `callTool ${exposed}`,
      ) as { content?: unknown; isError?: boolean };
      return { text: flattenContent(res?.content), isError: !!res?.isError };
    } catch (e) {
      return { text: `tool "${exposed}" failed: ${(e as Error)?.message || e}`, isError: true };
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.clients.map((c) => c.client.close()));
    this.clients = [];
  }
}

// ---------------------------------------------------------------------------
// Translation (pure functions) — MCP tool schema ⇄ OpenAI/Ollama function tools.
// ---------------------------------------------------------------------------

/** Make an MCP inputSchema palatable to Ollama's tool-arg parser: INLINE internal
 *  `$ref`s (to `$defs`/`definitions`) so nothing dangles after we drop the defs,
 *  strip $-keywords some model templates reject, and guarantee an object schema
 *  with a `properties` map (some models choke on parameters that lack one). */
function sanitizeSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const root: Record<string, unknown> = (schema && typeof schema === 'object') ? schema : {};
  const defs: Record<string, unknown> = {
    ...(root.$defs as Record<string, unknown> | undefined),
    ...(root.definitions as Record<string, unknown> | undefined),
  };
  const resolveRef = (ref: string): unknown => {
    const m = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
    return m ? defs[m[1]] : undefined;
  };
  const DROP = new Set(['$schema', '$id', '$defs', 'definitions']);
  const walk = (node: unknown, seen: Set<string>): unknown => {
    if (Array.isArray(node)) return node.map((x) => walk(x, seen));
    if (!node || typeof node !== 'object') return node;
    const n = node as Record<string, unknown>;
    if (typeof n.$ref === 'string') {
      if (seen.has(n.$ref)) return {}; // cycle guard
      const target = resolveRef(n.$ref);
      if (target === undefined) return {}; // unresolvable → permissive empty, never dangling
      const next = new Set(seen); next.add(n.$ref);
      return walk(target, next);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n)) {
      if (DROP.has(k)) continue;
      out[k] = walk(v, seen);
    }
    return out;
  };
  const s = walk(root, new Set<string>()) as Record<string, unknown>;
  if (!s.type) s.type = 'object';
  if (s.type === 'object' && (s.properties == null || typeof s.properties !== 'object')) s.properties = {};
  return s;
}

export function mcpToOpenAiTools(tools: HubTool[]): OpenAiTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.exposed, description: t.description, parameters: sanitizeSchema(t.inputSchema) },
  }));
}

/**
 * Apply an exact declarative tool-exposure boundary to OpenAI-compatible MCP
 * tools. `undefined` preserves runtime defaults while an explicit empty array
 * exposes no tools. Declarative names must identify the full owning server:
 * either the actual `<server>__<tool>` name advertised to the model or the
 * canonical Claude-style `mcp__<server>__<tool>` spelling. Bare final segments
 * are intentionally rejected because two servers may publish the same name.
 */
export function filterOpenAiToolsForAllowlist(
  tools: OpenAiTool[],
  allowedTools: string[] | undefined,
): OpenAiTool[] {
  if (allowedTools === undefined) return tools;
  const allowed = new Set(exactWholeToolNames(allowedTools));
  return tools.filter((tool) => {
    const exposedName = tool.function.name;
    return allowed.has(exposedName) || allowed.has(`mcp__${exposedName}`);
  });
}

/**
 * Avoid even starting MCP servers that cannot own an explicitly allowed tool.
 * Server startup is executable code, so schema filtering after connection is
 * too late to represent an explicit empty or built-in-only boundary.
 */
export function filterOpenAiMcpServersForAllowlist(
  servers: McpServerSpec[] | undefined,
  allowedTools: string[] | undefined,
): McpServerSpec[] {
  const configured = servers || [];
  if (allowedTools === undefined) return [...configured];
  const allowed = exactWholeToolNames(allowedTools);
  return configured.filter((server) => {
    const exposedPrefix = `${server.name}__`;
    const canonicalPrefix = `mcp__${server.name}__`;
    return allowed.some((tool) => (
      (tool.startsWith(exposedPrefix) && tool.length > exposedPrefix.length)
      || (tool.startsWith(canonicalPrefix) && tool.length > canonicalPrefix.length)
    ));
  });
}

/** Exact set of names the model was actually shown and may therefore execute. */
export function openAiToolExecutionSet(tools: OpenAiTool[]): ReadonlySet<string> {
  return new Set(tools.map((tool) => tool.function.name));
}

export async function callOpenAiToolWithinBoundary(
  hub: Pick<McpToolHub, 'callTool'>,
  executableToolNames: ReadonlySet<string>,
  call: OpenAiToolCall,
  signal?: AbortSignal,
): Promise<{ text: string; isError: boolean }> {
  const exposed = call.function?.name || '';
  if (!executableToolNames.has(exposed)) {
    return {
      text: `Tool "${exposed}" is outside the exact advertised tool boundary`,
      isError: true,
    };
  }
  return hub.callTool(exposed, parseOpenAiCallArgs(call), signal);
}

/** Parse a streamed/assembled OpenAI tool-call's `arguments` string into an object.
 *  On invalid JSON, wrap the raw string so the tool can error and the model retry,
 *  rather than crashing the run. */
export function parseOpenAiCallArgs(call: OpenAiToolCall): unknown {
  const raw = call.function?.arguments;
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return { __unparsed_arguments: raw }; }
}

// ---------------------------------------------------------------------------
// Model tool-capability detection (cheap → authoritative).
// ---------------------------------------------------------------------------

/** Local model families known to support tool/function calling — fallback when
 *  Ollama's /api/show predates the `capabilities` field. */
const TOOL_FAMILIES = [
  'qwen2.5', 'qwen3', 'qwq', 'llama3.1', 'llama3.2', 'llama3.3',
  'mistral-nemo', 'mistral-small', 'firefunction', 'command-r', 'hermes3',
];

/**
 * Does this Ollama model support tools? Prefers /api/show `capabilities`
 * (authoritative for the actual local build); falls back to a family allowlist
 * when the field is absent. `openAiBaseUrl` is the OpenAI-compatible base
 * (…/v1); /api/show lives on the native API one level up.
 */
export async function modelSupportsTools(model: string, openAiBaseUrl: string): Promise<boolean> {
  const nativeBase = openAiBaseUrl.replace(/\/v1\/?$/, '');
  try {
    const r = await fetch(`${nativeBase}/api/show`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }), signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      const j = await r.json() as { capabilities?: unknown };
      if (Array.isArray(j?.capabilities)) return j.capabilities.includes('tools');
    }
  } catch { /* fall through to the family allowlist */ }
  const m = model.toLowerCase();
  return TOOL_FAMILIES.some((f) => m.startsWith(f) || m.includes(`/${f}`));
}
