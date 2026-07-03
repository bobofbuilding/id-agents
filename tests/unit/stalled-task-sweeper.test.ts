// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentManagerDb } from '../../src/agent-manager-db.js';
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

function fakeDb(overrides: Record<string, any> = {}): any {
  return {
    teams: {
      getTeam: vi.fn(async () => team()),
      getConfig: vi.fn(async () => ({})),
      listTeams: vi.fn(async () => []),
      ...overrides.teams,
    },
    agents: {
      getById: vi.fn(async () => agent()),
      getByName: vi.fn(async () => null),
      list: vi.fn(async () => [agent()]),
      ...overrides.agents,
    },
    tasks: {
      list: vi.fn(async ({ status }: { status?: string } = {}) => status === 'doing' ? [task()] : []),
      updateFields: vi.fn(async () => {}),
      ...overrides.tasks,
    },
    checkins: {
      list: vi.fn(async () => []),
      updateFields: vi.fn(async () => {}),
      ...overrides.checkins,
    },
    queries: {
      getPendingByOwner: vi.fn(async () => []),
      ...overrides.queries,
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
    adapter: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
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
    delete process.env.STALL_MAX_PROBES;
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
});
