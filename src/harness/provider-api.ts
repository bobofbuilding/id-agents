// SPDX-License-Identifier: MIT
/**
 * Provider API Harness
 *
 * Runtime-neutral OpenAI-compatible API lane. IDACC assigns a configured
 * provider lane (OpenRouter, NVIDIA, Groq, Perplexity API, etc.) and passes the
 * selected endpoint/key to the child process as env at rebuild time. The key is
 * never stored on the agent row.
 */

import { AgentHarness, HarnessOptions, HarnessMessage, HarnessType } from './types.js';
import { reportTurnUsage } from './usage-report.js';

const DEFAULT_MODEL = 'default';
const REQUEST_TIMEOUT_MS = Number(process.env.PROVIDER_API_REQUEST_TIMEOUT_MS ?? 600000);
const MAX_TOKENS = Number(process.env.PROVIDER_API_MAX_TOKENS ?? -1);
const LOCAL_NO_KEY_SENTINEL = 'idacc-local-provider-no-key';

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

function endpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

export class ProviderApiHarness implements AgentHarness {
  readonly type: HarnessType = 'provider-api';
  private abortController: AbortController | null = null;

  async *run(prompt: string, options: HarnessOptions = {}): AsyncGenerator<HarnessMessage> {
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
    const started = Date.now();
    let result = '';
    let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;

    const messages: Array<{ role: string; content: string }> = [];
    if (options.workingDirectory) {
      messages.push({ role: 'system', content: `Working directory: ${options.workingDirectory}` });
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
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: 'error', content: name === 'TimeoutError' ? `${provider} request timed out after ${REQUEST_TIMEOUT_MS / 1000}s` : msg };
      throw err;
    }
  }

  cancel(): boolean {
    if (!this.abortController) return false;
    this.abortController.abort();
    this.abortController = null;
    return true;
  }
}
