// SPDX-License-Identifier: MIT
/**
 * Provider API Harness
 *
 * Runtime-neutral OpenAI-compatible API lane. IDACC assigns a configured
 * provider lane (OpenRouter, NVIDIA, Groq, Perplexity API, etc.) and passes the
 * selected endpoint/key to the child process as env at rebuild time. The key is
 * never stored on the agent row.
 */

import { AgentHarness, HarnessOptions, HarnessMessage, HarnessType, McpServerSpec } from './types.js';
import {
  callOpenAiToolWithinBoundary,
  McpToolHub,
  filterOpenAiMcpServersForAllowlist,
  filterOpenAiToolsForAllowlist,
  mcpToOpenAiTools,
  openAiToolExecutionSet,
} from './mcp-client.js';
import { reportTurnUsage } from './usage-report.js';
import { plainTextExecutionBoundary } from './external-text-policy.js';

const DEFAULT_MODEL = 'default';
const REQUEST_TIMEOUT_MS = Number(process.env.PROVIDER_API_REQUEST_TIMEOUT_MS ?? 600000);
const MAX_TOKENS = Number(process.env.PROVIDER_API_MAX_TOKENS ?? -1);
const LOCAL_NO_KEY_SENTINEL = 'idacc-local-provider-no-key';
const MAX_TOOL_TURNS = Number(process.env.PROVIDER_API_MAX_TOOL_TURNS ?? 8);

function providerHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey && apiKey !== LOCAL_NO_KEY_SENTINEL) headers.Authorization = `Bearer ${apiKey}`;
  // OpenRouter rewards/validates client identity headers when present.
  if (process.env.PROVIDER_API_HTTP_REFERER) headers['HTTP-Referer'] = process.env.PROVIDER_API_HTTP_REFERER;
  if (process.env.PROVIDER_API_X_TITLE) headers['X-Title'] = process.env.PROVIDER_API_X_TITLE;
  return headers;
}

function isLoopbackUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '0.0.0.0' || host === '::1' || host.endsWith('.local');
  } catch {
    return false;
  }
}

function isNativeOllamaBase(base: string): boolean {
  try {
    const u = new URL(base);
    const host = u.hostname.toLowerCase();
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return (host === '127.0.0.1' || host === 'localhost' || host === '0.0.0.0' || host === '::1') && port === '11434' && !u.pathname.replace(/\/+$/, '').endsWith('/v1');
  } catch {
    return false;
  }
}

export function endpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) return base;
  if (isNativeOllamaBase(base)) return `${base}/v1/chat/completions`;
  return `${base}/chat/completions`;
}

export class ProviderApiHarness implements AgentHarness {
  readonly type: HarnessType = 'provider-api';
  private abortController: AbortController | null = null;
  private hub: McpToolHub | null = null;

