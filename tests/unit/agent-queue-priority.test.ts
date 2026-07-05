// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'net';

import {
  AgentRestServer,
  classifyPrimaryLeadValidatorWakeSuppression,
  classifyQueryQueuePriority,
  shouldUseImplicitDefaultConversation,
  shouldSuppressPrimaryLeadValidatorNoopWake,
} from '../../src/claude-agent-server.js';
import type { AgentHarness, HarnessMessage, HarnessOptions, HarnessType } from '../../src/harness/index.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class RecordingHarness implements AgentHarness {
  readonly type = 'codex' as HarnessType;
  prompts: string[] = [];
  options: HarnessOptions[] = [];
  private releaseFirst: (() => void) | null = null;

  constructor(private readonly blockFirst = false) {}

  async *run(prompt: string, _options: HarnessOptions): AsyncGenerator<HarnessMessage> {
    this.prompts.push(prompt);
    this.options.push(_options);
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
    delete process.env.ID_AGENT_RUN_AUTOMATIC_HEARTBEATS;
    delete process.env.ID_MCP_SERVERS;
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
      prompt: 'Lead delegation kickoff: task #12345678 is assigned to you as the team coordinator.',
      from: 'manager',
    })).toBe('delegation');

    expect(classifyQueryQueuePriority({
      prompt: 'Please claim and complete task #0fcc3e2d (design-handoff-parallelization-rules).',
      from: 'engineering-lead',
    })).toBe('delegation');

    expect(classifyQueryQueuePriority({
      prompt: `[Message from the manager (your owner/operator) | Query ID: q1]

Team objective: Decompose this objective into member-owned work.`,
      from: 'manager',
    })).toBe('delegation');

    expect(classifyQueryQueuePriority({
      prompt: 'Heartbeat: review your checklist and act on anything that needs attention.',
    })).toBe('background');

    expect(classifyQueryQueuePriority({
      prompt: '[Incoming Reply from "researcher"]\n\nDone.',
      from: 'researcher',
      options: { noAutoReply: true },
    })).toBe('delegation');

    expect(classifyQueryQueuePriority({
      prompt: '[Incoming Message from "checkin-service"]\n\nCheckin due for linked task #12345678.',
      from: 'checkin-service',
      options: { noAutoReply: true },
    })).toBe('background');
  });

  it('keeps automated peer/control traffic out of the implicit default session', () => {
    expect(shouldUseImplicitDefaultConversation({})).toBe(true);
    expect(shouldUseImplicitDefaultConversation({ from: 'operator' })).toBe(true);
    expect(shouldUseImplicitDefaultConversation({ from: 'human' })).toBe(true);

    expect(shouldUseImplicitDefaultConversation({ from: 'remote' })).toBe(false);
    expect(shouldUseImplicitDefaultConversation({ from: 'manager' })).toBe(false);
    expect(shouldUseImplicitDefaultConversation({ from: 'researcher' })).toBe(false);
    expect(shouldUseImplicitDefaultConversation({ from: 'checkin-service', noAutoReply: true })).toBe(false);
    expect(shouldUseImplicitDefaultConversation({ resumeKey: 'chat-123', from: 'operator' })).toBe(false);
    expect(shouldUseImplicitDefaultConversation({ disableImplicitDefault: true })).toBe(false);
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

  it('runs control-plane prompts with read-only execution policy', async () => {
    const harness = new RecordingHarness();
    const server = new AgentRestServer({ agentName: 'lead', harness });

    try {
      await server.start(0);
      const port = ((server as any).httpServer.address() as AddressInfo).port;

      const res = await fetch(`http://127.0.0.1:${port}/talk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'manager',
          message: 'Supervision: task #12345678 has been in progress 48m with no completion.',
        }),
      });

      expect(res.status).toBe(202);
      await sleep(20);
      expect(harness.options[0]?.executionPolicy).toBe('control-plane-readonly');
      expect(harness.options[0]?.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
      expect(harness.options[0]?.mcpServers).toBeUndefined();
    } finally {
      await server.stop();
    }
  });

  it('runs delegation control prompts without MCP but with delegation-capable local tools', async () => {
    process.env.ID_MCP_SERVERS = JSON.stringify([
      { name: 'removed-server', transport: 'stdio', command: 'node', args: ['server.js'] },
    ]);
    const harness = new RecordingHarness();
    const server = new AgentRestServer({ agentName: 'engineering-lead', harness });

    try {
      await server.start(0);
      const port = ((server as any).httpServer.address() as AddressInfo).port;

      const res = await fetch(`http://127.0.0.1:${port}/talk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'manager',
          message: 'Lead delegation kickoff: task #12345678 is assigned to you as the team coordinator.',
        }),
      });

      expect(res.status).toBe(202);
      await viWaitFor(() => expect(harness.prompts).toHaveLength(1));
      expect(harness.options[0]?.executionPolicy).toBe('default');
      expect(harness.options[0]?.allowedTools).toEqual(['Read', 'Bash', 'Glob', 'Grep']);
      expect(harness.options[0]?.mcpServers).toBeUndefined();
    } finally {
      await server.stop();
    }
  });

  it('runs incoming agent reply wakes without MCP but with delegation-capable local tools', async () => {
    process.env.ID_MCP_SERVERS = JSON.stringify([
      { name: 'removed-server', transport: 'stdio', command: 'node', args: ['server.js'] },
    ]);
    const harness = new RecordingHarness();
    const server = new AgentRestServer({
      agentName: 'lead',
      agentIdentity: { name: 'lead', team: 'default', primaryLead: true } as any,
      harness,
    });

    try {
      await server.start(0);
      const port = ((server as any).httpServer.address() as AddressInfo).port;

      const res = await fetch(`http://127.0.0.1:${port}/news`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'reply',
          from: 'coder',
          in_reply_to: 'query_validator_packet',
          message: JSON.stringify({
            validation_status: 'approved',
            summary: 'Validation passed and includes a dispatch-ready follow-up.',
            next_step_recommendations: [
              { title: 'Route approved follow-up', priority: 'high' },
            ],
          }),
        }),
      });

      expect(res.status).toBe(202);
      await viWaitFor(() => expect(harness.prompts).toHaveLength(1));
      expect(harness.options[0]?.executionPolicy).toBe('default');
      expect(harness.options[0]?.allowedTools).toEqual(['Read', 'Bash', 'Glob', 'Grep']);
      expect(harness.options[0]?.mcpServers).toBeUndefined();
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
      const body = await res.json();
      expect(body).toMatchObject({ status: 'deferred' });
      await sleep(20);
      expect(harness.prompts).toHaveLength(0);

      const newsRes = await fetch(`http://127.0.0.1:${port}/news?query_id=${encodeURIComponent(body.query_id)}`);
      expect(newsRes.status).toBe(200);
      const newsBody = await newsRes.json();
      expect(newsBody.items).toHaveLength(1);
      expect(newsBody.items[0]).toMatchObject({
        type: 'schedule.received',
        data: {
          query_id: body.query_id,
          status: 'deferred',
        },
      });
    } finally {
      await server.stop();
    }
  });

  it('records automatic idle-worker heartbeats without launching the harness by default', async () => {
    const harness = new RecordingHarness();
    const server = new AgentRestServer({
      agentName: 'skill-discoverer',
      agentIdentity: { name: 'skill-discoverer', team: 'skillmesh' },
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
            id: 'hb-worker-idle',
            kind: 'heartbeat',
            title: 'Heartbeat: skill-discoverer',
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

  it('allows automatic idle-worker heartbeats when explicitly opted in', async () => {
    process.env.ID_AGENT_RUN_AUTOMATIC_HEARTBEATS = '1';
    const harness = new RecordingHarness();
    const server = new AgentRestServer({
      agentName: 'skill-discoverer',
      agentIdentity: { name: 'skill-discoverer', team: 'skillmesh' },
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
            id: 'hb-worker-idle-opt-in',
            kind: 'heartbeat',
            title: 'Heartbeat: skill-discoverer',
            scheduledKey: 'interval:1',
          },
          mode: 'internal',
        }),
      });

      expect(res.status).toBe(202);
      await expect(res.json()).resolves.toMatchObject({ status: 'processing' });
      await viWaitFor(() => expect(harness.prompts).toHaveLength(1));
    } finally {
      await server.stop();
    }
  });

  it('records automatic heartbeats for busy agents without stacking harness turns', async () => {
    const harness = new RecordingHarness(true);
    const server = new AgentRestServer({
      agentName: 'skill-discoverer',
      agentIdentity: { name: 'skill-discoverer', team: 'skillmesh' },
      harness,
    });

    try {
      await server.start(0);
      const port = ((server as any).httpServer.address() as AddressInfo).port;

      await (server as any).startQuery('q1', 'assigned task already in progress', undefined, 'manager');
      await viWaitFor(() => expect(harness.prompts).toHaveLength(1));

      const res = await fetch(`http://127.0.0.1:${port}/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Heartbeat: review your checklist and act on anything that needs attention.',
          schedule: {
            id: 'hb-worker',
            kind: 'heartbeat',
            title: 'Heartbeat: skill-discoverer',
            scheduledKey: 'interval:1',
          },
          mode: 'internal',
        }),
      });

      expect(res.status).toBe(202);
      await expect(res.json()).resolves.toMatchObject({ status: 'deferred' });
      await sleep(20);
      expect(harness.prompts).toHaveLength(1);

      harness.release();
      await viWaitFor(() => expect(harness.prompts).toHaveLength(1));
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

  it('suppresses approved validator packets with no dispatch-ready recommendations for the primary lead', async () => {
    const harness = new RecordingHarness();
    const server = new AgentRestServer({
      agentName: 'lead',
      agentIdentity: { name: 'lead', team: 'default' },
      harness,
    });

    try {
      await server.start(0);
      const port = ((server as any).httpServer.address() as AddressInfo).port;

      const res = await fetch(`http://127.0.0.1:${port}/news`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'reply',
          from: 'researcher',
          in_reply_to: 'query_validator_packet',
          message: JSON.stringify({
            validation_status: 'approved',
            summary: 'Validation passed; no live follow-up is needed.',
            validation_budget: {
              validator_passes_allowed: 1,
              rework_cycles_allowed: 1,
              validator_tasks_may_create_validator_tasks: false,
            },
            validator_findings: {
              researcher: 'APPROVE.',
            },
            next_step_recommendations: [],
            lead_routing_instruction: 'Lead should dispatch only high/medium approved recommendation objectives.',
          }),
        }),
      });

      expect(res.status).toBe(202);
      await expect(res.json()).resolves.toMatchObject({
        triggered: false,
        suppressed: true,
        reason: 'validator_approved_no_dispatch_ready_recommendations',
      });
      await sleep(20);
      expect(harness.prompts).toHaveLength(0);
    } finally {
      await server.stop();
    }
  });

  it('suppresses blocked validator packets with no dispatch-ready recommendations for the primary lead', async () => {
    const harness = new RecordingHarness();
    const server = new AgentRestServer({
      agentName: 'lead',
      agentIdentity: { name: 'lead', team: 'default' },
      harness,
    });

    try {
      await server.start(0);
      const port = ((server as any).httpServer.address() as AddressInfo).port;

      const res = await fetch(`http://127.0.0.1:${port}/news`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'reply',
          from: 'researcher',
          in_reply_to: 'query_validator_packet_blocked',
          message: JSON.stringify({
            validation_status: 'blocked',
            summary: 'Recommendation packet cannot be completed from the supplied payload.',
            validation_budget: {
              validator_passes_allowed: 1,
              rework_cycles_allowed: 1,
              validator_tasks_may_create_validator_tasks: false,
            },
            validator_findings: {
              researcher: 'BLOCKED: source artifact unavailable.',
            },
            next_step_recommendations: [],
            lead_routing_instruction: 'Lead should dispatch only high/medium approved recommendation objectives.',
          }),
        }),
      });

      expect(res.status).toBe(202);
      await expect(res.json()).resolves.toMatchObject({
        triggered: false,
        suppressed: true,
        reason: 'validator_blocked_no_dispatch_ready_recommendations',
      });
      await sleep(20);
      expect(harness.prompts).toHaveLength(0);
    } finally {
      await server.stop();
    }
  });

  it('suppresses needs-revision validator packets with no dispatch-ready recommendations for the primary lead', async () => {
    const harness = new RecordingHarness();
    const server = new AgentRestServer({
      agentName: 'lead',
      agentIdentity: { name: 'lead', team: 'default' },
      harness,
    });

    try {
      await server.start(0);
      const port = ((server as any).httpServer.address() as AddressInfo).port;

      const res = await fetch(`http://127.0.0.1:${port}/news`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'reply',
          from: 'researcher',
          in_reply_to: 'query_validator_packet_revision',
          message: JSON.stringify({
            validation_status: 'needs-revision',
            summary: 'Validation did not pass; the existing task needs rework.',
            validation_budget: {
              validator_passes_allowed: 1,
              rework_cycles_allowed: 1,
              validator_tasks_may_create_validator_tasks: false,
            },
            validator_findings: {
              researcher: 'REVISE: fix the evidence accounting on the current task.',
            },
            next_step_recommendations: [],
            lead_routing_instruction: 'Lead should dispatch only high/medium approved recommendation objectives.',
          }),
        }),
      });

      expect(res.status).toBe(202);
      await expect(res.json()).resolves.toMatchObject({
        triggered: false,
        suppressed: true,
        reason: 'validator_needs_revision_no_dispatch_ready_recommendations',
      });
      await sleep(20);
      expect(harness.prompts).toHaveLength(0);
    } finally {
      await server.stop();
    }
  });

  it('records triggered peer replies for busy agents without queueing another turn', async () => {
    const harness = new RecordingHarness(true);
    const server = new AgentRestServer({
      agentName: 'skillmesh-ops-lead',
      agentIdentity: { name: 'skillmesh-ops-lead', team: 'skillmesh' },
      harness,
    });

    try {
      await server.start(0);
      const port = ((server as any).httpServer.address() as AddressInfo).port;

      await (server as any).startQuery('q1', 'delegation synthesis already in progress', undefined, 'manager');
      await viWaitFor(() => expect(harness.prompts).toHaveLength(1));

      const res = await fetch(`http://127.0.0.1:${port}/news`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'reply',
          from: 'skill-discoverer',
          message: 'Task output landed while the lead is still synthesizing.',
          in_reply_to: 'query_1',
        }),
      });

      expect(res.status).toBe(202);
      await expect(res.json()).resolves.toMatchObject({
        triggered: false,
        deferred: true,
        reason: 'agent_busy',
      });
      await sleep(20);
      expect(harness.prompts).toHaveLength(1);

      harness.release();
      await viWaitFor(() => expect(harness.prompts).toHaveLength(1));
    } finally {
      await server.stop();
    }
  });

  it('uses DB-visible active queries to defer triggered peer replies', async () => {
    const harness = new RecordingHarness();
    let checkedDb = false;
    const db = {
      queries: {
        getPending: async (agentId: string) => {
          checkedDb = true;
          return [{
            team_id: 'team-skillmesh',
            agent_id: agentId,
            query_id: 'active-db-row',
            status: 'processing',
            prompt: 'visible active query',
            created: Date.now(),
            completed: null,
            result: null,
            error: null,
            session_id: null,
            owner_kind: 'agent',
            owner_id: agentId,
            metadata: null,
          }];
        },
      },
      news: {
        add: async () => {},
      },
    };
    const server = new AgentRestServer({
      agentName: 'skillmesh-ops-lead',
      agentIdentity: { name: 'skillmesh-ops-lead', team: 'skillmesh' },
      harness,
      db: { db: db as any, teamId: 'team-skillmesh', agentId: 'agent-skillmesh-lead' },
    });

    try {
      await server.start(0);
      const port = ((server as any).httpServer.address() as AddressInfo).port;

      const res = await fetch(`http://127.0.0.1:${port}/news`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'reply',
          from: 'skill-discoverer',
          message: 'Task output landed while the DB still has active work.',
          in_reply_to: 'query_1',
        }),
      });

      expect(res.status).toBe(202);
      await expect(res.json()).resolves.toMatchObject({
        triggered: false,
        deferred: true,
        reason: 'agent_busy',
      });
      expect(checkedDb).toBe(true);
      await sleep(20);
      expect(harness.prompts).toHaveLength(0);
    } finally {
      await server.stop();
    }
  });

  it('rejects peer /talk while DB-visible active work is running', async () => {
    const harness = new RecordingHarness();
    let checkedDb = false;
    const db = {
      queries: {
        getPending: async (agentId: string) => {
          checkedDb = true;
          return [{
            team_id: 'team-default',
            agent_id: agentId,
            query_id: 'active-validator-work',
            status: 'processing',
            prompt: 'current validation',
            created: Date.now(),
            completed: null,
            result: null,
            error: null,
            session_id: null,
            owner_kind: 'agent',
            owner_id: agentId,
            metadata: null,
          }];
        },
      },
    };
    const server = new AgentRestServer({
      agentName: 'researcher',
      agentIdentity: { name: 'researcher', team: 'default' },
      harness,
      db: { db: db as any, teamId: 'team-default', agentId: 'agent-researcher' },
    });

    try {
      await server.start(0);
      const port = ((server as any).httpServer.address() as AddressInfo).port;

      const res = await fetch(`http://127.0.0.1:${port}/talk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'skillmesh-ops-lead',
          message: 'Please validate another task while you are still busy.',
        }),
      });

      expect(res.status).toBe(429);
      await expect(res.json()).resolves.toMatchObject({
        error: 'agent_busy',
        status: 'busy',
      });
      expect(checkedDb).toBe(true);
      await sleep(20);
      expect(harness.prompts).toHaveLength(0);
    } finally {
      await server.stop();
    }
  });
});

describe('validator recommendation lead wake suppression', () => {
  it('does not suppress dispatch-ready recommendation packets', () => {
    expect(shouldSuppressPrimaryLeadValidatorNoopWake({
      isPrimaryLead: true,
      newsType: 'reply',
      from: 'researcher',
      inReplyTo: 'query_1',
      message: JSON.stringify({
        validation_status: 'approved',
        next_step_recommendations: [
          { title: 'Implement routed fix', priority: 'medium' },
        ],
      }),
    })).toBe(false);
  });

  it('classifies approved, needs-revision, and blocked no-op packets with distinct suppression reasons', () => {
    expect(classifyPrimaryLeadValidatorWakeSuppression({
      isPrimaryLead: true,
      newsType: 'reply',
      from: 'coder',
      inReplyTo: 'query_1',
      message: JSON.stringify({
        validation_status: 'approved',
        next_step_recommendations: [],
      }),
    })).toBe('validator_approved_no_dispatch_ready_recommendations');

    expect(classifyPrimaryLeadValidatorWakeSuppression({
      isPrimaryLead: true,
      newsType: 'reply',
      from: 'researcher',
      inReplyTo: 'query_2',
      message: JSON.stringify({
        validation_status: 'needs_revision',
        next_step_recommendations: [],
      }),
    })).toBe('validator_needs_revision_no_dispatch_ready_recommendations');

    expect(classifyPrimaryLeadValidatorWakeSuppression({
      isPrimaryLead: true,
      newsType: 'reply',
      from: 'researcher',
      inReplyTo: 'query_3',
      message: JSON.stringify({
        validation_status: 'blocked',
        next_step_recommendations: [],
      }),
    })).toBe('validator_blocked_no_dispatch_ready_recommendations');
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
