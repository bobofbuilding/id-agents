// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentManagerDb, shouldDelayLeadDelegationKickoffForFreshTask } from '../../src/agent-manager-db.js';
import type { AgentRow, TaskRow, TeamRow } from '../../src/db/types.js';

const NOW_MS = 1_800_000_000_000;
const TEAM_ID = 'team-1';

function team(overrides: Partial<TeamRow> = {}): TeamRow {
  return {
    id: TEAM_ID,
    name: 'default',
    config: {},
    port_start: 4101,
    port_end: 4125,
    created_at: 'now',
    ...overrides,
  };
}

function agent(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    team_id: TEAM_ID,
    id: 'agent-1',
    name: 'worker',
    type: 'claude',
    model: 'sonnet',
    port: 4210,
    endpoint: 'http://127.0.0.1:4210',
    working_directory: null,
    status: 'running',
    created_at: NOW_MS,
    registry: null,
    metadata: null,
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

function task(overrides: Partial<TaskRow> = {}): TaskRow {
  const nowSec = Math.floor(NOW_MS / 1000);
  return {
    id: 'task-1',
    name: 'stalled-work',
    uuid: '12345678-1234-1234-1234-123456789abc',
    team_id: TEAM_ID,
    title: 'Stalled work',
    description: null,
    status: 'doing',
    created_by: null,
    owner: 'agent-1',
    created_at: nowSec - 3600,
    updated_at: nowSec - 3600,
    completed_at: null,
    ...overrides,
  };
}

function activeQuery(agentId: string, overrides: Record<string, any> = {}): any {
  return {
    team_id: TEAM_ID,
    agent_id: agentId,
    query_id: `query-${agentId}`,
    status: 'processing',
    prompt: 'in flight',
    created: NOW_MS - 60_000,
    completed: null,
    result: null,
    error: null,
    session_id: null,
    owner_kind: 'agent',
    owner_id: agentId,
    metadata: null,
    ...overrides,
  };
}

function fakeDb(overrides: Record<string, any> = {}): any {
  return {
    teams: {
      getTeam: vi.fn(async () => team()),
      getTeamByName: vi.fn(async (name: string) => name === 'default' ? team() : null),
      getConfig: vi.fn(async () => ({})),
      listTeams: vi.fn(async () => []),
      ...overrides.teams,
    },
    agents: {
      getById: vi.fn(async () => agent()),
      getByName: vi.fn(async () => null),
      resolve: vi.fn(async () => [agent()]),
      list: vi.fn(async () => [agent()]),
      updateStatus: vi.fn(async () => {}),
      ...overrides.agents,
    },
    tasks: {
      list: vi.fn(async ({ status }: { status?: string } = {}) => status === 'doing' ? [task()] : []),
      getByNameForTeam: vi.fn(async () => task()),
      getByUuidPrefix: vi.fn(async () => [task()]),
      claim: vi.fn(async () => true),
      updateFields: vi.fn(async () => {}),
      listEventLinksForTask: vi.fn(async () => []),
      ...overrides.tasks,
    },
    checkins: {
      list: vi.fn(async () => []),
      updateFields: vi.fn(async () => {}),
      ...overrides.checkins,
    },
    queries: {
      expireStale: vi.fn(async () => []),
      expireQueuedPeerWakes: vi.fn(async () => []),
      getPending: vi.fn(async () => []),
      getPendingByOwner: vi.fn(async () => []),
      ...overrides.queries,
    },
    news: {
      add: vi.fn(async () => {}),
      ...overrides.news,
    },
    events: {
      insert: vi.fn(async () => ({ seq: 1 })),
      ...overrides.events,
    },
    runtimeLaneCooldowns: {
      upsert: vi.fn(async () => {}),
      listActive: vi.fn(async () => []),
      pruneExpired: vi.fn(async () => 0),
    },
    adapter: {
      dialect: 'sqlite',
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      ...overrides.adapter,
    },
  };
}

describe('stalled task sweeper', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.STALL_SWEEP_MS;
    delete process.env.STALL_SWEEP_INTERVAL_MS;
    delete process.env.ID_STALL_SWEEP_INTERVAL_MS;
    delete process.env.STALL_RENUDGE_MS;
    delete process.env.STALL_MANUAL_RENUDGE_MS;
    delete process.env.ID_STALL_MANUAL_RENUDGE_MS;
    delete process.env.STALL_SWEEP_MAX_PER_SWEEP;
    delete process.env.STALL_MAX_PROBES;
    delete process.env.STALL_PROBE_RESET_MS;
    delete process.env.ID_STALL_PROBE_RESET_MS;
    delete process.env.ID_TASK_MANAGER_FALLBACK_COOLDOWN_MS;
    delete process.env.ID_UNOWNED_ASSIGN_MIN_MS;
    delete process.env.ID_UNOWNED_ASSIGN_MAX_PER_SWEEP;
    delete process.env.ID_MAX_DOING_TASKS;
    delete process.env.ID_BLOCKED_TASK_REASSIGN_COOLDOWN_MS;
    delete process.env.ID_AGENT_QUERY_CONCURRENCY;
    delete process.env.ID_MAX_ACTIVE_QUERIES_PER_AGENT;
    delete process.env.ID_MAX_ACTIVE_QUERIES_PER_LEAD;
    delete process.env.ID_LEAD_QUERY_CONCURRENCY;
    delete process.env.ID_AGENT_LEAD_QUERY_CONCURRENCY;
    delete process.env.ID_LEAD_DELEGATION_KICKOFF_GRACE_MS;
    delete process.env.LEAD_DELEGATION_KICKOFF_GRACE_MS;
    delete process.env.ID_LEAD_BACKLOG_AUTO_KEEP_ACTIVE;
    delete process.env.ID_LEAD_BACKLOG_AUTO_DISABLED;
  });

  it('defaults automatic stalled-task sweeps to a responsive assignment cadence', () => {
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', fakeDb(), { libraryRoot: null }) as any;

    expect(manager.getStallSweepIntervalMs()).toBe(2 * 60 * 1000);
    expect(manager.unownedAssignMinMs()).toBe(60 * 1000);
  });

  it('allows stalled-task sweep cadence overrides with a one-minute floor', () => {
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', fakeDb(), { libraryRoot: null }) as any;

    process.env.ID_STALL_SWEEP_INTERVAL_MS = '1000';
    expect(manager.getStallSweepIntervalMs()).toBe(60 * 1000);

    process.env.STALL_SWEEP_INTERVAL_MS = String(20 * 60 * 1000);
    expect(manager.getStallSweepIntervalMs()).toBe(20 * 60 * 1000);
  });

  it('refreshes an exhausted stalled-probe budget after the reset window', () => {
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', fakeDb(), { libraryRoot: null }) as any;
    const renudgeMs = 90 * 60 * 1000;
    const resetMs = 4 * 60 * 60 * 1000;
    const key = 'todo-assign:task-1';

    expect(manager.markStalledProbe(key, NOW_MS)).toBe(1);
    expect(manager.markStalledProbe(key, NOW_MS)).toBe(2);
    expect(manager.markStalledProbe(key, NOW_MS)).toBe(3);

    // Budget exhausted: renudge spacing alone no longer re-opens probing.
    expect(manager.canRunStalledProbe(key, NOW_MS + renudgeMs, renudgeMs, 3)).toBe(false);
    expect(manager.canRunStalledProbe(key, NOW_MS + resetMs - 1, renudgeMs, 3)).toBe(false);

    // After the cool-off window the budget resets so the task is re-probed
    // instead of being stranded until a manager restart.
    expect(manager.canRunStalledProbe(key, NOW_MS + resetMs, renudgeMs, 3)).toBe(true);
    expect(manager.markStalledProbe(key, NOW_MS + resetMs)).toBe(1);
  });

  it('supports stalled-probe reset window override and opt-out', () => {
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', fakeDb(), { libraryRoot: null }) as any;
    const renudgeMs = 90 * 60 * 1000;
    const key = 'todo-assign:task-2';

    manager.markStalledProbe(key, NOW_MS);
    manager.markStalledProbe(key, NOW_MS);

    process.env.STALL_PROBE_RESET_MS = String(30 * 60 * 1000);
    expect(manager.getStallProbeResetMs()).toBe(30 * 60 * 1000);
    expect(manager.canRunStalledProbe(key, NOW_MS + 30 * 60 * 1000, renudgeMs, 2)).toBe(true);

    // 0 disables the reset entirely (legacy permanent burnout behavior).
    manager.markStalledProbe(key, NOW_MS);
    manager.markStalledProbe(key, NOW_MS);
    process.env.STALL_PROBE_RESET_MS = '0';
    expect(manager.canRunStalledProbe(key, NOW_MS + 365 * 24 * 60 * 60 * 1000, renudgeMs, 2)).toBe(false);
  });

  it('does not delay lead delegation kickoff for fresh tasks by default', () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    expect(shouldDelayLeadDelegationKickoffForFreshTask(task({
      created_at: nowSec - 30,
      updated_at: nowSec - 30,
    }), NOW_MS)).toBe(false);

    expect(shouldDelayLeadDelegationKickoffForFreshTask(task({
      created_at: NOW_MS - 30_000,
      updated_at: NOW_MS - 30_000,
    }), NOW_MS)).toBe(false);
  });

  it('supports an optional lead delegation kickoff grace override', () => {
    process.env.ID_LEAD_DELEGATION_KICKOFF_GRACE_MS = String(2 * 60 * 1000);
    const nowSec = Math.floor(NOW_MS / 1000);

    expect(shouldDelayLeadDelegationKickoffForFreshTask(task({
      created_at: nowSec - 30,
      updated_at: nowSec - 30,
    }), NOW_MS)).toBe(true);

    expect(shouldDelayLeadDelegationKickoffForFreshTask(task({
      created_at: NOW_MS - 30_000,
      updated_at: NOW_MS - 30_000,
    }), NOW_MS)).toBe(true);

    expect(shouldDelayLeadDelegationKickoffForFreshTask(task({
      created_at: NOW_MS - 180_000,
      updated_at: NOW_MS - 180_000,
    }), NOW_MS)).toBe(false);
  });

  it('detects goal-less duplicate open tasks by title before creating another copy', async () => {
    const existing = task({
      name: 'specify-agent-workflow',
      uuid: '6837df10-d9c5-4848-b093-f7ead813ca82',
      title: 'Specify agent workflow',
      status: 'doing',
      description: 'Define the end-to-end workflow for AI agents visiting the page.',
    });
    const db = fakeDb({
      tasks: {
        list: vi.fn(async () => [existing]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-goalless-task-duplicate-test', db, { libraryRoot: null }) as any;

    const duplicate = await manager.findDuplicateTaskByGoalSignature(TEAM_ID, {
      title: 'Specify agent workflow',
      description: 'Define workflow fields and routing rules.',
    });
    const response = await manager.existingTaskFoundResponse(existing, {
      title: 'Specify agent workflow',
    });

    expect(duplicate).toBe(existing);
    expect(response).toMatchObject({
      existing_task: 'specify-agent-workflow',
      existing_task_ref: '#6837df10',
      duplicate_scope: 'title',
      suggested_action: 'status-check',
    });
  });

  it('builds stable duplicate keys for repeated Learn routing prompts', () => {
    const manager = new AgentManagerDb('/tmp/id-agents-learn-route-dedup-key-test', fakeDb(), { libraryRoot: null }) as any;

    const first = manager.learnRoutingDedupKey(
      'Recursive Learn follow-up for `github: graphiti` (https://github.com/getzep/graphiti). Reuse existing work.',
      'research-lead-id',
    );
    const second = manager.learnRoutingDedupKey(
      'Operator re-fired IDACC Learn routing for github: graphiti at https://github.com/getzep/graphiti. Do not create a duplicate task.',
      'research-lead-id',
    );
    const otherRecipient = manager.learnRoutingDedupKey(
      'Recursive Learn follow-up for `github: graphiti` (https://github.com/getzep/graphiti). Reuse existing work.',
      'engineering-lead-id',
    );
    const primaryLeadIngest = manager.learnRoutingDedupKey(
      'IDACC Learn has ingested new material. You are the PRIMARY lead.\n\nTitle: github: graphiti\nSource: https://github.com/getzep/graphiti',
      'research-lead-id',
    );
    const flattenedRemotePrompt = manager.learnRoutingDedupKey(
      'IDACC Learn has ingested new material. You are the PRIMARY lead.nnTitle: github: graphitinSource: https://github.com/getzep/graphitinTopics: research',
      'research-lead-id',
    );
    const goalFitLens = manager.learnRoutingDedupKey(
      [
        'Recursive Learn follow-up for `github: graphiti` (https://github.com/getzep/graphiti).',
        'Learning lens: active-goal-fit',
        'Learning depth: initial',
        'Question set: goal-fit-v1',
        'Active goals: current default goals',
      ].join('\n'),
      'research-lead-id',
    );
    const sameGoalFitLens = manager.learnRoutingDedupKey(
      [
        'Operator re-fired IDACC Learn routing for github: graphiti at https://github.com/getzep/graphiti.',
        'Learning lens: active-goal-fit',
        'Learning depth: initial',
        'Question set: goal-fit-v1',
        'Active goals: current default goals',
      ].join('\n'),
      'research-lead-id',
    );
    const riskLens = manager.learnRoutingDedupKey(
      [
        'Recursive Learn follow-up for `github: graphiti` (https://github.com/getzep/graphiti).',
        'Learning lens: risk/security',
        'Learning depth: second-pass',
        'Question set: security-risk-v1',
        'Active goals: current default goals',
      ].join('\n'),
      'research-lead-id',
    );

    expect(first).toBeTruthy();
    expect(first).toBe(second);
    expect(first).toBe(primaryLeadIngest);
    expect(first).toBe(flattenedRemotePrompt);
    expect(first).not.toBe(otherRecipient);
    expect(goalFitLens).toBe(sameGoalFitLens);
    expect(goalFitLens).not.toBe(riskLens);
    expect(manager.learnRoutingDedupKey('normal task delegation with no Learn routing', 'research-lead-id')).toBeNull();
  });

  it('adds a recursive learning guard without duplicating the guard block', () => {
    const manager = new AgentManagerDb('/tmp/id-agents-learn-route-guard-test', fakeDb(), { libraryRoot: null }) as any;
    const prompt = 'Recursive Learn follow-up for `github: graphiti` (https://github.com/getzep/graphiti). Reuse existing work.';

    const guarded = manager.withRecursiveLearningGuard(prompt);

    expect(guarded).toContain('Recursive learning guard:');
    expect(guarded).toContain('Learning lens');
    expect(guarded).toContain('Question set');
    expect(guarded).toContain('NO-ACTION duplicate lens');
    expect(manager.withRecursiveLearningGuard(guarded)).toBe(guarded);
    expect(manager.withRecursiveLearningGuard('normal task delegation')).toBe('normal task delegation');
  });

  it('finds recent duplicate Learn routing queries before redispatch', async () => {
    const previousPrompt = 'Recursive Learn follow-up for `github: graphiti` (https://github.com/getzep/graphiti). Reuse existing work.';
    const db = fakeDb({
      adapter: {
        query: vi.fn(async () => ({
          rows: [{
            team_id: TEAM_ID,
            agent_id: 'research-lead-id',
            query_id: 'query-existing-learn',
            status: 'completed',
            prompt: previousPrompt,
            created: NOW_MS - 60_000,
            completed: NOW_MS - 30_000,
            result: null,
            error: null,
            session_id: null,
            owner_kind: 'agent',
            owner_id: 'research-lead-id',
            metadata: null,
          }],
          rowCount: 1,
        })),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-learn-route-dedup-query-test', db, { libraryRoot: null }) as any;
    const dedupKey = manager.learnRoutingDedupKey(
      'Operator re-fired IDACC Learn routing for github: graphiti at https://github.com/getzep/graphiti.',
      'research-lead-id',
    );

    const duplicate = await manager.findRecentDuplicateLearnRoutingQuery({
      teamId: TEAM_ID,
      agentId: 'research-lead-id',
      dedupKey,
      nowMs: NOW_MS,
    });

    expect(duplicate?.query_id).toBe('query-existing-learn');
  });

  it('prompts fresh lead delegation kickoff immediately by default', async () => {
    vi.restoreAllMocks();

    const nowSec = Math.floor(NOW_MS / 1000);
    const lead = agent({
      id: 'research-lead-1',
      name: 'research-lead',
      metadata: { catalog: { role: 'lead' } },
    });
    const worker = agent({
      id: 'researcher-1',
      name: 'researcher',
    });
    const leadTask = task({
      id: 'lead-task-1',
      name: 'coordinate-research-work',
      uuid: '87654321-4321-4321-8321-123456789abc',
      title: 'Coordinate research work',
      owner: lead.id,
      created_by: lead.id,
      created_at: nowSec,
      updated_at: nowSec,
    });
    const db = fakeDb({
      agents: {
        getById: vi.fn(async (id: string) => id === lead.id ? lead : worker),
        list: vi.fn(async () => [lead, worker]),
      },
      tasks: {
        getByNameForTeam: vi.fn(async () => leadTask),
        list: vi.fn(async () => [leadTask]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-lead-kickoff-retry-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.promptLeadForDelegationKickoff(TEAM_ID, 'research', leadTask, lead);

    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'research',
      'research-lead',
      expect.stringContaining('Lead delegation kickoff: task #87654321'),
    );
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      team_id: TEAM_ID,
      topic: 'task:triaged',
      actor_agent_id: lead.id,
      subject_id: leadTask.uuid,
      data: expect.objectContaining({
        reason: 'lead_delegation_required',
      }),
    }));

    await manager.shutdown();
  });

  it('does not treat fresh second-based task timestamps as stalled', async () => {
    const recent = task({ updated_at: Math.floor(NOW_MS / 1000) - 10 * 60 });
    const db = fakeDb({
      tasks: {
        list: vi.fn(async ({ status }: { status?: string } = {}) => status === 'doing' ? [recent] : []),
        updateFields: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(manager.sendSupervisionAsk).not.toHaveBeenCalled();
    expect(db.tasks.updateFields).not.toHaveBeenCalled();
    expect(db.events.insert).not.toHaveBeenCalled();
  });

  it('bumps task activity when the stalled sweeper sends an owner supervision prompt', async () => {
    const staleTask = task();
    const db = fakeDb({
      tasks: {
        list: vi.fn(async ({ status }: { status?: string } = {}) => status === 'doing' ? [staleTask] : []),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-activity-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'default',
      'worker',
      expect.stringContaining('Supervision: task #12345678'),
    );
    expect(db.tasks.updateFields).toHaveBeenCalledWith(staleTask.id, {
      updated_at: Math.floor(NOW_MS / 1000),
    });
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:refreshed',
      subject_id: staleTask.uuid,
      data: expect.objectContaining({
        reason: 'owner_refresh',
        stalled_minutes: 60,
      }),
    }));
  });

  it('bumps task activity when a backlog guard reply reports in progress', async () => {
    const staleTask = task();
    const db = fakeDb({
      tasks: {
        getByUuidPrefix: vi.fn(async () => [staleTask]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-control-reply-test', db, { libraryRoot: null }) as any;

    await manager.applyTaskControlReplyFromCompletedQuery(
      activeQuery(staleTask.owner!, {
        query_id: 'guard-in-progress',
        prompt: 'Backlog guard: task #12345678 ("Stalled work") has been active 60m with no progress update. Reply with one line: DONE, BLOCKED: <reason>, NEEDS-REASSIGNMENT, or IN-PROGRESS: <next update>.',
        status: 'completed',
      }),
      { result: 'IN-PROGRESS: reviewing the artifact now' },
      NOW_MS,
    );

    expect(db.tasks.updateFields).toHaveBeenCalledWith(staleTask.id, {
      updated_at: Math.floor(NOW_MS / 1000),
    });
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:refreshed',
      subject_id: staleTask.uuid,
      data: expect.objectContaining({
        reason: 'control_reply_in_progress',
        stalled_minutes: 60,
      }),
    }));
  });

  it('parks repeated in-progress replies that do not change approach', async () => {
    const staleTask = task();
    const db = fakeDb({
      tasks: {
        getByUuidPrefix: vi.fn(async () => [staleTask]),
      },
      adapter: {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("topic = 'task:attempt-approach'")) {
            return {
              rows: [{
                occurred_at: NOW_MS - 60_000,
                actor_agent_id: staleTask.owner,
                data: JSON.stringify({
                  action: 'in_progress',
                  note: 'reviewing the artifact now',
                }),
              }],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        }),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-repeat-approach-test', db, { libraryRoot: null }) as any;

    const result = await manager.applyTaskControlReplyFromCompletedQuery(
      activeQuery(staleTask.owner!, {
        query_id: 'guard-repeat-in-progress',
        prompt: 'Backlog guard: task #12345678 ("Stalled work") has been active 60m with no progress update. Reply with one line: DONE, BLOCKED: <reason>, NEEDS-REASSIGNMENT, or IN-PROGRESS: <next update>.',
        status: 'completed',
      }),
      { result: 'IN-PROGRESS: reviewing the artifact now' },
      NOW_MS,
    );

    expect(result).toEqual(expect.objectContaining({
      applied: true,
      action: 'repeat_attempt_blocked',
      reason: 'repeated_attempt_without_changed_approach',
    }));
    expect(db.tasks.updateFields).toHaveBeenCalledWith(staleTask.id, expect.objectContaining({
      owner: null,
      status: 'todo',
      completed_at: null,
      description: expect.stringContaining('REPEATED-ATTEMPT'),
    }));
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:attempt-approach',
      subject_id: staleTask.uuid,
      data: expect.objectContaining({
        action: 'repeat_attempt_blocked',
        repeated: true,
      }),
    }));
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:triaged',
      subject_id: staleTask.uuid,
      data: expect.objectContaining({
        reason: 'control_reply_repeated_attempt',
      }),
    }));
  });

  it('allows a repeated task reply when the agent states a changed approach', async () => {
    const staleTask = task();
    const db = fakeDb({
      tasks: {
        getByUuidPrefix: vi.fn(async () => [staleTask]),
      },
      adapter: {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("topic = 'task:attempt-approach'")) {
            return {
              rows: [{
                occurred_at: NOW_MS - 60_000,
                actor_agent_id: staleTask.owner,
                data: JSON.stringify({
                  action: 'in_progress',
                  note: 'reviewing the artifact now',
                }),
              }],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        }),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-changed-approach-test', db, { libraryRoot: null }) as any;

    const result = await manager.applyTaskControlReplyFromCompletedQuery(
      activeQuery(staleTask.owner!, {
        query_id: 'guard-changed-in-progress',
        prompt: 'Backlog guard: task #12345678 ("Stalled work") has been active 60m with no progress update. Reply with one line: DONE, BLOCKED: <reason>, NEEDS-REASSIGNMENT, or IN-PROGRESS: <next update>.',
        status: 'completed',
      }),
      { result: 'IN-PROGRESS: switching to a different source log instead of reviewing the artifact again' },
      NOW_MS,
    );

    expect(result).toEqual(expect.objectContaining({
      applied: true,
      action: 'in_progress',
    }));
    expect(db.tasks.updateFields).not.toHaveBeenCalledWith(staleTask.id, expect.objectContaining({
      owner: null,
      status: 'todo',
    }));
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:attempt-approach',
      subject_id: staleTask.uuid,
      data: expect.objectContaining({
        action: 'in_progress',
        changed_approach: true,
      }),
    }));
  });

  it('parks task for reassignment when a backlog guard reply requests reassignment', async () => {
    const staleTask = task();
    const db = fakeDb({
      tasks: {
        getByUuidPrefix: vi.fn(async () => [staleTask]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-control-reassign-test', db, { libraryRoot: null }) as any;

    await manager.applyTaskControlReplyFromCompletedQuery(
      activeQuery(staleTask.owner!, {
        query_id: 'guard-reassign',
        prompt: 'Backlog guard: task #12345678 ("Stalled work") has been active 60m with no progress update. Reply with one line: DONE, BLOCKED: <reason>, NEEDS-REASSIGNMENT, or IN-PROGRESS: <next update>.',
        status: 'completed',
      }),
      { result: 'NEEDS-REASSIGNMENT: no matching workspace state' },
      NOW_MS,
    );

    expect(db.tasks.updateFields).toHaveBeenCalledWith(staleTask.id, expect.objectContaining({
      owner: null,
      status: 'todo',
      completed_at: null,
      updated_at: Math.floor(NOW_MS / 1000),
    }));
    expect(db.tasks.updateFields.mock.calls[0][1].description).toContain('NEEDS-REASSIGNMENT');
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:triaged',
      subject_id: staleTask.uuid,
      data: expect.objectContaining({
        reason: 'control_reply_reassign',
        stalled_minutes: 60,
      }),
    }));
  });

  it('routes parked blocked control replies to task-master triage', async () => {
    const staleTask = task();
    const opsTeam = team({ id: 'ops-team-id', name: 'ops-team' });
    const taskMaster = agent({
      id: 'task-master-id',
      team_id: opsTeam.id,
      name: 'task-master',
      status: 'running',
    });
    const db = fakeDb({
      teams: {
        getTeamByName: vi.fn(async (name: string) => {
          if (name === 'ops-team') return opsTeam;
          if (name === 'default') return team();
          return null;
        }),
      },
      agents: {
        getByName: vi.fn(async (teamId: string, name: string) =>
          teamId === opsTeam.id && name === 'task-master' ? taskMaster : null,
        ),
        list: vi.fn(async (teamId: string) => teamId === opsTeam.id ? [taskMaster] : [agent()]),
      },
      tasks: {
        getByUuidPrefix: vi.fn(async () => [staleTask]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-blocked-control-task-manager-route-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.applyTaskControlReplyFromCompletedQuery(
      activeQuery(staleTask.owner!, {
        query_id: 'guard-blocked',
        prompt: 'Backlog guard: task #12345678 ("Stalled work") has been active 60m with no progress update. Reply with one line: DONE, BLOCKED: <reason>, NEEDS-REASSIGNMENT, or IN-PROGRESS: <next update>.',
        status: 'completed',
      }),
      { result: 'BLOCKED: missing source evidence' },
      NOW_MS,
    );

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(db.tasks.updateFields).toHaveBeenCalledWith(staleTask.id, expect.objectContaining({
      owner: null,
      status: 'todo',
      completed_at: null,
    }));
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'ops-team',
      'task-master',
      expect.stringContaining('task-manager triage for default task #12345678'),
    );
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'ops-team',
      'task-master',
      expect.stringContaining('task has no owner'),
    );
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'ops-team',
      'task-master',
      expect.stringContaining('The owner replied BLOCKED: missing source evidence'),
    );
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'ops-team',
      'task-master',
      expect.stringContaining('ASK-USER with the exact missing decision'),
    );
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      team_id: TEAM_ID,
      topic: 'task:triaged',
      actor_agent_id: 'task-master-id',
      data: expect.objectContaining({
        reason: 'unclaimed',
        stalled_minutes: 60,
      }),
    }));
  });

  it('assigns a routed control reply to the named live teammate', async () => {
    const routedTask = task({
      status: 'todo',
      owner: null,
    });
    const assignedTask = {
      ...routedTask,
      status: 'doing' as const,
      owner: 'agent-1',
      updated_at: Math.floor(NOW_MS / 1000),
    };
    const db = fakeDb({
      tasks: {
        list: vi.fn(async ({ status }: { status?: string } = {}) => status === 'doing' ? [] : [routedTask]),
        getByNameForTeam: vi.fn(async () => assignedTask),
        getByUuidPrefix: vi.fn(async () => [routedTask]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-control-route-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.applyTaskControlReplyFromCompletedQuery(
      activeQuery('lead-agent', {
        query_id: 'guard-route',
        prompt: 'Supervision: unclaimed task #12345678 ("Stalled work") has been waiting 60m. Reply with one line: CLAIM, ROUTE: <team/agent>, or BLOCKED: <reason>.',
        status: 'completed',
      }),
      { result: 'ROUTE: worker' },
      NOW_MS,
    );

    expect(db.tasks.updateFields).toHaveBeenCalledWith(routedTask.id, {
      owner: 'agent-1',
      status: 'doing',
      completed_at: null,
      updated_at: Math.floor(NOW_MS / 1000),
    });
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'default',
      'worker',
      expect.stringContaining('TASK DELEGATION from manager'),
    );
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:claimed',
      subject_id: routedTask.uuid,
      data: expect.objectContaining({
        owner: 'agent-1',
      }),
    }));
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:refreshed',
      subject_id: routedTask.uuid,
      data: expect.objectContaining({
        reason: 'control_reply_route_assigned',
      }),
    }));
  });

  it('extracts route targets from prose control replies without treating the task title as the target', async () => {
    const routedTask = task({
      status: 'todo',
      owner: null,
      title: 'Set governance rules',
    });
    const worker = agent({ id: 'counsel-1', name: 'general-counsel' });
    const db = fakeDb({
      agents: {
        resolve: vi.fn(async (_teamId: string, ref: string) => ref === 'general-counsel' ? [worker] : []),
      },
      tasks: {
        list: vi.fn(async ({ status }: { status?: string } = {}) => status === 'doing' ? [] : [routedTask]),
        getByNameForTeam: vi.fn(async () => ({
          ...routedTask,
          status: 'doing' as const,
          owner: worker.id,
          updated_at: Math.floor(NOW_MS / 1000),
        })),
        getByUuidPrefix: vi.fn(async () => [routedTask]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-control-route-prose-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.applyTaskControlReplyFromCompletedQuery(
      activeQuery('lead-agent', {
        query_id: 'guard-route-prose',
        prompt: 'Supervision: unclaimed task #12345678 ("Set governance rules") has been waiting 60m. Reply with one line: CLAIM, ROUTE: <team/agent>, or BLOCKED: <reason>.',
        status: 'completed',
      }),
      { result: 'Route `Set governance rules` to `general-counsel`.' },
      NOW_MS,
    );

    expect(db.agents.resolve).toHaveBeenCalledWith(TEAM_ID, 'general-counsel');
    expect(db.tasks.updateFields).toHaveBeenCalledWith(routedTask.id, expect.objectContaining({
      owner: worker.id,
      status: 'doing',
    }));
  });

  it('marks a task done when a supervision reply starts with task done command syntax', async () => {
    const staleTask = task();
    const db = fakeDb({
      tasks: {
        getByUuidPrefix: vi.fn(async () => [staleTask]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-control-done-test', db, { libraryRoot: null }) as any;

    await manager.applyTaskControlReplyFromCompletedQuery(
      activeQuery(staleTask.owner!, {
        query_id: 'guard-done',
        prompt: 'Supervision: task #12345678 ("Stalled work") has been in progress 60m with no completion. Reply with one line: DONE, BLOCKED: <reason>, NEEDS-REASSIGNMENT, or IN-PROGRESS: <next update>.',
        status: 'completed',
      }),
      { result: '/task done #12345678' },
      NOW_MS,
    );

    expect(db.tasks.updateFields).toHaveBeenCalledWith(staleTask.id, {
      status: 'done',
      completed_at: Math.floor(NOW_MS / 1000),
      updated_at: Math.floor(NOW_MS / 1000),
    });
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:completed',
      subject_id: staleTask.uuid,
    }));
  });

  it('marks a task done when a delegation reply includes task done command syntax', async () => {
    const staleTask = task();
    const db = fakeDb({
      tasks: {
        getByUuidPrefix: vi.fn(async () => [staleTask]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-delegation-done-test', db, { libraryRoot: null }) as any;

    await manager.applyTaskControlReplyFromCompletedQuery(
      activeQuery(staleTask.owner!, {
        query_id: 'delegation-done',
        prompt: 'TASK DELEGATION from manager: You are assigned task #12345678 ("Stalled work"). Start this task now.',
        status: 'completed',
      }),
      { result: 'Delivered the requested artifact.\n\n/task done #12345678 --acceptance "artifact delivered"' },
      NOW_MS,
    );

    expect(db.tasks.updateFields).toHaveBeenCalledWith(staleTask.id, {
      status: 'done',
      completed_at: Math.floor(NOW_MS / 1000),
      updated_at: Math.floor(NOW_MS / 1000),
    });
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:completed',
      subject_id: staleTask.uuid,
    }));
  });

  it('wakes the parent lead when all delegated child tasks are done', async () => {
    const lead = agent({ id: 'lead-1', name: 'research-lead', team_id: TEAM_ID, metadata: { lead: true } });
    const worker = agent({ id: 'worker-1', name: 'analyst', team_id: TEAM_ID });
    const parent = task({
      id: 'parent-task',
      name: 'map-active-goal-bindings',
      uuid: '87654321-1234-1234-1234-123456789abc',
      title: 'Map active goal bindings',
      owner: lead.id,
      created_by: lead.id,
      created_at: Math.floor(NOW_MS / 1000) - 600,
      updated_at: Math.floor(NOW_MS / 1000) - 600,
    });
    const child = task({
      id: 'child-task',
      name: 'map-goal-label-owner-routes',
      uuid: '33333333-3333-4333-8333-333333333333',
      title: 'Map goal label owner routes',
      description: 'Child of #87654321',
      owner: worker.id,
      created_by: lead.id,
      status: 'done',
      created_at: Math.floor(NOW_MS / 1000) - 500,
      updated_at: Math.floor(NOW_MS / 1000) - 100,
      completed_at: Math.floor(NOW_MS / 1000) - 100,
    });
    const db = fakeDb({
      teams: {
        getTeam: vi.fn(async () => team({ name: 'research' })),
      },
      agents: {
        getById: vi.fn(async (id: string) => id === lead.id ? lead : id === worker.id ? worker : null),
      },
      tasks: {
        list: vi.fn(async ({ status }: { status?: string } = {}) => status === 'doing' ? [parent] : [parent, child]),
      },
      adapter: {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('FROM queries')) {
            return {
              rows: [{
                query_id: 'query-child-complete',
                completed: NOW_MS,
                result: {
                  result: 'Done. Output: ./output/memory-architecture-canonical-v1.md. Summary: canonical memory plan is ready.',
                },
              }],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        }),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-delegated-parent-ready-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const sent = await manager.wakeDelegatedParentLeadIfReady({
      teamId: TEAM_ID,
      teamName: 'research',
      child,
      occurredAt: NOW_MS,
    });

    expect(sent).toBe(1);
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'research',
      'research-lead',
      expect.stringContaining('Manager DB confirms parent task #87654321'),
    );
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'research',
      'research-lead',
      expect.stringContaining('#87654321'),
    );
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'research',
      'research-lead',
      expect.stringContaining('#33333333 status=done owner=analyst'),
    );
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'research',
      'research-lead',
      expect.stringContaining('completion (query-child-complete): Done. Output: ./output/memory-architecture-canonical-v1.md. Summary: canonical memory plan is ready.'),
    );
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'research',
      'research-lead',
      expect.stringContaining('Do not answer that #87654321 has no trace'),
    );
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:refreshed',
      subject_id: parent.uuid,
      data: expect.objectContaining({
        reason: 'delegated_children_complete',
      }),
    }));
  });

  it('retries completed-child parent reconciliation with DB-backed context instead of generic owner refresh', async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const lead = agent({
      id: 'lead-1',
      name: 'engineering-lead',
      metadata: { catalog: { role: 'lead' } },
    });
    const worker = agent({
      id: 'worker-1',
      name: 'architecture-engineer',
      metadata: { catalog: { role: 'member' } },
    });
    const parent = task({
      id: 'parent-task',
      name: 'design-memory-architecture',
      uuid: 'effa1c30-3d9d-4633-af13-9db1833c24d2',
      title: 'Design memory architecture',
      owner: lead.id,
      created_by: null,
      status: 'doing',
      created_at: nowSec - 3600,
      updated_at: nowSec - 3600,
    });
    const child = task({
      id: 'child-task',
      name: 'consolidate-memory-architecture-plan',
      uuid: '7679bede-aaaa-4333-8333-333333333333',
      title: 'Consolidate memory architecture into one canonical implementation-ready plan',
      owner: worker.id,
      created_by: lead.id,
      status: 'done',
      created_at: nowSec - 3500,
      updated_at: nowSec - 3000,
      completed_at: nowSec - 3000,
    });
    const db = fakeDb({
      teams: {
        getTeam: vi.fn(async () => team({ name: 'engineering-team' })),
      },
      agents: {
        getById: vi.fn(async (id: string) => id === lead.id ? lead : id === worker.id ? worker : null),
        getByName: vi.fn(async () => null),
      },
      tasks: {
        list: vi.fn(async ({ status, teamId }: { status?: string; teamId?: string } = {}) => {
          if (status === 'doing') return [parent];
          if (teamId === TEAM_ID) return [parent, child];
          return [parent, child];
        }),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-done-child-reconcile-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(manager.sendSupervisionAsk).toHaveBeenCalledTimes(1);
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'engineering-team',
      'engineering-lead',
      expect.stringContaining('Manager DB confirms parent task #effa1c30'),
    );
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'engineering-team',
      'engineering-lead',
      expect.stringContaining('#7679bede status=done owner=architecture-engineer'),
    );
    expect(manager.sendSupervisionAsk).not.toHaveBeenCalledWith(
      'engineering-team',
      'engineering-lead',
      expect.stringContaining('has been in progress'),
    );
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:refreshed',
      subject_id: parent.uuid,
      data: expect.objectContaining({
        reason: 'delegated_children_complete',
      }),
    }));
  });

  it('does not attach unrelated later lead-created tasks as delegated children', async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const lead = agent({
      id: 'lead-1',
      name: 'engineering-lead',
      metadata: { catalog: { role: 'lead' } },
    });
    const worker = agent({
      id: 'worker-1',
      name: 'architecture-engineer',
      metadata: { catalog: { role: 'member' } },
    });
    const parent = task({
      id: 'parent-task',
      name: 'design-memory-architecture',
      uuid: 'effa1c30-3d9d-4633-af13-9db1833c24d2',
      title: 'Design memory architecture',
      owner: lead.id,
      created_by: null,
      status: 'doing',
      created_at: nowSec - 3600,
      updated_at: nowSec - 3600,
      description: '[goal:goal_memory] Design durable memory storage and retrieval.',
    });
    const realChild = task({
      id: 'real-child',
      name: 'consolidate-memory-architecture-plan',
      uuid: '7679bede-aaaa-4333-8333-333333333333',
      title: 'Consolidate memory architecture into one canonical implementation-ready plan',
      description: 'Child of #effa1c30. Goal: stable longterm memory.',
      owner: worker.id,
      created_by: lead.id,
      status: 'done',
      created_at: nowSec - 3500,
      updated_at: nowSec - 3000,
      completed_at: nowSec - 3000,
    });
    const unrelated = task({
      id: 'unrelated-child',
      name: 'incorporate-security-norun-bittrees-readiness',
      uuid: 'f723c0ce-aaaa-4333-8333-333333333333',
      title: 'Incorporate security-router NO-GO into agent.bittrees.org readiness packet',
      description: 'Child of #cfafce2f and #befe37a7. Goal ID: goal_plan_rzit49',
      owner: worker.id,
      created_by: lead.id,
      status: 'done',
      created_at: nowSec - 1000,
      updated_at: nowSec - 900,
      completed_at: nowSec - 900,
    });
    const db = fakeDb({
      teams: {
        getTeam: vi.fn(async () => team({ name: 'engineering-team' })),
      },
      agents: {
        getById: vi.fn(async (id: string) => id === lead.id ? lead : id === worker.id ? worker : null),
      },
      tasks: {
        list: vi.fn(async ({ teamId }: { teamId?: string } = {}) => {
          if (teamId === TEAM_ID) return [parent, realChild, unrelated];
          return [parent, realChild, unrelated];
        }),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-delegated-child-filter-test', db, { libraryRoot: null }) as any;

    const audit = await manager.buildDelegationAudit(parent, TEAM_ID, 'engineering-team', lead);

    expect(audit).toMatchObject({
      status: 'ok',
      childTaskRefs: ['#7679bede'],
    });
    expect(audit.childTasks).toEqual([
      expect.objectContaining({
        ref: '#7679bede',
        name: 'consolidate-memory-architecture-plan',
      }),
    ]);
  });

  it('marks a task done when a delegation reply starts with completed-task prose', async () => {
    const staleTask = task();
    const db = fakeDb({
      tasks: {
        getByUuidPrefix: vi.fn(async () => [staleTask]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-delegation-prose-done-test', db, { libraryRoot: null }) as any;

    await manager.applyTaskControlReplyFromCompletedQuery(
      activeQuery(staleTask.owner!, {
        query_id: 'delegation-prose-done',
        prompt: 'TASK DELEGATION from manager: You are assigned task #12345678 ("Stalled work"). Start this task now.',
        status: 'completed',
      }),
      { result: 'Done. Task: Stalled work (#12345678). Output: artifact delivered.' },
      NOW_MS,
    );

    expect(db.tasks.updateFields).toHaveBeenCalledWith(staleTask.id, {
      status: 'done',
      completed_at: Math.floor(NOW_MS / 1000),
      updated_at: Math.floor(NOW_MS / 1000),
    });
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:completed',
      subject_id: staleTask.uuid,
    }));
  });

  it('closes delegated parent reconciliation when the only blocker is missing HTTP tooling', async () => {
    const parent = task({
      name: 'bootstrap-agent-bittrees-portal',
      title: 'Bootstrap dedicated agent.bittrees.org portal repo',
      uuid: 'befe37a7-c751-4d66-938f-92ae045bf839',
    });
    const db = fakeDb({
      tasks: {
        getByUuidPrefix: vi.fn(async () => [parent]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-delegated-parent-no-http-close-test', db, { libraryRoot: null }) as any;

    await manager.applyTaskControlReplyFromCompletedQuery(
      activeQuery(parent.owner!, {
        query_id: 'delegated-parent-no-http-close',
        prompt: [
          'Supervision: Manager DB confirms parent task #befe37a7 ("Bootstrap dedicated agent.bittrees.org portal repo") exists and all detected delegated child tasks are done.',
          'Completed delegated children and available completion evidence:',
          '- #5afa13f5 status=done owner=architecture-engineer',
        ].join('\n'),
        status: 'completed',
      }),
      {
        result: [
          'BLOCKED: I have no tool in this session capable of making the HTTP call needed to close the task.',
          '',
          'All four children are done with concrete evidence, so the parent objective is complete.',
          'No contradicting source was found in the child evidence.',
          'Reconciliation: parent task bootstrap-agent-bittrees-portal is DONE.',
        ].join('\n'),
      },
      NOW_MS,
    );

    expect(db.tasks.updateFields).toHaveBeenCalledWith(parent.id, {
      status: 'done',
      completed_at: Math.floor(NOW_MS / 1000),
      updated_at: Math.floor(NOW_MS / 1000),
    });
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:completed',
      subject_id: parent.uuid,
    }));
  });

  it('closes control replies when shell/http tool access is the only blocker', async () => {
    const staleTask = task({
      name: 'publish-plan-status-update',
      title: 'Publish plan status update',
    });
    const db = fakeDb({
      tasks: {
        getByUuidPrefix: vi.fn(async () => [staleTask]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-control-reply-read-only-tooling-close-test', db, { libraryRoot: null }) as any;

    await manager.applyTaskControlReplyFromCompletedQuery(
      activeQuery(staleTask.owner!, {
        query_id: 'read-only-tooling-clean-close',
        prompt: 'Supervision: task #12345678 ("Publish plan status update") has been in progress 60m. Reply with one line: DONE, BLOCKED: <reason>, NEEDS-REASSIGNMENT, or IN-PROGRESS: <next update>.',
        status: 'completed',
      }),
      {
        result: [
          'BLOCKED: this session has no shell/HTTP execution tool (only file read/search tools are available), so I cannot POST the completion to the manager.',
          '',
          'Reconciliation is complete: the supplied evidence is clean, the task is complete, and there is no concrete blocker other than the local done-call limitation.',
        ].join('\n'),
      },
      NOW_MS,
    );

    expect(db.tasks.updateFields).toHaveBeenCalledWith(staleTask.id, {
      status: 'done',
      completed_at: Math.floor(NOW_MS / 1000),
      updated_at: Math.floor(NOW_MS / 1000),
    });
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:completed',
      subject_id: staleTask.uuid,
    }));
  });

  it('closes delegated parent reconciliation when children reconcile cleanly despite validation routing prose', async () => {
    const parent = task({
      name: 'review-brain-snapshot-hook-risks',
      title: 'Review Brain snapshot and hook risks',
      uuid: '0edabc01-582d-42cd-af76-ce81b983c5ef',
    });
    const db = fakeDb({
      tasks: {
        getByUuidPrefix: vi.fn(async () => [parent]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-delegated-parent-clean-reconcile-test', db, { libraryRoot: null }) as any;

    await manager.applyTaskControlReplyFromCompletedQuery(
      activeQuery(parent.owner!, {
        query_id: 'delegated-parent-clean-reconcile',
        prompt: [
          'Supervision: Manager DB confirms parent task #0edabc01 ("Review Brain snapshot and hook risks") exists and all detected delegated child tasks are done.',
          'Completed delegated children and available completion evidence:',
          '- #945df1a8 status=done owner=mobile-reverse',
          '- #25affc85 status=done owner=field-journal-curator',
        ].join('\n'),
        status: 'completed',
      }),
      {
        result: [
          "Both delegated children reconcile cleanly against the parent, so I'm marking the parent done.",
          '',
          'Both children cover the two halves of the objective with terminal done states and concrete evidence.',
          '',
          "One honesty caveat: I don't have an HTTP/shell tool in this session, so I can't fire the done call myself.",
          '',
          'Per validation policy, the consolidated result should route to the default-team coder and researcher validators before it reaches the primary lead.',
          '',
          'Reconciled and done. Task: `review-brain-snapshot-hook-risks`. Children: `#945df1a8`, `#25affc85`.',
        ].join('\n'),
      },
      NOW_MS,
    );

    expect(db.tasks.updateFields).toHaveBeenCalledWith(parent.id, {
      status: 'done',
      completed_at: Math.floor(NOW_MS / 1000),
      updated_at: Math.floor(NOW_MS / 1000),
    });
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:completed',
      subject_id: parent.uuid,
    }));
  });

  it('can force-replay a previously applied control reply after parser fixes', async () => {
    const parent = task({
      name: 'bootstrap-agent-bittrees-portal',
      title: 'Bootstrap dedicated agent.bittrees.org portal repo',
      uuid: 'befe37a7-c751-4d66-938f-92ae045bf839',
    });
    const db = fakeDb({
      tasks: {
        getByUuidPrefix: vi.fn(async () => [parent]),
      },
      adapter: {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("topic = 'query:control-reply-applied'")) {
            return { rows: [{ seq: 1 }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-control-reply-force-replay-test', db, { libraryRoot: null }) as any;
    const query = activeQuery(parent.owner!, {
      query_id: 'delegated-parent-applied-before-parser-fix',
      prompt: 'Supervision: Manager DB confirms parent task #befe37a7 ("Bootstrap dedicated agent.bittrees.org portal repo") exists and all detected delegated child tasks are done.',
      status: 'completed',
    });
    const payload = {
      result: 'All delegated children are done with concrete evidence. Reconciliation complete: parent task is DONE.',
    };

    const skipped = await manager.applyTaskControlReplyFromCompletedQuery(query, payload, NOW_MS);
    const forced = await manager.applyTaskControlReplyFromCompletedQuery(query, payload, NOW_MS, { force: true });

    expect(skipped).toMatchObject({ applied: false, reason: 'already_applied' });
    expect(forced).toMatchObject({ applied: true, action: 'done', task: parent.name });
    expect(db.tasks.updateFields).toHaveBeenCalledWith(parent.id, {
      status: 'done',
      completed_at: Math.floor(NOW_MS / 1000),
      updated_at: Math.floor(NOW_MS / 1000),
    });
  });

  it('keeps delegated parent reconciliation blocked when the reply reports a real missing artifact', async () => {
    const parent = task({
      name: 'design-memory-architecture',
      title: 'Design memory architecture',
      uuid: 'effa1c30-3d9d-4633-af13-9db1833c24d2',
    });
    const db = fakeDb({
      tasks: {
        getByUuidPrefix: vi.fn(async () => [parent]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-delegated-parent-real-blocker-test', db, { libraryRoot: null }) as any;

    await manager.applyTaskControlReplyFromCompletedQuery(
      activeQuery(parent.owner!, {
        query_id: 'delegated-parent-real-blocker',
        prompt: [
          'Supervision: Manager DB confirms parent task #effa1c30 ("Design memory architecture") exists and all detected delegated child tasks are done.',
          'Completed delegated children and available completion evidence:',
          '- #7679bede status=done owner=architecture-engineer',
        ].join('\n'),
        status: 'completed',
      }),
      {
        result: [
          'BLOCKED: child output artifact path is missing from the task handoff.',
          '',
          'I cannot reconcile the parent without the missing artifact evidence.',
        ].join('\n'),
      },
      NOW_MS,
    );

    expect(db.tasks.updateFields).toHaveBeenCalledWith(parent.id, expect.objectContaining({
      owner: null,
      status: 'todo',
      completed_at: null,
      updated_at: Math.floor(NOW_MS / 1000),
      description: expect.stringContaining('BLOCKED: child output artifact path is missing'),
    }));
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:triaged',
      subject_id: parent.uuid,
    }));
  });

  it('does not mark a task done when the reply reports done-blocked ambiguity', async () => {
    const staleTask = task();
    const db = fakeDb({
      tasks: {
        getByUuidPrefix: vi.fn(async () => [staleTask]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-done-blocked-test', db, { libraryRoot: null }) as any;

    await manager.applyTaskControlReplyFromCompletedQuery(
      activeQuery(staleTask.owner!, {
        query_id: 'guard-done-blocked',
        prompt: 'Backlog guard: task #12345678 ("Stalled work") has been active 60m with no progress update.',
        status: 'completed',
      }),
      { result: 'DONE, BLOCKED: no completion artifact was produced' },
      NOW_MS,
    );

    expect(db.tasks.updateFields).toHaveBeenCalledWith(staleTask.id, expect.objectContaining({
      owner: null,
      status: 'todo',
      completed_at: null,
      updated_at: Math.floor(NOW_MS / 1000),
    }));
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:triaged',
      subject_id: staleTask.uuid,
    }));
  });

  it('closes a control reply when only the local manager done call was refused', async () => {
    const staleTask = task({
      name: 'audit-canceled-item-reason',
      title: 'Audit canceled item reason',
    });
    const db = fakeDb({
      tasks: {
        getByUuidPrefix: vi.fn(async () => [staleTask]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-control-reply-manager-url-refused-close-test', db, { libraryRoot: null }) as any;

    await manager.applyTaskControlReplyFromCompletedQuery(
      activeQuery(staleTask.owner!, {
        query_id: 'manager-url-refused-clean-close',
        prompt: 'Supervision: task #12345678 ("Audit canceled item reason") has been in progress 60m. Reply with one line: DONE, BLOCKED: <reason>, NEEDS-REASSIGNMENT, or IN-PROGRESS: <next update>.',
        status: 'completed',
      }),
      {
        result: [
          'BLOCKED: I could not mark `audit-canceled-item-reason` done because `$MANAGER_URL` (`http://127.0.0.1:4100`) refused the completion POST.',
          '',
          'Reconciliation is complete from the embedded evidence: delegated child `verify-skillmesh-bucket-replacement-evidence` passed.',
        ].join('\n'),
      },
      NOW_MS,
    );

    expect(db.tasks.updateFields).toHaveBeenCalledWith(staleTask.id, {
      status: 'done',
      completed_at: Math.floor(NOW_MS / 1000),
      updated_at: Math.floor(NOW_MS / 1000),
    });
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:completed',
      subject_id: staleTask.uuid,
      data: expect.objectContaining({
        failure_note: expect.stringContaining('Manager-applied closure after local done-call failure'),
      }),
    }));
  });

  it('closes delegated parent reconciliation when only the manager done callback is unreachable', async () => {
    const parent = task({
      name: 'investigate-release-v0-1-622',
      title: 'Investigate missing release asset for v0.1.622',
      uuid: '16b2d2e5-bcf9-48be-9810-74cf051d8541',
    });
    const db = fakeDb({
      tasks: {
        getByUuidPrefix: vi.fn(async () => [parent]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-delegated-parent-manager-url-unreachable-close-test', db, { libraryRoot: null }) as any;

    await manager.applyTaskControlReplyFromCompletedQuery(
      activeQuery(parent.owner!, {
        query_id: 'delegated-parent-manager-url-unreachable',
        prompt: [
          'Supervision: Manager DB confirms parent task #16b2d2e5 ("Investigate missing release asset for v0.1.622") exists and all detected delegated child tasks are done.',
          'Completed delegated children and available completion evidence:',
          '- #43b9e9d9 status=done owner=content-moderator title="Verify release asset state for v0.1.622"',
          '- #4351513e status=done owner=maintainer title="Verify local IDACC publish tooling for v0.1.622"',
          '- #9fc94d45 status=done owner=deployer title="Assess safe publish action or blocker for v0.1.622"',
        ].join('\n'),
        status: 'completed',
      }),
      {
        result: [
          'BLOCKED: I reconciled the embedded child evidence, but I cannot mark parent task `investigate-release-v0-1-622` done because `MANAGER_URL=http://127.0.0.1:4100` is not reachable from this sandbox (`curl: failed to connect to 127.0.0.1 port 4100`).',
          '',
          'Completion decision, ready to post: parent investigation is complete. Child tasks done: `assess-safe-publish-action-v0-1-622`, `verify-release-v0-1-622-assets`, `verify-idacc-publish-tooling-v0-1-622`.',
          '',
          'Reconciled finding: GitHub tag `v0.1.622` exists, but no public GitHub release/assets exist for `v0.1.622`; latest public release remains `v0.1.621`. This workspace is not publish-capable, so safe publish is blocked here.',
        ].join('\n'),
      },
      NOW_MS,
    );

    expect(db.tasks.updateFields).toHaveBeenCalledWith(parent.id, {
      status: 'done',
      completed_at: Math.floor(NOW_MS / 1000),
      updated_at: Math.floor(NOW_MS / 1000),
    });
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:completed',
      subject_id: parent.uuid,
    }));
  });

  it('keeps a manager-url-refused control reply blocked when evidence is still missing', async () => {
    const staleTask = task({
      name: 'audit-missing-output',
      title: 'Audit missing output',
    });
    const db = fakeDb({
      tasks: {
        getByUuidPrefix: vi.fn(async () => [staleTask]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-control-reply-manager-url-real-blocker-test', db, { libraryRoot: null }) as any;

    await manager.applyTaskControlReplyFromCompletedQuery(
      activeQuery(staleTask.owner!, {
        query_id: 'manager-url-refused-real-blocker',
        prompt: 'Supervision: task #12345678 ("Audit missing output") has been in progress 60m. Reply with one line: DONE, BLOCKED: <reason>, NEEDS-REASSIGNMENT, or IN-PROGRESS: <next update>.',
        status: 'completed',
      }),
      {
        result: [
          'BLOCKED: I could not mark the task done because `$MANAGER_URL` refused the connection.',
          '',
          'The child output artifact is missing, so I cannot reconcile acceptance.',
        ].join('\n'),
      },
      NOW_MS,
    );

    expect(db.tasks.updateFields).toHaveBeenCalledWith(staleTask.id, expect.objectContaining({
      owner: null,
      status: 'todo',
      completed_at: null,
      updated_at: Math.floor(NOW_MS / 1000),
    }));
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:triaged',
      subject_id: staleTask.uuid,
      data: expect.objectContaining({
        reason: 'control_reply_blocked',
      }),
    }));
  });

  it('applies a blocked control reply even when context precedes the control line', async () => {
    const staleTask = task();
    const db = fakeDb({
      tasks: {
        getByUuidPrefix: vi.fn(async () => [staleTask]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-multiline-blocked-test', db, { libraryRoot: null }) as any;

    await manager.applyTaskControlReplyFromCompletedQuery(
      activeQuery(staleTask.owner!, {
        query_id: 'guard-multiline-blocked',
        prompt: 'Supervision: task #12345678 ("Stalled work") has been in progress 60m.',
        status: 'completed',
      }),
      {
        result: [
          'I checked my local session and do not have the artifact yet.',
          '',
          'BLOCKED: child output artifact path is missing from the task handoff.',
        ].join('\n'),
      },
      NOW_MS,
    );

    expect(db.tasks.updateFields).toHaveBeenCalledWith(staleTask.id, expect.objectContaining({
      owner: null,
      status: 'todo',
      completed_at: null,
      updated_at: Math.floor(NOW_MS / 1000),
      description: expect.stringContaining('BLOCKED: child output artifact path is missing'),
    }));
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:triaged',
      subject_id: staleTask.uuid,
    }));
  });

  it('does not promote vague human-intervention blocked replies into the manager inbox', async () => {
    const db = fakeDb({
      agents: {
        getById: vi.fn(async () => agent({ name: 'coder' })),
      },
      queries: {
        getByQueryIdForTeam: vi.fn(async () => null),
        create: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-human-blocker-inbox-test', db, { libraryRoot: null }) as any;

    await manager.promoteHumanDecisionBlockerToManagerInbox(
      activeQuery('agent-1', {
        query_id: 'query-source-1',
        prompt: 'Audit the engineering prompt issue and resolve any blockers.',
        status: 'completed',
      }),
      { result: 'BLOCKED: Task requires human intervention to resolve the engineering prompt audit issue.' },
      NOW_MS,
    );

    expect(db.queries.create).not.toHaveBeenCalled();
    expect(db.news.add).not.toHaveBeenCalled();
  });

  it('promotes explicit human-decision blocked replies into the manager inbox', async () => {
    const db = fakeDb({
      agents: {
        getById: vi.fn(async () => agent({ name: 'coder' })),
      },
      queries: {
        getByQueryIdForTeam: vi.fn(async () => null),
        create: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-human-blocker-inbox-test', db, { libraryRoot: null }) as any;

    await manager.promoteHumanDecisionBlockerToManagerInbox(
      activeQuery('agent-1', {
        query_id: 'query-source-1',
        prompt: 'Audit the engineering prompt issue and resolve any blockers.',
        status: 'completed',
      }),
      { result: 'BLOCKED: ASK-USER: Should we approve the engineering prompt audit as complete before closing this task?' },
      NOW_MS,
    );

    expect(db.queries.create).toHaveBeenCalledWith(
      TEAM_ID,
      'manager_blocked_query-source-1',
      null,
      expect.stringContaining('[From: coder] BLOCKED: ASK-USER: Should we approve'),
      NOW_MS,
      undefined,
      { owner_kind: 'manager', owner_id: TEAM_ID },
      expect.objectContaining({
        source: 'human_decision_blocker',
        source_query_id: 'query-source-1',
        source_agent_id: 'agent-1',
        source_agent_name: 'coder',
      }),
    );
    expect(db.news.add).toHaveBeenCalledWith(TEAM_ID, null, expect.objectContaining({
      type: 'query.received',
      query_id: 'manager_blocked_query-source-1',
      kind: 'talk',
      reply_expected: true,
      owner_kind: 'manager',
      owner_id: TEAM_ID,
    }));
  });

  it('promotes bare ASK-USER replies into the manager inbox', async () => {
    const db = fakeDb({
      agents: {
        getById: vi.fn(async () => agent({ name: 'task-master' })),
      },
      queries: {
        getByQueryIdForTeam: vi.fn(async () => null),
        create: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-ask-user-inbox-test', db, { libraryRoot: null }) as any;

    await manager.promoteHumanDecisionBlockerToManagerInbox(
      activeQuery('agent-1', {
        query_id: 'query-task-manager-ask-user',
        prompt: 'TASK DELEGATION from manager: resolve missing child owner decision.',
        status: 'completed',
      }),
      { result: 'ASK-USER: the missing decision is which live child owner should take the first decomposition of `default` parent objective.' },
      NOW_MS,
    );

    expect(db.queries.create).toHaveBeenCalledWith(
      TEAM_ID,
      'manager_blocked_query-task-manager-ask-user',
      null,
      expect.stringContaining('[From: task-master] ASK-USER: the missing decision is which live child owner'),
      NOW_MS,
      undefined,
      { owner_kind: 'manager', owner_id: TEAM_ID },
      expect.objectContaining({
        source: 'human_decision_blocker',
        source_query_id: 'query-task-manager-ask-user',
        source_agent_id: 'agent-1',
        source_agent_name: 'task-master',
      }),
    );
    expect(db.news.add).toHaveBeenCalledWith(TEAM_ID, null, expect.objectContaining({
      type: 'query.received',
      query_id: 'manager_blocked_query-task-manager-ask-user',
      kind: 'talk',
      reply_expected: true,
      owner_kind: 'manager',
      owner_id: TEAM_ID,
    }));
  });

  it('refreshes supervision replies that contain follow-up command text instead of a control verb', async () => {
    const staleTask = task();
    const db = fakeDb({
      tasks: {
        getByUuidPrefix: vi.fn(async () => [staleTask]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-followup-command-test', db, { libraryRoot: null }) as any;

    await manager.applyTaskControlReplyFromCompletedQuery(
      activeQuery(staleTask.owner!, {
        query_id: 'guard-followup-command',
        prompt: 'Supervision: Manager DB confirms parent task #12345678 ("Stalled work") exists and all detected delegated child tasks are done.',
        status: 'completed',
      }),
      {
        result: [
          'The child artifact is not in my workspace.',
          '',
          '/talk-to architecture-engineer "Please provide the output artifact path before I close parent #12345678."',
        ].join('\n'),
      },
      NOW_MS,
    );

    expect(db.tasks.updateFields).toHaveBeenCalledWith(staleTask.id, {
      updated_at: Math.floor(NOW_MS / 1000),
    });
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:refreshed',
      subject_id: staleTask.uuid,
      data: expect.objectContaining({
        reason: 'control_reply_in_progress',
      }),
    }));
  });

  it('marks a task done when a delegation reply returns a report artifact heading', async () => {
    const staleTask = task({
      name: 'publish-improvement-report',
      title: 'Publish improvement report',
    });
    const db = fakeDb({
      tasks: {
        getByUuidPrefix: vi.fn(async () => [staleTask]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-delegation-artifact-heading-test', db, { libraryRoot: null }) as any;

    await manager.applyTaskControlReplyFromCompletedQuery(
      activeQuery(staleTask.owner!, {
        query_id: 'delegation-artifact-heading',
        prompt: 'TASK DELEGATION from manager: You are assigned task #12345678 ("Publish improvement report"). Start this task now.',
        status: 'completed',
      }),
      {
        result: [
          '**Task #12345678 - Publish Improvement Report**',
          '',
          '- **Cleanup Results:** 120 fact entries were identified and corrected.',
          '- **Schema Adoption Status:** 85 percent of the new schema has been adopted across the report.',
          '- **Recommendations:** Keep the report cadence active and validate source quality on each run.',
        ].join('\n'),
      },
      NOW_MS,
    );

    expect(db.tasks.updateFields).toHaveBeenCalledWith(staleTask.id, {
      status: 'done',
      completed_at: Math.floor(NOW_MS / 1000),
      updated_at: Math.floor(NOW_MS / 1000),
    });
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:completed',
      subject_id: staleTask.uuid,
    }));
  });

  it('marks an assigned team-objective task done when the reply includes a completion packet', async () => {
    const staleTask = task({
      name: 'audit-brain-fact-quality',
      title: 'Audit Brain fact quality',
      uuid: '7f0d68c3-610c-4df9-9a0c-f512fc18203d',
    });
    const db = fakeDb({
      tasks: {
        getByUuidPrefix: vi.fn(async () => [staleTask]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-team-objective-completion-test', db, { libraryRoot: null }) as any;

    await manager.applyTaskControlReplyFromCompletedQuery(
      activeQuery(staleTask.owner!, {
        query_id: 'team-objective-completion',
        prompt: [
          'Team objective: Build a cleaner, more reliable Brain knowledge base that stores facts in structured, source-grounded form.',
          '',
          'Your assigned task (#7f0d68c3): Audit Brain fact quality',
          'Do this task now. When finished, mark it done with: /task done #7f0d68c3 --acceptance "completed the assigned scope; evidence is in my reply"',
        ].join('\n'),
        status: 'completed',
      }),
      {
        result: [
          'Task #7f0d68c3 complete. Output: [brain-fact-audit.md](/tmp/brain-fact-audit.md)',
          '',
          '- Highest-priority cluster: duplicated learning facts with contradictory routed teams.',
          '- Highest-priority structural bug: malformed query IDs.',
          '',
          '/task done #7f0d68c3 --acceptance "completed the assigned scope; evidence is in my reply"',
        ].join('\n'),
      },
      NOW_MS,
    );

    expect(db.tasks.updateFields).toHaveBeenCalledWith(staleTask.id, {
      status: 'done',
      completed_at: Math.floor(NOW_MS / 1000),
      updated_at: Math.floor(NOW_MS / 1000),
    });
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:completed',
      subject_id: staleTask.uuid,
    }));
  });

  it('compacts Brain context before returning dispatch responses', () => {
    const manager = new AgentManagerDb('/tmp/id-agents-brain-context-response-test', fakeDb(), { libraryRoot: null }) as any;

    const response = manager.brainContextResponse({
      bundles: [],
      cited: {
        canonical_source_ids: ['memory:101'],
        entity_ids: ['entity:task:1'],
        fact_ids: [9],
        text_unit_ids: [12],
        source_origins: {
          'memory:101': ['shared_memory', 'lexical'],
        },
      },
      timelineEventId: 123,
      context_package_id: 456,
      instructions: [{
        source_id: 'memory:101',
        memory_id: 101,
        key: 'org:policy',
        content: 'large instruction body that should already be in the prompt and query metadata',
        scope: { project: 'default', task_id: '', session_id: '', user_id: '', turn_id: '' },
      }],
    });

    expect(response).toMatchObject({
      cited: {
        canonical_source_ids: ['memory:101'],
        entity_ids: ['entity:task:1'],
        fact_ids: [9],
        text_unit_ids: [12],
      },
      timelineEventId: 123,
      context_package_id: 456,
      instructions: [{
        source_id: 'memory:101',
        memory_id: 101,
        key: 'org:policy',
      }],
    });
    expect(response.cited.source_origins).toBeUndefined();
    expect(response.instructions[0].content).toBeUndefined();
    expect(response.bundles).toBeUndefined();
  });

  it('accepts comma-separated delegated task names for team-lead completion packets', async () => {
    const lead = agent({ id: 'lead-1', name: 'research-lead', metadata: { lead: true } });
    const worker = agent({ id: 'worker-1', name: 'analyst' });
    const parent = task({
      id: 'parent-task',
      name: 'design-brain-retrieval-eval-suite',
      uuid: '2ddd2587-0cb1-49a5-bcf3-6afe773e8cfa',
      title: 'Design Brain retrieval evaluation suite',
      owner: lead.id,
    });
    const child = task({
      id: 'child-task',
      name: 'brain-eval-metrics-rubric',
      uuid: '7e973121-091f-481e-bcc7-e15f042d9519',
      title: 'Specify Brain retrieval evaluation metrics and rubric',
      owner: worker.id,
      status: 'done',
      completed_at: Math.floor(NOW_MS / 1000) - 60,
    });
    const db = fakeDb({
      agents: {
        getById: vi.fn(async (id: string) => id === lead.id ? lead : id === worker.id ? worker : null),
      },
      tasks: {
        getByUuidPrefix: vi.fn(async (prefix: string) => {
          if (child.uuid.startsWith(prefix)) return [child];
          if (parent.uuid.startsWith(prefix)) return [parent];
          return [];
        }),
        getByNameForTeam: vi.fn(async (name: string) => {
          if (name === child.name) return child;
          if (name === parent.name) return parent;
          return null;
        }),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-comma-delegated-task-names-test', db, { libraryRoot: null }) as any;

    const result = await manager.validateTeamLeadDelegationBeforeDone({
      teamId: TEAM_ID,
      teamName: 'research',
      task: parent,
      payload: {
        delegated_task_names: ' brain-eval-metrics-rubric, brain-eval-metrics-rubric ',
      },
    });

    expect(result.error).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it('marks a memory-writing delegation done when it returns a memory update package', async () => {
    const staleTask = task({
      name: 'write-memory-entries',
      title: 'Write memory entries',
    });
    const db = fakeDb({
      tasks: {
        getByUuidPrefix: vi.fn(async () => [staleTask]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-delegation-memory-package-test', db, { libraryRoot: null }) as any;

    await manager.applyTaskControlReplyFromCompletedQuery(
      activeQuery(staleTask.owner!, {
        query_id: 'delegation-memory-package',
        prompt: 'TASK DELEGATION from manager: You are assigned task #12345678 ("Write memory entries"). Start this task now.',
        status: 'completed',
      }),
      {
        result: JSON.stringify({
          memory_update_package: [
            {
              skill_id: 's1',
              name: 'Advanced Prompt Engineering',
              description: 'Reusable memory entry for prompt work.',
            },
          ],
        }, null, 2),
      },
      NOW_MS,
    );

    expect(db.tasks.updateFields).toHaveBeenCalledWith(staleTask.id, {
      status: 'done',
      completed_at: Math.floor(NOW_MS / 1000),
      updated_at: Math.floor(NOW_MS / 1000),
    });
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:completed',
      subject_id: staleTask.uuid,
    }));
  });

  it('does not mark a delegation done when the reply is only an acknowledgement plan', async () => {
    const staleTask = task({
      name: 'validate-tracking-system-spec-coder',
      title: 'Validate tracking system spec - coder',
    });
    const db = fakeDb({
      tasks: {
        getByUuidPrefix: vi.fn(async () => [staleTask]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-delegation-ack-test', db, { libraryRoot: null }) as any;

    const applied = await manager.applyTaskControlReplyFromCompletedQuery(
      activeQuery(staleTask.owner!, {
        query_id: 'delegation-ack',
        prompt: 'TASK DELEGATION from manager: You are assigned task #12345678 ("Validate tracking system spec - coder"). Start this task now.',
        status: 'completed',
      }),
      {
        result: [
          'Understood! I will begin working on validating the tracking system spec - coder.',
          '',
          '### Step 1: Review the Tracking System Spec',
          'First, I will review the tracking-system-spec-v2.md file to understand its contents and structure.',
        ].join('\n'),
      },
      NOW_MS,
    );

    expect(applied).toEqual({ applied: false, reason: 'no_control_action' });
    expect(db.tasks.updateFields).not.toHaveBeenCalled();
    expect(db.events.insert).not.toHaveBeenCalled();
  });

  it('refreshes a stalled task by nudging its live owner and recording an event', async () => {
    const db = fakeDb();
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'default',
      'worker',
      expect.stringContaining('probe 1/3'),
    );
    expect(db.tasks.updateFields).toHaveBeenCalledWith('task-1', {
      updated_at: Math.floor(NOW_MS / 1000),
    });
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      team_id: TEAM_ID,
      topic: 'task:refreshed',
      actor_agent_id: 'agent-1',
      subject_kind: 'task',
      subject_id: '12345678-1234-1234-1234-123456789abc',
      data: expect.objectContaining({
        reason: 'owner_refresh',
        stalled_minutes: 60,
      }),
    }));
  });

  it('does not send multiple owner refresh prompts to one owner in the same sweep', async () => {
    process.env.STALL_SWEEP_MAX_PER_SWEEP = '5';
    const nowSec = Math.floor(NOW_MS / 1000);
    const first = task({
      id: 'task-1',
      name: 'oldest-stalled-work',
      uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      title: 'Oldest stalled work',
      updated_at: nowSec - 7200,
    });
    const second = task({
      id: 'task-2',
      name: 'second-stalled-work',
      uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      title: 'Second stalled work',
      updated_at: nowSec - 5400,
    });
    const db = fakeDb({
      tasks: {
        list: vi.fn(async ({ status }: { status?: string } = {}) => status === 'doing' ? [first, second] : []),
        updateFields: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-owner-single-nudge-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(manager.sendSupervisionAsk).toHaveBeenCalledTimes(1);
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'default',
      'worker',
      expect.stringContaining('#aaaaaaaa'),
    );
    expect(db.events.insert).toHaveBeenCalledTimes(1);
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      subject_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      data: expect.objectContaining({ reason: 'owner_refresh' }),
    }));
  });

  it('blocks additional owner work and immediately bumps the stale task first', async () => {
    const db = fakeDb();
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-owner-guard-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const guard = await manager.stalledOwnerBacklogGuard({
      teamId: TEAM_ID,
      teamName: 'default',
      owner: agent(),
    });

    expect(guard?.message).toContain('stalled_task_backlog');
    expect(guard?.blockers).toEqual(['#12345678']);
    expect(guard?.triage).toMatchObject({ status: 'sent_owner', taskRef: '#12345678', actor: 'worker' });
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'default',
      'worker',
      expect.stringContaining('New task assignment to you is held'),
    );
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      team_id: TEAM_ID,
      topic: 'task:refreshed',
      actor_agent_id: 'agent-1',
      data: expect.objectContaining({
        reason: 'owner_refresh',
        stalled_minutes: 60,
      }),
    }));
  });

  it('exposes an operator command to triage stalled owner backlogs without adding work', async () => {
    const create = vi.fn(async () => {});
    const db = fakeDb({
      teams: {
        listTeams: vi.fn(async () => [team()]),
      },
      tasks: {
        create,
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-owner-command-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const result = await manager.executeRemoteCommand('/task triage-stalled --all --limit 5', TEAM_ID, 'default');

    expect(result).toMatchObject({
      ok: true,
      result: {
        stallMinutes: 45,
        scannedTeams: 1,
        scannedOwners: 1,
        triagedOwners: 1,
        items: [
          {
            team: 'default',
            owner: 'worker',
            blockers: ['#12345678'],
            triage: { status: 'sent_owner', taskRef: '#12345678', actor: 'worker' },
          },
        ],
      },
    });
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'default',
      'worker',
      expect.stringContaining('New task assignment to you is held'),
    );
    expect(create).not.toHaveBeenCalled();
    expect(db.tasks.claim).not.toHaveBeenCalled();
  });

  it('force-jumpstarts an exact doing task before the automatic stall threshold', async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const selected = task({
      uuid: 'abcdef12-3456-4abc-8abc-abcdef123456',
      updated_at: nowSec - 35 * 60,
    });
    const db = fakeDb({
      tasks: {
        list: vi.fn(async ({ status }: { status?: string } = {}) => status === 'doing' ? [selected] : []),
        getByUuidPrefix: vi.fn(async (prefix: string) => prefix === 'abcdef12' ? [selected] : []),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-task-ref-force-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const result = await manager.executeRemoteCommand('/task jumpstart-stalled #abcdef12 --force', TEAM_ID, 'default');

    expect(result).toMatchObject({
      ok: true,
      result: {
        scannedOwners: 1,
        triagedOwners: 1,
        items: [
          {
            team: 'default',
            owner: 'worker',
            blockers: ['#abcdef12'],
            triage: { status: 'sent_owner', taskRef: '#abcdef12', actor: 'worker' },
          },
        ],
      },
    });
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'default',
      'worker',
      expect.stringContaining('35m'),
    );
  });

  it('exposes a manager-owned command to assign exact unowned todo refs without lead planning', async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const selected = task({
      id: 'todo-exact-1',
      name: 'exact-unowned',
      uuid: 'abcdef12-3456-4789-8123-abcdef123456',
      title: 'Exact unowned task',
      status: 'todo',
      owner: null,
      updated_at: nowSec - 120,
    });
    const other = task({
      id: 'todo-other-1',
      name: 'other-unowned',
      uuid: 'fedcba98-3456-4789-8123-abcdef123456',
      title: 'Other unowned task',
      status: 'todo',
      owner: null,
      updated_at: nowSec - 120,
    });
    const worker = agent({ id: 'worker-2', name: 'worker-b' });
    const lead = agent({ id: 'lead-1', name: 'lead', metadata: { primaryLead: true, leadMaxActiveQueries: 1 } });
    const updated = { ...selected, owner: worker.id, status: 'doing' as const, updated_at: nowSec };
    const create = vi.fn(async () => {});
    let taskLookupCount = 0;
    const db = fakeDb({
      agents: {
        getById: vi.fn(async () => worker),
        getByName: vi.fn(async () => lead),
        list: vi.fn(async () => [lead, worker]),
      },
      tasks: {
        list: vi.fn(async ({ status }: { status?: string } = {}) => {
          if (status === 'doing') return [];
          if (status === 'todo') return [selected, other];
          return [];
        }),
        getByUuidPrefix: vi.fn(async (prefix: string) => prefix === 'abcdef12' ? [selected] : []),
        getByNameForTeam: vi.fn(async (name: string) => {
          if (name !== selected.name) return null;
          return ++taskLookupCount === 1 ? selected : updated;
        }),
        claim: vi.fn(async (taskId: string) => taskId === selected.id),
        updateFields: vi.fn(async () => {}),
        create,
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-assign-unowned-command-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const result = await manager.executeRemoteCommand('/task assign-unowned --task #abcdef12 --limit 4', TEAM_ID, 'default');

    expect(result).toMatchObject({
      ok: true,
      result: {
        scannedTeams: 1,
        assignedCount: 1,
        items: [
          {
            team: 'default',
            task: '#abcdef12',
            status: 'assigned',
            owner: 'worker-b',
            dispatched: true,
          },
        ],
      },
    });
    expect(db.tasks.claim).toHaveBeenCalledWith('todo-exact-1', 'worker-2', nowSec, {
      maxDoingForTeam: expect.any(Number),
    });
    expect(db.tasks.claim).not.toHaveBeenCalledWith('todo-other-1', expect.any(String), expect.any(Number), expect.any(Object));
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'default',
      'worker-b',
      expect.stringContaining('TASK DELEGATION from manager'),
    );
    expect(manager.sendSupervisionAsk).not.toHaveBeenCalledWith(
      'default',
      'lead',
      expect.any(String),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('does not auto-assign an unowned todo task that was recently blocked', async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const recentlyBlocked = task({
      id: 'todo-blocked-1',
      name: 'recently-blocked',
      uuid: 'abcdef12-3456-4789-8123-abcdef123456',
      title: 'Recently blocked task',
      status: 'todo',
      owner: null,
      updated_at: nowSec - 600,
    });
    const worker = agent({ id: 'worker-2', name: 'worker-b' });
    const lead = agent({ id: 'lead-1', name: 'lead', metadata: { primaryLead: true, leadMaxActiveQueries: 1 } });
    const create = vi.fn(async () => {});
    const db = fakeDb({
      agents: {
        getById: vi.fn(async () => worker),
        getByName: vi.fn(async () => lead),
        list: vi.fn(async () => [lead, worker]),
      },
      tasks: {
        list: vi.fn(async ({ status }: { status?: string } = {}) => {
          if (status === 'doing') return [];
          if (status === 'todo') return [recentlyBlocked];
          return [];
        }),
        getByUuidPrefix: vi.fn(async (prefix: string) => prefix === 'abcdef12' ? [recentlyBlocked] : []),
        getByNameForTeam: vi.fn(async () => recentlyBlocked),
        claim: vi.fn(async () => true),
        updateFields: vi.fn(async () => {}),
        create,
      },
      adapter: {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("topic = 'task:triaged'")) {
            return { rows: [{ seq: 1, data: '{"reason":"control_reply_blocked"}' }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-assign-unowned-blocked-cooldown-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const result = await manager.executeRemoteCommand('/task assign-unowned --task #abcdef12 --limit 4 --min-age-min 1', TEAM_ID, 'default');

    expect(result).toMatchObject({
      ok: true,
      result: {
        assignedCount: 0,
        skippedCount: 1,
        items: [
          {
            team: 'default',
            task: '#abcdef12',
            status: 'skipped',
            reason: 'recent_blocked_triage',
          },
        ],
      },
    });
    expect(db.tasks.claim).not.toHaveBeenCalled();
    expect(manager.sendSupervisionAsk).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('routes manual jumpstart for parked blocked tasks to task-master triage', async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const parkedBlocked = task({
      id: 'todo-blocked-jumpstart-1',
      name: 'parked-blocked',
      uuid: 'abcdef12-3456-4789-8123-abcdef123456',
      title: 'Parked blocked task',
      status: 'todo',
      owner: null,
      updated_at: nowSec - 600,
      description: [
        'Original task brief',
        'Manager triage (control_reply_blocked, 2026-07-05T05:55:13.599Z): BLOCKED: Task requires additional information from the team lead to proceed.',
      ].join('\n\n'),
    });
    const opsTeam = team({ id: 'ops-team-id', name: 'ops-team' });
    const taskMaster = agent({
      id: 'task-master-id',
      team_id: opsTeam.id,
      name: 'task-master',
      status: 'running',
    });
    const db = fakeDb({
      teams: {
        getTeamByName: vi.fn(async (name: string) => {
          if (name === 'ops-team') return opsTeam;
          if (name === 'default') return team();
          return null;
        }),
        listTeams: vi.fn(async () => [opsTeam]),
      },
      agents: {
        getByName: vi.fn(async (teamId: string, name: string) =>
          teamId === opsTeam.id && name === 'task-master' ? taskMaster : null,
        ),
        list: vi.fn(async (teamId: string) => teamId === opsTeam.id ? [taskMaster] : [agent()]),
      },
      tasks: {
        getByUuidPrefix: vi.fn(async (prefix: string) => prefix === 'abcdef12' ? [parkedBlocked] : []),
        claim: vi.fn(async () => true),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-jumpstart-parked-blocked-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const result = await manager.executeRemoteCommand('/task jumpstart-stalled --task #abcdef12', TEAM_ID, 'default');

    expect(result).toMatchObject({
      ok: true,
      result: {
        scannedTeams: 1,
        scannedOwners: 1,
        triagedOwners: 1,
        items: [
          {
            team: 'default',
            owner: 'unclaimed',
            message: expect.stringContaining('parked and needs task-manager triage'),
            triage: {
              status: 'sent_task_manager',
              actor: 'task-master',
              actorTeam: 'ops-team',
            },
          },
        ],
      },
    });
    expect(db.tasks.claim).not.toHaveBeenCalled();
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'ops-team',
      'task-master',
      expect.stringContaining('The owner replied BLOCKED: Task requires additional information from the team lead to proceed.'),
    );
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'ops-team',
      'task-master',
      expect.stringContaining('ASK-USER with the exact missing decision'),
    );
  });

  it('does not auto-assign an unowned todo task that was recently held for lead delegation', async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const recentlyHeld = task({
      id: 'todo-delegation-hold-1',
      name: 'recently-held-delegation',
      uuid: 'ba5eba11-3456-4789-8123-ba5eba111111',
      title: 'Recently held delegation task',
      status: 'todo',
      owner: null,
      updated_at: nowSec - 600,
    });
    const worker = agent({ id: 'worker-2', name: 'worker-b' });
    const lead = agent({ id: 'lead-1', name: 'lead', metadata: { primaryLead: true, leadMaxActiveQueries: 1 } });
    const create = vi.fn(async () => {});
    const db = fakeDb({
      agents: {
        getById: vi.fn(async () => worker),
        getByName: vi.fn(async () => lead),
        list: vi.fn(async () => [lead, worker]),
      },
      tasks: {
        list: vi.fn(async ({ status }: { status?: string } = {}) => {
          if (status === 'doing') return [];
          if (status === 'todo') return [recentlyHeld];
          return [];
        }),
        getByUuidPrefix: vi.fn(async (prefix: string) => prefix === 'ba5eba11' ? [recentlyHeld] : []),
        getByNameForTeam: vi.fn(async () => recentlyHeld),
        claim: vi.fn(async () => true),
        updateFields: vi.fn(async () => {}),
        create,
      },
      adapter: {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("topic = 'task:triaged'")) {
            return { rows: [{ seq: 1, data: '{"reason":"lead_delegation_required"}' }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-assign-unowned-lead-delegation-cooldown-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const result = await manager.executeRemoteCommand('/task assign-unowned --task #ba5eba11 --limit 4 --min-age-min 1', TEAM_ID, 'default');

    expect(result).toMatchObject({
      ok: true,
      result: {
        assignedCount: 0,
        skippedCount: 1,
        items: [
          {
            team: 'default',
            task: '#ba5eba11',
            status: 'skipped',
            reason: 'recent_lead_delegation_triage',
          },
        ],
      },
    });
    expect(db.tasks.claim).not.toHaveBeenCalled();
    expect(manager.sendSupervisionAsk).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects owner-targeted task creation when that owner has stalled work', async () => {
    const create = vi.fn(async () => {});
    const db = fakeDb({
      tasks: {
        create,
        getByNameForTeam: vi.fn(async () => null),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-owner-create-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const result = await manager.executeRemoteCommand(
      '/task create "Follow-on work" --owner worker --goal goal_stalled_owner_guard --expected-output "A concise result." --acceptance "The stalled blocker is cleared first." --validation-path "coder,researcher" --out-of-scope "New backlog fanout." --backlog-policy "Do not create duplicate backlog." --relevance "high - keeps Bittrees task dispatch moving."',
      TEAM_ID,
      'default',
    );

    expect(result).toMatchObject({
      ok: false,
      error: 'stalled_task_backlog',
      result: {
        message: expect.stringContaining('New work for this owner is held'),
        blocking_tasks: ['#12345678'],
        triage: { status: 'sent_owner', taskRef: '#12345678', actor: 'worker' },
      },
    });
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'default',
      'worker',
      expect.stringContaining('New task assignment to you is held'),
    );
    expect(create).not.toHaveBeenCalled();
    expect(db.tasks.claim).not.toHaveBeenCalled();
  });

  it('keeps explicit lead-coordination task creation owned by the team lead despite delegation backlog', async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const lead = agent({
      id: 'engineering-lead-1',
      name: 'engineering-lead',
      metadata: { role: 'team lead' },
      last_seen: NOW_MS,
    });
    const worker = agent({ id: 'architect-1', name: 'architect', last_seen: NOW_MS });
    const existingLeadParent = task({
      id: 'existing-lead-parent',
      name: 'existing-lead-parent',
      uuid: '11111111-2222-4333-8444-555555555555',
      team_id: TEAM_ID,
      title: 'Existing lead parent',
      status: 'doing',
      owner: lead.id,
      created_at: nowSec - 20 * 60,
      updated_at: nowSec - 20 * 60,
    });
    let createdTask: TaskRow | null = null;
    const create = vi.fn(async (row: TaskRow) => {
      createdTask = row;
    });
    const db = fakeDb({
      teams: {
        getTeam: vi.fn(async () => team({ name: 'engineering-team' })),
        getTeamByName: vi.fn(async (name: string) => name === 'engineering-team' ? team({ name }) : null),
      },
      agents: {
        getById: vi.fn(async (id: string) => id === lead.id ? lead : worker),
        getByName: vi.fn(async (name: string) => name === lead.name ? lead : name === worker.name ? worker : null),
        resolve: vi.fn(async (_teamId: string, ref: string) => {
          if (ref === lead.name) return [lead];
          if (ref === worker.name) return [worker];
          return [];
        }),
        list: vi.fn(async () => [lead, worker]),
      },
      tasks: {
        list: vi.fn(async ({ status, owner }: { status?: string; owner?: string } = {}) => {
          if (status === 'doing' && owner === lead.id) return [existingLeadParent];
          if (status === 'doing') return [existingLeadParent];
          return [];
        }),
        getByNameForTeam: vi.fn(async (name: string) => {
          if (name === existingLeadParent.name) return existingLeadParent;
          if (createdTask && name === createdTask.name) return createdTask;
          return null;
        }),
        getByUuidPrefix: vi.fn(async () => []),
        create,
        claim: vi.fn(async () => true),
        updateFields: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-lead-coordination-create-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);
    manager.wakeAssignedTaskOwner = vi.fn(async () => ({ status: 'started' }));

    const result = await manager.executeRemoteCommand(
      '/task create "Coordinate goal fanout" --owner engineering-lead --lead-coordination --goal goal_autopilot_fanout --expected-output "Lead creates child tasks and reports refs." --acceptance "Child task refs are cited." --validation-path "coder,researcher" --out-of-scope "Direct lead execution." --backlog-policy "Optional follow-ups stay backlog." --relevance "medium - improves managed-agent throughput."',
      TEAM_ID,
      'engineering-team',
    );

    expect(result).toMatchObject({ ok: true });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Coordinate goal fanout',
        status: 'doing',
        owner: lead.id,
      }),
      undefined,
    );
    expect(result.result.task.ownerName).toBe('engineering-lead');
    expect(result.result.warning).toBeUndefined();
    expect(manager.wakeAssignedTaskOwner).toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'engineering-team',
      'engineering-lead',
      expect.stringContaining('Lead delegation kickoff'),
    );
  });

  it('does not attach Brain context to control-plane status prompts', async () => {
    const manager = new AgentManagerDb('/tmp/id-agents-brain-context-control-plane-test', fakeDb(), { libraryRoot: null }) as any;

    expect(manager.shouldAttachBrainContext('Control ping after manager restart: reply OK only.')).toBe(false);
    expect(manager.shouldAttachBrainContext('reply with OK')).toBe(false);
    expect(manager.shouldAttachBrainContext('respond with OK only')).toBe(false);
    expect(manager.shouldAttachBrainContext('Backlog guard: task #12345678 is stalled.')).toBe(false);
    expect(manager.shouldAttachBrainContext('TASK DELEGATION from manager: You are assigned task #12345678.')).toBe(false);
    expect(manager.shouldAttachBrainContext('Backlog guard alert: task #12345678 is stalled.')).toBe(false);
    expect(manager.shouldAttachBrainContext('Urgent: task #12345678 has been stalled 88+ minutes on ops-team with no progress.')).toBe(false);
    expect(manager.shouldAttachBrainContext('Status check on task #12345678. Reply in one sentence.')).toBe(false);
    expect(manager.shouldAttachBrainContext('Lead delegation kickoff: task #12345678 is assigned to you as the team coordinator.')).toBe(false);
    expect(manager.shouldAttachBrainContext('Team objective: Decompose this objective into member-owned work.')).toBe(false);
    expect(manager.shouldAttachBrainContext('You are the team lead. Break the objective below into a small set of concrete, independently-actionable sub-tasks.')).toBe(false);
    expect(manager.shouldAttachBrainContext('IDACC Learn routed this material to the default team lead for digestion.')).toBe(true);
    expect(manager.shouldAttachBrainContext('You have 2 stalled doing tasks from before a team outage that need to be closed.')).toBe(false);
    expect(manager.shouldAttachBrainContext('Assignment sweep complete (Jul 4). Assigned: 0.')).toBe(false);
    expect(manager.shouldAttachBrainContext('Task assignment sweep: inspect unassigned todo tasks across all teams.')).toBe(false);
    expect(manager.shouldAttachBrainContext('No approved recommendation routed. The completed result was REVISE.')).toBe(false);
    expect(manager.shouldAttachBrainContext('Already handled. Task #12345678 is done with no active delegation.')).toBe(false);
    expect(manager.shouldAttachBrainContext('Please close your task confirm-release-asset-v0-1-584 (#02de8605) now - it is blocking parent #72a19716.')).toBe(false);
    expect(manager.shouldAttachBrainContext('Please mark your task confirm-release-asset-v0-1-584 (#02de8605) done with the confirmation text.')).toBe(false);
    expect(manager.shouldAttachBrainContext('Please validate output/legal-routing-policy-8da84377.md against task #8da84377.')).toBe(false);
    expect(manager.shouldAttachBrainContext('Validation request for run-baseline-cycle (#784ff464), goal goal_mr4khc5x_lf68y. Read the artifact and reply PASS or FAIL.')).toBe(false);
    expect(manager.shouldAttachBrainContext('AUTO-RELEASE shipped v0.1.585. Please verify the asset and self-update smoke.')).toBe(false);
    expect(manager.shouldAttachBrainContext('Resume and complete task #12345678: inventory MCP servers.')).toBe(true);
    expect(manager.shouldAttachBrainContext('Please inspect the repository and run the integration tests.')).toBe(true);
    expect(manager.shouldAttachBrainContext('TASK DELEGATION from manager: You are assigned task #be3463dd ("Audit SkillMesh plugin/skill gaps").')).toBe(true);
    expect(manager.shouldAttachBrainContext('Team objective: Decompose this submission intake and contribution review workflow into member-owned work.')).toBe(true);
    expect(manager.shouldAttachBrainContext('Lead delegation kickoff: task #654690fd is assigned to you as the team coordinator. Inspect Brain connectivity and skill optimization.')).toBe(true);
    expect(manager.shouldAttachBrainContext('You are the team lead. Break the objective below into knowledge graph and skills-catalog follow-up tasks.')).toBe(true);
  });

  it('expires duplicate active control-plane relay prompts after restart', async () => {
    const rows = [
      {
        team_id: TEAM_ID,
        agent_id: 'lead-1',
        query_id: 'no-route-old',
        status: 'pending',
        prompt: 'No approved recommendation routed. This is the same #edad4eb3 Deepsec task-focus loop. The completed result was APPROVE.',
        created: NOW_MS - 20_000,
        completed: null,
        result: null,
        error: null,
        session_id: null,
        owner_kind: 'agent',
        owner_id: 'lead-1',
        metadata: null,
      },
      {
        team_id: TEAM_ID,
        agent_id: 'lead-1',
        query_id: 'no-route-new',
        status: 'pending',
        prompt: 'No approved recommendation routed. For #edad4eb3, the completed Deepsec task-focus result was APPROVE CLOSURE.',
        created: NOW_MS - 10_000,
        completed: null,
        result: null,
        error: null,
        session_id: null,
        owner_kind: 'agent',
        owner_id: 'lead-1',
        metadata: null,
      },
      {
        team_id: TEAM_ID,
        agent_id: 'lead-1',
        query_id: 'handled-old',
        status: 'pending',
        prompt: 'Already handled. Task #abc12345 is done with no active delegation.',
        created: NOW_MS - 20_000,
        completed: null,
        result: null,
        error: null,
        session_id: null,
        owner_kind: 'agent',
        owner_id: 'lead-1',
        metadata: null,
      },
      {
        team_id: TEAM_ID,
        agent_id: 'lead-1',
        query_id: 'handled-new',
        status: 'pending',
        prompt: 'Already handled. Task #abc12345 is done with no active delegation path.',
        created: NOW_MS - 10_000,
        completed: null,
        result: null,
        error: null,
        session_id: null,
        owner_kind: 'agent',
        owner_id: 'lead-1',
        metadata: null,
      },
    ];
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/FROM queries\s+WHERE status IN \('pending', 'processing'\)/.test(sql)) {
        return { rows, rowCount: rows.length };
      }
      if (/FROM queries\s+WHERE status = 'completed'/.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      if (/UPDATE queries/.test(sql)) {
        const ids = params.slice(1).map(String);
        const expired = rows.filter((row) => ids.includes(row.query_id)).map((row) => ({
          ...row,
          status: 'expired',
          completed: params[0],
        }));
        return { rows: expired, rowCount: expired.length };
      }
      return { rows: [], rowCount: 0 };
    });
    const manager = new AgentManagerDb('/tmp/id-agents-control-relay-dedupe-test', fakeDb({
      adapter: { query },
    }), { libraryRoot: null }) as any;

    const expired = await manager.expireDuplicateActiveTaskAsks(NOW_MS);

    expect(expired.map((row: { query_id: string }) => row.query_id).sort()).toEqual([
      'handled-new',
      'no-route-new',
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("LOWER(prompt) LIKE 'no approved recommendation routed%'"),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("LOWER(prompt) LIKE 'already handled. task%'"),
    );
  });

  it('cancels active query rows before rebuilding an agent process', async () => {
    const db = fakeDb({
      queries: {
        cancel: vi.fn(async () => ['query-1']),
      },
      news: {
        add: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-rebuild-cancel-test', db, { libraryRoot: null }) as any;
    manager.killAgentProcess = vi.fn(async () => ({ killed: true }));
    manager.spawnLocalAgentProcess = vi.fn(async () => ({ success: true, pid: 123, logFile: '/tmp/agent.log' }));

    const result = await manager.rebuildLocalClaudeAgent(TEAM_ID, 'default', agent());

    expect(result).toMatchObject({ success: true, pid: 123 });
    expect(db.queries.cancel).toHaveBeenCalledWith('agent-1', NOW_MS);
    expect(db.news.add).toHaveBeenCalledWith(
      TEAM_ID,
      'agent-1',
      expect.objectContaining({
        type: 'query.cancelled',
        query_id: 'query-1',
      }),
    );
    expect(db.queries.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      manager.killAgentProcess.mock.invocationCallOrder[0],
    );
  });

  it('starts the stalled-task probe reads in parallel before sending a nudge', async () => {
    let releaseEvent!: () => void;
    let releasePending!: () => void;
    let eventStarted = false;
    let pendingStarted = false;
    const eventGate = new Promise<void>((resolve) => { releaseEvent = resolve; });
    const pendingGate = new Promise<void>((resolve) => { releasePending = resolve; });
    const db = fakeDb({
      adapter: {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('FROM event_log')) {
            eventStarted = true;
            await eventGate;
            return { rows: [], rowCount: 0 };
          }
          return { rows: [], rowCount: 0 };
        }),
      },
      queries: {
        getPending: vi.fn(async () => {
          pendingStarted = true;
          await pendingGate;
          return [];
        }),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const sweep = manager.sweepStalledTasks();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(eventStarted).toBe(true);
    expect(pendingStarted).toBe(true);

    releaseEvent();
    releasePending();
    await sweep;

    expect(manager.sendSupervisionAsk).toHaveBeenCalledTimes(1);
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'default',
      'worker',
      expect.stringContaining('probe 1/3'),
    );
  });

  it('does not repeat owner refresh after restart when a recent supervision event exists', async () => {
    const db = fakeDb({
      adapter: {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('FROM event_log')) {
            return { rows: [{ seq: 42, occurred_at: NOW_MS - 2 * 60 * 1000 }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(manager.sendSupervisionAsk).not.toHaveBeenCalled();
    expect(db.events.insert).not.toHaveBeenCalled();
    expect(db.adapter.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM event_log'),
      [TEAM_ID, '12345678-1234-1234-1234-123456789abc', NOW_MS - 90 * 60 * 1000],
    );
  });

  it('does not let an older event-only supervision record mask an expired probe after restart', async () => {
    const db = fakeDb({
      adapter: {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('FROM event_log')) {
            return { rows: [{ seq: 42, occurred_at: NOW_MS - 10 * 60 * 1000 }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      },
      queries: {
        getPending: vi.fn(async () => []),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-old-event-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(manager.sendSupervisionAsk).toHaveBeenCalledTimes(1);
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'default',
      'worker',
      expect.stringContaining('probe 1/3'),
    );
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:refreshed',
      actor_agent_id: 'agent-1',
      data: expect.objectContaining({
        reason: 'owner_refresh',
      }),
    }));
  });

  it('does not consume a stalled-probe attempt when supervision dispatch is rejected', async () => {
    const db = fakeDb();
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await manager.sweepStalledTasks();

    expect(manager.sendSupervisionAsk).toHaveBeenCalledTimes(1);
    expect(db.events.insert).not.toHaveBeenCalled();

    await manager.sweepStalledTasks();

    expect(manager.sendSupervisionAsk).toHaveBeenCalledTimes(2);
    expect(manager.sendSupervisionAsk).toHaveBeenNthCalledWith(
      2,
      'default',
      'worker',
      expect.stringContaining('probe 1/3'),
    );
    expect(db.events.insert).toHaveBeenCalledTimes(1);
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      team_id: TEAM_ID,
      topic: 'task:refreshed',
      actor_agent_id: 'agent-1',
      data: expect.objectContaining({
        reason: 'owner_refresh',
        stalled_minutes: 60,
      }),
    }));
  });

  it('does not send automated owner refresh while the recipient already has active work', async () => {
    const db = fakeDb({
      queries: {
        getPending: vi.fn(async () => [{
          team_id: TEAM_ID,
          agent_id: 'agent-1',
          query_id: 'active-unrelated-work',
          status: 'processing',
          prompt: 'Heartbeat: review your checklist and act on anything that needs attention.',
          created: NOW_MS - 60_000,
          completed: null,
          result: null,
          error: null,
          session_id: null,
          owner_kind: 'agent',
          owner_id: 'agent-1',
          metadata: null,
        }]),
        getPendingByOwner: vi.fn(async () => []),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(manager.sendSupervisionAsk).not.toHaveBeenCalled();
    expect(db.events.insert).not.toHaveBeenCalled();
  });

  it('does not auto-assign queued work to an owner with stale active work', async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const staleOwner = agent({ id: 'agent-1', name: 'aaa-stalled' });
    const freshOwner = agent({ id: 'agent-2', name: 'zzz-fresh', port: 4211 });
    const staleActive = task({
      id: 'stale-active',
      name: 'stale-active',
      uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      owner: staleOwner.id,
      updated_at: nowSec - 3600,
    });
    const queued = task({
      id: 'queued-task',
      name: 'queued-task',
      uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      title: 'Queued task',
      description: 'Expected output: produce the bounded routing checklist and cite blockers.',
      status: 'todo',
      owner: null,
      updated_at: nowSec - 900,
    });
    const db = fakeDb({
      agents: {
        list: vi.fn(async () => [staleOwner, freshOwner]),
        getById: vi.fn(async (id: string) => id === staleOwner.id ? staleOwner : id === freshOwner.id ? freshOwner : null),
      },
      tasks: {
        list: vi.fn(async ({ status, owner }: { status?: string; owner?: string } = {}) => {
          if (status === 'doing' && owner === staleOwner.id) return [staleActive];
          if (status === 'doing' && owner === freshOwner.id) return [];
          if (status === 'doing') return [staleActive];
          return [];
        }),
        getByNameForTeam: vi.fn(async () => queued),
        claim: vi.fn(async () => true),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-autoassign-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const result = await manager.assignUnownedTodoTask(queued, team(), NOW_MS);

    expect(result).toMatchObject({ assigned: true, owner: expect.objectContaining({ id: freshOwner.id }) });
    expect(db.tasks.claim).toHaveBeenCalledWith('queued-task', freshOwner.id, nowSec, { maxDoingForTeam: expect.any(Number) });
    expect(db.tasks.claim).not.toHaveBeenCalledWith('queued-task', staleOwner.id, expect.any(Number), expect.any(Object));
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'default',
      'zzz-fresh',
      expect.stringContaining('TASK DELEGATION from manager'),
    );
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'default',
      'zzz-fresh',
      expect.stringContaining('Task details:\nExpected output: produce the bounded routing checklist and cite blockers.'),
    );
  });

  it('does not auto-assign queued work to an owner that already has fresh active work', async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const busyOwner = agent({ id: 'agent-1', name: 'busy-worker' });
    const busyActive = task({
      id: 'busy-active',
      name: 'busy-active',
      uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      owner: busyOwner.id,
      updated_at: nowSec - 60,
    });
    const queued = task({
      id: 'queued-task',
      name: 'queued-task',
      uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      title: 'Queued task',
      status: 'todo',
      owner: null,
      updated_at: nowSec - 900,
    });
    const db = fakeDb({
      agents: {
        list: vi.fn(async () => [busyOwner]),
        getById: vi.fn(async (id: string) => id === busyOwner.id ? busyOwner : null),
      },
      tasks: {
        list: vi.fn(async ({ status, owner }: { status?: string; owner?: string } = {}) => {
          if (status === 'doing' && (!owner || owner === busyOwner.id)) return [busyActive];
          return [];
        }),
        getByNameForTeam: vi.fn(async () => queued),
        claim: vi.fn(async () => true),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-open-owner-autoassign-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const result = await manager.assignUnownedTodoTask(queued, team(), NOW_MS);

    expect(result).toMatchObject({ assigned: false, reason: 'no_idle_live_member' });
    expect(db.tasks.claim).not.toHaveBeenCalled();
    expect(manager.sendSupervisionAsk).not.toHaveBeenCalledWith(
      'default',
      'busy-worker',
      expect.stringContaining('TASK DELEGATION from manager'),
    );
  });

  it('does not auto-assign executor work to protected task-manager agents', async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const taskMaster = agent({ id: 'task-master-1', name: 'task-master' });
    const queued = task({
      id: 'queued-task',
      name: 'queued-task',
      uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      title: 'Queued task',
      status: 'todo',
      owner: null,
      updated_at: nowSec - 900,
    });
    const db = fakeDb({
      agents: {
        list: vi.fn(async () => [taskMaster]),
        getById: vi.fn(async (id: string) => id === taskMaster.id ? taskMaster : null),
      },
      tasks: {
        list: vi.fn(async () => []),
        getByNameForTeam: vi.fn(async () => queued),
        claim: vi.fn(async () => true),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-protected-autoassign-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const result = await manager.assignUnownedTodoTask(queued, team(), NOW_MS);

    expect(result).toMatchObject({ assigned: false, reason: 'no_idle_live_member' });
    expect(db.tasks.claim).not.toHaveBeenCalled();
    expect(manager.sendSupervisionAsk).not.toHaveBeenCalled();
  });

  it('auto-assigns queued default work to idle parking protected executor agents', async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const coder = agent({ id: 'agent-coder', name: 'coder' });
    const researcher = agent({ id: 'agent-researcher', name: 'researcher' });
    const queued = task({
      id: 'queued-task',
      name: 'queued-task',
      uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      title: 'Queued task',
      description: 'Expected output: implement the requested change and report verification.',
      status: 'todo',
      owner: null,
      updated_at: nowSec - 900,
    });
    const db = fakeDb({
      agents: {
        list: vi.fn(async () => [coder, researcher]),
        getById: vi.fn(async (id: string) => id === coder.id ? coder : id === researcher.id ? researcher : null),
      },
      tasks: {
        list: vi.fn(async () => []),
        getByNameForTeam: vi.fn(async () => queued),
        claim: vi.fn(async () => true),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-default-executor-autoassign-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const result = await manager.assignUnownedTodoTask(queued, team({ name: 'default' }), NOW_MS);

    expect(result).toMatchObject({ assigned: true, owner: expect.objectContaining({ id: coder.id }) });
    expect(db.tasks.claim).toHaveBeenCalledWith('queued-task', coder.id, nowSec, { maxDoingForTeam: expect.any(Number) });
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'default',
      'coder',
      expect.stringContaining('TASK DELEGATION from manager'),
    );
  });

  it('wakes a stopped local teammate before auto-assigning stale unowned work', async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const stoppedWorker = agent({
      id: 'agent-stopped-worker',
      name: 'stopped-worker',
      status: 'stopped',
      port: 4217,
      type: 'claude',
      runtime: 'claude-code-cli',
    });
    const queued = task({
      id: 'queued-task',
      name: 'queued-task',
      uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      title: 'Queued task',
      description: 'Expected output: produce the bounded routing checklist and cite blockers.',
      status: 'todo',
      owner: null,
      updated_at: nowSec - 900,
    });
    const db = fakeDb({
      agents: {
        list: vi.fn(async () => [stoppedWorker]),
        getById: vi.fn(async (id: string) => id === stoppedWorker.id ? stoppedWorker : null),
        updateStatus: vi.fn(async () => {}),
      },
      tasks: {
        list: vi.fn(async () => []),
        getByNameForTeam: vi.fn(async () => queued),
        claim: vi.fn(async () => true),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-wake-autoassign-test', db, { libraryRoot: null }) as any;
    manager.spawnLocalAgentProcess = vi.fn(async () => ({ success: true, pid: 22222, logFile: '/tmp/stopped-worker.log' }));
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const result = await manager.assignUnownedTodoTask(queued, team(), NOW_MS);

    expect(result).toMatchObject({ assigned: true, owner: expect.objectContaining({ id: stoppedWorker.id }) });
    expect(manager.spawnLocalAgentProcess).toHaveBeenCalledWith(
      TEAM_ID,
      'default',
      expect.objectContaining({
        id: stoppedWorker.id,
        name: 'stopped-worker',
        port: 4217,
      }),
    );
    expect(db.agents.updateStatus).toHaveBeenCalledWith(stoppedWorker.id, 'running');
    expect(db.tasks.claim).toHaveBeenCalledWith('queued-task', stoppedWorker.id, nowSec, { maxDoingForTeam: expect.any(Number) });
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'default',
      'stopped-worker',
      expect.stringContaining('TASK DELEGATION from manager'),
    );
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'agent:started',
      actor_agent_id: stoppedWorker.id,
      data: expect.objectContaining({
        agent: 'stopped-worker',
        task_name: queued.name,
        task_uuid: queued.uuid,
        reason: 'task-assign',
        pid: 22222,
      }),
    }));
  });

  it('holds a live team lead task that missed delegation when task-manager routing is unavailable', async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const lead = agent({
      id: 'lead-1',
      name: 'ops-lead',
      metadata: { catalog: { role: 'lead' } },
    });
    const leadTask = task({
      id: 'lead-task-1',
      name: 'coordinate-release-work',
      uuid: '87654321-4321-4321-8321-123456789abc',
      title: 'Coordinate release work',
      owner: 'lead-1',
      created_by: 'lead-1',
      created_at: nowSec - 11 * 60,
      updated_at: nowSec - 11 * 60,
    });
    const oldChild = task({
      id: 'old-child-1',
      name: 'old-child-work',
      uuid: '99999999-9999-4999-8999-999999999999',
      title: 'Old child work',
      status: 'done',
      owner: 'agent-1',
      created_by: 'lead-1',
      created_at: nowSec - 60 * 60,
      updated_at: nowSec - 60 * 60,
      completed_at: nowSec - 60 * 60,
    });
    const db = fakeDb({
      teams: {
        getTeam: vi.fn(async () => team({ name: 'ops-team' })),
      },
      agents: {
        getById: vi.fn(async (id: string) => id === 'lead-1' ? lead : agent()),
        list: vi.fn(async () => [lead, agent()]),
      },
      tasks: {
        list: vi.fn(async ({ status, teamId }: { status?: string; teamId?: string } = {}) => {
          if (status === 'doing') return [leadTask];
          if (teamId === TEAM_ID) return [leadTask, oldChild];
          return [];
        }),
        updateFields: vi.fn(async () => {}),
      },
      queries: {
        getPending: vi.fn(async () => [activeQuery('lead-1', {
          prompt: 'lead is still working the parent objective',
        })]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(manager.sendSupervisionAsk).not.toHaveBeenCalled();
    expect(db.tasks.updateFields).toHaveBeenCalledWith('lead-task-1', {
      updated_at: Math.floor(NOW_MS / 1000),
    });
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      team_id: TEAM_ID,
      topic: 'task:triaged',
      actor_agent_id: 'lead-1',
      subject_id: '87654321-4321-4321-8321-123456789abc',
      data: expect.objectContaining({
        reason: 'lead_delegation_required',
        stalled_minutes: 11,
      }),
    }));
  });

  it('auto-compacts extra lead-owned delegation parents before they stack as stalled work', async () => {
    const previousLeadMaxParallel = process.env.LEAD_MAX_PARALLEL_OBJECTIVES;
    process.env.LEAD_MAX_PARALLEL_OBJECTIVES = '1';
    const nowSec = Math.floor(NOW_MS / 1000);
    const lead = agent({
      id: 'lead-1',
      name: 'lead',
      metadata: { primaryLead: true },
    });
    const oldParent = task({
      id: 'lead-task-old',
      name: 'old-parent',
      uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      title: 'Old parent',
      owner: lead.id,
      created_by: lead.id,
      created_at: nowSec - 30 * 60,
      updated_at: nowSec - 30 * 60,
    });
    const extraParent = task({
      id: 'lead-task-extra',
      name: 'extra-parent',
      uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      title: 'Extra parent',
      owner: lead.id,
      created_by: lead.id,
      created_at: nowSec - 20 * 60,
      updated_at: nowSec - 20 * 60,
    });
    const updateFields = vi.fn(async () => {});
    const db = fakeDb({
      teams: {
        listTeams: vi.fn(async () => [team()]),
      },
      agents: {
        list: vi.fn(async () => [lead]),
        getById: vi.fn(async (id: string) => id === lead.id ? lead : null),
      },
      tasks: {
        list: vi.fn(async ({ status, teamId, owner }: { status?: string; teamId?: string; owner?: string } = {}) => {
          if (status === 'doing' && owner === lead.id) return [oldParent, extraParent];
          if (teamId === TEAM_ID) return [oldParent, extraParent];
          return [];
        }),
        updateFields,
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-lead-backlog-auto-guard-test', db, { libraryRoot: null }) as any;

    try {
      const requeued = await manager.autoCompactLeadDelegationBacklog();

      expect(requeued).toBe(1);
      expect(updateFields).toHaveBeenCalledWith(extraParent.id, expect.objectContaining({
        owner: null,
        status: 'todo',
        completed_at: null,
      }));
      expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
        topic: 'task:triaged',
        subject_id: extraParent.uuid,
        actor_agent_id: lead.id,
        data: expect.objectContaining({
          reason: 'lead_delegation_backlog_requeued',
        }),
      }));
    } finally {
      if (previousLeadMaxParallel === undefined) delete process.env.LEAD_MAX_PARALLEL_OBJECTIVES;
      else process.env.LEAD_MAX_PARALLEL_OBJECTIVES = previousLeadMaxParallel;
    }
  });

  it('routes lead-owned delegation stalls to task-manager when available', async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const researchTeam = team({ name: 'research' });
    const opsTeam = team({ id: 'ops-team-id', name: 'ops-team' });
    const lead = agent({
      id: 'research-lead-1',
      name: 'research-lead',
      metadata: { catalog: { role: 'lead' } },
    });
    const worker = agent({ id: 'researcher-1', name: 'researcher' });
    const taskManager = agent({
      team_id: opsTeam.id,
      id: 'task-manager-id',
      name: 'task-manager',
      metadata: { catalog: { role: 'task-manager' } },
    });
    const leadTask = task({
      id: 'lead-task-1',
      name: 'map-work-lanes',
      uuid: '87654321-4321-4321-8321-123456789abc',
      title: 'Map work lanes',
      owner: lead.id,
      created_by: lead.id,
      created_at: nowSec - 30 * 60,
      updated_at: nowSec - 30 * 60,
    });
    const db = fakeDb({
      teams: {
        getTeam: vi.fn(async () => researchTeam),
        getTeamByName: vi.fn(async (name: string) => name === 'ops-team' ? opsTeam : null),
      },
      agents: {
        getById: vi.fn(async (id: string) => id === lead.id ? lead : null),
        getByName: vi.fn(async (teamId: string, name: string) =>
          teamId === opsTeam.id && name === 'task-master' ? taskManager : null,
        ),
        list: vi.fn(async (teamId: string) => teamId === opsTeam.id ? [taskManager] : [lead, worker]),
      },
      tasks: {
        list: vi.fn(async ({ status, teamId }: { status?: string; teamId?: string } = {}) => {
          if (status === 'doing') return [leadTask];
          if (teamId === TEAM_ID) return [leadTask];
          return [];
        }),
        updateFields: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'ops-team',
      'task-manager',
      expect.stringContaining('task-manager delegation is required'),
    );
    expect(db.tasks.updateFields).toHaveBeenCalledWith('lead-task-1', {
      status: 'todo',
      owner: 'research-lead-1',
      updated_at: nowSec,
    });
    expect(manager.sendSupervisionAsk).not.toHaveBeenCalledWith(
      'research',
      'research-lead',
      expect.any(String),
    );
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      team_id: TEAM_ID,
      topic: 'task:triaged',
      actor_agent_id: 'task-manager-id',
      subject_id: '87654321-4321-4321-8321-123456789abc',
      data: expect.objectContaining({
        reason: 'lead_delegation_required',
        stalled_minutes: 30,
      }),
    }));
  });

  it('treats HR managers and stand-in lead names as delegation-constrained coordinators', async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const owners = [
      {
        teamName: 'legal',
        agent: agent({
          id: 'hr-lead-1',
          name: 'hr-manager',
          metadata: {
            catalog: {
              role: 'HR manager',
              description: 'Coordinate staffing, onboarding, team operations, and task routing with the legal team lead.',
            },
          },
        }),
      },
      {
        teamName: 'technology-security',
        agent: agent({
          id: 'sandbox-lead-1',
          name: 'ctf-sandbox-lead',
          metadata: {
            catalog: {
              role: 'ctf-orchestrator',
              description: 'Coordinates sandbox challenges, assigns specialists, and tracks handoffs.',
            },
          },
        }),
      },
    ];

    for (const [index, ownerCase] of owners.entries()) {
      const leadTask = task({
        id: `task-${ownerCase.agent.id}`,
        name: `coordinate-${ownerCase.agent.name}`,
        uuid: index === 0 ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        title: `Coordinate ${ownerCase.agent.name}`,
        owner: ownerCase.agent.id,
        created_by: ownerCase.agent.id,
        created_at: nowSec - 11 * 60,
        updated_at: nowSec - 11 * 60,
      });
      const db = fakeDb({
        teams: {
          getTeam: vi.fn(async () => team({ name: ownerCase.teamName })),
        },
        agents: {
          getById: vi.fn(async (id: string) => id === ownerCase.agent.id ? ownerCase.agent : agent()),
          list: vi.fn(async () => [ownerCase.agent, agent()]),
        },
        tasks: {
          list: vi.fn(async ({ status, teamId }: { status?: string; teamId?: string } = {}) => {
            if (status === 'doing') return [leadTask];
            if (teamId === TEAM_ID) return [leadTask];
            return [];
          }),
          updateFields: vi.fn(async () => {}),
        },
      });
      const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', db, { libraryRoot: null }) as any;
      manager.sendSupervisionAsk = vi.fn(async () => true);

      await manager.sweepStalledTasks();

      expect(manager.sendSupervisionAsk).not.toHaveBeenCalled();
      expect(db.tasks.updateFields).toHaveBeenCalledWith(leadTask.id, {
        updated_at: Math.floor(NOW_MS / 1000),
      });
      expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
        topic: 'task:triaged',
        actor_agent_id: ownerCase.agent.id,
        data: expect.objectContaining({ reason: 'lead_delegation_required' }),
      }));
    }
  });

  it('does not classify every manager-named specialist as a lead', async () => {
    const managerAgent = agent({
      id: 'marketplace-manager-1',
      name: 'marketplace-manager',
      metadata: {
        catalog: {
          role: 'manager',
          description: 'Marketplace health, listings, pricing, demand analysis, and inventory optimization.',
        },
      },
    });
    const managerTask = task({
      owner: managerAgent.id,
      created_by: managerAgent.id,
    });
    const db = fakeDb({
      teams: {
        getTeam: vi.fn(async () => team({ name: 'skillmesh' })),
      },
      agents: {
        getById: vi.fn(async (id: string) => id === managerAgent.id ? managerAgent : agent()),
        list: vi.fn(async () => [managerAgent, agent()]),
      },
      tasks: {
        list: vi.fn(async ({ status }: { status?: string } = {}) => status === 'doing' ? [managerTask] : [managerTask]),
        updateFields: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'skillmesh',
      'marketplace-manager',
      expect.not.stringContaining('has no detected member-owned child tasks'),
    );
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:refreshed',
      actor_agent_id: managerAgent.id,
      data: expect.objectContaining({ reason: 'owner_refresh' }),
    }));
  });

  it('does not classify standalone orchestrators as team leads without lead-like names', async () => {
    const orchestrator = agent({
      id: 'skill-discoverer-1',
      name: 'skill-discoverer',
      metadata: {
        catalog: {
          role: 'orchestrator',
          description: 'Runs catalog audits and reports actions to skillmesh-ops-lead.',
        },
      },
    });
    const orchestratorTask = task({
      owner: orchestrator.id,
      created_by: orchestrator.id,
    });
    const db = fakeDb({
      teams: {
        getTeam: vi.fn(async () => team({ name: 'skillmesh' })),
      },
      agents: {
        getById: vi.fn(async (id: string) => id === orchestrator.id ? orchestrator : agent()),
        list: vi.fn(async () => [orchestrator, agent()]),
      },
      tasks: {
        list: vi.fn(async ({ status }: { status?: string } = {}) => status === 'doing' ? [orchestratorTask] : [orchestratorTask]),
        updateFields: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'skillmesh',
      'skill-discoverer',
      expect.not.stringContaining('has no detected member-owned child tasks'),
    );
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:refreshed',
      actor_agent_id: orchestrator.id,
      data: expect.objectContaining({ reason: 'owner_refresh' }),
    }));
  });

  it('does not stack lead delegation probes while a prior task supervision ask is active', async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const lead = agent({
      id: 'lead-1',
      name: 'ops-lead',
      metadata: { catalog: { role: 'lead' } },
    });
    const leadTask = task({
      id: 'lead-task-1',
      name: 'coordinate-release-work',
      uuid: '87654321-4321-4321-8321-123456789abc',
      title: 'Coordinate release work',
      owner: 'lead-1',
      created_by: 'lead-1',
      created_at: nowSec - 11 * 60,
      updated_at: nowSec - 11 * 60,
    });
    const db = fakeDb({
      teams: {
        getTeam: vi.fn(async () => team({ name: 'ops-team' })),
      },
      agents: {
        getById: vi.fn(async () => lead),
        list: vi.fn(async () => [lead, agent()]),
      },
      tasks: {
        list: vi.fn(async ({ status, teamId }: { status?: string; teamId?: string } = {}) => {
          if (status === 'doing') return [leadTask];
          if (teamId === TEAM_ID) return [leadTask];
          return [];
        }),
        updateFields: vi.fn(async () => {}),
      },
      queries: {
        getPending: vi.fn(async () => [{
          team_id: TEAM_ID,
          agent_id: 'lead-1',
          query_id: 'active-delegation-probe',
          status: 'pending',
          prompt: 'Supervision: team-lead task #87654321 ("Coordinate release work") has no detected member-owned child tasks after 11m (delegation probe 1/3).',
          created: NOW_MS - 60_000,
          completed: null,
          result: null,
          error: null,
          session_id: null,
          owner_kind: 'agent',
          owner_id: 'lead-1',
          metadata: null,
        }]),
        getPendingByOwner: vi.fn(async () => []),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(manager.sendSupervisionAsk).not.toHaveBeenCalled();
    expect(db.events.insert).not.toHaveBeenCalled();
  });

  it('does not stack lead delegation probes behind an active urgent delegation probe', async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const lead = agent({
      id: 'lead-1',
      name: 'engineering-lead',
      metadata: { catalog: { role: 'lead' } },
    });
    const leadTask = task({
      id: 'lead-task-1',
      name: 'idacc-performance-audit',
      uuid: '0776b1f6-4321-4321-8321-123456789abc',
      title: 'IDACC performance audit',
      owner: 'lead-1',
      created_by: 'lead-1',
      created_at: nowSec - 16 * 60,
      updated_at: nowSec - 16 * 60,
    });
    const db = fakeDb({
      teams: {
        getTeam: vi.fn(async () => team({ name: 'engineering-team' })),
      },
      agents: {
        getById: vi.fn(async () => lead),
        list: vi.fn(async () => [lead, agent()]),
      },
      tasks: {
        list: vi.fn(async ({ status, teamId }: { status?: string; teamId?: string } = {}) => {
          if (status === 'doing') return [leadTask];
          if (teamId === TEAM_ID) return [leadTask];
          return [];
        }),
        updateFields: vi.fn(async () => {}),
      },
      queries: {
        getPending: vi.fn(async () => [{
          team_id: TEAM_ID,
          agent_id: 'lead-1',
          query_id: 'active-urgent-delegation-probe',
          status: 'processing',
          prompt: 'URGENT delegation probe: task #0776b1f6 has no child tasks after 15m. Create child tasks NOW.',
          created: NOW_MS - 60_000,
          completed: null,
          result: null,
          error: null,
          session_id: null,
          owner_kind: 'agent',
          owner_id: 'lead-1',
          metadata: null,
        }]),
        getPendingByOwner: vi.fn(async () => []),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(manager.sendSupervisionAsk).not.toHaveBeenCalled();
    expect(db.events.insert).not.toHaveBeenCalled();
  });

  it('does not stack lead delegation probes behind an active manager supervision probe', async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const lead = agent({
      id: 'lead-1',
      name: 'engineering-lead',
      metadata: { catalog: { role: 'lead' } },
    });
    const leadTask = task({
      id: 'lead-task-1',
      name: 'idacc-performance-audit',
      uuid: '0776b1f6-4321-4321-8321-123456789abc',
      title: 'IDACC performance audit',
      owner: 'lead-1',
      created_by: 'lead-1',
      created_at: nowSec - 16 * 60,
      updated_at: nowSec - 16 * 60,
    });
    const db = fakeDb({
      teams: {
        getTeam: vi.fn(async () => team({ name: 'engineering-team' })),
      },
      agents: {
        getById: vi.fn(async () => lead),
        list: vi.fn(async () => [lead, agent()]),
      },
      tasks: {
        list: vi.fn(async ({ status, teamId }: { status?: string; teamId?: string } = {}) => {
          if (status === 'doing') return [leadTask];
          if (teamId === TEAM_ID) return [leadTask];
          return [];
        }),
        updateFields: vi.fn(async () => {}),
      },
      queries: {
        getPending: vi.fn(async () => [{
          team_id: TEAM_ID,
          agent_id: 'lead-1',
          query_id: 'active-manager-supervision-probe',
          status: 'pending',
          prompt: 'Supervision probe from manager: task #0776b1f6 has been in doing status for 12+ minutes with NO member-owned child tasks.',
          created: NOW_MS - 60_000,
          completed: null,
          result: null,
          error: null,
          session_id: null,
          owner_kind: 'agent',
          owner_id: 'lead-1',
          metadata: null,
        }]),
        getPendingByOwner: vi.fn(async () => []),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(manager.sendSupervisionAsk).not.toHaveBeenCalled();
    expect(db.events.insert).not.toHaveBeenCalled();
  });

  it('does not stack lead delegation kickoffs while a prior kickoff ask is active', async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const lead = agent({
      id: 'lead-1',
      name: 'ops-lead',
      metadata: { catalog: { role: 'lead' } },
    });
    const leadTask = task({
      id: 'lead-task-1',
      name: 'coordinate-release-work',
      uuid: '87654321-4321-4321-8321-123456789abc',
      title: 'Coordinate release work',
      owner: 'lead-1',
      created_by: 'lead-1',
      created_at: nowSec - 11 * 60,
      updated_at: nowSec - 11 * 60,
    });
    const db = fakeDb({
      agents: {
        list: vi.fn(async () => [lead, agent()]),
      },
      tasks: {
        list: vi.fn(async ({ teamId }: { teamId?: string } = {}) => teamId === TEAM_ID ? [leadTask] : []),
        updateFields: vi.fn(async () => {}),
      },
      queries: {
        getPending: vi.fn(async () => [{
          team_id: TEAM_ID,
          agent_id: 'lead-1',
          query_id: 'active-kickoff',
          status: 'pending',
          prompt: 'Lead delegation kickoff: task #87654321 ("Coordinate release work") is assigned to you as the team coordinator.',
          created: NOW_MS - 60_000,
          completed: null,
          result: null,
          error: null,
          session_id: null,
          owner_kind: 'agent',
          owner_id: 'lead-1',
          metadata: null,
        }]),
        getPendingByOwner: vi.fn(async () => []),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.promptLeadForDelegationKickoff(TEAM_ID, 'ops-team', leadTask, lead);

    expect(manager.sendSupervisionAsk).not.toHaveBeenCalled();
    expect(db.events.insert).not.toHaveBeenCalled();
  });

  it('does not suppress lead delegation kickoff when the lead has spare query capacity', async () => {
    process.env.ID_AGENT_LEAD_QUERY_CONCURRENCY = '2';
    const nowSec = Math.floor(NOW_MS / 1000);
    const lead = agent({
      id: 'lead-1',
      name: 'research-lead',
      metadata: { catalog: { role: 'lead' } },
    });
    const worker = agent({ id: 'worker-1', name: 'researcher' });
    const leadTask = task({
      id: 'lead-task-1',
      name: 'coordinate-research-work',
      uuid: '87654321-4321-4321-8321-123456789abc',
      title: 'Coordinate research work',
      owner: lead.id,
      created_by: lead.id,
      created_at: nowSec - 11 * 60,
      updated_at: nowSec - 11 * 60,
    });
    const db = fakeDb({
      agents: {
        list: vi.fn(async () => [lead, worker]),
      },
      tasks: {
        list: vi.fn(async ({ teamId }: { teamId?: string } = {}) => teamId === TEAM_ID ? [leadTask] : []),
      },
      queries: {
        getPending: vi.fn(async (agentId: string) => agentId === lead.id
          ? [activeQuery(lead.id, {
              query_id: 'active-operator-plan',
              prompt: 'Create a clear, structured implementation plan for the operator.',
            })]
          : []),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-lead-spare-capacity-kickoff-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.promptLeadForDelegationKickoff(TEAM_ID, 'research', leadTask, lead);

    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'research',
      'research-lead',
      expect.stringContaining('Lead delegation kickoff: task #87654321'),
    );
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'research',
      'research-lead',
      expect.stringContaining('Available teammates: researcher'),
    );
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      team_id: TEAM_ID,
      topic: 'task:triaged',
      actor_agent_id: lead.id,
      subject_id: leadTask.uuid,
      data: expect.objectContaining({
        reason: 'lead_delegation_required',
      }),
    }));
  });

  it('holds lead delegation kickoff when the lead query capacity is full', async () => {
    process.env.ID_AGENT_LEAD_QUERY_CONCURRENCY = '1';
    const nowSec = Math.floor(NOW_MS / 1000);
    const lead = agent({
      id: 'lead-1',
      name: 'research-lead',
      metadata: { catalog: { role: 'lead' } },
    });
    const worker = agent({ id: 'worker-1', name: 'researcher' });
    const leadTask = task({
      id: 'lead-task-1',
      name: 'coordinate-research-work',
      uuid: '87654321-4321-4321-8321-123456789abc',
      title: 'Coordinate research work',
      owner: lead.id,
      created_by: lead.id,
      created_at: nowSec - 11 * 60,
      updated_at: nowSec - 11 * 60,
    });
    const db = fakeDb({
      agents: {
        list: vi.fn(async () => [lead, worker]),
      },
      tasks: {
        list: vi.fn(async ({ teamId }: { teamId?: string } = {}) => teamId === TEAM_ID ? [leadTask] : []),
      },
      queries: {
        getPending: vi.fn(async (agentId: string) => agentId === lead.id
          ? [activeQuery(lead.id, { query_id: 'active-operator-plan', prompt: 'operator plan in progress' })]
          : []),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-lead-full-capacity-kickoff-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.promptLeadForDelegationKickoff(TEAM_ID, 'research', leadTask, lead);

    expect(manager.sendSupervisionAsk).not.toHaveBeenCalled();
    expect(db.events.insert).not.toHaveBeenCalled();
  });

  it('routes lead kickoff to task-manager when no live member capacity exists', async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const researchTeam = team({ name: 'research' });
    const opsTeam = team({ id: 'ops-team-id', name: 'ops-team' });
    const lead = agent({
      id: 'research-lead-1',
      name: 'research-lead',
      metadata: { catalog: { role: 'lead' } },
    });
    const stoppedWorker = agent({
      id: 'researcher-1',
      name: 'researcher',
      status: 'stopped',
      runtime: 'public-agent-remote',
    });
    const taskManager = agent({
      team_id: opsTeam.id,
      id: 'task-manager-id',
      name: 'task-manager',
      metadata: { catalog: { role: 'task-manager' } },
    });
    const leadTask = task({
      id: 'lead-task-1',
      name: 'coordinate-research-work',
      uuid: '87654321-4321-4321-8321-123456789abc',
      title: 'Coordinate research work',
      owner: lead.id,
      created_by: lead.id,
      created_at: nowSec - 11 * 60,
      updated_at: nowSec - 11 * 60,
    });
    const db = fakeDb({
      teams: {
        getTeam: vi.fn(async () => researchTeam),
        getTeamByName: vi.fn(async (name: string) => name === 'ops-team' ? opsTeam : null),
      },
      agents: {
        getByName: vi.fn(async (teamId: string, name: string) =>
          teamId === opsTeam.id && name === 'task-master' ? taskManager : null,
        ),
        list: vi.fn(async (teamId: string) => teamId === opsTeam.id ? [taskManager] : [lead, stoppedWorker]),
      },
      tasks: {
        list: vi.fn(async ({ teamId }: { teamId?: string } = {}) => teamId === TEAM_ID ? [leadTask] : []),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-lead-capacity-kickoff-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.promptLeadForDelegationKickoff(TEAM_ID, 'research', leadTask, lead);

    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'ops-team',
      'task-manager',
      expect.stringContaining('no live non-lead teammate available for delegation'),
    );
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'ops-team',
      'task-manager',
      expect.stringContaining('task-manager capacity triage is required before waking the lead'),
    );
    expect(manager.sendSupervisionAsk).not.toHaveBeenCalledWith(
      'research',
      'research-lead',
      expect.any(String),
    );
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      team_id: TEAM_ID,
      topic: 'task:triaged',
      actor_agent_id: taskManager.id,
      subject_id: '87654321-4321-4321-8321-123456789abc',
      data: expect.objectContaining({
        reason: 'lead_delegation_required',
        stalled_minutes: 11,
      }),
    }));
  });

  it('wakes one stopped teammate before asking a lead to delegate', async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const researchTeam = team({ name: 'research' });
    const lead = agent({
      id: 'research-lead-1',
      name: 'research-lead',
      metadata: { catalog: { role: 'lead' } },
    });
    const stoppedWorker = agent({
      id: 'researcher-1',
      name: 'researcher',
      status: 'stopped',
      port: 4218,
      runtime: 'codex',
      endpoint: 'http://127.0.0.1:4218',
    });
    const leadTask = task({
      id: 'lead-task-1',
      name: 'coordinate-research-work',
      uuid: '87654321-4321-4321-8321-123456789abc',
      title: 'Coordinate research work',
      owner: lead.id,
      created_by: lead.id,
      created_at: nowSec - 11 * 60,
      updated_at: nowSec - 11 * 60,
    });
    const db = fakeDb({
      teams: {
        getTeam: vi.fn(async () => researchTeam),
      },
      agents: {
        list: vi.fn(async () => [lead, stoppedWorker]),
        updateStatus: vi.fn(async () => {}),
      },
      tasks: {
        list: vi.fn(async ({ teamId }: { teamId?: string } = {}) => teamId === TEAM_ID ? [leadTask] : []),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-lead-capacity-wake-test', db, { libraryRoot: null }) as any;
    manager.spawnLocalAgentProcess = vi.fn(async () => ({ success: true, pid: 1234, logFile: '/tmp/researcher.log' }));
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.promptLeadForDelegationKickoff(TEAM_ID, 'research', leadTask, lead);

    expect(manager.spawnLocalAgentProcess).toHaveBeenCalledWith(TEAM_ID, 'research', expect.objectContaining({
      id: stoppedWorker.id,
      name: stoppedWorker.name,
      port: stoppedWorker.port,
    }));
    expect(db.agents.updateStatus).toHaveBeenCalledWith(stoppedWorker.id, 'running');
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'research',
      'research-lead',
      expect.stringContaining('Available teammates: researcher.'),
    );
    expect(manager.sendSupervisionAsk).not.toHaveBeenCalledWith(
      'ops-team',
      expect.any(String),
      expect.any(String),
    );
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      team_id: TEAM_ID,
      topic: 'agent:started',
      actor_agent_id: stoppedWorker.id,
      data: expect.objectContaining({
        reason: 'lead-delegation-capacity',
        task_name: leadTask.name,
      }),
    }));
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      team_id: TEAM_ID,
      topic: 'task:triaged',
      actor_agent_id: lead.id,
      subject_id: leadTask.uuid,
      data: expect.objectContaining({
        reason: 'lead_delegation_required',
      }),
    }));
  });

  it('triages a stalled task to the lead when the owner is unavailable', async () => {
    const unavailableOwner = agent({ status: 'stopped' });
    const lead = agent({ id: 'lead-1', name: 'lead', metadata: { primaryLead: true } });
    const db = fakeDb({
      agents: {
        getById: vi.fn(async () => unavailableOwner),
        getByName: vi.fn(async () => lead),
        list: vi.fn(async () => [unavailableOwner, lead]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'default',
      'lead',
      expect.stringContaining('triage probe 1/3'),
    );
    expect(db.tasks.updateFields).toHaveBeenCalledWith('task-1', {
      updated_at: Math.floor(NOW_MS / 1000),
    });
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      team_id: TEAM_ID,
      topic: 'task:triaged',
      actor_agent_id: 'lead-1',
      data: expect.objectContaining({
        owner: 'agent-1',
        reason: 'owner_unavailable',
        stalled_minutes: 60,
      }),
    }));
  });

  it('routes stalled-owner triage to task-master when the team lead is offline', async () => {
    const unavailableOwner = agent({ status: 'stopped' });
    const liveNonLead = agent({ id: 'risk-id', name: 'risk-analyst', port: 4211, status: 'running' });
    const opsTeam = team({ id: 'ops-team-id', name: 'ops-team' });
    const taskMaster = agent({
      id: 'task-master-id',
      team_id: opsTeam.id,
      name: 'task-master',
      status: 'running',
    });
    const db = fakeDb({
      teams: {
        getTeamByName: vi.fn(async (name: string) => name === 'ops-team' ? opsTeam : null),
      },
      agents: {
        getById: vi.fn(async (id: string) => id === unavailableOwner.id ? unavailableOwner : null),
        getByName: vi.fn(async (teamId: string, name: string) =>
          teamId === opsTeam.id && name === 'task-master' ? taskMaster : null,
        ),
        list: vi.fn(async (teamId: string) => teamId === opsTeam.id ? [taskMaster] : [unavailableOwner, liveNonLead]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-task-master-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const guard = await manager.stalledOwnerBacklogGuard({
      teamId: TEAM_ID,
      teamName: 'default',
      owner: unavailableOwner,
    });

    expect(guard?.triage).toMatchObject({
      status: 'sent_task_manager',
      taskRef: '#12345678',
      actor: 'task-master',
      actorTeam: 'ops-team',
    });
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'ops-team',
      'task-master',
      expect.stringContaining('there is no live team lead'),
    );
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      team_id: TEAM_ID,
      topic: 'task:triaged',
      actor_agent_id: 'task-master-id',
      data: expect.objectContaining({
        reason: 'owner_unavailable',
        stalled_minutes: 60,
      }),
    }));
  });

  it('does not fan out task-manager fallback prompts while the task-manager lane is cooling down', async () => {
    const unavailableOwner = agent({ status: 'stopped' });
    const opsTeam = team({ id: 'ops-team-id', name: 'ops-team' });
    const taskMaster = agent({
      id: 'task-master-id',
      team_id: opsTeam.id,
      name: 'task-master',
      status: 'running',
    });
    const recentFailedFallback = {
      team_id: opsTeam.id,
      agent_id: taskMaster.id,
      query_id: 'recent-task-manager-fallback',
      status: 'failed',
      prompt: 'Backlog guard: legal task #484f50b2 ("Inventory legal skills") has been active 17m, team lead general-counsel owns a parent objective without member-owned child tasks.',
      created: NOW_MS - 60_000,
      completed: NOW_MS - 10_000,
      result: null,
      error: 'Query recent-task-manager-fallback exceeded control-plane timeout after 90s',
      session_id: null,
      owner_kind: 'agent',
      owner_id: taskMaster.id,
      metadata: null,
    };
    const db = fakeDb({
      teams: {
        getTeamByName: vi.fn(async (name: string) => name === 'ops-team' ? opsTeam : null),
      },
      agents: {
        getById: vi.fn(async (id: string) => id === unavailableOwner.id ? unavailableOwner : null),
        getByName: vi.fn(async (teamId: string, name: string) =>
          teamId === opsTeam.id && name === 'task-master' ? taskMaster : null,
        ),
        list: vi.fn(async (teamId: string) => teamId === opsTeam.id ? [taskMaster] : [unavailableOwner]),
      },
      adapter: {
        query: vi.fn(async () => ({ rows: [recentFailedFallback], rowCount: 1 })),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-task-manager-fallback-cooldown-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const guard = await manager.stalledOwnerBacklogGuard({
      teamId: TEAM_ID,
      teamName: 'default',
      owner: unavailableOwner,
    });

    expect(guard?.triage).toMatchObject({
      status: 'task_manager_recent_backlog_probe',
      taskRef: '#12345678',
      actor: 'task-master',
      actorTeam: 'ops-team',
    });
    expect(manager.sendSupervisionAsk).not.toHaveBeenCalled();
    expect(db.events.insert).not.toHaveBeenCalled();
  });

  it('does not fan out task-manager triage delegations after a restart', async () => {
    const unavailableOwner = agent({ status: 'stopped' });
    const opsTeam = team({ id: 'ops-team-id', name: 'ops-team' });
    const taskMaster = agent({
      id: 'task-master-id',
      team_id: opsTeam.id,
      name: 'task-master',
      status: 'running',
    });
    const recentTriageDelegation = {
      team_id: opsTeam.id,
      agent_id: taskMaster.id,
      query_id: 'recent-task-manager-triage',
      status: 'processing',
      prompt: 'TASK DELEGATION from manager: You are assigned task-manager triage for legal task #484f50b2 ("Inventory legal skills"). Use the manager task flow to reassign or park it.',
      created: NOW_MS - 60_000,
      completed: null,
      result: null,
      error: null,
      session_id: null,
      owner_kind: 'agent',
      owner_id: taskMaster.id,
      metadata: null,
    };
    const db = fakeDb({
      teams: {
        getTeamByName: vi.fn(async (name: string) => name === 'ops-team' ? opsTeam : null),
      },
      agents: {
        getById: vi.fn(async (id: string) => id === unavailableOwner.id ? unavailableOwner : null),
        getByName: vi.fn(async (teamId: string, name: string) =>
          teamId === opsTeam.id && name === 'task-master' ? taskMaster : null,
        ),
        list: vi.fn(async (teamId: string) => teamId === opsTeam.id ? [taskMaster] : [unavailableOwner]),
      },
      adapter: {
        query: vi.fn(async () => ({ rows: [recentTriageDelegation], rowCount: 1 })),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-task-manager-triage-cooldown-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const guard = await manager.stalledOwnerBacklogGuard({
      teamId: TEAM_ID,
      teamName: 'default',
      owner: unavailableOwner,
    });

    expect(guard?.triage).toMatchObject({
      status: 'task_manager_recent_backlog_probe',
      taskRef: '#12345678',
      actor: 'task-master',
      actorTeam: 'ops-team',
    });
    expect(manager.sendSupervisionAsk).not.toHaveBeenCalled();
    expect(db.events.insert).not.toHaveBeenCalled();
  });

  it('uses recently completed task-manager triage as restart-persistent lane cooldown', async () => {
    const unavailableOwner = agent({ status: 'stopped' });
    const opsTeam = team({ id: 'ops-team-id', name: 'ops-team' });
    const taskMaster = agent({
      id: 'task-master-id',
      team_id: opsTeam.id,
      name: 'task-master',
      status: 'running',
    });
    const recentCompletedTriage = {
      team_id: opsTeam.id,
      agent_id: taskMaster.id,
      query_id: 'recent-completed-task-manager-triage',
      status: 'completed',
      prompt: 'TASK DELEGATION from manager: You are assigned task-manager triage for legal task #484f50b2 ("Inventory legal skills"). Use the manager task flow to reassign or park it.',
      created: NOW_MS - 90_000,
      completed: NOW_MS - 30_000,
      result: { result: 'PARK: waiting on legal owner decision.' },
      error: null,
      session_id: null,
      owner_kind: 'agent',
      owner_id: taskMaster.id,
      metadata: null,
    };
    const db = fakeDb({
      teams: {
        getTeamByName: vi.fn(async (name: string) => name === 'ops-team' ? opsTeam : null),
      },
      agents: {
        getById: vi.fn(async (id: string) => id === unavailableOwner.id ? unavailableOwner : null),
        getByName: vi.fn(async (teamId: string, name: string) =>
          teamId === opsTeam.id && name === 'task-master' ? taskMaster : null,
        ),
        list: vi.fn(async (teamId: string) => teamId === opsTeam.id ? [taskMaster] : [unavailableOwner]),
      },
      adapter: {
        query: vi.fn(async () => ({ rows: [recentCompletedTriage], rowCount: 1 })),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-task-manager-completed-triage-cooldown-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const guard = await manager.stalledOwnerBacklogGuard({
      teamId: TEAM_ID,
      teamName: 'default',
      owner: unavailableOwner,
    });

    expect(guard?.triage).toMatchObject({
      status: 'task_manager_recent_backlog_probe',
      taskRef: '#12345678',
      actor: 'task-master',
      actorTeam: 'ops-team',
    });
    expect(manager.sendSupervisionAsk).not.toHaveBeenCalled();
    expect(db.events.insert).not.toHaveBeenCalled();
  });

  it('limits task-manager fallback to one accepted prompt per lane cooldown window', async () => {
    const ownerA = agent({ id: 'owner-a', name: 'worker-a', status: 'stopped', runtime: 'public-agent-remote' });
    const ownerB = agent({ id: 'owner-b', name: 'worker-b', status: 'stopped', runtime: 'public-agent-remote' });
    const opsTeam = team({ id: 'ops-team-id', name: 'ops-team' });
    const taskMaster = agent({
      id: 'task-master-id',
      team_id: opsTeam.id,
      name: 'task-master',
      status: 'running',
    });
    const taskA = task({
      id: 'task-a',
      name: 'stalled-a',
      uuid: 'aaaaaaaa-1234-4234-8234-123456789abc',
      owner: ownerA.id,
    });
    const taskB = task({
      id: 'task-b',
      name: 'stalled-b',
      uuid: 'bbbbbbbb-1234-4234-8234-123456789abc',
      owner: ownerB.id,
    });
    const db = fakeDb({
      teams: {
        getTeamByName: vi.fn(async (name: string) => name === 'ops-team' ? opsTeam : null),
      },
      agents: {
        getById: vi.fn(async (id: string) => id === ownerA.id ? ownerA : id === ownerB.id ? ownerB : null),
        getByName: vi.fn(async (teamId: string, name: string) =>
          teamId === opsTeam.id && name === 'task-master' ? taskMaster : null,
        ),
        list: vi.fn(async (teamId: string) => teamId === opsTeam.id ? [taskMaster] : [ownerA, ownerB]),
      },
      tasks: {
        list: vi.fn(async ({ status }: { status?: string } = {}) => status === 'doing' ? [taskA, taskB] : []),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-task-manager-fallback-lane-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const first = await manager.stalledOwnerBacklogGuard({
      teamId: TEAM_ID,
      teamName: 'default',
      owner: ownerA,
    });
    const second = await manager.stalledOwnerBacklogGuard({
      teamId: TEAM_ID,
      teamName: 'default',
      owner: ownerB,
      onlyTaskId: taskB.id,
    });

    expect(first?.triage).toMatchObject({
      status: 'sent_task_manager',
      taskRef: '#aaaaaaaa',
      actor: 'task-master',
      actorTeam: 'ops-team',
    });
    expect(second?.triage).toMatchObject({
      status: 'task_manager_recent_backlog_probe',
      taskRef: '#bbbbbbbb',
      actor: 'task-master',
      actorTeam: 'ops-team',
    });
    expect(manager.sendSupervisionAsk).toHaveBeenCalledTimes(1);
  });

  it('routes stalled-owner triage to task-master when the team lead is busy', async () => {
    const unavailableOwner = agent({ status: 'stopped', runtime: 'public-agent-remote' });
    const lead = agent({ id: 'lead-1', name: 'lead', metadata: { primaryLead: true, leadMaxActiveQueries: 1 } });
    const opsTeam = team({ id: 'ops-team-id', name: 'ops-team' });
    const taskMaster = agent({
      id: 'task-master-id',
      team_id: opsTeam.id,
      name: 'task-master',
      status: 'running',
    });
    const db = fakeDb({
      teams: {
        getTeamByName: vi.fn(async (name: string) => name === 'ops-team' ? opsTeam : null),
      },
      agents: {
        getById: vi.fn(async (id: string) => id === unavailableOwner.id ? unavailableOwner : null),
        getByName: vi.fn(async (teamId: string, name: string) => {
          if (teamId === opsTeam.id && name === 'task-master') return taskMaster;
          return null;
        }),
        list: vi.fn(async (teamId: string) => teamId === opsTeam.id ? [taskMaster] : [unavailableOwner, lead]),
      },
      queries: {
        getPending: vi.fn(async (agentId: string) => agentId === lead.id ? [activeQuery(lead.id)] : []),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-task-master-lead-busy-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const guard = await manager.stalledOwnerBacklogGuard({
      teamId: TEAM_ID,
      teamName: 'default',
      owner: unavailableOwner,
    });

    expect(guard?.triage).toMatchObject({
      status: 'sent_task_manager',
      taskRef: '#12345678',
      actor: 'task-master',
      actorTeam: 'ops-team',
    });
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'ops-team',
      'task-master',
      expect.stringContaining('team lead lead is busy'),
    );
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      team_id: TEAM_ID,
      topic: 'task:triaged',
      actor_agent_id: 'task-master-id',
      data: expect.objectContaining({
        reason: 'owner_unavailable',
        stalled_minutes: 60,
      }),
    }));
  });

  it('routes stalled-owner triage to a lead that still has query capacity', async () => {
    const unavailableOwner = agent({ status: 'stopped', runtime: 'public-agent-remote' });
    const lead = agent({ id: 'lead-1', name: 'lead', metadata: { primaryLead: true, leadMaxActiveQueries: 2 } });
    const db = fakeDb({
      agents: {
        getById: vi.fn(async (id: string) => id === unavailableOwner.id ? unavailableOwner : null),
        list: vi.fn(async () => [unavailableOwner, lead]),
      },
      queries: {
        getPending: vi.fn(async (agentId: string) => agentId === lead.id ? [activeQuery(lead.id)] : []),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-lead-spare-capacity-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const guard = await manager.stalledOwnerBacklogGuard({
      teamId: TEAM_ID,
      teamName: 'default',
      owner: unavailableOwner,
    });

    expect(guard?.triage).toMatchObject({
      status: 'sent_lead',
      taskRef: '#12345678',
      actor: 'lead',
    });
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'default',
      'lead',
      expect.stringContaining('owner worker is not live'),
    );
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      team_id: TEAM_ID,
      topic: 'task:triaged',
      actor_agent_id: 'lead-1',
      data: expect.objectContaining({
        reason: 'owner_unavailable',
        stalled_minutes: 60,
      }),
    }));
  });

  it('routes manual jumpstart to task-master when the stalled owner is busy', async () => {
    const busyOwner = agent({ id: 'busy-owner', name: 'worker' });
    const opsTeam = team({ id: 'ops-team-id', name: 'ops-team' });
    const taskMaster = agent({
      id: 'task-master-id',
      team_id: opsTeam.id,
      name: 'task-master',
      status: 'running',
    });
    const stalled = task({ owner: busyOwner.id });
    const db = fakeDb({
      teams: {
        getTeamByName: vi.fn(async (name: string) => name === 'ops-team' ? opsTeam : null),
      },
      agents: {
        resolve: vi.fn(async (_teamId: string, ref: string) => ref === 'worker' ? [busyOwner] : []),
        getById: vi.fn(async (id: string) => id === busyOwner.id ? busyOwner : null),
        getByName: vi.fn(async (teamId: string, name: string) => {
          if (teamId === opsTeam.id && name === 'task-master') return taskMaster;
          return null;
        }),
        list: vi.fn(async (teamId: string) => teamId === opsTeam.id ? [taskMaster] : [busyOwner]),
      },
      tasks: {
        list: vi.fn(async ({ status }: { status?: string } = {}) => status === 'doing' ? [stalled] : []),
      },
      queries: {
        getPending: vi.fn(async (agentId: string) => agentId === busyOwner.id ? [activeQuery(busyOwner.id)] : []),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-task-master-owner-busy-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const result = await manager.executeRemoteCommand('/task jumpstart-stalled --owner worker --limit 1', TEAM_ID, 'default');

    expect(result).toMatchObject({
      ok: true,
      result: {
        triagedOwners: 1,
        items: [
          {
            team: 'default',
            owner: 'worker',
            blockers: ['#12345678'],
            triage: {
              status: 'sent_task_manager',
              taskRef: '#12345678',
              actor: 'task-master',
              actorTeam: 'ops-team',
            },
          },
        ],
      },
    });
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'ops-team',
      'task-master',
      expect.stringContaining('owner worker already has another active query'),
    );
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      team_id: TEAM_ID,
      topic: 'task:triaged',
      actor_agent_id: 'task-master-id',
      data: expect.objectContaining({
        reason: 'owner_busy',
        stalled_minutes: 60,
      }),
    }));
  });

  it('routes manual jumpstart to task-master after repeated owner control failures', async () => {
    const owner = agent({ id: 'busy-owner', name: 'worker' });
    const opsTeam = team({ id: 'ops-team-id', name: 'ops-team' });
    const taskMaster = agent({
      id: 'task-master-id',
      team_id: opsTeam.id,
      name: 'task-master',
      status: 'running',
    });
    const stalled = task({ owner: owner.id });
    const failedControl = (queryId: string, status: 'failed' | 'expired') => ({
      team_id: TEAM_ID,
      agent_id: owner.id,
      query_id: queryId,
      status,
      prompt: 'Backlog guard: task #12345678 ("Stalled work") has been active 60m with no progress update.',
      created: NOW_MS - 5 * 60_000,
      completed: NOW_MS - 4 * 60_000,
      result: null,
      error: status === 'failed' ? 'Query exceeded control-plane timeout after 90s' : null,
      session_id: null,
      owner_kind: 'agent',
      owner_id: owner.id,
      metadata: null,
    });
    const db = fakeDb({
      teams: {
        getTeamByName: vi.fn(async (name: string) => name === 'ops-team' ? opsTeam : null),
      },
      agents: {
        getById: vi.fn(async (id: string) => id === owner.id ? owner : null),
        getByName: vi.fn(async (teamId: string, name: string) => {
          if (teamId === opsTeam.id && name === 'task-master') return taskMaster;
          return null;
        }),
        list: vi.fn(async (teamId: string) => teamId === opsTeam.id ? [taskMaster] : [owner]),
      },
      tasks: {
        list: vi.fn(async ({ status }: { status?: string } = {}) => status === 'doing' ? [stalled] : []),
        getByUuidPrefix: vi.fn(async () => [stalled]),
      },
      adapter: {
        query: vi.fn(async (sql: string) => {
          if (String(sql).includes("status IN ('failed', 'expired')")) {
            return {
              rows: [
                failedControl('failed-owner-refresh', 'failed'),
                failedControl('expired-owner-refresh', 'expired'),
              ],
              rowCount: 2,
            };
          }
          return { rows: [], rowCount: 0 };
        }),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-owner-unresponsive-fallback-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const result = await manager.executeRemoteCommand('/task jumpstart-stalled #12345678 --limit 1', TEAM_ID, 'default');

    expect(result).toMatchObject({
      ok: true,
      result: {
        triagedOwners: 1,
        items: [
          {
            team: 'default',
            owner: 'worker',
            blockers: ['#12345678'],
            triage: {
              status: 'sent_task_manager',
              taskRef: '#12345678',
              actor: 'task-master',
              actorTeam: 'ops-team',
            },
          },
        ],
      },
    });
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'ops-team',
      'task-master',
      expect.stringContaining('repeated failed or expired control prompts'),
    );
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      team_id: TEAM_ID,
      topic: 'task:triaged',
      actor_agent_id: 'task-master-id',
      data: expect.objectContaining({
        reason: 'owner_busy',
        stalled_minutes: 60,
      }),
    }));
  });

  it('wakes a stopped local owner and sends the stalled task prompt', async () => {
    const stoppedOwner = agent({
      status: 'stopped',
      port: 4210,
      type: 'claude',
      runtime: 'claude-code-cli',
    });
    const db = fakeDb({
      agents: {
        getById: vi.fn(async () => stoppedOwner),
        updateStatus: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-owner-wake-guard-test', db, { libraryRoot: null }) as any;
    manager.spawnLocalAgentProcess = vi.fn(async () => ({ success: true, pid: 1234, logFile: '/tmp/worker.log' }));
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const guard = await manager.stalledOwnerBacklogGuard({
      teamId: TEAM_ID,
      teamName: 'default',
      owner: stoppedOwner,
    });

    expect(guard?.triage).toMatchObject({
      status: 'owner_wake_prompt_sent',
      taskRef: '#12345678',
      actor: 'worker',
    });
    expect(manager.spawnLocalAgentProcess).toHaveBeenCalledWith(TEAM_ID, 'default', expect.objectContaining({
      id: stoppedOwner.id,
      name: stoppedOwner.name,
      port: stoppedOwner.port,
    }));
    expect(db.agents.updateStatus).toHaveBeenCalledWith(stoppedOwner.id, 'running');
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'default',
      'worker',
      expect.stringContaining('New task assignment to you is held'),
    );
  });

  it('does not repeat stalled owner backlog guard when a matching control query just finished', async () => {
    const recentCompleted = activeQuery('agent-1', {
      query_id: 'recent-backlog-guard',
      status: 'completed',
      prompt: 'Backlog guard: task #12345678 ("Stalled work") has been active 57m with no progress update.',
      created: NOW_MS - 90_000,
      completed: NOW_MS - 30_000,
    });
    const db = fakeDb({
      adapter: {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('FROM queries')) {
            return { rows: [recentCompleted], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-owner-recent-control-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const guard = await manager.stalledOwnerBacklogGuard({
      teamId: TEAM_ID,
      teamName: 'default',
      owner: agent(),
    });

    expect(guard?.triage).toMatchObject({
      status: 'throttled',
      taskRef: '#12345678',
      actor: 'worker',
    });
    expect(manager.sendSupervisionAsk).not.toHaveBeenCalled();
    expect(db.events.insert).not.toHaveBeenCalled();
  });

  it('lets forced stalled owner triage bypass the recent control-query throttle', async () => {
    const recentCompleted = activeQuery('agent-1', {
      query_id: 'recent-backlog-guard',
      status: 'completed',
      prompt: 'Backlog guard: task #12345678 ("Stalled work") has been active 57m with no progress update.',
      created: NOW_MS - 90_000,
      completed: NOW_MS - 30_000,
    });
    const db = fakeDb({
      adapter: {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('FROM queries')) {
            return { rows: [recentCompleted], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-owner-force-recent-control-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const guard = await manager.stalledOwnerBacklogGuard({
      teamId: TEAM_ID,
      teamName: 'default',
      owner: agent(),
      forceTriage: true,
    });

    expect(guard?.triage).toMatchObject({
      status: 'sent_owner',
      taskRef: '#12345678',
      actor: 'worker',
    });
    expect(manager.sendSupervisionAsk).toHaveBeenCalledTimes(1);
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:refreshed',
      actor_agent_id: 'agent-1',
      data: expect.objectContaining({
        reason: 'owner_refresh',
      }),
    }));
  });

  it('routes live owner send failures to the team lead on forced stalled triage', async () => {
    const owner = agent();
    const lead = agent({ id: 'lead-1', name: 'lead', metadata: { primaryLead: true, leadMaxActiveQueries: 2 } });
    const db = fakeDb({
      agents: {
        getById: vi.fn(async (id: string) => id === owner.id ? owner : id === lead.id ? lead : null),
        getByName: vi.fn(async (_teamId: string, name: string) => name === 'lead' ? lead : null),
        list: vi.fn(async () => [owner, lead]),
        resolve: vi.fn(async () => [owner, lead]),
        updateStatus: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-live-owner-send-fallback-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async (teamName: string, agentName: string) => teamName === 'default' && agentName === 'lead');

    const guard = await manager.stalledOwnerBacklogGuard({
      teamId: TEAM_ID,
      teamName: 'default',
      owner,
      forceTriage: true,
    });

    expect(guard?.triage).toMatchObject({
      status: 'sent_lead',
      taskRef: '#12345678',
      actor: 'lead',
    });
    expect(manager.sendSupervisionAsk).toHaveBeenNthCalledWith(
      1,
      'default',
      'worker',
      expect.stringContaining('New task assignment to you is held'),
    );
    expect(manager.sendSupervisionAsk).toHaveBeenNthCalledWith(
      2,
      'default',
      'lead',
      expect.stringContaining('could not be reached through owner worker'),
    );
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:triaged',
      actor_agent_id: lead.id,
      data: expect.objectContaining({
        reason: 'owner_unavailable',
      }),
    }));
  });

  it('routes stalled wake prompt failures to task-master fallback', async () => {
    const stoppedOwner = agent({
      status: 'stopped',
      port: 4210,
      type: 'claude',
      runtime: 'claude-code-cli',
    });
    const opsTeam = team({ id: 'ops-team-id', name: 'ops-team' });
    const taskMaster = agent({
      id: 'task-master-id',
      team_id: opsTeam.id,
      name: 'task-master',
      status: 'running',
    });
    const db = fakeDb({
      teams: {
        getConfig: vi.fn(async () => ({})),
        getTeamByName: vi.fn(async (name: string) => name === 'ops-team' ? opsTeam : null),
        listTeams: vi.fn(async () => []),
      },
      agents: {
        getById: vi.fn(async (id: string) => id === stoppedOwner.id ? stoppedOwner : null),
        getByName: vi.fn(async (teamId: string, name: string) => {
          if (teamId === opsTeam.id && name === 'task-master') return taskMaster;
          return null;
        }),
        list: vi.fn(async (teamId: string) => teamId === opsTeam.id ? [taskMaster] : [stoppedOwner]),
        resolve: vi.fn(async () => []),
        updateStatus: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-owner-wake-fallback-test', db, { libraryRoot: null }) as any;
    manager.spawnLocalAgentProcess = vi.fn(async () => ({ success: true, pid: 1234, logFile: '/tmp/worker.log' }));
    manager.sendSupervisionAsk = vi.fn(async (teamName: string, agentName: string) => {
      return teamName === 'ops-team' && agentName === 'task-master';
    });

    const guard = await manager.stalledOwnerBacklogGuard({
      teamId: TEAM_ID,
      teamName: 'default',
      owner: stoppedOwner,
    });

    expect(guard?.triage).toMatchObject({
      status: 'sent_task_manager',
      taskRef: '#12345678',
      actor: 'task-master',
      actorTeam: 'ops-team',
    });
    expect(manager.spawnLocalAgentProcess).toHaveBeenCalled();
    expect(manager.sendSupervisionAsk).toHaveBeenNthCalledWith(
      1,
      'default',
      'worker',
      expect.stringContaining('New task assignment to you is held'),
    );
    expect(manager.sendSupervisionAsk).toHaveBeenNthCalledWith(
      2,
      'ops-team',
      'task-master',
      expect.stringContaining('there is no live team lead'),
    );
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      team_id: TEAM_ID,
      topic: 'task:triaged',
      actor_agent_id: taskMaster.id,
      data: expect.objectContaining({
        reason: 'owner_unavailable',
        stalled_minutes: 60,
      }),
    }));
  });

  it('aliases jumpstart-stalled to stalled owner triage', async () => {
    const db = fakeDb({
      teams: {
        listTeams: vi.fn(async () => [team()]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-owner-jumpstart-command-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const result = await manager.executeRemoteCommand('/task jumpstart-stalled --all --limit 5', TEAM_ID, 'default');

    expect(result).toMatchObject({
      ok: true,
      result: {
        triagedOwners: 1,
        items: [
          {
            team: 'default',
            owner: 'worker',
            triage: { status: 'sent_owner', taskRef: '#12345678', actor: 'worker' },
          },
        ],
      },
    });
  });

  it('jumpstarts a specific stalled task ref instead of the owner oldest task', async () => {
    const older = task({
      id: 'task-old',
      name: 'older-stalled-work',
      uuid: '11111111-1111-4111-8111-111111111111',
      title: 'Older stalled work',
      updated_at: Math.floor(NOW_MS / 1000) - 7200,
    });
    const target = task({
      id: 'task-target',
      name: 'target-stalled-work',
      uuid: '87654321-1234-4234-9234-123456789abc',
      title: 'Target stalled work',
      updated_at: Math.floor(NOW_MS / 1000) - 3600,
    });
    const db = fakeDb({
      tasks: {
        list: vi.fn(async ({ status }: { status?: string } = {}) => status === 'doing' ? [older, target] : []),
        getByUuidPrefix: vi.fn(async (prefix: string) => prefix === '87654321' ? [target] : []),
        getByNameForTeam: vi.fn(async () => null),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-task-ref-jumpstart-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const result = await manager.executeRemoteCommand('/task jumpstart-stalled #87654321 --limit 1', TEAM_ID, 'default');

    expect(result).toMatchObject({
      ok: true,
      result: {
        scannedOwners: 1,
        triagedOwners: 1,
        items: [
          {
            team: 'default',
            owner: 'worker',
            blockers: ['#87654321'],
            triage: { status: 'sent_owner', taskRef: '#87654321', actor: 'worker' },
          },
        ],
      },
    });
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringContaining('task #87654321 ("Target stalled work")'),
    );
  });

  it('treats an accidental --owner short task id as a task-ref jumpstart', async () => {
    const target = task({
      id: 'task-target',
      name: 'target-stalled-work',
      uuid: '87654321-1234-4234-9234-123456789abc',
      title: 'Target stalled work',
    });
    const db = fakeDb({
      tasks: {
        list: vi.fn(async ({ status }: { status?: string } = {}) => status === 'doing' ? [target] : []),
        getByUuidPrefix: vi.fn(async (prefix: string) => prefix === '87654321' ? [target] : []),
        getByNameForTeam: vi.fn(async () => null),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-owner-short-ref-jumpstart-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const result = await manager.executeRemoteCommand('/task jumpstart-stalled --owner #87654321 --limit 1', TEAM_ID, 'default');

    expect(result).toMatchObject({
      ok: true,
      result: {
        triagedOwners: 1,
        items: [
          {
            owner: 'worker',
            blockers: ['#87654321'],
            triage: { status: 'sent_owner', taskRef: '#87654321' },
          },
        ],
      },
    });
  });

  it('lets manual jump-start bypass only the renudge throttle', async () => {
    const db = fakeDb();
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-owner-manual-jumpstart-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const first = await manager.executeRemoteCommand('/task triage-stalled --owner worker --limit 1', TEAM_ID, 'default');
    const throttled = await manager.executeRemoteCommand('/task triage-stalled --owner worker --limit 1', TEAM_ID, 'default');
    vi.mocked(Date.now).mockReturnValue(NOW_MS + 61_000);
    manager.sendSupervisionAsk.mockClear();
    const manual = await manager.executeRemoteCommand('/task jumpstart-stalled --owner worker --limit 1', TEAM_ID, 'default');

    expect(first).toMatchObject({ ok: true, result: { items: [{ triage: { status: 'sent_owner' } }] } });
    expect(throttled).toMatchObject({ ok: true, result: { items: [{ triage: { status: 'throttled' } }] } });
    expect(manual).toMatchObject({ ok: true, result: { items: [{ triage: { status: 'sent_owner' } }] } });
    expect(manager.sendSupervisionAsk).toHaveBeenCalledTimes(1);
  });

  it('falls through to ops-lead when task-master is busy', async () => {
    const unavailableOwner = agent({ status: 'stopped' });
    const opsTeam = team({ id: 'ops-team-id', name: 'ops-team' });
    const taskMaster = agent({
      id: 'task-master-id',
      team_id: opsTeam.id,
      name: 'task-master',
      status: 'running',
    });
    const opsLead = agent({
      id: 'ops-lead-id',
      team_id: opsTeam.id,
      name: 'ops-lead',
      status: 'running',
    });
    const db = fakeDb({
      teams: {
        getTeamByName: vi.fn(async (name: string) => name === 'ops-team' ? opsTeam : null),
      },
      agents: {
        getById: vi.fn(async (id: string) => id === unavailableOwner.id ? unavailableOwner : null),
        getByName: vi.fn(async (teamId: string, name: string) => {
          if (teamId !== opsTeam.id) return null;
          if (name === 'task-master') return taskMaster;
          if (name === 'ops-lead') return opsLead;
          return null;
        }),
        list: vi.fn(async (teamId: string) => teamId === opsTeam.id ? [taskMaster, opsLead] : [unavailableOwner]),
      },
      queries: {
        getPending: vi.fn(async (ownerId: string) => ownerId === taskMaster.id ? [{
          team_id: opsTeam.id,
          agent_id: taskMaster.id,
          query_id: 'busy-task-master',
          prompt: 'existing supervision work',
          status: 'processing',
          created: NOW_MS - 1000,
          updated: NOW_MS - 1000,
          completed: null,
          result: null,
          error: null,
          session_id: null,
          owner_kind: 'agent',
          owner_id: taskMaster.id,
          metadata: null,
        }] : []),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-task-master-fallback-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    const guard = await manager.stalledOwnerBacklogGuard({
      teamId: TEAM_ID,
      teamName: 'default',
      owner: unavailableOwner,
    });

    expect(guard?.triage).toMatchObject({
      status: 'sent_task_manager',
      taskRef: '#12345678',
      actor: 'ops-lead',
      actorTeam: 'ops-team',
    });
    expect(manager.sendSupervisionAsk).toHaveBeenCalledTimes(1);
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'ops-team',
      'ops-lead',
      expect.stringContaining('there is no live team lead'),
    );
  });

  it('does not stack unavailable-owner triage probes while a prior task supervision ask is active', async () => {
    const unavailableOwner = agent({ status: 'stopped' });
    const lead = agent({ id: 'lead-1', name: 'lead', metadata: { primaryLead: true, leadMaxActiveQueries: 1 } });
    const db = fakeDb({
      agents: {
        getById: vi.fn(async () => unavailableOwner),
        getByName: vi.fn(async () => lead),
        list: vi.fn(async () => [unavailableOwner, lead]),
      },
      queries: {
        getPending: vi.fn(async () => [{
          team_id: TEAM_ID,
          agent_id: 'lead-1',
          query_id: 'active-owner-unavailable-probe',
          status: 'processing',
          prompt: 'Supervision: task #12345678 ("Stalled work") has been in progress 60m, but owner worker is stopped (triage probe 1/3).',
          created: NOW_MS - 60_000,
          completed: null,
          result: null,
          error: null,
          session_id: null,
          owner_kind: 'agent',
          owner_id: 'lead-1',
          metadata: null,
        }]),
        getPendingByOwner: vi.fn(async () => []),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(manager.sendSupervisionAsk).not.toHaveBeenCalled();
    expect(db.events.insert).not.toHaveBeenCalled();
  });

  it('does not stack unclaimed-task triage on a lead that already has active work', async () => {
    const unclaimed = task({
      id: 'todo-1',
      name: 'unclaimed-work',
      uuid: '11111111-2222-4333-8444-555555555555',
      title: 'Unclaimed work',
      status: 'todo',
      owner: null,
    });
    const lead = agent({ id: 'lead-1', name: 'lead', metadata: { primaryLead: true, leadMaxActiveQueries: 1 } });
    const db = fakeDb({
      agents: {
        getByName: vi.fn(async () => lead),
        list: vi.fn(async () => [lead]),
      },
      tasks: {
        list: vi.fn(async ({ status }: { status?: string } = {}) => {
          if (status === 'doing') return [];
          if (status === 'todo') return [unclaimed];
          return [];
        }),
        updateFields: vi.fn(async () => {}),
      },
      queries: {
        getPending: vi.fn(async () => [{
          team_id: TEAM_ID,
          agent_id: 'lead-1',
          query_id: 'lead-current-work',
          status: 'processing',
          prompt: 'Heartbeat: review your checklist and act on anything that needs attention.',
          created: NOW_MS - 60_000,
          completed: null,
          result: null,
          error: null,
          session_id: null,
          owner_kind: 'agent',
          owner_id: 'lead-1',
          metadata: null,
        }]),
        getPendingByOwner: vi.fn(async () => []),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(manager.sendSupervisionAsk).not.toHaveBeenCalled();
    expect(db.events.insert).not.toHaveBeenCalled();
  });

  it('routes unclaimed-task triage to task-manager when the lead is busy', async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const unclaimed = task({
      id: 'todo-1',
      name: 'unclaimed-work',
      uuid: '11111111-2222-4333-8444-555555555555',
      title: 'Unclaimed work',
      status: 'todo',
      owner: null,
      updated_at: nowSec - 3600,
    });
    const lead = agent({ id: 'lead-1', name: 'lead', metadata: { primaryLead: true, leadMaxActiveQueries: 1 } });
    const opsTeam = team({ id: 'ops-team-id', name: 'ops-team' });
    const taskMaster = agent({
      team_id: opsTeam.id,
      id: 'task-master-id',
      name: 'task-master',
      metadata: { catalog: { role: 'task-manager' } },
    });
    const db = fakeDb({
      teams: {
        getTeamByName: vi.fn(async (name: string) => name === 'ops-team' ? opsTeam : null),
      },
      agents: {
        getByName: vi.fn(async (teamId: string, name: string) =>
          teamId === opsTeam.id && name === 'task-master' ? taskMaster : null,
        ),
        list: vi.fn(async (teamId: string) => teamId === opsTeam.id ? [taskMaster] : [lead]),
      },
      tasks: {
        list: vi.fn(async ({ status }: { status?: string } = {}) => {
          if (status === 'doing') return [];
          if (status === 'todo') return [unclaimed];
          return [];
        }),
        updateFields: vi.fn(async () => {}),
      },
      queries: {
        getPending: vi.fn(async (agentId: string) => agentId === lead.id ? [{
          team_id: TEAM_ID,
          agent_id: lead.id,
          query_id: 'lead-current-work',
          status: 'processing',
          prompt: 'Heartbeat: review your checklist and act on anything that needs attention.',
          created: NOW_MS - 60_000,
          completed: null,
          result: null,
          error: null,
          session_id: null,
          owner_kind: 'agent',
          owner_id: lead.id,
          metadata: null,
        }] : []),
        getPendingByOwner: vi.fn(async () => []),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-unclaimed-task-manager-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'ops-team',
      'task-master',
      expect.stringContaining('task has no owner'),
    );
    expect(manager.sendSupervisionAsk).not.toHaveBeenCalledWith(
      'default',
      'lead',
      expect.any(String),
    );
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      team_id: TEAM_ID,
      topic: 'task:triaged',
      actor_agent_id: 'task-master-id',
      subject_id: '11111111-2222-4333-8444-555555555555',
      data: expect.objectContaining({
        reason: 'unclaimed',
        stalled_minutes: 60,
      }),
    }));
  });

  it('holds stopped lead-owned work that missed delegation when task-manager routing is unavailable', async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const stoppedLead = agent({
      id: 'research-lead-1',
      name: 'research-lead',
      status: 'stopped',
      metadata: { catalog: { role: 'lead' } },
    });
    const leadTask = task({
      id: 'research-task-1',
      name: 'run-deep-research',
      uuid: 'aaaa1111-2222-4333-8444-555555555555',
      title: 'Run deep research',
      owner: 'research-lead-1',
      created_by: 'research-lead-1',
      created_at: nowSec - 11 * 60,
      updated_at: nowSec - 11 * 60,
    });
    const db = fakeDb({
      teams: {
        getTeam: vi.fn(async () => team({ name: 'research' })),
      },
      agents: {
        getById: vi.fn(async () => stoppedLead),
        getByName: vi.fn(async () => agent({ id: 'lead-1', name: 'lead', metadata: { primaryLead: true } })),
        list: vi.fn(async () => [stoppedLead]),
      },
      tasks: {
        list: vi.fn(async ({ status, teamId }: { status?: string; teamId?: string } = {}) => {
          if (status === 'doing') return [leadTask];
          if (teamId === TEAM_ID) return [leadTask];
          return [];
        }),
        updateFields: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(manager.sendSupervisionAsk).not.toHaveBeenCalled();
    expect(db.tasks.updateFields).toHaveBeenCalledWith('research-task-1', {
      updated_at: Math.floor(NOW_MS / 1000),
    });
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      team_id: TEAM_ID,
      topic: 'task:triaged',
      actor_agent_id: 'research-lead-1',
      subject_id: 'aaaa1111-2222-4333-8444-555555555555',
      data: expect.objectContaining({
        owner: 'research-lead-1',
        reason: 'lead_owner_unavailable',
        stalled_minutes: 11,
      }),
    }));
  });

  it('routes stopped lead-owned delegation stalls to task-manager when available', async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const researchTeam = team({ name: 'research' });
    const opsTeam = team({ id: 'ops-team-id', name: 'ops-team' });
    const stoppedLead = agent({
      id: 'research-lead-1',
      name: 'research-lead',
      status: 'stopped',
      metadata: { catalog: { role: 'lead' } },
    });
    const taskManager = agent({
      team_id: opsTeam.id,
      id: 'task-manager-id',
      name: 'task-manager',
      metadata: { catalog: { role: 'task-manager' } },
    });
    const leadTask = task({
      id: 'research-task-1',
      name: 'run-deep-research',
      uuid: 'aaaa1111-2222-4333-8444-555555555555',
      title: 'Run deep research',
      owner: 'research-lead-1',
      created_by: 'research-lead-1',
      created_at: nowSec - 11 * 60,
      updated_at: nowSec - 11 * 60,
    });
    const db = fakeDb({
      teams: {
        getTeam: vi.fn(async () => researchTeam),
        getTeamByName: vi.fn(async (name: string) => name === 'ops-team' ? opsTeam : null),
      },
      agents: {
        getById: vi.fn(async () => stoppedLead),
        getByName: vi.fn(async (teamId: string, name: string) =>
          teamId === opsTeam.id && name === 'task-manager' ? taskManager : null,
        ),
        list: vi.fn(async (teamId: string) => teamId === opsTeam.id ? [taskManager] : [stoppedLead]),
      },
      tasks: {
        list: vi.fn(async ({ status, teamId }: { status?: string; teamId?: string } = {}) => {
          if (status === 'doing') return [leadTask];
          if (teamId === TEAM_ID) return [leadTask];
          return [];
        }),
        updateFields: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stopped-lead-task-manager-route-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'ops-team',
      'task-manager',
      expect.stringContaining('task-manager delegation is required'),
    );
    expect(manager.sendSupervisionAsk).not.toHaveBeenCalledWith(
      'research',
      'research-lead',
      expect.any(String),
    );
    expect(db.tasks.updateFields).toHaveBeenCalledWith('research-task-1', {
      status: 'todo',
      owner: null,
      updated_at: nowSec,
    });
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      team_id: TEAM_ID,
      topic: 'task:triaged',
      actor_agent_id: 'task-manager-id',
      subject_id: 'aaaa1111-2222-4333-8444-555555555555',
      data: expect.objectContaining({
        reason: 'lead_delegation_required',
        stalled_minutes: 11,
      }),
    }));
  });

  it('probes an active linked checkin instead of double-poking the task owner', async () => {
    const db = fakeDb({
      checkins: {
        list: vi.fn(async () => [{
          id: 'chk_1',
          team_id: TEAM_ID,
          owner_agent_id: 'agent-1',
          created_by_agent_id: null,
          linked_task_id: 'task-1',
          interval_seconds: 600,
          priority: 'normal',
          status: 'active',
          close_when: { task_status: ['done'] },
          max_iterations: null,
          iteration_count: 0,
          next_fire_at: NOW_MS + 600_000,
          snooze_until: null,
          ttl_expires_at: null,
          last_fire_at: null,
          last_event_seq: null,
          note: null,
          created_at: NOW_MS - 3_600_000,
          updated_at: NOW_MS - 3_600_000,
          closed_at: null,
          closed_reason: null,
        }]),
        updateFields: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(manager.sendSupervisionAsk).not.toHaveBeenCalled();
    expect(db.checkins.updateFields).toHaveBeenCalledWith('chk_1', TEAM_ID, {
      next_fire_at: NOW_MS,
      updated_at: NOW_MS,
    });
    expect(db.tasks.updateFields).toHaveBeenCalledWith('task-1', {
      updated_at: Math.floor(NOW_MS / 1000),
    });
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      team_id: TEAM_ID,
      topic: 'task:refreshed',
      actor_agent_id: 'agent-1',
      data: expect.objectContaining({
        reason: 'checkin_heartbeat_probe',
        stalled_minutes: 60,
      }),
    }));
  });

  it('caps repeated owner probes and escalates once instead of looping', async () => {
    process.env.STALL_RENUDGE_MS = '1';
    process.env.STALL_MAX_PROBES = '1';
    const lead = agent({ id: 'lead-1', name: 'lead', metadata: { primaryLead: true } });
    const db = fakeDb({
      agents: {
        getById: vi.fn(async () => agent()),
        getByName: vi.fn(async () => lead),
        list: vi.fn(async () => [agent(), lead]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();
    vi.mocked(Date.now).mockReturnValue(NOW_MS + 2);
    await manager.sweepStalledTasks();
    vi.mocked(Date.now).mockReturnValue(NOW_MS + 4);
    await manager.sweepStalledTasks();

    expect(manager.sendSupervisionAsk).toHaveBeenCalledTimes(2);
    expect(manager.sendSupervisionAsk).toHaveBeenNthCalledWith(
      1,
      'default',
      'worker',
      expect.stringContaining('probe 1/1'),
    );
    expect(manager.sendSupervisionAsk).toHaveBeenNthCalledWith(
      2,
      'default',
      'lead',
      expect.stringContaining('after 1 stalled owner probes'),
    );
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:triaged',
      actor_agent_id: 'lead-1',
      data: expect.objectContaining({ reason: 'probe_limit_reached' }),
    }));
  });

  it('closes stalled validator tasks terminally after the bounded probe budget', async () => {
    process.env.STALL_RENUDGE_MS = '1';
    process.env.STALL_MAX_PROBES = '1';
    const validator = agent({ id: 'coder-1', name: 'coder' });
    const validationTask = task({
      owner: 'coder-1',
      title: 'Validate parent work',
      name: 'validate-parent-work-coder',
    });
    const db = fakeDb({
      agents: {
        getById: vi.fn(async () => validator),
        getByName: vi.fn(async () => agent({ id: 'lead-1', name: 'lead', metadata: { primaryLead: true } })),
        list: vi.fn(async () => [validator]),
      },
      tasks: {
        list: vi.fn(async ({ status }: { status?: string } = {}) => status === 'doing' ? [validationTask] : []),
        updateFields: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();
    vi.mocked(Date.now).mockReturnValue(NOW_MS + 2);
    await manager.sweepStalledTasks();

    expect(manager.sendSupervisionAsk).toHaveBeenCalledTimes(1);
    expect(db.tasks.updateFields).toHaveBeenCalledWith('task-1', expect.objectContaining({
      status: 'done',
    }));
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:completed',
      actor_agent_id: 'coder-1',
      data: expect.objectContaining({
        failure_note: expect.stringContaining('stalled_validation_terminal'),
      }),
    }));
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:triaged',
      actor_agent_id: 'coder-1',
      data: expect.objectContaining({
        reason: 'validator_stalled_terminal',
      }),
    }));
  });

  it('does not repeat unclaimed todo triage after restart when a recent supervision event exists', async () => {
    const staleTodo = task({
      id: 'todo-1',
      name: 'stale-unclaimed',
      uuid: '88888888-8888-4888-8888-888888888888',
      title: 'Stale unclaimed work',
      status: 'todo',
      owner: null,
    });
    const lead = agent({ id: 'lead-1', name: 'lead', metadata: { primaryLead: true } });
    const db = fakeDb({
      agents: {
        getByName: vi.fn(async () => lead),
        list: vi.fn(async () => [lead]),
      },
      tasks: {
        list: vi.fn(async ({ status }: { status?: string } = {}) => {
          if (status === 'doing') return [];
          if (status === 'todo') return [staleTodo];
          return [];
        }),
        updateFields: vi.fn(async () => {}),
      },
      adapter: {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('FROM event_log')) {
            return { rows: [{ seq: 99, occurred_at: NOW_MS - 2 * 60 * 1000 }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(manager.sendSupervisionAsk).not.toHaveBeenCalled();
    expect(db.events.insert).not.toHaveBeenCalled();
  });

  it('does not let an older event-only unclaimed-task record suppress triage after restart', async () => {
    const staleTodo = task({
      id: 'todo-1',
      name: 'stale-unclaimed',
      uuid: '88888888-8888-4777-9666-555555555555',
      title: 'Stale unclaimed work',
      status: 'todo',
      owner: null,
      updated_at: Math.floor((NOW_MS - 60 * 60 * 1000) / 1000),
    });
    const lead = agent({ id: 'lead-1', name: 'lead', metadata: { primaryLead: true } });
    const db = fakeDb({
      agents: {
        getByName: vi.fn(async () => lead),
        list: vi.fn(async () => [lead]),
      },
      tasks: {
        list: vi.fn(async ({ status }: { status?: string } = {}) => {
          if (status === 'doing') return [];
          if (status === 'todo') return [staleTodo];
          return [];
        }),
        updateFields: vi.fn(async () => {}),
      },
      adapter: {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('FROM event_log')) {
            return { rows: [{ seq: 99, occurred_at: NOW_MS - 10 * 60 * 1000 }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-old-unclaimed-event-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'default',
      'lead',
      expect.stringContaining('unclaimed task #88888888'),
    );
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'task:triaged',
      actor_agent_id: 'lead-1',
      data: expect.objectContaining({
        reason: 'unclaimed',
      }),
    }));
  });

  it('auto-assigns old unclaimed todo work to an idle live non-lead member', async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const staleTodo = task({
      id: 'todo-assign-1',
      name: 'stale-unclaimed',
      uuid: '99999999-8888-4777-9666-555555555555',
      title: 'Stale unclaimed work',
      status: 'todo',
      owner: null,
      updated_at: nowSec - 3600,
    });
    const worker = agent({ id: 'worker-2', name: 'worker-b' });
    const lead = agent({ id: 'lead-1', name: 'lead', metadata: { primaryLead: true } });
    const updated = { ...staleTodo, owner: worker.id, status: 'doing' as const, updated_at: nowSec };
    let taskLookupCount = 0;
    const db = fakeDb({
      agents: {
        getById: vi.fn(async () => worker),
        getByName: vi.fn(async () => lead),
        list: vi.fn(async () => [lead, worker]),
      },
      tasks: {
        list: vi.fn(async ({ status }: { status?: string } = {}) => {
          if (status === 'doing') return [];
          if (status === 'todo') return [staleTodo];
          return [];
        }),
        getByNameForTeam: vi.fn(async () => (++taskLookupCount === 1 ? staleTodo : updated)),
        claim: vi.fn(async () => true),
        updateFields: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(db.tasks.claim).toHaveBeenCalledWith('todo-assign-1', 'worker-2', nowSec, {
      maxDoingForTeam: expect.any(Number),
    });
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'default',
      'worker-b',
      expect.stringContaining('TASK DELEGATION from manager'),
    );
    expect(manager.sendSupervisionAsk).not.toHaveBeenCalledWith(
      'default',
      'lead',
      expect.any(String),
    );
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      team_id: TEAM_ID,
      topic: 'task:claimed',
      actor_agent_id: 'worker-2',
      subject_kind: 'task',
      subject_id: '99999999-8888-4777-9666-555555555555',
      data: expect.objectContaining({
        owner: 'worker-2',
        status: 'doing',
      }),
    }));
  });

  it('repairs ownerless doing work back to todo and assigns it', async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const ownerlessDoing = task({
      id: 'ownerless-doing-1',
      name: 'ownerless-doing-work',
      uuid: '91919191-8888-4777-9666-555555555555',
      title: 'Ownerless doing work',
      status: 'doing',
      owner: null,
      updated_at: nowSec - 3600,
    });
    const repairedTodo = {
      ...ownerlessDoing,
      status: 'todo' as const,
      owner: null,
      completed_at: null,
      updated_at: nowSec,
    };
    const worker = agent({ id: 'worker-2', name: 'worker-b' });
    const lead = agent({ id: 'lead-1', name: 'lead', metadata: { primaryLead: true } });
    const assigned = { ...repairedTodo, owner: worker.id, status: 'doing' as const };
    let taskLookupCount = 0;
    const db = fakeDb({
      agents: {
        getById: vi.fn(async () => worker),
        getByName: vi.fn(async () => lead),
        list: vi.fn(async () => [lead, worker]),
      },
      tasks: {
        list: vi.fn(async ({ status, owner }: { status?: string; owner?: string } = {}) => {
          if (status === 'doing' && owner) return [];
          if (status === 'doing') return [ownerlessDoing];
          if (status === 'todo') return [];
          return [];
        }),
        getByNameForTeam: vi.fn(async () => (++taskLookupCount === 1 ? repairedTodo : assigned)),
        claim: vi.fn(async () => true),
        updateFields: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-ownerless-doing-repair-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(db.tasks.updateFields).toHaveBeenCalledWith('ownerless-doing-1', expect.objectContaining({
      owner: null,
      status: 'todo',
      completed_at: null,
      updated_at: nowSec,
    }));
    expect(db.tasks.claim).toHaveBeenCalledWith('ownerless-doing-1', 'worker-2', nowSec, {
      maxDoingForTeam: expect.any(Number),
    });
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'default',
      'worker-b',
      expect.stringContaining('TASK DELEGATION from manager'),
    );
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      team_id: TEAM_ID,
      topic: 'task:triaged',
      subject_id: ownerlessDoing.uuid,
      data: expect.objectContaining({
        reason: 'ownerless_doing_repaired',
      }),
    }));
  });

  it('routes old unclaimed work to task-manager when every executor is already occupied', async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const staleTodo = task({
      id: 'todo-busy-assign-1',
      name: 'stale-unclaimed-busy',
      uuid: '77777777-8888-4777-9666-555555555555',
      title: 'Stale unclaimed busy work',
      status: 'todo',
      owner: null,
      updated_at: nowSec - 3600,
    });
    const activeDoing = task({
      id: 'doing-worker-1',
      name: 'active-worker-task',
      uuid: '88888888-8888-4777-9666-555555555555',
      title: 'Active worker task',
      status: 'doing',
      owner: 'worker-2',
      updated_at: nowSec,
    });
    const worker = agent({ id: 'worker-2', name: 'worker-b' });
    const lead = agent({ id: 'lead-1', name: 'lead', metadata: { primaryLead: true } });
    const opsTeam = team({ id: 'ops-team-id', name: 'ops-team' });
    const taskMaster = agent({
      team_id: opsTeam.id,
      id: 'task-master-id',
      name: 'task-master',
      metadata: { catalog: { role: 'task-manager' } },
    });
    const db = fakeDb({
      teams: {
        getTeamByName: vi.fn(async (name: string) => name === 'ops-team' ? opsTeam : null),
        listTeams: vi.fn(async () => [opsTeam]),
      },
      agents: {
        getById: vi.fn(async (id: string) => id === worker.id ? worker : id === lead.id ? lead : null),
        getByName: vi.fn(async (teamId: string, name: string) =>
          teamId === opsTeam.id && name === 'task-master' ? taskMaster : lead,
        ),
        list: vi.fn(async (teamId: string) => teamId === opsTeam.id ? [taskMaster] : [lead, worker]),
      },
      tasks: {
        list: vi.fn(async ({ status, owner }: { status?: string; owner?: string } = {}) => {
          if (status === 'doing' && owner === worker.id) return [activeDoing];
          if (status === 'doing' && owner === lead.id) return [];
          if (status === 'doing') return [activeDoing];
          if (status === 'todo') return [staleTodo];
          return [];
        }),
        getByNameForTeam: vi.fn(async () => staleTodo),
        claim: vi.fn(async () => true),
        updateFields: vi.fn(async () => {}),
      },
      queries: {
        getPending: vi.fn(async () => []),
        getPendingByOwner: vi.fn(async () => []),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-busy-unclaimed-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(db.tasks.claim).not.toHaveBeenCalled();
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'ops-team',
      'task-master',
      expect.stringContaining('Auto-assignment could not find an immediately available executor: no_idle_live_member'),
    );
    expect(manager.sendSupervisionAsk).not.toHaveBeenCalledWith(
      'default',
      'lead',
      expect.any(String),
    );
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      team_id: TEAM_ID,
      topic: 'task:triaged',
      actor_agent_id: 'task-master-id',
      subject_id: '77777777-8888-4777-9666-555555555555',
      data: expect.objectContaining({
        reason: 'unclaimed',
        stalled_minutes: 60,
      }),
    }));
  });

  it('transfers coordinator-owned checkins when auto-assigning unowned todo work', async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const staleTodo = task({
      id: 'todo-checkin-assign',
      name: 'stale-checkin-unclaimed',
      uuid: 'aaaaaaaa-8888-4777-9666-555555555555',
      title: 'Stale checkin unclaimed work',
      status: 'todo',
      owner: null,
      created_by: 'lead-1',
      updated_at: nowSec - 3600,
    });
    const worker = agent({ id: 'worker-2', name: 'worker-b' });
    const lead = agent({ id: 'lead-1', name: 'lead', metadata: { primaryLead: true } });
    const updated = { ...staleTodo, owner: worker.id, status: 'doing' as const, updated_at: nowSec };
    const checkin = {
      id: 'checkin-1',
      team_id: TEAM_ID,
      owner_agent_id: lead.id,
      created_by_agent_id: lead.id,
      linked_task_id: staleTodo.id,
      interval_seconds: 1200,
      priority: 'normal',
      status: 'active',
      close_when: { task_status: ['done'] },
      max_iterations: null,
      iteration_count: 0,
      next_fire_at: NOW_MS + 1200_000,
      snooze_until: null,
      ttl_expires_at: null,
      last_fire_at: null,
      last_event_seq: null,
      note: null,
      created_at: NOW_MS - 3600_000,
      updated_at: NOW_MS - 3600_000,
      closed_at: null,
      closed_reason: null,
    };
    let taskLookupCount = 0;
    const db = fakeDb({
      agents: {
        getById: vi.fn(async (id: string) => id === lead.id ? lead : id === worker.id ? worker : null),
        getByName: vi.fn(async () => lead),
        list: vi.fn(async () => [lead, worker]),
      },
      tasks: {
        list: vi.fn(async ({ status }: { status?: string } = {}) => {
          if (status === 'doing') return [];
          if (status === 'todo') return [staleTodo];
          return [];
        }),
        getByNameForTeam: vi.fn(async () => (++taskLookupCount === 1 ? staleTodo : updated)),
        claim: vi.fn(async () => true),
        updateFields: vi.fn(async () => {}),
      },
      checkins: {
        list: vi.fn(async () => [checkin]),
        updateFields: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-checkin-transfer-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(db.tasks.claim).toHaveBeenCalledWith('todo-checkin-assign', 'worker-2', nowSec, {
      maxDoingForTeam: expect.any(Number),
    });
    expect(db.checkins.updateFields).toHaveBeenCalledWith('checkin-1', TEAM_ID, {
      owner_agent_id: 'worker-2',
      updated_at: NOW_MS,
    });
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'default',
      'worker-b',
      expect.stringContaining('TASK DELEGATION from manager'),
    );
  });

  it('reconciles coordinator-owned checkins on already assigned tasks', async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    const worker = agent({ id: 'worker-2', name: 'worker-b' });
    const lead = agent({ id: 'lead-1', name: 'lead', metadata: { primaryLead: true } });
    const assigned = task({
      id: 'assigned-checkin-task',
      name: 'assigned-checkin-task',
      uuid: 'bbbbbbbb-8888-4777-9666-555555555555',
      title: 'Assigned checkin task',
      status: 'doing',
      owner: worker.id,
      created_by: lead.id,
      updated_at: nowSec,
    });
    const checkin = {
      id: 'checkin-assigned-1',
      team_id: TEAM_ID,
      owner_agent_id: lead.id,
      created_by_agent_id: lead.id,
      linked_task_id: assigned.id,
      interval_seconds: 1200,
      priority: 'normal',
      status: 'active',
      close_when: { task_status: ['done'] },
      max_iterations: null,
      iteration_count: 0,
      next_fire_at: NOW_MS + 1200_000,
      snooze_until: null,
      ttl_expires_at: null,
      last_fire_at: null,
      last_event_seq: null,
      note: null,
      created_at: NOW_MS - 3600_000,
      updated_at: NOW_MS - 3600_000,
      closed_at: null,
      closed_reason: null,
    };
    const db = fakeDb({
      agents: {
        getById: vi.fn(async (id: string) => id === lead.id ? lead : id === worker.id ? worker : null),
        getByName: vi.fn(async () => lead),
        list: vi.fn(async () => [lead, worker]),
      },
      tasks: {
        list: vi.fn(async ({ status }: { status?: string } = {}) => {
          if (status === 'doing') return [assigned];
          if (status === 'todo') return [];
          return [];
        }),
      },
      checkins: {
        list: vi.fn(async () => [checkin]),
        updateFields: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-checkin-reconcile-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(db.checkins.updateFields).toHaveBeenCalledWith('checkin-assigned-1', TEAM_ID, {
      owner_agent_id: 'worker-2',
      updated_at: NOW_MS,
    });
    expect(manager.sendSupervisionAsk).not.toHaveBeenCalled();
  });

  it('does not auto-assign unclaimed todo work when the doing cap is full', async () => {
    process.env.ID_MAX_DOING_TASKS = '1';
    const nowSec = Math.floor(NOW_MS / 1000);
    const activeDoing = task({
      id: 'doing-1',
      name: 'active-work',
      uuid: '11111111-2222-4333-8444-555555555555',
      title: 'Active work',
      status: 'doing',
      owner: 'worker-1',
      updated_at: nowSec,
    });
    const staleTodo = task({
      id: 'todo-full-1',
      name: 'stale-unclaimed',
      uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      title: 'Stale unclaimed work',
      status: 'todo',
      owner: null,
      updated_at: nowSec - 3600,
    });
    const worker = agent({ id: 'worker-1', name: 'worker' });
    const lead = agent({ id: 'lead-1', name: 'lead', metadata: { primaryLead: true } });
    const db = fakeDb({
      agents: {
        getById: vi.fn(async () => worker),
        getByName: vi.fn(async () => lead),
        list: vi.fn(async () => [lead, worker]),
      },
      tasks: {
        list: vi.fn(async ({ status }: { status?: string } = {}) => {
          if (status === 'doing') return [activeDoing];
          if (status === 'todo') return [staleTodo];
          return [];
        }),
        getByNameForTeam: vi.fn(async () => staleTodo),
        claim: vi.fn(async () => true),
        updateFields: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(db.tasks.claim).not.toHaveBeenCalled();
    expect(manager.sendSupervisionAsk).not.toHaveBeenCalled();
    expect(db.events.insert).not.toHaveBeenCalled();
  });

  it('reserves the first sweep slot for old unclaimed todo assignment', async () => {
    process.env.STALL_SWEEP_MAX_PER_SWEEP = '1';
    const nowSec = Math.floor(NOW_MS / 1000);
    const staleDoing = task({
      id: 'doing-stale-1',
      name: 'already-stale',
      uuid: 'bbbbbbbb-2222-4333-8444-555555555555',
      title: 'Already stale work',
      status: 'doing',
      owner: 'busy-worker',
      updated_at: nowSec - 7200,
    });
    const staleTodo = task({
      id: 'todo-priority-1',
      name: 'priority-unclaimed',
      uuid: 'cccccccc-2222-4333-8444-555555555555',
      title: 'Priority unclaimed work',
      status: 'todo',
      owner: null,
      updated_at: nowSec - 3600,
    });
    const busyWorker = agent({ id: 'busy-worker', name: 'busy-worker' });
    const idleWorker = agent({ id: 'idle-worker', name: 'idle-worker' });
    const updated = { ...staleTodo, owner: idleWorker.id, status: 'doing' as const, updated_at: nowSec };
    let taskLookupCount = 0;
    const db = fakeDb({
      agents: {
        getById: vi.fn(async () => busyWorker),
        list: vi.fn(async () => [busyWorker, idleWorker]),
      },
      tasks: {
        list: vi.fn(async ({ status, owner }: { status?: string; owner?: string } = {}) => {
          if (status === 'doing' && owner === busyWorker.id) return [staleDoing];
          if (status === 'doing' && owner === idleWorker.id) return [];
          if (status === 'doing') return [staleDoing];
          if (status === 'todo') return [staleTodo];
          return [];
        }),
        getByNameForTeam: vi.fn(async () => (++taskLookupCount === 1 ? staleTodo : updated)),
        claim: vi.fn(async () => true),
        updateFields: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(db.tasks.claim).toHaveBeenCalledWith('todo-priority-1', 'idle-worker', nowSec, {
      maxDoingForTeam: expect.any(Number),
    });
    expect(manager.sendSupervisionAsk).toHaveBeenCalledTimes(1);
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'default',
      'idle-worker',
      expect.stringContaining('TASK DELEGATION from manager'),
    );
  });

  it('wakes a stopped local owner and sends stalled work back to that owner', async () => {
    const stoppedOwner = agent({
      id: 'worker-1',
      name: 'worker',
      status: 'stopped',
      port: 4210,
      type: 'claude',
      runtime: 'claude-code-cli',
    });
    const db = fakeDb({
      agents: {
        getById: vi.fn(async () => stoppedOwner),
        getByName: vi.fn(async () => agent({ id: 'lead-1', name: 'lead', metadata: { primaryLead: true } })),
        list: vi.fn(async () => [stoppedOwner, agent({ id: 'lead-1', name: 'lead', metadata: { primaryLead: true } })]),
        updateStatus: vi.fn(async () => {}),
      },
      tasks: {
        list: vi.fn(async ({ status }: { status?: string } = {}) => status === 'doing'
          ? [task({ owner: 'worker-1', updated_at: Math.floor(NOW_MS / 1000) - 7200 })]
          : []),
        updateFields: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', db, { libraryRoot: null }) as any;
    manager.spawnLocalAgentProcess = vi.fn(async () => ({ success: true, pid: 1234, logFile: '/tmp/worker.log' }));
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(manager.spawnLocalAgentProcess).toHaveBeenCalledWith(TEAM_ID, 'default', expect.objectContaining({
      id: 'worker-1',
      name: 'worker',
      port: 4210,
    }));
    expect(db.agents.updateStatus).toHaveBeenCalledWith('worker-1', 'running');
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'default',
      'worker',
      expect.stringContaining('You have been restarted for this task'),
    );
    expect(db.events.insert).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'agent:started',
      actor_agent_id: 'worker-1',
      data: expect.objectContaining({
        reason: 'stalled-owner',
      }),
    }));
  });
});
