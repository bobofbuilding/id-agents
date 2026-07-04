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
    vi.restoreAllMocks();
    delete process.env.STALL_SWEEP_MS;
    delete process.env.STALL_RENUDGE_MS;
    delete process.env.STALL_MANUAL_RENUDGE_MS;
    delete process.env.ID_STALL_MANUAL_RENUDGE_MS;
    delete process.env.STALL_SWEEP_MAX_PER_SWEEP;
    delete process.env.STALL_MAX_PROBES;
    delete process.env.ID_UNOWNED_ASSIGN_MIN_MS;
    delete process.env.ID_UNOWNED_ASSIGN_MAX_PER_SWEEP;
    delete process.env.ID_MAX_DOING_TASKS;
  });

  it('delays immediate lead delegation kickoff for fresh second-based tasks', () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    expect(shouldDelayLeadDelegationKickoffForFreshTask(task({
      created_at: nowSec - 30,
      updated_at: nowSec - 30,
    }), NOW_MS)).toBe(true);

    expect(shouldDelayLeadDelegationKickoffForFreshTask(task({
      created_at: nowSec - 180,
      updated_at: nowSec - 180,
    }), NOW_MS)).toBe(false);
  });

  it('delays immediate lead delegation kickoff for fresh millisecond-based tasks', () => {
    expect(shouldDelayLeadDelegationKickoffForFreshTask(task({
      created_at: NOW_MS - 30_000,
      updated_at: NOW_MS - 30_000,
    }), NOW_MS)).toBe(true);

    expect(shouldDelayLeadDelegationKickoffForFreshTask(task({
      created_at: NOW_MS - 180_000,
      updated_at: NOW_MS - 180_000,
    }), NOW_MS)).toBe(false);
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
    expect(db.tasks.updateFields).not.toHaveBeenCalled();
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

  it('does not attach Brain context to control-plane status prompts', async () => {
    const manager = new AgentManagerDb('/tmp/id-agents-brain-context-control-plane-test', fakeDb(), { libraryRoot: null }) as any;

    expect(manager.shouldAttachBrainContext('Backlog guard: task #12345678 is stalled.')).toBe(false);
    expect(manager.shouldAttachBrainContext('TASK DELEGATION from manager: You are assigned task #12345678.')).toBe(false);
    expect(manager.shouldAttachBrainContext('Backlog guard alert: task #12345678 is stalled.')).toBe(false);
    expect(manager.shouldAttachBrainContext('Urgent: task #12345678 has been stalled 88+ minutes on ops-team with no progress.')).toBe(false);
    expect(manager.shouldAttachBrainContext('Status check on task #12345678. Reply in one sentence.')).toBe(false);
    expect(manager.shouldAttachBrainContext('Lead delegation kickoff: task #12345678 is assigned to you as the team coordinator.')).toBe(false);
    expect(manager.shouldAttachBrainContext('Team objective: Decompose this objective into member-owned work.')).toBe(false);
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
            return { rows: [{ seq: 42 }], rowCount: 1 };
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
    const freshActive = task({
      id: 'fresh-active',
      name: 'fresh-active',
      uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      owner: freshOwner.id,
      updated_at: nowSec - 60,
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
          if (status === 'doing' && owner === freshOwner.id) return [freshActive];
          if (status === 'doing') return [staleActive, freshActive];
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
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'default',
      'aaa-stalled',
      expect.stringContaining('New task assignment to you is held'),
    );
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

  it('asks a live team lead to delegate when a lead-owned task has no real child tasks', async () => {
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
    });
    const manager = new AgentManagerDb('/tmp/id-agents-stalled-test', db, { libraryRoot: null }) as any;
    manager.sendSupervisionAsk = vi.fn(async () => true);

    await manager.sweepStalledTasks();

    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'ops-team',
      'ops-lead',
      expect.stringContaining('has no detected member-owned child tasks'),
    );
    expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
      'ops-team',
      'ops-lead',
      expect.stringContaining('delegation probe 1/3'),
    );
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

      expect(manager.sendSupervisionAsk).toHaveBeenCalledWith(
        ownerCase.teamName,
        ownerCase.agent.name,
        expect.stringContaining('has no detected member-owned child tasks'),
      );
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
    expect(db.tasks.updateFields).not.toHaveBeenCalled();
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

  it('routes stalled-owner triage to task-master when the team lead is busy', async () => {
    const unavailableOwner = agent({ status: 'stopped', runtime: 'public-agent-remote' });
    const lead = agent({ id: 'lead-1', name: 'lead', metadata: { primaryLead: true } });
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
    const lead = agent({ id: 'lead-1', name: 'lead', metadata: { primaryLead: true } });
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
    const lead = agent({ id: 'lead-1', name: 'lead', metadata: { primaryLead: true } });
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

  it('parks stopped lead-owned work that missed delegation instead of nudging another lead', async () => {
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
      status: 'todo',
      owner: null,
      updated_at: nowSec,
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
    expect(db.tasks.updateFields).not.toHaveBeenCalled();
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
            return { rows: [{ seq: 99 }], rowCount: 1 };
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
