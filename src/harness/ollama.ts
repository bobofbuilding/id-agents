// SPDX-License-Identifier: MIT
/**
 * Ollama Harness
 *
 * Calls the Ollama OpenAI-compatible REST API (http://localhost:11434/v1).
 * Intended for lightweight local models (e.g. qwen3:4b) running on Tier-3
 * agents that do structured text processing rather than interactive coding.
 *
 * No subprocess spawning — pure HTTP. Streams via SSE when available,
 * falls back to a single blocking POST otherwise.
 */

import { AgentHarness, HarnessOptions, HarnessMessage, HarnessType, McpServerSpec } from './types.js';
import { McpToolHub, mcpToOpenAiTools, parseOpenAiCallArgs, modelSupportsTools } from './mcp-client.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1';
const DEFAULT_MODEL = 'qwen3:4b';

// Max call→execute→continue turns in the MCP tool loop (env OLLAMA_MAX_TOOL_TURNS).
// Bounds a weak model that can otherwise loop call→call→call forever.
const MAX_TOOL_TURNS = Number(process.env.OLLAMA_MAX_TOOL_TURNS ?? 8);

// How long to wait for any single Ollama generation (default 10 min).
// Local models can be slow; this prevents a hung request from blocking the
// queue slot forever while still enforcing an outer bound.
const REQUEST_TIMEOUT_MS = Number(process.env.OLLAMA_REQUEST_TIMEOUT_MS ?? 600000);

// Maximum tokens to generate per response (default: unlimited via -1).
// Ollama's built-in default is 128 tokens, which truncates most real responses.
const MAX_TOKENS = Number(process.env.OLLAMA_MAX_TOKENS ?? -1);

// Global semaphore shared across all OllamaHarness instances.
// Ollama queues requests internally, but unlimited concurrent HTTP connections
// cause timeouts before the model even starts. Limit to 3 in-flight requests
// so slow qwen3:4b responses don't starve the connection pool.
const MAX_CONCURRENT = Number(process.env.OLLAMA_MAX_CONCURRENT ?? 3);
let _activeCount = 0;
const _queue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  return new Promise(resolve => {
    if (_activeCount < MAX_CONCURRENT) {
      _activeCount++;
      resolve();
    } else {
      _queue.push(() => { _activeCount++; resolve(); });
    }
  });
}

function releaseSlot(): void {
  const next = _queue.shift();
  if (next) {
    next();
  } else {
    _activeCount--;
  }
}

/**
 * Best-effort, fire-and-forget report of one local-model generation's token
 * usage to the manager's /usage/record endpoint. Wrapped so it can NEVER throw
 * into or delay the agent's reply path — on any failure it silently no-ops.
 */
