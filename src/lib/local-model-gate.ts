// SPDX-License-Identifier: MIT
/**
 * LocalModelGate — serialize work on runtimes whose inference runs LOCALLY (the
 * `ollama` runtime — the umbrella for Ollama / LM Studio / any openai-compatible
 * local server) while letting subscription/API-backed agents run in parallel. A
 * single local model on one machine can't usefully run many inferences at once
 * (it thrashes VRAM/CPU); cloud/subscription backends can.
 *
 * Each agent runs in its own process, so the cross-process coordination point is
 * the manager: acquire a slot when dispatching a query to a local-model agent,
 * release it when that query reaches a terminal state. Subscription runtimes
 * never touch the gate.
 *
 * Deadlock-safe by design: every hold auto-releases after `maxHoldMs` (matched to
 * the manager's stuck-query sweeper), so a missed release path can never wedge
 * dispatch permanently — at worst a slot frees late. acquire()/release() are
 * idempotent per key (queryId).
 */

/**
 * Runtimes whose inference happens on THIS machine and must be serialized.
 *
 * Only the `ollama` runtime qualifies — it's the catch-all for every local
 * inference server (Ollama, LM Studio, openai-compatible local). Every other
 * runtime is subscription/cloud-backed and runs in parallel, INCLUDING
 * `claude-code-local`: despite its name, it's the Claude Code CLI on an Anthropic
 * *subscription* serving cloud Claude models (opus/sonnet/haiku) — the "local"
 * refers to the agent process, not the model. (See idctl runtimeCatalog: claude-*
 * runtimes ← anthropic provider; the `ollama` runtime ← local model servers.)
 */
export function isLocalModelRuntime(runtime?: string | null): boolean {
  return runtime === 'ollama';
}

export class LocalModelGate {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private readonly holds = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * @param concurrency  max local-model queries in flight (default 1)
   * @param maxHoldMs     auto-release safety net (default 16 min, > sweeper)
   */
  constructor(
    private readonly concurrency = 1,
    private readonly maxHoldMs = 16 * 60 * 1000,
  ) {}

  /** Acquire a slot for `key`; resolves when one is free. Idempotent per key. */
  acquire(key: string): Promise<void> {
    if (this.holds.has(key)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const grant = () => {
        this.active++;
        const timer = setTimeout(() => this.release(key), this.maxHoldMs);
        // Don't keep the event loop alive just for the safety timer.
        (timer as { unref?: () => void }).unref?.();
        this.holds.set(key, timer);
        resolve();
      };
      if (this.active < this.concurrency) grant();
      else this.queue.push(grant);
    });
  }

  /** Release the slot held by `key` and admit the next waiter. Idempotent. */
  release(key: string): void {
    const timer = this.holds.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.holds.delete(key);
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) next();
  }

  get activeCount(): number {
    return this.active;
  }
  get queuedCount(): number {
    return this.queue.length;
  }
  /** True if this key currently holds (or is mid-hold on) a slot. */
  holding(key: string): boolean {
    return this.holds.has(key);
  }
}
