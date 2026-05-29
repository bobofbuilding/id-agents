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

import { AgentHarness, HarnessOptions, HarnessMessage, HarnessType } from './types.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1';
const DEFAULT_MODEL = 'qwen3:4b';

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

export class OllamaHarness implements AgentHarness {
  readonly type: HarnessType = 'ollama';

  private abortController: AbortController | null = null;

  async *run(prompt: string, options: HarnessOptions = {}): AsyncGenerator<HarnessMessage> {
    const baseUrl = process.env.OLLAMA_BASE_URL || DEFAULT_BASE_URL;
    const model = options.model || process.env.OLLAMA_MODEL || DEFAULT_MODEL;
    const url = `${baseUrl}/chat/completions`;

    console.log(`[Ollama] Starting harness`);
    console.log(`[Ollama] Endpoint: ${url}`);
    console.log(`[Ollama] Model: ${model}`);

    this.abortController = new AbortController();

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

      const reader = response.body?.getReader();
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
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
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
      yield { type: 'result', result };
    } else {
      yield { type: 'error', content: 'Ollama returned an empty response' };
    }

    this.abortController = null;
  }

  cancel(): boolean {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      return true;
    }
    return false;
  }
}
