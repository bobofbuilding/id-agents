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
 * `ollama` is the native local-model runtime. OpenAI-compatible provider lanes
 * can also be local when their endpoint is loopback (for example LM Studio at
 * http://127.0.0.1:1234/v1). Cloud provider lanes stay parallel. Every other
 * subscription runtime also runs in parallel, INCLUDING `claude-code-local`:
 * despite its name, it's the Claude Code CLI on an Anthropic subscription
 * serving cloud Claude models — the "local" refers to the agent process.
 */
export function isLocalProviderUrl(raw?: string | null): boolean {
  if (!raw) return false;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '0.0.0.0' || host === '::1' || host.endsWith('.local');
  } catch {
    return false;
  }
}

export function isLocalModelRuntime(runtime?: string | null, providerBaseUrl?: string | null): boolean {
  if (runtime === 'ollama') return true;
  if (providerBaseUrl && isLocalProviderUrl(providerBaseUrl)) return true;
  return String(runtime ?? '').toLowerCase() === 'provider:lmstudio';
}

export class LocalModelGate {
  private active = 0;
  private concurrency: number;
  private readonly queue: Array<() => void> = [];
  private readonly holds = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * @param concurrency  max local-model queries in flight (default 1)
   * @param maxHoldMs     auto-release safety net (default 16 min, > sweeper)
   */
  constructor(
    concurrency = 1,
    private readonly maxHoldMs = 16 * 60 * 1000,
  ) {
    this.concurrency = Math.max(1, Math.floor(concurrency) || 1);
  }

  /** Current max concurrent local-model queries. */
  getConcurrency(): number {
    return this.concurrency;
  }

  /** Change the cap at runtime; raising it immediately admits queued waiters. */
  setConcurrency(n: number): void {
    this.concurrency = Math.max(1, Math.floor(n) || 1);
    while (this.active < this.concurrency && this.queue.length > 0) {
      this.queue.shift()!();
    }
  }

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
