import { describe, it, expect } from 'vitest';
import { LocalModelGate, isLocalModelRuntime } from '../../src/lib/local-model-gate.js';

describe('isLocalModelRuntime', () => {
  it('serializes only local model runtimes', () => {
    expect(isLocalModelRuntime('ollama')).toBe(true);
    expect(isLocalModelRuntime('provider:lmstudio')).toBe(true);
    expect(isLocalModelRuntime('provider:custom', 'http://127.0.0.1:1234/v1')).toBe(true);
    expect(isLocalModelRuntime('provider:custom', 'http://localhost:1234/v1')).toBe(true);
    expect(isLocalModelRuntime('claude-code-local')).toBe(false);
    expect(isLocalModelRuntime('claude-code-cli')).toBe(false);
    expect(isLocalModelRuntime('codex')).toBe(false);
    expect(isLocalModelRuntime('cursor-cli')).toBe(false);
    expect(isLocalModelRuntime('provider:openrouter', 'https://openrouter.ai/api/v1')).toBe(false);
    expect(isLocalModelRuntime(undefined)).toBe(false);
    expect(isLocalModelRuntime(null)).toBe(false);
  });
});

describe('LocalModelGate', () => {
  it('runs one at a time and admits the next on release (FIFO)', async () => {
    const gate = new LocalModelGate(1);
    const order: string[] = [];

    await gate.acquire('q1'); // immediate
    order.push('q1-start');
    expect(gate.activeCount).toBe(1);

    // q2 and q3 queue behind q1.
    const q2 = gate.acquire('q2').then(() => order.push('q2-start'));
    const q3 = gate.acquire('q3').then(() => order.push('q3-start'));
    await Promise.resolve();
    expect(gate.queuedCount).toBe(2);
    expect(order).toEqual(['q1-start']); // neither admitted yet

    gate.release('q1');
    await q2;
    expect(order).toEqual(['q1-start', 'q2-start']);
    expect(gate.activeCount).toBe(1);

    gate.release('q2');
    await q3;
    expect(order).toEqual(['q1-start', 'q2-start', 'q3-start']);
    gate.release('q3');
    expect(gate.activeCount).toBe(0);
  });

  it('honors a concurrency above 1', async () => {
    const gate = new LocalModelGate(2);
    await gate.acquire('a');
    await gate.acquire('b');
    expect(gate.activeCount).toBe(2);
    let cGranted = false;
    const c = gate.acquire('c').then(() => (cGranted = true));
    await Promise.resolve();
    expect(cGranted).toBe(false); // third waits
    gate.release('a');
    await c;
    expect(cGranted).toBe(true);
  });

  it('is idempotent: re-acquire/double-release do not corrupt the count', async () => {
    const gate = new LocalModelGate(1);
    await gate.acquire('q1');
    await gate.acquire('q1'); // no-op, already held
    expect(gate.activeCount).toBe(1);
    gate.release('q1');
    gate.release('q1'); // no-op, already released
    expect(gate.activeCount).toBe(0);
  });

  it('auto-releases after maxHoldMs so a missed release cannot deadlock dispatch', async () => {
    const gate = new LocalModelGate(1, 20); // 20ms safety net
    await gate.acquire('stuck'); // never released by caller
    let nextGranted = false;
    gate.acquire('next').then(() => (nextGranted = true));
    expect(nextGranted).toBe(false);
    await new Promise((r) => setTimeout(r, 40)); // wait past the safety net
    expect(nextGranted).toBe(true); // self-healed
    expect(gate.holding('stuck')).toBe(false);
  });

  it('cancels queued timed-out acquires without consuming a later slot', async () => {
    const gate = new LocalModelGate(1);
    await gate.acquire('active');

    await expect(gate.acquire('timed-out', 10)).rejects.toThrow('local_model_gate_timeout');
    expect(gate.activeCount).toBe(1);

    let nextGranted = false;
    const next = gate.acquire('next').then(() => (nextGranted = true));
    await Promise.resolve();
    expect(nextGranted).toBe(false);

    gate.release('active');
    await next;
    expect(nextGranted).toBe(true);
    expect(gate.holding('timed-out')).toBe(false);
    expect(gate.holding('next')).toBe(true);
  });
});
