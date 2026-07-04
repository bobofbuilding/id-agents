// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node-fetch', () => ({
  default: vi.fn(),
}));

import fetch from 'node-fetch';
import { AgentManagerDb } from '../../src/agent-manager-db.js';

function makeDb(): any {
  return {};
}

function makeResponse(status: number, body: unknown): any {
  const ok = status >= 200 && status < 300;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Service Unavailable',
    text: async () => text,
    json: async () => body,
  };
}

describe('AgentManagerDb /talk-to delivery retry backoff', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries transient failures with exponential backoff before succeeding', async () => {
    vi.useFakeTimers();

    const manager = new AgentManagerDb('/tmp/id-agents-talk-retry-test', makeDb() as any, { libraryRoot: null }) as any;
    let attempt = 0;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async () => {
      attempt += 1;
      if (attempt < 3) {
        return makeResponse(503, { error: `unavailable-${attempt}` }) as any;
      }
      return makeResponse(202, { query_id: 'query-123' }) as any;
    });

    const delivery = manager.forwardToAgent(
      'http://worker.example',
      'hello',
      'manager',
      'session-1',
      { attempts: 3, initialDelayMs: 250, label: 'worker' },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(249);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await expect(delivery).resolves.toEqual({
      ok: true,
      data: { query_id: 'query-123' },
    });
  });

  it('does not retry client errors', async () => {
    const manager = new AgentManagerDb('/tmp/id-agents-talk-retry-test', makeDb() as any, { libraryRoot: null }) as any;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(makeResponse(400, 'bad request') as any);

    await expect(
      manager.forwardToAgent(
        'http://worker.example',
        'hello',
        'manager',
        'session-1',
        { attempts: 3, initialDelayMs: 250, label: 'worker' },
      ),
    ).resolves.toEqual({
      ok: false,
      status: 400,
      error: '400 bad request',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
