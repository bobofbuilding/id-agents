// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import {
  AgentRestServer,
  QueryCancellationQuiescenceError,
  withQueryExecutionTimeout,
} from '../../src/claude-agent-server.js';
import type {
  AgentHarness,
  HarnessMessage,
  HarnessOptions,
} from '../../src/harness/types.js';

function pendingIterator(options: {
  returnDelayMs?: number;
  onReturn?: () => void;
  returnPromise?: Promise<void>;
} = {}): AsyncGenerator<HarnessMessage> {
  return {
    next: () => new Promise<IteratorResult<HarnessMessage>>(() => {}),
    return: async () => {
      options.onReturn?.();
      if (options.returnPromise) {
        await options.returnPromise;
      } else if (options.returnDelayMs) {
        await new Promise(resolve => setTimeout(resolve, options.returnDelayMs));
      }
      return { done: true, value: undefined };
    },
    throw: async (error?: unknown) => {
      throw error;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    [Symbol.asyncDispose]: async () => {},
  } as AsyncGenerator<HarnessMessage>;
}

async function consume(iterator: AsyncGenerator<HarnessMessage>): Promise<void> {
  for await (const _message of iterator) {
    // This helper only exercises timeout and terminal cleanup.
  }
}

describe('query timeout quiescence', () => {
  it('holds the timeout result until the cancelled generator confirms cleanup', async () => {
    let returnCalled = false;
    const started = Date.now();

    await expect(consume(withQueryExecutionTimeout(
      pendingIterator({
        returnDelayMs: 25,
        onReturn: () => { returnCalled = true; },
      }),
      {
        queryId: 'query-confirmed-cleanup',
        timeoutMs: 10,
        quiescenceTimeoutMs: 100,
        onTimeout: () => {},
      },
    ))).rejects.toMatchObject({
      name: 'QueryExecutionTimeoutError',
      queryId: 'query-confirmed-cleanup',
    });

    expect(returnCalled).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });

  it('returns after a bounded grace and exposes the exact late-quiescence barrier', async () => {
    let releaseReturn!: () => void;
    const returnPromise = new Promise<void>((resolve) => {
      releaseReturn = resolve;
    });
    const started = Date.now();

    let caught: unknown;
    try {
      await consume(withQueryExecutionTimeout(
        pendingIterator({ returnPromise }),
        {
          queryId: 'query-late-cleanup',
          timeoutMs: 5,
          quiescenceTimeoutMs: 20,
          onTimeout: () => {},
        },
      ));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(QueryCancellationQuiescenceError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);

    const quiescence = (caught as QueryCancellationQuiescenceError).quiescence;
    let settled = false;
    void quiescence.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseReturn();
    await quiescence;
    expect(settled).toBe(true);
  });

  it('keeps new admissions closed until every late generator actually settles', async () => {
    let release!: () => void;
    const late = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness: AgentHarness = {
      type: 'provider-api',
      async *run(_prompt: string, _options: HarnessOptions) {
        yield { type: 'result', result: 'ok' };
      },
      cancel: () => true,
    };
    const server = new AgentRestServer({ harness }) as any;

    server.holdAdmissionsUntilHarnessQuiescent('late-query', late);
    expect(() => server.assertQueryAdmissionOpen()).toThrow(
      /temporarily closed while 1 cancelled harness/,
    );

    release();
    await late;
    await Promise.resolve();
    expect(() => server.assertQueryAdmissionOpen()).not.toThrow();
    await server.stop();
  });
});
