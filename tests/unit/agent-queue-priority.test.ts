// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'net';

import {
  AgentRestServer,
  classifyQueryQueuePriority,
} from '../../src/claude-agent-server.js';
import type { AgentHarness, HarnessMessage, HarnessOptions, HarnessType } from '../../src/harness/index.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class RecordingHarness implements AgentHarness {
  readonly type = 'codex' as HarnessType;
  prompts: string[] = [];
  private releaseFirst: (() => void) | null = null;

  constructor(private readonly blockFirst = false) {}

  async *run(prompt: string, _options: HarnessOptions): AsyncGenerator<HarnessMessage> {
    this.prompts.push(prompt);
    if (this.blockFirst && this.prompts.length === 1) {
      await new Promise<void>((resolve) => {
        this.releaseFirst = resolve;
      });
    }
    yield { type: 'result', result: 'ok' };
  }

  release(): void {
    this.releaseFirst?.();
  }
}

describe('agent query queue priority', () => {
  afterEach(() => {
    delete process.env.MANAGER_URL;
    delete process.env.ID_TEAM;
  });

  it('classifies operator work ahead of delegation and background work', () => {
    expect(classifyQueryQueuePriority({
      prompt: 'can you inspect the brain graph lag?',
      from: 'remote',
    })).toBe('operator');

    expect(classifyQueryQueuePriority({
      prompt: 'You are the team lead. Break the objective below into sub-tasks.',
      from: 'manager',
    })).toBe('delegation');

    expect(classifyQueryQueuePriority({
      prompt: 'Heartbeat: review your checklist and act on anything that needs attention.',
    })).toBe('background');

    expect(classifyQueryQueuePriority({
      prompt: '[Incoming Reply from "researcher"]\n\nDone.',
      from: 'researcher',
      options: { noAutoReply: true },
    })).toBe('background');
  });

  it('runs queued operator work before older queued background work', async () => {
    const harness = new RecordingHarness(true);
    const server = new AgentRestServer({ agentName: 'lead', harness });

    try {
      await (server as any).startQuery('q1', 'Heartbeat: first background wake', undefined, undefined, { priority: 'background' });
      await viWaitFor(() => expect(harness.prompts).toHaveLength(1));

      await (server as any).startQuery('q2', 'Heartbeat: second background wake', undefined, undefined, { priority: 'background' });
      await (server as any).startQuery('q3', 'operator request that should jump the background queue', undefined, 'remote');

      harness.release();
      await viWaitFor(() => expect(harness.prompts).toHaveLength(3));

      expect(harness.prompts[0]).toContain('Heartbeat: first background wake');
      expect(harness.prompts[1]).toContain('operator request that should jump the background queue');
      expect(harness.prompts[2]).toContain('Heartbeat: second background wake');
    } finally {
      await server.stop();
    }
  });

  it('records automatic primary-lead heartbeats without launching the harness', async () => {
    const harness = new RecordingHarness();
    const server = new AgentRestServer({
      agentName: 'lead',
      agentIdentity: { name: 'lead', team: 'default' },
      harness,
    });

    try {
      await server.start(0);
      const port = ((server as any).httpServer.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Heartbeat: review your checklist and act on anything that needs attention.',
          schedule: {
            id: 'hb-lead',
            kind: 'heartbeat',
            title: 'Heartbeat: lead',
            scheduledKey: 'interval:1',
          },
          mode: 'internal',
        }),
      });

      expect(res.status).toBe(202);
      await expect(res.json()).resolves.toMatchObject({ status: 'deferred' });
      await sleep(20);
      expect(harness.prompts).toHaveLength(0);
    } finally {
      await server.stop();
    }
  });

  it('records triggered agent replies without stacking another primary-lead harness turn while busy', async () => {
    const harness = new RecordingHarness(true);
    const server = new AgentRestServer({
      agentName: 'lead',
      agentIdentity: { name: 'lead', team: 'default' },
      harness,
    });

    try {
      await server.start(0);
      const port = ((server as any).httpServer.address() as AddressInfo).port;

      await (server as any).startQuery('q1', 'operator work already in progress', undefined, 'remote');
      await viWaitFor(() => expect(harness.prompts).toHaveLength(1));

      const res = await fetch(`http://127.0.0.1:${port}/news`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'reply',
          from: 'researcher',
          message: 'Validation reply landed while the lead is busy.',
          in_reply_to: 'query_1',
        }),
      });

      expect(res.status).toBe(202);
      await expect(res.json()).resolves.toMatchObject({
        triggered: false,
        deferred: true,
        reason: 'primary_lead_busy',
      });
      await sleep(20);
      expect(harness.prompts).toHaveLength(1);

      harness.release();
      await viWaitFor(() => expect(harness.prompts).toHaveLength(1));
    } finally {
      await server.stop();
    }
  });
});

async function viWaitFor(assertion: () => void): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < 1000) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await sleep(10);
    }
  }
  throw lastError;
}