function reportOllamaUsage(u: { model: string; input: number | null; output: number | null; genMs: number }): void {
  try {
    const input = typeof u.input === 'number' && u.input >= 0 ? u.input : null;
    const output = typeof u.output === 'number' && u.output >= 0 ? u.output : null;
    if (input == null && output == null) return; // nothing measured (server ignored include_usage)
    const managerUrl = (process.env.MANAGER_URL || 'http://127.0.0.1:4100').replace(/\/+$/, '');
    const tps = output && u.genMs > 0 ? +(output / (u.genMs / 1000)).toFixed(2) : null;
    const payload = {
      runtime: 'ollama',
      model: u.model,
      agent: process.env.ID_AGENT_NAME || process.env.ID_AGENT_ALIAS || 'local',
      team: process.env.ID_AGENT_TEAM || process.env.ID_TEAM || 'default',
      input, output, genMs: u.genMs, tps,
    };
    void fetch(`${managerUrl}/usage/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    }).catch(() => { /* best-effort; ignore */ });
  } catch { /* never throw */ }
}

export class OllamaHarness implements AgentHarness {
  readonly type: HarnessType = 'ollama';

  private abortController: AbortController | null = null;
  private hub: McpToolHub | null = null; // active MCP tool hub (so cancel() can close it)

  async *run(prompt: string, options: HarnessOptions = {}): AsyncGenerator<HarnessMessage> {
    const baseUrl = process.env.OLLAMA_BASE_URL || DEFAULT_BASE_URL;
    const model = options.model || process.env.OLLAMA_MODEL || DEFAULT_MODEL;
    const url = `${baseUrl}/chat/completions`;

    console.log(`[Ollama] Starting harness`);
    console.log(`[Ollama] Endpoint: ${url}`);
    console.log(`[Ollama] Model: ${model}`);

    this.abortController = new AbortController();

    // MCP tool-calling: when servers are attached AND this model supports tools,
    // run the agentic call→execute→continue loop instead of the plain-text path.
    const servers = options.mcpServers;
    if (servers && servers.length) {
      let toolsOk = false;
      try { toolsOk = await modelSupportsTools(model, baseUrl); } catch { toolsOk = false; }
      if (toolsOk) { yield* this.runWithTools(prompt, options, servers, baseUrl, model); return; }
      console.log(`[Ollama] ${servers.length} MCP server(s) attached, but model "${model}" lacks tool support — plain-text path`);
    }

    // Build system prompt from workingDirectory context if available
    const systemParts: string[] = [];
    if (options.workingDirectory) {
      systemParts.push(`Working directory: ${options.workingDirectory}`);
    }
    const systemContent = systemParts.length > 0 ? systemParts.join('\n') : undefined;

    const messages: Array<{ role: string; content: string }> = [];
    if (systemContent) {
      messages.push({ role: 'system', content: systemContent });
    }
    messages.push({ role: 'user', content: prompt });

    const body = JSON.stringify({
      model,
      messages,
      stream: true,
      temperature: 0.2,
      max_tokens: MAX_TOKENS,
      // Ask the OpenAI-compatible endpoint to emit a final usage chunk
      // ({prompt_tokens, completion_tokens}) so we can report local-model
      // token throughput to the manager. Harmless on servers that ignore it.
      stream_options: { include_usage: true },
    });

    yield { type: 'system', subtype: 'init', session_id: undefined };

    // Wait for a concurrency slot before hitting Ollama.
    const queuePos = _queue.length;
    if (queuePos > 0) {
      console.log(`[Ollama] Queued — waiting for slot (${queuePos} ahead, model: ${model})`);
    }
    await acquireSlot();

    let result = '';
    let requestFailed = false;
    let failError = '';
    let aborted = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined; // hoisted so finally can release it
    // Token-usage accounting for the throughput gauge / 24h-7d averages.
    let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
    let firstTokenAt = 0; // wall-clock of the first content delta
    let lastTokenAt = 0;  // wall-clock of the last content delta

    try {
      // Combine the user-cancel signal with a hard wall-clock timeout so a
      // hung or extremely slow generation doesn't hold the concurrency slot
      // indefinitely. AbortSignal.any fires on whichever signal fires first.
      const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const combinedSignal = AbortSignal.any([this.abortController.signal, timeoutSignal]);

      console.log(`[Ollama] Request timeout: ${REQUEST_TIMEOUT_MS}ms, max_tokens: ${MAX_TOKENS}`);

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: combinedSignal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => `HTTP ${response.status}`);
        yield { type: 'error', content: `Ollama request failed: ${errText}` };
        return;
      }

      reader = response.body?.getReader();
      if (!reader) {
        yield { type: 'error', content: 'No response body from Ollama' };
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;

          const data = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed;
          try {
            const chunk = JSON.parse(data);
            // Final usage chunk (from stream_options.include_usage); choices is
            // typically empty here.
            if (chunk.usage) usage = chunk.usage;
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              const now = Date.now();
              if (!firstTokenAt) firstTokenAt = now;
              lastTokenAt = now;
              result += delta;
              yield { type: 'progress', subtype: 'message_delta', content: delta };
            }
          } catch {
            // non-JSON line — skip
          }
        }
      }
    } catch (err: unknown) {
      const errName = (err as Error).name;
      if (errName === 'AbortError' || errName === 'TimeoutError') {
        aborted = true;
        // Distinguish timeout from explicit cancel for the error message
        failError = errName === 'TimeoutError'
          ? `Ollama generation timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
          : 'Cancelled';
      } else {
        requestFailed = true;
        failError = (err as Error).message || String(err);
      }
    } finally {
      // Release the stream lock + cancel the underlying body on EVERY exit
      // (abort, timeout, read error, or consumer abandonment via generator return).
      try { void reader?.cancel(); } catch { /* reader may already be closed */ }
      releaseSlot();
    }

    if (aborted) {
      yield { type: 'error', content: failError || 'Cancelled' };
      return;
    }

    if (requestFailed) {
      yield { type: 'error', content: `Ollama connection error: ${failError}. Is Ollama running? (ollama serve)` };
      return;
    }

    if (result) {
      // Fire-and-forget token-usage report (never blocks or breaks the reply).
      const genMs = firstTokenAt && lastTokenAt ? Math.max(0, lastTokenAt - firstTokenAt) : 0;
      reportOllamaUsage({
        model,
        input: usage?.prompt_tokens ?? null,
        output: usage?.completion_tokens ?? null,
        genMs,
      });
      yield { type: 'result', result };
    } else {
      yield { type: 'error', content: 'Ollama returned an empty response' };
    }

    this.abortController = null;
  }

  /**
   * MCP tool-calling loop. Connects the attached MCP servers, exposes their tools
   * to the model, and runs call→execute→feed-back until the model answers without a
   * tool call (or MAX_TOOL_TURNS). Each turn STREAMS: assistant text is yielded as
   * message_delta progress events as it arrives, while tool_call deltas are
   * assembled per index (name + a growing arguments JSON string) and parsed once the
   * turn completes. One concurrency slot is held for the WHOLE loop; token usage is
   * summed across turns; the hub is closed in `finally` so child MCP processes never
   * leak on cancel/timeout.
   */
  private async *runWithTools(
    prompt: string,
    options: HarnessOptions,
    servers: McpServerSpec[],
    baseUrl: string,
    model: string,
  ): AsyncGenerator<HarnessMessage> {
    const url = `${baseUrl}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    // Snapshot the controller: a between-turn cancel() nulls the shared field, so
    // closing over it directly would null-deref. cancel() calls abort() first, so
    // `ac.signal` stays aborted and the next fetch is created already-aborted.
    const ac = this.abortController!;
    const newSignal = () => AbortSignal.any([ac.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);

    yield { type: 'system', subtype: 'init', session_id: undefined };

    const queuePos = _queue.length;
    if (queuePos > 0) console.log(`[Ollama] Queued — waiting for slot (${queuePos} ahead, model: ${model})`);
    await acquireSlot();

    let hub: McpToolHub | null = null;
    let totalIn = 0;
    let totalOut = 0;
    const t0 = Date.now();

    try {
      hub = await McpToolHub.connect(servers);
      this.hub = hub; // expose to cancel() so an abort tears down child MCP processes
      let tools = mcpToOpenAiTools(hub.listTools());
      if (options.allowedTools && options.allowedTools.length) {
        const allow = new Set(options.allowedTools);
        // Scope: allow by exposed (namespaced) name OR the underlying bare tool name.
        tools = tools.filter((t) => allow.has(t.function.name) || allow.has(t.function.name.split('__').pop() || ''));
      }
      console.log(`[Ollama] Attached ${servers.length} MCP server(s); ${tools.length} tool(s) exposed`);

      const messages: Array<Record<string, unknown>> = [
        {
          role: 'system',
          content:
            'You can call the provided tools to gather information needed to answer. ' +
            'Call a tool only when it actually helps; once you have enough to answer, reply in plain text. ' +
            'Never fabricate tool output — use the values the tools return.' +
            (options.workingDirectory ? `\nWorking directory: ${options.workingDirectory}` : ''),
        },
        { role: 'user', content: prompt },
      ];

      let finalText = '';
      let plainFallback = false;

      for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
        const reqBody: Record<string, unknown> = {
          model, messages, stream: true, temperature: 0.2, max_tokens: MAX_TOKENS,
          stream_options: { include_usage: true },
        };
        if (tools.length && !plainFallback) reqBody.tools = tools;

        const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(reqBody), signal: newSignal() });
        if (!resp.ok) {
          const errText = await resp.text().catch(() => `HTTP ${resp.status}`);
          // A tools-related 4xx on the first turn → retry once WITHOUT tools, so
          // MCP can never hard-fail the agent (capability detection can be wrong).
          if (turn === 0 && !plainFallback && tools.length && resp.status >= 400 && resp.status < 500) {
            console.warn(`[Ollama] tools rejected by model (${resp.status}); falling back to plain text`);
            plainFallback = true;
            continue;
          }
          yield { type: 'error', content: `Ollama request failed: ${errText}` };
          return;
        }
        const reader = resp.body?.getReader();
        if (!reader) { yield { type: 'error', content: 'No response body from Ollama' }; return; }

        // Stream the turn: yield assistant text deltas live; assemble tool_call
        // deltas per index (.function.name + a growing .function.arguments string).
        const decoder = new TextDecoder();
        let buffer = '';
        let turnContent = '';
        const partial = new Map<number, { id?: string; name: string; args: string }>();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed === 'data: [DONE]') continue;
              const data = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed;
              try {
                const chunk = JSON.parse(data);
                if (chunk.usage) { totalIn += chunk.usage.prompt_tokens || 0; totalOut += chunk.usage.completion_tokens || 0; }
                const delta = chunk.choices?.[0]?.delta;
                if (delta?.content) {
                  turnContent += delta.content;
                  yield { type: 'progress', subtype: 'message_delta', content: delta.content };
                }
                if (Array.isArray(delta?.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    const idx = typeof tc.index === 'number' ? tc.index : 0;
                    let p = partial.get(idx);
                    if (!p) { p = { id: tc.id, name: '', args: '' }; partial.set(idx, p); }
                    if (tc.id) p.id = tc.id;
                    if (tc.function?.name) p.name += tc.function.name;
                    if (typeof tc.function?.arguments === 'string') p.args += tc.function.arguments;
                  }
                }
              } catch { /* non-JSON keep-alive / partial line — skip */ }
            }
          }
        } finally {
          try { void reader.cancel(); } catch { /* already closed */ }
        }

        // Assemble the streamed tool calls (sorted by index → stable order).
        const calls = [...partial.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => ({ id: p.id, function: { name: p.name, arguments: p.args } }));
        // Only a turn WITHOUT tool_calls is a real final answer — never let
        // intermediate "let me check…" narration alongside a tool_call become it.
        if (!calls.length && turnContent) finalText = turnContent;

        // Record the assistant turn (incl. tool_calls) so the model keeps context.
        messages.push({ role: 'assistant', content: turnContent, ...(calls.length ? { tool_calls: calls } : {}) });

        if (!calls.length) break; // the model produced a final answer

        for (const call of calls) {
          const exposed = call.function.name || '';
          yield { type: 'tool_use', tool_name: exposed, content: call.function.arguments || '' };
          console.log(`[Ollama] tool_call: ${exposed}`);
          const out = await hub.callTool(exposed, parseOpenAiCallArgs(call), ac.signal);
          console.log(`[Ollama] tool result: ${out.text.length} chars${out.isError ? ' (error)' : ''}`);
          messages.push({ role: 'tool', tool_call_id: call.id || exposed, content: out.text });
        }

        if (turn === MAX_TOOL_TURNS - 1) console.warn(`[Ollama] hit MAX_TOOL_TURNS (${MAX_TOOL_TURNS}); forcing a final answer`);
      }

      // If we ran out of turns mid-tool-call (no clean final answer yet), give the
      // model ONE tools-free turn so it answers from the accumulated tool results
      // instead of returning a placeholder.
      if (!finalText) {
        try {
          const wrap = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ model, messages, stream: false, temperature: 0.2, max_tokens: MAX_TOKENS }), signal: newSignal() });
          if (wrap.ok) {
            const wj = (await wrap.json()) as { usage?: { prompt_tokens?: number; completion_tokens?: number }; choices?: Array<{ message?: { content?: string } }> };
            if (wj.usage) { totalIn += wj.usage.prompt_tokens || 0; totalOut += wj.usage.completion_tokens || 0; }
            const c = wj.choices?.[0]?.message?.content;
            if (typeof c === 'string' && c) finalText = c;
          }
        } catch { /* keep the sentinel below */ }
      }

      reportOllamaUsage({ model, input: totalIn || null, output: totalOut || null, genMs: Date.now() - t0 });
      yield { type: 'result', result: finalText || '(the model stopped without a final answer)' };
    } catch (err: unknown) {
      const name = (err as Error).name;
      if (name === 'AbortError' || name === 'TimeoutError') {
        yield { type: 'error', content: name === 'TimeoutError' ? `Ollama tool run timed out after ${REQUEST_TIMEOUT_MS / 1000}s` : 'Cancelled' };
      } else {
        yield { type: 'error', content: `Ollama tool-loop error: ${(err as Error).message || String(err)}` };
      }
    } finally {
      if (hub) await hub.close().catch(() => { /* best-effort */ });
      this.hub = null;
      releaseSlot();
      this.abortController = null;
    }
  }

  cancel(): boolean {
    const active = this.abortController !== null;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    // Tear down any in-flight MCP tool hub so child server processes don't linger
    // (the loop's finally also closes it; this makes cancel immediate).
    if (this.hub) {
      const h = this.hub;
      this.hub = null;
      void h.close().catch(() => { /* best-effort */ });
    }
    return active;
  }
}
