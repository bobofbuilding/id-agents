# Local-Model Tool-Calling Loop — Design Plan

Status: **DRAFT / not started** · Owner: idagents · Last updated: 2026-06-20

> Return-to-later plan. The goal is to give **local models (Ollama, and any
> future locally-hosted runtime)** the ability to actually *use* attached MCP
> servers — the same capability the Claude runtimes and (as of this week) Codex
> already have. Local models can't borrow a vendor CLI's built-in MCP client, so
> we build the agentic tool-calling loop ourselves.

---

## 1. Why this is needed

MCP attachment is already plumbed end-to-end on the manager side:

- The manager serializes `metadata.mcpServers` → `ID_MCP_SERVERS` env for **every**
  agent (`buildLocalAgentEnv`, `agent-manager-db.ts`).
- `claude-agent-server.ts` parses it with `parseMcpServersEnv()` and passes
  `mcpServers` into `harness.run(prompt, { ..., mcpServers })` **generically, for
  all runtimes**.
- Each harness decides what to do with `options.mcpServers`:
  - `claude-agent-sdk` → SDK `Options.mcpServers` (in-process client).
  - `claude-code-cli` / `claude-code-local` → writes a temp `.mcp.json`, passes
    `--mcp-config --strict-mcp-config`.
  - `codex` → `-c mcp_servers.<name>.*` config overrides (added 2026-06).
  - **`ollama` → ignores it.** `OllamaHarness.run()` does a single
    `POST /v1/chat/completions` (streamed text) and returns. No tools, no loop.
  - `cursor-cli`, `public-agent-remote` → also ignore it.

So `options.mcpServers` already arrives at `OllamaHarness.run()` — it's just
dropped on the floor. The work is to consume it: connect to the servers, expose
their tools to the model, and run the call/observe/continue loop.

### What "from scratch" means here

The **MCP transport plumbing is NOT from scratch** — `@modelcontextprotocol/sdk`
(v1.29.0) is already in `node_modules` (transitive via the Claude SDK) and gives
us a `Client` plus `StdioClientTransport`, `SSEClientTransport`, and
`StreamableHTTPClientTransport`. Reuse it; do not hand-roll JSON-RPC.

The **agentic loop IS from scratch** — Ollama's OpenAI-compatible endpoint gives
us raw `tool_calls` in the response but no orchestration. We own: tool-schema
translation, the multi-turn call→execute→feed-back loop, streaming of tool-call
deltas, iteration/turn limits, and capability gating.

---

## 2. Current building blocks (reuse these)

| Symbol | File | Role |
|---|---|---|
| `McpServerSpec`, `McpTransport` | `src/harness/types.ts` | Normalized, serializable server def (name/transport/command/args/env/url/headers). |
| `HarnessOptions.mcpServers` | `src/harness/types.ts` | Already populated for ollama runs. |
| `parseMcpServersEnv()` | `src/harness/mcp.ts` | `ID_MCP_SERVERS` → `McpServerSpec[]`. |
| `toMcpServerRecord()` | `src/harness/mcp.ts` | Spec → `.mcp.json`/SDK record (Claude-shaped; informative only for ollama). |
| `OllamaHarness.run()` | `src/harness/ollama.ts` | The harness we extend; already streams + reports token usage. |
| `reportOllamaUsage()` | `src/harness/ollama.ts` | Keep working through the loop (sum usage across turns). |

`@modelcontextprotocol/sdk` import paths (verified, v1.29.0):

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
```

---

## 3. Architecture

Four new pieces, kept as small focused modules so the harness stays readable.

```
                    ┌──────────────────────────────────────────────┐
 ID_MCP_SERVERS ──▶ │ McpToolHub (new: src/harness/mcp-client.ts)   │
 (McpServerSpec[])  │  • connect each spec via SDK transport        │
                    │  • listTools() → flat catalog (server,name)   │
                    │  • callTool(server,name,args) → text/JSON     │
                    │  • close() all                                │
                    └───────────────┬──────────────────────────────┘
                                    │ tools (MCP schema)
                                    ▼
                    ┌──────────────────────────────────────────────┐
 OpenAI tools  ◀────│ mcpToOpenAiTools()  (translation, pure fn)    │
 [{type:function}]  │ openAiCallToMcp()   (reverse, pure fn)        │
                    └───────────────┬──────────────────────────────┘
                                    │
                                    ▼
                    ┌──────────────────────────────────────────────┐
                    │ runToolLoop()  (the agentic loop)             │
                    │  messages[] + tools[] → POST chat/completions │
                    │  while (assistant.tool_calls):                │
                    │    execute each via McpToolHub                │
                    │    append tool results as role:"tool" msgs    │
                    │    re-POST                                     │
                    │  until no tool_calls OR maxTurns reached      │
                    └───────────────┬──────────────────────────────┘
                                    │ HarnessMessage stream
                                    ▼
                         OllamaHarness.run() yields
