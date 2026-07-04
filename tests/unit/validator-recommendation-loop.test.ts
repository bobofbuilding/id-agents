// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';

import { AgentManagerDb } from '../../src/agent-manager-db.js';
import type { AgentRow, TaskRow } from '../../src/db/types.js';

const TEAM_ID = 'team-1';
const VALIDATOR_ID = 'agent-researcher';

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 'task-1',
    uuid: 'task-uuid-1',
    team_id: TEAM_ID,
    name: 'validate-throughput-change',
    title: 'Validate throughput change',
    description: 'Review the completed implementation and produce validation findings.',
    status: 'done',
    created_by: 'agent-lead',
    owner: VALIDATOR_ID,
    created_at: 1,
    updated_at: 2,
    completed_at: 3,
    ...overrides,
  };
}

function makeValidator(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    team_id: TEAM_ID,
    id: VALIDATOR_ID,
    name: 'researcher',
    type: 'claude',
    model: 'sonnet',
    status: 'running',
    created_at: 1,
    port: 4244,
    endpoint: 'http://localhost:4244',
    working_directory: '/tmp/researcher',
    registry: null,
    metadata: {},
    deleted_at: null,
    runtime: 'claude-code-cli',
    token_id: null,
    domain: null,
    api_key: null,
    customer_domain: null,
    public_endpoint_url: null,
    internal_endpoint_url: null,
    ssh_target: null,
    last_seen: null,
    last_probed_at: null,
    last_error: null,
    consecutive_failures: 0,
    ...overrides,
  };
}

function makeManager(sendInternalNewsTo = vi.fn(async () => {})) {
  const events: Array<{
    seq: number;
    team_id: string;
    topic: string;
    actor_agent_id?: string | null;
    subject_kind?: string | null;
    subject_id?: string | null;
    occurred_at: number;
    data: Record<string, unknown>;
  }> = [];
  let seq = 0;

  const db = {
    teams: {
      getConfig: vi.fn(async () => ({
        validatorRecommendationLoop: {
          enabled: true,
          owners: ['researcher'],
          lead: 'lead',
          objective: 'Recommend only approved, dispatch-ready next steps.',
        },
      })),
    },
    agents: {
      getById: vi.fn(async (id: string) => id === VALIDATOR_ID ? makeValidator() : null),
    },
    events: {
      insert: vi.fn(async (event: any) => {
        const row = { ...event, seq: ++seq };
        events.push(row);
        return { seq };
      }),
    },
    adapter: {
      query: vi.fn(async (_sql: string, params: unknown[]) => {
        const [teamId, topic, taskUuid, ownerId] = params;
        const rows = events
          .filter((event) =>
            event.team_id === teamId
            && event.topic === topic
            && event.subject_kind === 'task'
            && event.subject_id === taskUuid
            && event.actor_agent_id === ownerId)
          .map((event) => ({ seq: event.seq }));
        return { rows, rowCount: rows.length };
      }),
    },
  };

  const manager = new AgentManagerDb('/tmp/id-agents-validator-loop-test', db as any, { libraryRoot: null }) as any;
  manager.sendInternalNewsTo = sendInternalNewsTo;
  manager.managerLog = vi.fn();
  return { manager, db, events };
}

describe('validator recommendation loop idempotency', () => {
  it('forbids validators from directly routing recommendation packets', () => {
    const { manager } = makeManager();
    const prompt = manager.validatorRecommendationPrompt({
      task: makeTask(),
      validatorName: 'researcher',
      leadName: 'lead',
      objective: 'Recommend only approved, dispatch-ready next steps.',
      completionNote: 'PASS',
    });

    expect(prompt).toContain('Your only action in this loop is to return the JSON packet');
    expect(prompt).toContain('Do not call /news-to, /talk-to, /ask, inter-agent tools, task creation tools, or assignment commands');
    expect(prompt).toContain('Do not send direct handoffs to team leads');
    expect(prompt).toContain('lead is the sole router for approved high/medium recommendations');
    expect(prompt).toContain('Do not turn draft proposals into live tasks or assignments');
    expect(prompt).toContain('return next_step_recommendations: [] and do not notify anyone else');
  });

  it('dispatches only once for duplicate completion handling of the same validator task', async () => {
    const sendInternalNewsTo = vi.fn(async () => {});
    const { manager, db, events } = makeManager(sendInternalNewsTo);
    const task = makeTask();

    await manager.maybeTriggerValidatorRecommendationLoop({
      teamId: TEAM_ID,
      teamName: 'default',
      task,
      completionPayload: { note: 'approved' },
    });
    await manager.maybeTriggerValidatorRecommendationLoop({
      teamId: TEAM_ID,
      teamName: 'default',
      task,
      completionPayload: { note: 'approved again' },
    });

    expect(sendInternalNewsTo).toHaveBeenCalledTimes(1);
    expect(db.events.insert).toHaveBeenCalledTimes(1);
    expect(events[0]).toMatchObject({
      team_id: TEAM_ID,
      topic: 'validator:recommendation-loop',
      actor_agent_id: VALIDATOR_ID,
      subject_kind: 'task',
      subject_id: task.uuid,
    });
  });

  it('serializes concurrent duplicate triggers for the same validator task', async () => {
    let releaseSend!: () => void;
    let markSendStarted!: () => void;
    const sendStarted = new Promise<void>((resolve) => { markSendStarted = resolve; });
    const sendInternalNewsTo = vi.fn(async () => {
      markSendStarted();
      await new Promise<void>((release) => { releaseSend = release; });
    });
    const { manager, db } = makeManager(sendInternalNewsTo);
    const task = makeTask();

    const first = manager.maybeTriggerValidatorRecommendationLoop({
      teamId: TEAM_ID,
      teamName: 'default',
      task,
      completionPayload: { note: 'first' },
    });

    await sendStarted;
    const second = manager.maybeTriggerValidatorRecommendationLoop({
      teamId: TEAM_ID,
      teamName: 'default',
      task,
      completionPayload: { note: 'second' },
    });

    await new Promise((r) => setTimeout(r, 25));
    expect(sendInternalNewsTo).toHaveBeenCalledTimes(1);

    releaseSend();
    await Promise.all([first, second]);

    expect(sendInternalNewsTo).toHaveBeenCalledTimes(1);
    expect(db.events.insert).toHaveBeenCalledTimes(1);
  });
});
