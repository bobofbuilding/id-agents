// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'net';

import { AgentRestServer } from '../../src/claude-agent-server.js';
import type { AgentHarness, HarnessMessage, HarnessOptions, HarnessType } from '../../src/harness/index.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class CancellableHarness implements AgentHarness {
  readonly type = 'claude-code-cli' as HarnessType;
  cancelled = false;
  cancelCalls = 0;
  private doneResolve!: () => void;
  done = new Promise<void>((resolve) => {
    this.doneResolve = resolve;
  });

  async *run(_prompt: string, _options: HarnessOptions): AsyncGenerator<HarnessMessage> {
    try {
      while (!this.cancelled) {
        await sleep(5);
      }
      yield { type: 'error', content: 'Query was cancelled' };
    } finally {
      this.doneResolve();
    }
  }

  cancel(): boolean {
    this.cancelCalls += 1;
    this.cancelled = true;
    return true;
  }
}

class TimeoutOnceHarness implements AgentHarness {
  readonly type = 'claude-code-cli' as HarnessType;
  runs = 0;
  cancelCalls = 0;
  private releaseFirst: (() => void) | null = null;

  async *run(_prompt: string, _options: HarnessOptions): AsyncGenerator<HarnessMessage> {
    this.runs += 1;
    if (this.runs === 1) {
      await new Promise<void>((resolve) => {
        this.releaseFirst = resolve;
      });
      return;
    }
    yield { type: 'result', result: 'ok after retry' };
  }

  cancel(): boolean {
    this.cancelCalls += 1;
    this.releaseFirst?.();
    return true;
  }
}

function queryRow(status: string) {
  return {
    team_id: 'team-1',
    agent_id: 'agent-1',
    query_id: 'query-1',
    status,
    prompt: 'prompt',
    created: 1,
    completed: status === 'processing' ? null : 2,
    result: null,
    error: status === 'failed' ? 'manager marked failed' : null,
    session_id: null,
    owner_kind: 'agent',
    owner_id: 'agent-1',
    metadata: null,
  };
}