  async *run(prompt: string, options: HarnessOptions = {}): AsyncGenerator<HarnessMessage> {
    const boundary = plainTextExecutionBoundary(options, MAX_TOKENS);
    const provider = process.env.ID_PROVIDER_NAME || 'api-provider';
    const baseUrl = process.env.ID_PROVIDER_BASE_URL || process.env.OPENAI_BASE_URL || '';
    const apiKey = process.env.ID_PROVIDER_API_KEY || process.env.OPENAI_API_KEY || '';
    const model = options.model || process.env.ID_PROVIDER_MODEL || process.env.OPENAI_MODEL || DEFAULT_MODEL;
    const url = baseUrl ? endpoint(baseUrl) : '';

    yield { type: 'system', subtype: 'init', content: `Starting API provider harness (${provider})` };

    if (!url) {
      yield { type: 'error', content: 'Provider API runtime is missing ID_PROVIDER_BASE_URL.' };
      return;
    }
    if (!apiKey && !isLoopbackUrl(baseUrl)) {
      yield { type: 'error', content: `Provider API runtime "${provider}" is missing an API key.` };
      return;
    }

    console.log(`[ProviderAPI] Starting ${provider}`);
    console.log(`[ProviderAPI] Endpoint: ${url}`);
    console.log(`[ProviderAPI] Model: ${model}`);

    this.abortController = new AbortController();

    const permittedMcpServers = filterOpenAiMcpServersForAllowlist(
      boundary.mcpServers,
      options.allowedTools,
    );
    if (permittedMcpServers.length) {
      yield* this.runWithTools(prompt, options, permittedMcpServers, provider, url, apiKey, model);
      return;
    }

    const started = Date.now();
    let result = '';
    let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;

    const messages: Array<{ role: string; content: string }> = [];
    if (boundary.workingDirectory) {
      messages.push({ role: 'system', content: `Working directory: ${boundary.workingDirectory}` });
    }
    messages.push({ role: 'user', content: prompt });

    try {
      const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const signal = AbortSignal.any([this.abortController.signal, timeoutSignal]);
      const response = await fetch(url, {
        method: 'POST',
        headers: providerHeaders(apiKey),
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          temperature: 0.2,
          ...(boundary.maxTokens >= 0 ? { max_tokens: boundary.maxTokens } : {}),
          stream_options: { include_usage: true },
        }),
        signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => `HTTP ${response.status}`);
        yield { type: 'error', content: `${provider} request failed: ${errText}` };
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        yield { type: 'error', content: `${provider} returned no response body` };
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
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
              if (chunk.usage) usage = chunk.usage;
              const delta = chunk.choices?.[0]?.delta?.content;
              if (delta) {
                result += delta;
                yield { type: 'progress', subtype: 'message_delta', content: delta };
              }
            } catch {
              // Ignore keepalive/non-JSON lines.
            }
          }
        }
      } finally {
        try { reader.releaseLock(); } catch {}
      }

      reportTurnUsage({
        runtime: 'provider-api',
        model,
        input: usage?.prompt_tokens ?? null,
        output: usage?.completion_tokens ?? null,
        genMs: Date.now() - started,
        queryId: options.queryId,
      });

      yield { type: 'result', result };
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: 'error', content: name === 'TimeoutError' ? `${provider} request timed out after ${REQUEST_TIMEOUT_MS / 1000}s` : msg };
      throw err;
    }
  }

  private async *runWithTools(
    prompt: string,
    options: HarnessOptions,
    servers: McpServerSpec[],
    provider: string,
    url: string,
    apiKey: string,
    model: string,
  ): AsyncGenerator<HarnessMessage> {
    const ac = this.abortController!;
    const headers = providerHeaders(apiKey);
    const newSignal = () => AbortSignal.any([ac.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    const started = Date.now();

    let hub: McpToolHub | null = null;
    let totalIn = 0;
    let totalOut = 0;

    try {
      hub = await McpToolHub.connect(servers);
      this.hub = hub;
      const tools = filterOpenAiToolsForAllowlist(
        mcpToOpenAiTools(hub.listTools()),
        options.allowedTools,
      );
      const executableToolNames = openAiToolExecutionSet(tools);

      if (!tools.length) {
        console.log(`[ProviderAPI] ${servers.length} MCP server(s) attached, but no tools were available — plain-text path`);
        yield* this.runPlain(prompt, options, provider, url, apiKey, model, started);
        return;
      }

      console.log(`[ProviderAPI] Attached ${servers.length} MCP server(s); ${tools.length} tool(s) exposed`);

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
          model,
          messages,
          stream: true,
          temperature: 0.2,
          ...(MAX_TOKENS >= 0 ? { max_tokens: MAX_TOKENS } : {}),
          stream_options: { include_usage: true },
        };
        if (!plainFallback) reqBody.tools = tools;

        const resp = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(reqBody),
          signal: newSignal(),
        });

        if (!resp.ok) {
          const errText = await resp.text().catch(() => `HTTP ${resp.status}`);
          if (turn === 0 && !plainFallback && resp.status >= 400 && resp.status < 500) {
            console.warn(`[ProviderAPI] tools rejected by ${provider} (${resp.status}); falling back to plain text`);
            plainFallback = true;
            continue;
          }
          yield { type: 'error', content: `${provider} request failed: ${errText}` };
          return;
        }

        const reader = resp.body?.getReader();
        if (!reader) {
          yield { type: 'error', content: `${provider} returned no response body` };
          return;
        }

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
                if (chunk.usage) {
                  totalIn += chunk.usage.prompt_tokens || 0;
                  totalOut += chunk.usage.completion_tokens || 0;
                }
                const delta = chunk.choices?.[0]?.delta;
                if (delta?.content) {
                  turnContent += delta.content;
                  yield { type: 'progress', subtype: 'message_delta', content: delta.content };
                }
                if (Array.isArray(delta?.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    const idx = typeof tc.index === 'number' ? tc.index : 0;
                    let p = partial.get(idx);
                    if (!p) {
                      p = { id: tc.id, name: '', args: '' };
                      partial.set(idx, p);
                    }
                    if (tc.id) p.id = tc.id;
                    if (tc.function?.name) p.name += tc.function.name;
                    if (typeof tc.function?.arguments === 'string') p.args += tc.function.arguments;
                  }
                }
              } catch {
                // Ignore keepalive/non-JSON lines.
              }
            }
          }
        } finally {
          try { void reader.cancel(); } catch {}
        }

        const calls = [...partial.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, p]) => ({ id: p.id, function: { name: p.name, arguments: p.args } }));

        if (!calls.length && turnContent) finalText = turnContent;
        messages.push({ role: 'assistant', content: turnContent, ...(calls.length ? { tool_calls: calls } : {}) });

        if (!calls.length) break;

        for (const call of calls) {
          const exposed = call.function.name || '';
          yield { type: 'tool_use', tool_name: exposed, content: call.function.arguments || '' };
          console.log(`[ProviderAPI] tool_call: ${exposed}`);
          const out = await callOpenAiToolWithinBoundary(
            hub,
            plainFallback ? new Set<string>() : executableToolNames,
            call,
            ac.signal,
          );
          console.log(`[ProviderAPI] tool result: ${out.text.length} chars${out.isError ? ' (error)' : ''}`);
          messages.push({ role: 'tool', tool_call_id: call.id || exposed, content: out.text });
        }

        if (turn === MAX_TOOL_TURNS - 1) console.warn(`[ProviderAPI] hit MAX_TOOL_TURNS (${MAX_TOOL_TURNS}); forcing a final answer`);
      }

      if (!finalText) {
        try {
          const wrap = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model,
              messages,
              stream: false,
              temperature: 0.2,
              ...(MAX_TOKENS >= 0 ? { max_tokens: MAX_TOKENS } : {}),
            }),
            signal: newSignal(),
          });
          if (wrap.ok) {
            const body = await wrap.json() as { usage?: { prompt_tokens?: number; completion_tokens?: number }; choices?: Array<{ message?: { content?: string } }> };
            if (body.usage) {
              totalIn += body.usage.prompt_tokens || 0;
              totalOut += body.usage.completion_tokens || 0;
            }
            const content = body.choices?.[0]?.message?.content;
            if (typeof content === 'string' && content) finalText = content;
          }
        } catch {
          // Keep sentinel below.
        }
      }

      reportTurnUsage({
        runtime: 'provider-api',
        model,
        input: totalIn || null,
        output: totalOut || null,
        genMs: Date.now() - started,
        queryId: options.queryId,
      });
      yield { type: 'result', result: finalText || '(the model stopped without a final answer)' };
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: 'error', content: name === 'TimeoutError' ? `${provider} tool run timed out after ${REQUEST_TIMEOUT_MS / 1000}s` : `${provider} tool-loop error: ${msg}` };
    } finally {
      if (hub) await hub.close().catch(() => {});
      this.hub = null;
      this.abortController = null;
    }
  }

  private async *runPlain(
    prompt: string,
    options: HarnessOptions,
    provider: string,
    url: string,
    apiKey: string,
    model: string,
    started: number = Date.now(),
  ): AsyncGenerator<HarnessMessage> {
    let result = '';
    let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
    const messages: Array<{ role: string; content: string }> = [];
    if (options.workingDirectory) {
      messages.push({ role: 'system', content: `Working directory: ${options.workingDirectory}` });
    }
    messages.push({ role: 'user', content: prompt });

    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = AbortSignal.any([this.abortController!.signal, timeoutSignal]);
    const response = await fetch(url, {
      method: 'POST',
      headers: providerHeaders(apiKey),
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        temperature: 0.2,
        ...(MAX_TOKENS >= 0 ? { max_tokens: MAX_TOKENS } : {}),
        stream_options: { include_usage: true },
      }),
      signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => `HTTP ${response.status}`);
      yield { type: 'error', content: `${provider} request failed: ${errText}` };
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      yield { type: 'error', content: `${provider} returned no response body` };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
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
            if (chunk.usage) usage = chunk.usage;
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              result += delta;
              yield { type: 'progress', subtype: 'message_delta', content: delta };
            }
          } catch {
            // Ignore keepalive/non-JSON lines.
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }

    reportTurnUsage({
      runtime: 'provider-api',
      model,
      input: usage?.prompt_tokens ?? null,
      output: usage?.completion_tokens ?? null,
      genMs: Date.now() - started,
      queryId: options.queryId,
    });

    yield { type: 'result', result };
  }

  cancel(): boolean {
    const active = this.abortController !== null;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.hub) {
      const h = this.hub;
      this.hub = null;
      void h.close().catch(() => {});
    }
    return active;
  }
}