```

### 3.1 `McpToolHub` — the MCP client (`src/harness/mcp-client.ts`, new)

Runtime-agnostic; usable by any future local harness, not just ollama.

```ts
export interface HubTool {
  server: string;            // which MCP server it came from
  name: string;              // tool name as MCP knows it
  description?: string;
  inputSchema: object;       // JSON Schema from MCP
}

export class McpToolHub {
  static async connect(specs: McpServerSpec[], opts?: { startupTimeoutMs?: number }): Promise<McpToolHub>;
  listTools(): HubTool[];
  callTool(server: string, name: string, args: unknown): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}
```

- One `Client` per spec. Transport chosen from `spec.transport`:
  - `stdio` → `StdioClientTransport({ command, args, env })`.
  - `http`  → `StreamableHTTPClientTransport(new URL(spec.url), { requestInit:{ headers } })`.
  - `sse`   → `SSEClientTransport(new URL(spec.url), { requestInit:{ headers } })`.
- `connect()` calls `client.connect(transport)` + `client.listTools()` per server,
  **with a per-server startup timeout** (default 15s). A server that fails to
  start is logged and skipped — never fatal (matches `toMcpServerRecord`'s
  tolerant philosophy).
- Tool-name collisions across servers: namespace the exposed name as
  `"<server>__<tool>"` (double underscore) so the model gets unique names; map
  back on call. (OpenAI tool names must match `^[a-zA-Z0-9_-]{1,64}$` — sanitize.)
- `callTool` flattens MCP `content[]` parts to a text string (concat text parts;
  JSON-stringify resource/embedded parts); preserves `isError`.

### 3.2 Translation (pure functions, same file or `mcp-openai.ts`)

```ts
// MCP HubTool[] → OpenAI Chat Completions "tools" array
function mcpToOpenAiTools(tools: HubTool[]): OpenAiTool[]
// "<server>__<tool>" + JSON args  → { server, name, args }
function openAiCallToMcp(call: OpenAiToolCall, index: Map<string,HubTool>): McpInvocation
```

OpenAI function-tool shape Ollama expects:

```jsonc
{
  "type": "function",
  "function": {
    "name": "everything__echo",
    "description": "Echo back the input",
    "parameters": { /* the MCP inputSchema, JSON Schema */ }
  }
}
```

Notes / gotchas:
- Some local models choke on `parameters` with no `properties`. Emit
  `{"type":"object","properties":{}}` when the MCP schema is empty.
- Strip JSON-Schema keywords Ollama's parser rejects (`$schema`, `$defs` in some
  builds). Keep a sanitizer; expand it as we hit model-specific quirks.

### 3.3 `runToolLoop()` — the agentic loop

This is the core "from scratch" part. Pseudocode:

```ts
const messages = [ ...system, { role:'user', content: prompt } ];
const tools = mcpToOpenAiTools(hub.listTools());
for (let turn = 0; turn < MAX_TURNS; turn++) {
  const resp = await chatCompletion({ model, messages, tools, stream:true });
  // accumulate streamed content + tool_call deltas; sum usage
  yield assistant text deltas as { type:'progress', subtype:'message_delta' }
  messages.push(assistantMessage); // includes tool_calls
  if (!assistantMessage.tool_calls?.length) {
    yield { type:'result', result: assistantMessage.content };
    return;
  }
  for (const call of assistantMessage.tool_calls) {
    yield { type:'tool_use', tool_name: call.function.name, content: call.function.arguments };
    const { server, name, args } = openAiCallToMcp(call, index);
    const out = await hub.callTool(server, name, args);   // with per-call timeout
    messages.push({ role:'tool', tool_call_id: call.id, content: out.text });
  }
}
// fell through MAX_TURNS — emit best-effort final answer + a note
```

Loop controls:
- `MAX_TURNS` (default 8, env `OLLAMA_MAX_TOOL_TURNS`) — prevents infinite
  call→call→call loops a weak model can fall into.
- Per-tool-call timeout (default 60s) independent of the existing
  `REQUEST_TIMEOUT_MS` generation bound.
- Reuse the existing concurrency semaphore (`acquireSlot`/`releaseSlot`) — but
  acquire **once for the whole loop**, not per turn, so a multi-turn agent
  doesn't release and re-queue mid-task.
- **Token accounting:** sum `prompt_tokens`/`completion_tokens` across every turn
  and report the total once at the end via `reportOllamaUsage()`. (Tool-augmented
  runs use far more tokens — the Health gauge should reflect that.)

### 3.4 Streaming tool-calls

Ollama streams `tool_calls` as deltas: `choices[0].delta.tool_calls[]` arrive
incrementally with `.index`, partial `.function.name`, and partial
`.function.arguments` (a growing JSON string). The loop must:
- accumulate per-`index` into a `Map<number, PartialToolCall>`,
- concatenate `arguments` string fragments,
- `JSON.parse` the assembled arguments only when the turn finishes (a stream may
  split a single arg object across many chunks),
- tolerate a model that emits the whole tool_call in one non-streamed chunk.

Keep the existing `stream: true` + `stream_options.include_usage` so the final
usage chunk still arrives. Non-streaming fallback (`stream:false`) is acceptable
for a v1 if delta assembly proves fiddly — simpler, slightly less responsive.

---

## 4. Model capability detection

Not every local model supports tool/function calling. Calling with `tools` on a
model that lacks it either errors or (worse) the model hallucinates tool syntax
into plain text. Before entering the tool loop, decide: **tools or plain text?**

Detection order (cheapest first):
1. **No servers attached** → skip entirely, use the existing simple text path.
2. **Ollama `/api/show`** (`POST {model}`) returns a `capabilities` array; modern
   builds list `"tools"` when the model template supports it. Prefer this — it's
   authoritative for the actual local build.
3. **Family allowlist fallback** (when `/api/show` is old / lacks the field):
   known tool-capable families — `qwen2.5`, `qwen3`, `llama3.1`, `llama3.2`,
   `llama3.3`, `mistral-nemo`, `mistral-small`, `firefunction`, `command-r`,
   `hermes3`. Match on the model name prefix.
4. **Default when unknown:** if servers are attached but capability is unproven,
   **attempt the tool loop once**; on a tools-related 4xx from Ollama, fall back
   to the plain text path for that run and log a clear warning. Never hard-fail
   the agent because of MCP.

This same capability check feeds **task 17's runtime/model gating** (see §7) —
expose it as a small helper, e.g. `modelSupportsTools(model): Promise<boolean>`,
so the manager can answer "can this agent use MCP?" without running it.

---

## 5. Integration points

- `src/harness/ollama.ts` — `run()` branches early:
  ```ts
  const servers = options.mcpServers;
  if (servers?.length && await modelSupportsTools(model)) {
    yield* this.runWithTools(prompt, options, servers);  // new path
    return;
  }
  // ...existing plain-text streaming path unchanged...
  ```
- `src/harness/mcp-client.ts` — new `McpToolHub` + translation (shared, reusable).
- No change needed in `claude-agent-server.ts` — `mcpServers` already flows in.
- `cursor-cli` / `public-agent-remote` stay tools-unaware (gated out in §7).

---

## 6. Safety, isolation, observability

- **Process isolation:** stdio MCP servers spawn child processes with the agent's
  env. Same trust boundary as the Claude harnesses already have — local,
  single-user. No new exposure, but: pass only the agent's intended env, and
  **never** echo secret env values into logs (the codex harness logs the full
  command — local-only, acceptable; the ollama path should log tool *names* and
  arg *keys*, not full secret-bearing args).
- **Tool allow-listing:** honor `options.allowedTools` if present — filter the
  tool catalog before exposing it, so an agent can be scoped to a subset.
- **Cleanup:** `hub.close()` in a `finally` so child MCP processes don't leak on
  cancel/timeout. Wire `cancel()` to also close the hub.
- **Logging:** mirror the codex style — `[Ollama] Attached N MCP server(s)`,
  `[Ollama] tool_call: <name>`, `[Ollama] tool result: <n> chars` — so the same
  log-tail verification used for codex works here.

---

## 7. Capability gating (task 17 — ships independently, before this)

Independent of the loop itself, the UI/manager should **stop offering MCP
(and other capabilities) to agents whose runtime/model can't use them.** This is
a separate, smaller change and can land first.

- Add a capability matrix in `idctl/src/runtimeCatalog.ts`:
  ```ts
  export type Capability = 'mcp' | 'plugins' | 'skills' | 'subagents';
  // After codex MCP landed, MCP-capable runtimes:
  const MCP_CAPABLE = ['claude-agent-sdk','claude-code-cli','claude-code-local','codex'];
  // ollama: 'mcp' becomes true ONLY once this plan ships AND the chosen model
  // supports tools — so gate on (runtime ∈ capable) AND modelSupportsTools.
  export function runtimeSupports(runtime: HarnessType, cap: Capability): boolean;
  ```
- In `idctl-desktop` `Modules.tsx`: in the "apply to" agent chips, **disable**
  agents whose runtime fails `runtimeSupports(runtime,'mcp')`, with a tooltip
  ("codex/claude only — ollama gains MCP after the local tool-loop ships").
  Skip them in attach / install / "all" bulk actions.
- Generalize the same gate to plugins/skills where the underlying runtime can't
  consume them.
- Once §3–4 ship, flip ollama's `mcp` capability to a **dynamic** check that also
  consults `modelSupportsTools(model)` for the agent's configured model.

---

## 8. Phased delivery

1. **Phase 0 — Gating (task 17).** `runtimeSupports` matrix + Modules.tsx
   disable/skip. No loop yet; ollama simply stays "not MCP-capable." Ships now.
2. **Phase 1 — Hub + translation.** `McpToolHub.connect/listTools/callTool/close`
   over stdio only + `mcpToOpenAiTools`/`openAiCallToMcp`. Unit-test against the
   `@modelcontextprotocol/server-everything` echo/add tools (same server used to
   verify codex). No model in the loop yet.
3. **Phase 2 — Non-streaming tool loop.** `runWithTools` with `stream:false`,
   `MAX_TURNS`, capability detection via `/api/show` + family allowlist. Verify
   live with `qwen3` calling `everything__echo` → log shows the tool call + result.
4. **Phase 3 — Streaming.** Delta assembly for `tool_calls`; keep usage capture.
5. **Phase 4 — http/sse transports, allowedTools scoping, polish.** Flip ollama's
   `mcp` capability to the dynamic per-model check.

Each phase is independently shippable and verifiable by log-tail (the codex
verification pattern: dispatch a `/ask` that forces a tool call, tail the agent
log for the tool name + result).

---

## 9. Open questions / risks

- **Weak-model loop quality.** `qwen3:4b` may call tools poorly (wrong args, loops,
  ignores results). `MAX_TURNS` + a crisp system prompt ("you have these tools;
  call one only when needed; stop when you can answer") mitigate, but tool use on
  4B-class models is genuinely hit-or-miss. Document expected models (≥7B for
  reliable tool use).
- **Schema dialect drift.** Ollama's tool-arg JSON-Schema support varies by model
  template. The sanitizer (§3.2) will need iteration; keep it data-driven.
- **Arg JSON truncation.** Streamed `arguments` can be invalid JSON until the
  stream completes — only parse at turn end; on parse failure, feed the model an
  error tool-result so it can retry rather than crashing the run.
- **Concurrency.** Holding one semaphore slot for a whole multi-turn loop reduces
  effective throughput. Consider a separate, larger slot budget for tool-using
  runs, or per-turn re-acquire with fair queueing — measure first.
- **Versioning.** `@modelcontextprotocol/sdk` is currently transitive (1.29.0). If
  we depend on it directly, **add it to `package.json`** so a future dedupe of the
  Claude SDK can't silently remove it.

---

## 10. Definition of done

- An ollama agent (model ≥7B, tools-capable) with an attached stdio MCP server
  calls a tool and uses its result in the final answer — proven by agent-log tail,
  exactly like the codex MCP verification.
- Capability gating hides MCP from runtimes/models that can't use it (no dead-end
  "attach" that silently does nothing).
- Token usage for tool-augmented runs is summed across turns and shows on the
  Health gauge.
- No regression to the existing plain-text ollama path when no servers are
  attached or the model lacks tool support.