describe('AgentRestServer external query terminal watcher', () => {
  afterEach(() => {
    delete process.env.ID_AGENT_QUERY_TERMINAL_POLL_MS;
    delete process.env.ID_HARNESS;
    delete process.env.ID_AGENT_LEAD_QUERY_CONCURRENCY;
    delete process.env.ID_AGENT_DELEGATION_QUERY_TIMEOUT_MS;
    delete process.env.ID_AGENT_QUERY_TIMEOUT_RETRIES;
    vi.useRealTimers();
  });

  it.each([
    ['expired', 'query.expired'],
    ['failed', 'query.failed'],
  ] as const)('cancels the local harness without overwriting manager-%s query state', async (terminalStatus, newsType) => {
    process.env.ID_AGENT_QUERY_TERMINAL_POLL_MS = '5';
    process.env.ID_HARNESS = 'claude-code-cli';

    const harness = new CancellableHarness();
    let reads = 0;
    const db: any = {
      queries: {
        upsert: vi.fn(async () => {}),
        getByQueryIdForTeam: vi.fn(async () => {
          reads += 1;
          return queryRow(reads >= 2 ? terminalStatus : 'processing');
        }),
      },
      news: {
        add: vi.fn(async () => {}),
      },
    };

    const server = new AgentRestServer({
      agentName: 'worker',
      db: { db, teamId: 'team-1', agentId: 'agent-1' },
      harness,
    });

    try {
      await (server as any).startQuery('query-1', 'prompt', undefined, 'manager');

      await vi.waitFor(() => {
        expect(harness.cancelCalls).toBeGreaterThan(0);
      }, { timeout: 1000 });
      await harness.done;

      expect(db.queries.upsert).toHaveBeenCalledWith(
        'team-1',
        'agent-1',
        expect.objectContaining({ query_id: 'query-1', status: 'processing' }),
      );
      expect(db.queries.upsert.mock.calls.some((call: any[]) => call[2]?.status === 'failed')).toBe(false);
      expect(db.news.add).toHaveBeenCalledWith(
        'team-1',
        'agent-1',
        expect.objectContaining({
          type: newsType,
          query_id: 'query-1',
          data: expect.objectContaining({ external_status: terminalStatus }),
        }),
      );
    } finally {
      await server.stop();
    }
  });

  it('persists direct cancel as a terminal query row', async () => {
    process.env.ID_HARNESS = 'claude-code-cli';

    const harness = new CancellableHarness();
    const db: any = {
      queries: {
        upsert: vi.fn(async () => {}),
        getByQueryIdForTeam: vi.fn(async () => queryRow('processing')),
      },
      news: {
        add: vi.fn(async () => {}),
      },
    };

    const server = new AgentRestServer({
      agentName: 'worker',
      db: { db, teamId: 'team-1', agentId: 'agent-1' },
      harness,
    });

    try {
      await server.start(0);
      const port = ((server as any).httpServer.address() as AddressInfo).port;
      await (server as any).startQuery('query-1', 'prompt', undefined, 'manager');
      await vi.waitFor(() => {
        expect(db.queries.upsert).toHaveBeenCalledWith(
          'team-1',
          'agent-1',
          expect.objectContaining({ query_id: 'query-1', status: 'processing' }),
        );
      });

      const res = await fetch(`http://127.0.0.1:${port}/cancel`, { method: 'POST' });
      expect(res.status).toBe(200);
      await vi.waitFor(() => {
        expect(db.queries.upsert).toHaveBeenCalledWith(
          'team-1',
          'agent-1',
          expect.objectContaining({
            query_id: 'query-1',
            status: 'failed',
            error: 'Query was cancelled',
            completed: expect.any(Number),
          }),
        );
      });
      expect(db.news.add).toHaveBeenCalledWith(
        'team-1',
        'agent-1',
        expect.objectContaining({
          type: 'query.cancelled',
          query_id: 'query-1',
        }),
      );
    } finally {
      await harness.done;
      await server.stop();
    }
  });

  it('cancels every active query harness for parallel lead work', async () => {
    process.env.ID_HARNESS = 'claude-code-cli';
    process.env.ID_AGENT_LEAD_QUERY_CONCURRENCY = '2';

    const fallbackHarness = new CancellableHarness();
    const activeHarnesses: CancellableHarness[] = [];
    const db: any = {
      queries: {
        upsert: vi.fn(async () => {}),
        getByQueryIdForTeam: vi.fn(async (_teamId: string, queryId: string) => ({
          ...queryRow('processing'),
          query_id: queryId,
        })),
      },
      news: {
        add: vi.fn(async () => {}),
      },
    };

    const server = new AgentRestServer({
      agentName: 'lead',
      agentIdentity: { name: 'lead', team: 'default', metadata: { primaryLead: true } },
      db: { db, teamId: 'team-1', agentId: 'agent-1' },
      harness: fallbackHarness,
    });
    (server as any).queryHarnessFactory = () => {
      const harness = new CancellableHarness();
      activeHarnesses.push(harness);
      return harness;
    };

    try {
      await server.start(0);
      const port = ((server as any).httpServer.address() as AddressInfo).port;
      await (server as any).startQuery('query-1', 'first prompt', undefined, 'manager');
      await (server as any).startQuery('query-2', 'second prompt', undefined, 'manager');
      await vi.waitFor(() => {
        expect(activeHarnesses).toHaveLength(2);
      });

      const res = await fetch(`http://127.0.0.1:${port}/cancel`, { method: 'POST' });
      expect(res.status).toBe(200);

      await vi.waitFor(() => {
        expect(activeHarnesses[0].cancelCalls).toBeGreaterThan(0);
        expect(activeHarnesses[1].cancelCalls).toBeGreaterThan(0);
      });
      await Promise.all(activeHarnesses.map((harness) => harness.done));
      expect(db.queries.upsert).toHaveBeenCalledWith(
        'team-1',
        'agent-1',
        expect.objectContaining({ query_id: 'query-1', status: 'failed', error: 'Query was cancelled' }),
      );
      expect(db.queries.upsert).toHaveBeenCalledWith(
        'team-1',
        'agent-1',
        expect.objectContaining({ query_id: 'query-2', status: 'failed', error: 'Query was cancelled' }),
      );
    } finally {
      for (const harness of activeHarnesses) harness.cancel();
      await Promise.all(activeHarnesses.map((harness) => harness.done).filter(Boolean));
      await server.stop();
    }
  });

  it('requeues a timed-out execution once and completes the same query id on retry', async () => {
    vi.useFakeTimers();
    process.env.ID_HARNESS = 'claude-code-cli';
    process.env.ID_AGENT_DELEGATION_QUERY_TIMEOUT_MS = '60000';
    process.env.ID_AGENT_QUERY_TIMEOUT_RETRIES = '1';

    const harness = new TimeoutOnceHarness();
    const db: any = {
      queries: {
        upsert: vi.fn(async () => {}),
        getByQueryIdForTeam: vi.fn(async () => queryRow('processing')),
      },
      news: {
        add: vi.fn(async () => {}),
      },
    };

    const server = new AgentRestServer({
      agentName: 'worker',
      db: { db, teamId: 'team-1', agentId: 'agent-1' },
      harness,
    });

    try {
      await (server as any).startQuery('query-timeout', 'Team objective: retry this timed-out task', undefined, 'manager');
      await vi.waitFor(() => expect(harness.runs).toBe(1));

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(harness.cancelCalls).toBe(1));
      await vi.waitFor(() => expect(harness.runs).toBe(2));
      await vi.waitFor(() => {
        expect(db.queries.upsert).toHaveBeenCalledWith(
          'team-1',
          'agent-1',
          expect.objectContaining({
            query_id: 'query-timeout',
            status: 'completed',
            result: expect.objectContaining({ result: 'ok after retry' }),
          }),
        );
      });

      expect(db.news.add).toHaveBeenCalledWith(
        'team-1',
        'agent-1',
        expect.objectContaining({
          type: 'query.timeout_retry',
          query_id: 'query-timeout',
          data: expect.objectContaining({ retry_attempt: 1, max_retries: 1 }),
        }),
      );
      expect(db.queries.upsert.mock.calls.some((call: any[]) => call[2]?.query_id === 'query-timeout' && call[2]?.status === 'failed')).toBe(false);
    } finally {
      await server.stop();
    }
  });
});

describe('AgentRestServer stop cleanup', () => {
  it('cancels the active harness during shutdown', async () => {
    const harness = new CancellableHarness();
    const server = new AgentRestServer({
      agentName: 'worker',
      harness,
    });

    await server.stop();

    expect(harness.cancelCalls).toBe(1);
    expect(harness.cancelled).toBe(true);
  });
});
