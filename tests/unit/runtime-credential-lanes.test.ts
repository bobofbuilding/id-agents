// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentManagerDb } from '../../src/agent-manager-db.js';

function fakeDb(overrides: Record<string, any> = {}): any {
  return {
    teams: {
      listTeamsWithConfig: vi.fn(async () => []),
      listTeams: vi.fn(async () => []),
      setRuntimeCredentialPool: vi.fn(async () => {}),
      ...overrides.teams,
    },
    runtimeLaneCooldowns: {
      upsert: vi.fn(async () => {}),
      listActive: vi.fn(async () => []),
      pruneExpired: vi.fn(async () => 0),
      ...overrides.runtimeLaneCooldowns,
    },
    agents: {
      getById: vi.fn(async () => null),
      list: vi.fn(async () => []),
      updateMetadata: vi.fn(async () => {}),
      updateStatus: vi.fn(async () => {}),
      ...overrides.agents,
    },
    queries: {
      getByQueryIdForTeam: vi.fn(async () => null),
      getPending: vi.fn(async () => []),
      create: vi.fn(async () => {}),
      ...overrides.queries,
    },
    news: { add: vi.fn(async () => {}), ...overrides.news },
    events: overrides.events || {},
    adapter: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), ...overrides.adapter },
  };
}

function seedRuntimeLaneCooldown(
  manager: any,
  teamId: string,
  cooldown: Record<string, any> & { laneId: string; runtime: string },
): void {
  manager.runtimeLaneCooldowns.set(
    manager.runtimeLaneCooldownKey(teamId, cooldown.runtime, cooldown.laneId),
    cooldown,
  );
}

describe('runtime credential lanes', () => {
  afterEach(() => {
    delete process.env.ID_RUNTIME_CREDENTIAL_POOL;
    delete process.env.ID_RATE_LIMIT_LOCAL_FALLBACK;
    delete process.env.ID_RATE_LIMIT_LOCAL_MODEL;
    delete process.env.ID_LOCAL_FALLBACK_MODEL;
    delete process.env.ID_RATE_LIMIT_OVERLOAD_COOLDOWN_MS;
    delete process.env.ID_RATE_LIMIT_UNKNOWN_COOLDOWN_MS;
    delete process.env.ID_RATE_LIMIT_CAP_COOLDOWN_MS;
  });

  it('excludes the failed mid-run lane and replays the query on the next lane', async () => {
    const db = fakeDb({
      agents: {
        getById: vi.fn(async () => ({
          team_id: 'team-1',
          id: 'agent-1',
          name: 'worker',
          type: 'claude',
          model: 'sonnet',
          port: 4311,
          endpoint: 'http://localhost:4311',
          working_directory: '/tmp/agent-1',
          status: 'running',
          created_at: 1,
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
        })),
        updateMetadata: vi.fn(async () => {}),
      },
      queries: {
        getByQueryIdForTeam: vi.fn(async () => ({
          team_id: 'team-1',
          agent_id: 'agent-1',
          query_id: 'query-original',
          status: 'pending',
          prompt: 'do the work',
          created: 1,
          completed: null,
          result: null,
          error: null,
          session_id: 'session-1',
          owner_kind: 'agent',
          owner_id: 'agent-1',
          metadata: null,
        })),
        create: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-runtime-test', db, { libraryRoot: null }) as any;
    manager.runtimeCredentialPoolByTeam.set('team-1', {
      lanes: [
        { id: 'sub-a', runtime: 'claude-code-cli', kind: 'subscription' },
        { id: 'sub-b', runtime: 'claude-code-cli', kind: 'subscription' },
        { id: 'metered', runtime: 'claude-code-cli', kind: 'metered-api', env: { ANTHROPIC_API_KEY: 'test-key' } },
      ],
    });
    manager.rebuildLocalClaudeAgent = vi.fn(async () => ({ success: true, pid: 1234 }));
    manager.forwardToAgent = vi.fn(async () => ({ ok: true, data: { query_id: 'query-retry' } }));

    const failover = await manager.handleRuntimeRateLimitFailover('team-1', 'default', {
      laneId: 'sub-a',
      runtime: 'claude-code-cli',
      kind: 'subscription',
      coolingUntilMs: Date.now() + 60_000,
      observedAtMs: Date.now(),
      reason: 'subscription_session_cap_unknown_window',
      teamId: 'team-1',
      agentId: 'agent-1',
      queryId: 'query-original',
    });

    expect(failover).toMatchObject({ attempted: true, success: true, laneId: 'sub-b', retryQueryId: 'query-retry' });
    expect(db.agents.updateMetadata).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      runtimeCredentialLane: 'sub-b',
    }));
    expect(manager.forwardToAgent).toHaveBeenCalledWith(
      'http://localhost:4311',
      'do the work',
      'manager',
      'session-1',
      undefined,
      expect.objectContaining({
        id: 'agent-1',
        team_id: 'team-1',
        runtime: 'claude-code-cli',
      }),
      'default',
    );
    expect(db.queries.create).toHaveBeenCalledWith(
      'team-1',
      'query-retry',
      'agent-1',
      'do the work',
      expect.any(Number),
      'session-1',
      undefined,
      expect.objectContaining({ retry_of: 'query-original', runtimeCredentialLane: 'sub-b' }),
    );
  });

  it('moves a session-capped Claude agent to the next active subscription runtime and replays the query', async () => {
    const agent = {
      team_id: 'team-1',
      id: 'agent-1',
      name: 'hr-manager',
      type: 'claude',
      model: 'claude-opus-4-8',
      port: 4311,
      endpoint: 'http://localhost:4311',
      working_directory: '/tmp/agent-1',
      status: 'running',
      created_at: 1,
      registry: null,
      metadata: { rateLimitSubscriptionRuntimes: ['codex', 'antigravity'] },
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
    };
    const db = fakeDb({
      agents: { getById: vi.fn(async () => agent) },
      queries: {
        getByQueryIdForTeam: vi.fn(async () => ({
          team_id: 'team-1',
          agent_id: agent.id,
          query_id: 'query-original',
          status: 'failed',
          prompt: 'triage the staffing plan',
          created: 1,
          completed: 2,
          result: null,
          error: 'session limit',
          session_id: 'session-1',
          owner_kind: 'agent',
          owner_id: agent.id,
          metadata: null,
        })),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-subscription-runtime-test', db, { libraryRoot: null }) as any;
    manager.isSubscriptionRuntimeActive = vi.fn((runtime: string) => runtime === 'codex');
    manager.rebuildLocalClaudeAgent = vi.fn(async () => ({ success: true, pid: 1234 }));
    manager.forwardToAgent = vi.fn(async () => ({ ok: true, data: { query_id: 'query-retry' } }));

    const failover = await manager.handleRuntimeRateLimitFailover('team-1', 'legal', {
      laneId: 'claude-code-cli:default',
      runtime: 'claude-code-cli',
      kind: 'subscription',
      coolingUntilMs: Date.now() + 60_000,
      observedAtMs: Date.now(),
      reason: 'subscription_session_cap_unknown_window',
      teamId: 'team-1',
      agentId: agent.id,
      queryId: 'query-original',
    });

    expect(failover).toMatchObject({
      attempted: true,
      success: true,
      laneId: 'codex:default',
      retryQueryId: 'query-retry',
    });
    expect(db.agents.updateStatus).toHaveBeenCalledWith(agent.id, 'pending', expect.objectContaining({
      runtime: 'codex',
      metadata: expect.objectContaining({
        runtimeCredentialLane: 'codex:default',
        runtimeRateLimitFailover: expect.objectContaining({
          fromRuntime: 'claude-code-cli',
          toRuntime: 'codex',
          fromLaneId: 'claude-code-cli:default',
        }),
      }),
    }));
    expect(manager.forwardToAgent).toHaveBeenCalledWith(
      'http://localhost:4311',
      'triage the staffing plan',
      'manager',
      'session-1',
      undefined,
      agent,
      'legal',
    );
    expect(db.queries.create).toHaveBeenCalledWith(
      'team-1',
      'query-retry',
      agent.id,
      'triage the staffing plan',
      expect.any(Number),
      'session-1',
      undefined,
      expect.objectContaining({
        retry_of: 'query-original',
        runtime: 'codex',
        runtimeCredentialLane: 'codex:default',
      }),
    );
  });

  it('skips a cooling subscription runtime and selects the next active runtime', () => {
    const manager = new AgentManagerDb('/tmp/id-agents-subscription-order-test', fakeDb(), { libraryRoot: null }) as any;
    seedRuntimeLaneCooldown(manager, 'team-1', {
      laneId: 'codex:default',
      runtime: 'codex',
      kind: 'subscription',
      coolingUntilMs: Date.now() + 60_000,
      observedAtMs: Date.now(),
      reason: 'subscription_monthly_cap',
    });
    manager.isSubscriptionRuntimeActive = vi.fn(() => true);

    const fallback = manager.resolveRateLimitSubscriptionFallback({
      id: 'agent-1',
      name: 'hr-manager',
      runtime: 'claude-code-cli',
      model: 'claude-opus-4-8',
      metadata: { rateLimitSubscriptionRuntimes: ['codex', 'antigravity', 'grok'] },
    }, 'team-1', 'claude-code-cli');

    expect(fallback).toEqual({
      runtime: 'antigravity',
      model: 'Gemini 3.5 Flash (Medium)',
      laneId: 'antigravity:default',
    });
  });

  it('switches Codex models and replays work when the selected model is at capacity', async () => {
    const agent = {
      team_id: 'team-1',
      id: 'agent-1',
      name: 'coder',
      type: 'claude',
      model: 'gpt-5.6-luna',
      port: 4311,
      endpoint: 'http://localhost:4311',
      working_directory: '/tmp/agent-1',
      status: 'running',
      created_at: 1,
      registry: null,
      metadata: {},
      deleted_at: null,
      runtime: 'codex',
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
    };
    const db = fakeDb({
      agents: { getById: vi.fn(async () => agent) },
      queries: {
        getByQueryIdForTeam: vi.fn(async () => ({
          team_id: 'team-1',
          agent_id: agent.id,
          query_id: 'query-original',
          status: 'failed',
          prompt: 'validate the build',
          created: 1,
          completed: 2,
          result: null,
          error: 'Selected model is at capacity. Please try a different model.',
          session_id: 'session-1',
          owner_kind: 'agent',
          owner_id: agent.id,
          metadata: null,
        })),
        create: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-model-capacity-test', db, { libraryRoot: null }) as any;
    manager.rebuildLocalClaudeAgent = vi.fn(async () => ({ success: true, pid: 1234 }));
    manager.forwardToAgent = vi.fn(async () => ({ ok: true, data: { query_id: 'query-retry' } }));

    const failover = await manager.handleRuntimeRateLimitFailover('team-1', 'default', {
      laneId: 'codex:default',
      runtime: 'codex',
      kind: 'subscription',
      coolingUntilMs: Date.now() + 300_000,
      observedAtMs: Date.now(),
      reason: 'model_capacity',
      teamId: 'team-1',
      agentId: agent.id,
      queryId: 'query-original',
    });

    expect(failover).toMatchObject({ attempted: true, success: true, laneId: 'codex:model:gpt-5.5', retryQueryId: 'query-retry' });
    expect(db.agents.updateStatus).toHaveBeenCalledWith(agent.id, 'pending', expect.objectContaining({
      runtime: 'codex',
      model: 'gpt-5.5',
      metadata: expect.objectContaining({
        runtimeRateLimitFailover: expect.objectContaining({ reason: 'model_capacity', fromModel: 'gpt-5.6-luna', toModel: 'gpt-5.5' }),
      }),
    }));
    expect(manager.forwardToAgent).toHaveBeenCalledWith(
      'http://localhost:4311',
      'validate the build',
      'manager',
      'session-1',
      undefined,
      agent,
      'default',
    );
    expect(db.queries.create).toHaveBeenCalledWith(
      'team-1',
      'query-retry',
      agent.id,
      'validate the build',
      expect.any(Number),
      'session-1',
      undefined,
      expect.objectContaining({ retry_of: 'query-original', model: 'gpt-5.5' }),
    );
  });

  it('does not restore a preferred model while the fallback replay is still active', async () => {
    const agent = {
      id: 'agent-1',
      team_id: 'team-1',
      name: 'coder',
      type: 'claude',
      runtime: 'codex',
      model: 'gpt-5.5',
      status: 'running',
      port: 4311,
      metadata: {
        runtimeRateLimitFailover: {
          reason: 'model_capacity',
          fromLaneId: 'codex:model:gpt-5.6-luna',
          fromRuntime: 'codex',
          toRuntime: 'codex',
          fromModel: 'gpt-5.6-luna',
          toModel: 'gpt-5.5',
        },
      },
    } as any;
    const db = fakeDb({
      queries: {
        getPending: vi.fn(async () => [{ query_id: 'query-retry', status: 'processing' }]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-model-capacity-active-restore-test', db, { libraryRoot: null }) as any;

    await expect(manager.restoreAgentFromRateLimitFallbackIfReady('team-1', 'default', agent, Date.now()))
      .resolves.toBe(false);
    expect(db.agents.updateStatus).not.toHaveBeenCalled();
  });

  it('hydrates team-config credential pools and active DB cooldowns', async () => {
    const future = Date.now() + 60_000;
    const db = fakeDb({
      teams: {
        listTeamsWithConfig: vi.fn(async () => [{
          id: 'team-1',
          name: 'default',
          config: {
            runtimeCredentialPool: {
              lanes: [
                { id: 'sub-a', runtime: 'claude-code-cli', kind: 'subscription' },
                { id: 'sub-b', runtime: 'claude-code-cli', kind: 'subscription' },
                { id: 'metered', runtime: 'claude-code-cli', kind: 'metered-api' },
              ],
            },
          },
          port_start: 4101,
          port_end: 4125,
          created_at: 'now',
        }]),
        setRuntimeCredentialPool: vi.fn(async () => {}),
      },
      runtimeLaneCooldowns: {
        pruneExpired: vi.fn(async () => 1),
        listActive: vi.fn(async () => [{
          lane_id: 'sub-a',
          runtime: 'claude-code-cli',
          kind: 'subscription',
          cooling_until_ms: future,
          observed_at_ms: future - 1000,
          reason: 'api_rate_limit',
          team_id: 'team-1',
          agent_id: 'agent-1',
          agent_name: 'worker',
          query_id: 'query-original',
          reset_text: null,
          message: null,
        }]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-runtime-test', db, { libraryRoot: null }) as any;

    await manager.hydrateRuntimeStateFromTeams();

    expect(manager.runtimeCredentialLanes('claude-code-cli', 'team-1').map((lane: any) => lane.id)).toEqual(['sub-a', 'sub-b', 'metered']);
    const laneKey = manager.runtimeLaneCooldownKey('team-1', 'claude-code-cli', 'sub-a');
    expect(manager.runtimeLaneCooldowns.has(laneKey)).toBe(true);
    expect(manager.runtimeLaneCooldowns.get(laneKey)).toMatchObject({ queryId: 'query-original', coolingUntilMs: future });
    expect(db.runtimeLaneCooldowns.pruneExpired).toHaveBeenCalledWith(expect.any(Number));
    expect(db.runtimeLaneCooldowns.listActive).toHaveBeenCalledWith(expect.any(Number));
  });

  it('does not cool another team that uses the same raw lane id', async () => {
    const db = fakeDb();
    const manager = new AgentManagerDb('/tmp/id-agents-runtime-team-namespace-test', db, { libraryRoot: null }) as any;
    const pool = {
      lanes: [
        { id: 'shared-subscription', runtime: 'claude-code-cli', kind: 'subscription' },
        { id: 'backup-subscription', runtime: 'claude-code-cli', kind: 'subscription' },
      ],
    };
    manager.runtimeCredentialPoolByTeam.set('team-a', pool);
    manager.runtimeCredentialPoolByTeam.set('team-b', pool);

    await manager.recordRuntimeRateLimit('team-a', {
      runtime: 'claude-code-cli',
      laneId: 'shared-subscription',
      rateLimit: {
        reason: 'subscription_monthly_cap',
        retryAfterSeconds: 60,
      },
    });

    expect(manager.chooseRuntimeCredentialLane('claude-code-cli', undefined, 'team-a').id)
      .toBe('backup-subscription');
    expect(manager.chooseRuntimeCredentialLane('claude-code-cli', undefined, 'team-b').id)
      .toBe('shared-subscription');
    expect(db.runtimeLaneCooldowns.upsert).toHaveBeenCalledWith(expect.objectContaining({
      team_id: 'team-a',
      runtime: 'claude-code-cli',
      runtime_namespace: 'claude-code-cli',
      lane_id: 'shared-subscription',
    }));
  });

  it('does not collide when different canonical runtimes reuse the same raw lane id', async () => {
    const manager = new AgentManagerDb('/tmp/id-agents-runtime-runtime-namespace-test', fakeDb(), { libraryRoot: null }) as any;
    manager.runtimeCredentialPoolByTeam.set('team-1', {
      lanes: [
        { id: 'shared', runtime: 'codex', kind: 'subscription' },
        { id: 'codex-backup', runtime: 'codex', kind: 'subscription' },
        { id: 'shared', runtime: 'claude-code-cli', kind: 'subscription' },
        { id: 'claude-backup', runtime: 'claude-code-cli', kind: 'subscription' },
      ],
    });

    await manager.recordRuntimeRateLimit('team-1', {
      runtime: 'codex',
      laneId: 'shared',
      rateLimit: {
        reason: 'subscription_monthly_cap',
        retryAfterSeconds: 60,
      },
    });

    expect(manager.chooseRuntimeCredentialLane('codex', undefined, 'team-1').id)
      .toBe('codex-backup');
    expect(manager.chooseRuntimeCredentialLane('claude-code-cli', undefined, 'team-1').id)
      .toBe('shared');
  });

  it('hydrates a cooldown under its persisted owner and restores another team independently', async () => {
    const now = Date.now();
    const pool = {
      lanes: [
        { id: 'shared-subscription', runtime: 'claude-code-cli', kind: 'subscription' },
        { id: 'backup-subscription', runtime: 'claude-code-cli', kind: 'subscription' },
      ],
    };
    const db = fakeDb({
      teams: {
        listTeamsWithConfig: vi.fn(async () => [
          { id: 'team-a', name: 'Team A', config: { runtimeCredentialPool: pool } },
          { id: 'team-b', name: 'Team B', config: { runtimeCredentialPool: pool } },
        ]),
      },
      runtimeLaneCooldowns: {
        listActive: vi.fn(async () => [{
          lane_id: 'shared-subscription',
          runtime: 'claude-code-cli',
          runtime_namespace: 'claude-code-cli',
          kind: 'subscription',
          cooling_until_ms: now + 60_000,
          observed_at_ms: now,
          reason: 'subscription_monthly_cap',
          team_id: 'team-a',
          agent_id: 'agent-a',
          agent_name: 'worker-a',
          query_id: 'query-a',
          reset_text: null,
          message: null,
        }]),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-runtime-owner-hydration-test', db, { libraryRoot: null }) as any;
    manager.rebuildLocalClaudeAgent = vi.fn(async () => ({ success: true, pid: 1234 }));

    await manager.hydrateRuntimeStateFromTeams();

    expect(manager.isRuntimeLaneCooling(
      'team-a',
      'claude-code-cli',
      'shared-subscription',
      now,
    )).toBe(true);
    expect(manager.isRuntimeLaneCooling(
      'team-b',
      'claude-code-cli',
      'shared-subscription',
      now,
    )).toBe(false);

    const restored = await manager.restoreAgentFromRateLimitFallbackIfReady(
      'team-b',
      'Team B',
      {
        team_id: 'team-b',
        id: 'agent-b',
        name: 'worker-b',
        type: 'claude',
        model: 'claude-sonnet-5',
        port: 4312,
        endpoint: 'http://localhost:4312',
        working_directory: '/tmp/agent-b',
        status: 'running',
        created_at: 1,
        registry: null,
        metadata: {
          runtimeCredentialLane: 'backup-subscription',
          runtimeRateLimitFailover: {
            fromLaneId: 'shared-subscription',
            toLaneId: 'backup-subscription',
          },
        },
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
      },
      now,
    );

    expect(restored).toBe(true);
    expect(db.agents.updateStatus).toHaveBeenCalledWith('agent-b', 'pending', expect.objectContaining({
      metadata: expect.objectContaining({ runtimeCredentialLane: 'shared-subscription' }),
    }));
  });

  it('falls back to a local model before metered overflow when every subscription lane hits a daily/weekly subscription cap', async () => {
    process.env.ID_RATE_LIMIT_LOCAL_MODEL = 'llama3.2:3b';
    const db = fakeDb({
      agents: {
        getById: vi.fn(async () => ({
          team_id: 'team-1',
          id: 'agent-1',
          name: 'worker',
          type: 'claude',
          model: 'sonnet',
          port: 4311,
          endpoint: 'http://localhost:4311',
          working_directory: '/tmp/agent-1',
          status: 'running',
          created_at: 1,
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
        })),
        updateMetadata: vi.fn(async () => {}),
        updateStatus: vi.fn(async () => {}),
      },
      queries: {
        getByQueryIdForTeam: vi.fn(async () => ({
          team_id: 'team-1',
          agent_id: 'agent-1',
          query_id: 'query-original',
          status: 'pending',
          prompt: 'do the work',
          created: 1,
          completed: null,
          result: null,
          error: null,
          session_id: 'session-1',
          owner_kind: 'agent',
          owner_id: 'agent-1',
          metadata: null,
        })),
        create: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-runtime-test', db, { libraryRoot: null }) as any;
    manager.isSubscriptionRuntimeActive = vi.fn(() => false);
    manager.runtimeCredentialPoolByTeam.set('team-1', {
      lanes: [
        { id: 'sub-a', runtime: 'claude-code-cli', kind: 'subscription' },
        { id: 'sub-b', runtime: 'claude-code-cli', kind: 'subscription' },
        { id: 'metered', runtime: 'claude-code-cli', kind: 'metered-api', env: { ANTHROPIC_API_KEY: 'test-key' } },
      ],
    });
    seedRuntimeLaneCooldown(manager, 'team-1', {
      laneId: 'sub-b',
      runtime: 'claude-code-cli',
      kind: 'subscription',
      coolingUntilMs: Date.now() + 60_000,
      observedAtMs: Date.now(),
      reason: 'subscription_weekly_cap',
      teamId: 'team-1',
    });
    manager.rebuildLocalClaudeAgent = vi.fn(async () => ({ success: true, pid: 1234 }));
    manager.forwardToAgent = vi.fn(async () => ({ ok: true, data: { query_id: 'query-retry' } }));

    const failover = await manager.handleRuntimeRateLimitFailover('team-1', 'default', {
      laneId: 'sub-a',
      runtime: 'claude-code-cli',
      kind: 'subscription',
      coolingUntilMs: Date.now() + 60_000,
      observedAtMs: Date.now(),
      reason: 'subscription_weekly_cap',
      teamId: 'team-1',
      agentId: 'agent-1',
      queryId: 'query-original',
    });

    expect(failover).toMatchObject({ attempted: true, success: true, laneId: 'ollama:rate-limit-local', retryQueryId: 'query-retry' });
    expect(db.agents.updateStatus).toHaveBeenCalledWith('agent-1', 'pending', expect.objectContaining({
      runtime: 'ollama',
      model: 'llama3.2:3b',
      metadata: expect.objectContaining({
        previousRuntimeBeforeRateLimit: 'claude-code-cli',
        previousModelBeforeRateLimit: 'sonnet',
        runtimeRateLimitFailover: expect.objectContaining({
          toRuntime: 'ollama',
          toModel: 'llama3.2:3b',
          toLaneId: 'ollama:rate-limit-local',
        }),
      }),
    }));
    expect(manager.rebuildLocalClaudeAgent).toHaveBeenCalledWith(
      'team-1',
      'default',
      expect.objectContaining({ runtime: 'ollama', model: 'llama3.2:3b' }),
    );
    expect(db.queries.create).toHaveBeenCalledWith(
      'team-1',
      'query-retry',
      'agent-1',
      'do the work',
      expect.any(Number),
      'session-1',
      undefined,
      expect.objectContaining({ retry_of: 'query-original', runtime: 'ollama', model: 'llama3.2:3b' }),
    );
  });

  it('falls back to a local model for non-Claude cloud subscription daily/weekly caps', async () => {
    process.env.ID_RATE_LIMIT_LOCAL_MODEL = 'qwen3:4b';
    const db = fakeDb({
      agents: {
        getById: vi.fn(async () => ({
          team_id: 'team-1',
          id: 'agent-1',
          name: 'worker',
          type: 'claude',
          model: 'gpt-5.3',
          port: 4311,
          endpoint: 'http://localhost:4311',
          working_directory: '/tmp/agent-1',
          status: 'running',
          created_at: 1,
          registry: null,
          metadata: {},
          deleted_at: null,
          runtime: 'codex',
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
        })),
        updateMetadata: vi.fn(async () => {}),
        updateStatus: vi.fn(async () => {}),
      },
      queries: {
        getByQueryIdForTeam: vi.fn(async () => ({
          team_id: 'team-1',
          agent_id: 'agent-1',
          query_id: 'query-original',
          status: 'pending',
          prompt: 'do the work',
          created: 1,
          completed: null,
          result: null,
          error: null,
          session_id: null,
          owner_kind: 'agent',
          owner_id: 'agent-1',
          metadata: null,
        })),
        create: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-runtime-test', db, { libraryRoot: null }) as any;
    manager.isSubscriptionRuntimeActive = vi.fn(() => false);
    manager.rebuildLocalClaudeAgent = vi.fn(async () => ({ success: true, pid: 1234 }));
    manager.forwardToAgent = vi.fn(async () => ({ ok: true, data: { query_id: 'query-retry' } }));

    const failover = await manager.handleRuntimeRateLimitFailover('team-1', 'default', {
      laneId: 'codex:default',
      runtime: 'codex',
      kind: 'subscription',
      coolingUntilMs: Date.now() + 60_000,
      observedAtMs: Date.now(),
      reason: 'subscription_daily_cap',
      teamId: 'team-1',
      agentId: 'agent-1',
      queryId: 'query-original',
    });

    expect(failover).toMatchObject({ attempted: true, success: true, laneId: 'ollama:rate-limit-local', retryQueryId: 'query-retry' });
    expect(db.agents.updateStatus).toHaveBeenCalledWith('agent-1', 'pending', expect.objectContaining({
      runtime: 'ollama',
      model: 'qwen3:4b',
    }));
  });

  it.each(['api_rate_limit', 'api_overloaded', 'unknown_rate_limit'] as const)(
    'does not pivot non-Claude cloud runtimes to a local model for %s',
    async (reason) => {
    process.env.ID_RATE_LIMIT_LOCAL_MODEL = 'qwen3:4b';
    const db = fakeDb({
      agents: {
        getById: vi.fn(async () => ({
          team_id: 'team-1',
          id: 'agent-1',
          name: 'lead',
          type: 'claude',
          model: 'gpt-5.5',
          port: 4311,
          endpoint: 'http://localhost:4311',
          working_directory: '/tmp/agent-1',
          status: 'running',
          created_at: 1,
          registry: null,
          metadata: { primaryLead: true },
          deleted_at: null,
          runtime: 'codex',
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
        })),
        updateStatus: vi.fn(async () => {}),
      },
      queries: {
        getByQueryIdForTeam: vi.fn(async () => ({
          team_id: 'team-1',
          agent_id: 'agent-1',
          query_id: 'query-original',
          status: 'failed',
          prompt: 'do the work',
          created: 1,
          completed: 2,
          result: null,
          error: 'rate limited',
          session_id: 'session-1',
          owner_kind: 'agent',
          owner_id: 'agent-1',
          metadata: null,
        })),
        create: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-runtime-test', db, { libraryRoot: null }) as any;
    manager.rebuildLocalClaudeAgent = vi.fn(async () => ({ success: true, pid: 1234 }));
    manager.forwardToAgent = vi.fn(async () => ({ ok: true, data: { query_id: 'query-retry' } }));

    const failover = await manager.handleRuntimeRateLimitFailover('team-1', 'default', {
      laneId: 'codex:default',
      runtime: 'codex',
      kind: 'subscription',
      coolingUntilMs: Date.now() + 60_000,
      observedAtMs: Date.now(),
      reason,
      teamId: 'team-1',
      agentId: 'agent-1',
      queryId: 'query-original',
    });

      expect(failover).toEqual({ attempted: false });
      expect(db.agents.updateStatus).not.toHaveBeenCalled();
      expect(manager.rebuildLocalClaudeAgent).not.toHaveBeenCalled();
      expect(manager.forwardToAgent).not.toHaveBeenCalled();
    },
  );

  it('does not use local fallback for session or monthly caps when subscription lanes are unavailable', async () => {
    process.env.ID_RATE_LIMIT_LOCAL_MODEL = 'qwen3:4b';
    const db = fakeDb({
      agents: {
        getById: vi.fn(async () => ({
          team_id: 'team-1',
          id: 'agent-1',
          name: 'lead',
          type: 'claude',
          model: 'sonnet',
          port: 4311,
          endpoint: 'http://localhost:4311',
          working_directory: '/tmp/agent-1',
          status: 'running',
          created_at: 1,
          registry: null,
          metadata: { primaryLead: true },
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
        })),
        updateMetadata: vi.fn(async () => {}),
        updateStatus: vi.fn(async () => {}),
      },
      queries: {
        getByQueryIdForTeam: vi.fn(async () => ({
          team_id: 'team-1',
          agent_id: 'agent-1',
          query_id: 'query-original',
          status: 'pending',
          prompt: 'do the work',
          created: 1,
          completed: null,
          result: null,
          error: null,
          session_id: 'session-1',
          owner_kind: 'agent',
          owner_id: 'agent-1',
          metadata: null,
        })),
        create: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-runtime-test', db, { libraryRoot: null }) as any;
    manager.isSubscriptionRuntimeActive = vi.fn(() => false);
    manager.runtimeCredentialPoolByTeam.set('team-1', {
      lanes: [
        { id: 'sub-a', runtime: 'claude-code-cli', kind: 'subscription' },
        { id: 'sub-b', runtime: 'claude-code-cli', kind: 'subscription' },
        { id: 'metered', runtime: 'claude-code-cli', kind: 'metered-api', env: { ANTHROPIC_API_KEY: 'test-key' } },
      ],
    });
    seedRuntimeLaneCooldown(manager, 'team-1', {
      laneId: 'sub-b',
      runtime: 'claude-code-cli',
      kind: 'subscription',
      coolingUntilMs: Date.now() + 60_000,
      observedAtMs: Date.now(),
      reason: 'subscription_monthly_cap',
      teamId: 'team-1',
    });
    manager.rebuildLocalClaudeAgent = vi.fn(async () => ({ success: true, pid: 1234 }));
    manager.forwardToAgent = vi.fn(async () => ({ ok: true, data: { query_id: 'query-retry' } }));

    const failover = await manager.handleRuntimeRateLimitFailover('team-1', 'default', {
      laneId: 'sub-a',
      runtime: 'claude-code-cli',
      kind: 'subscription',
      coolingUntilMs: Date.now() + 60_000,
      observedAtMs: Date.now(),
      reason: 'subscription_session_cap_unknown_window',
      teamId: 'team-1',
      agentId: 'agent-1',
      queryId: 'query-original',
    });

    expect(failover).toMatchObject({ attempted: true, success: true, laneId: 'metered', retryQueryId: 'query-retry' });
    expect(db.agents.updateStatus).not.toHaveBeenCalledWith('agent-1', 'pending', expect.objectContaining({ runtime: 'ollama' }));
    expect(db.agents.updateMetadata).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      runtimeCredentialLane: 'metered',
    }));
    expect(manager.rebuildLocalClaudeAgent).toHaveBeenCalledWith(
      'team-1',
      'default',
      expect.objectContaining({ runtime: 'claude-code-cli', model: 'sonnet' }),
    );
  });

  it('uses short probe cooldowns for unclassified limits and keeps explicit reset times', async () => {
    const manager = new AgentManagerDb('/tmp/id-agents-runtime-test', fakeDb(), { libraryRoot: null }) as any;
    const before = Date.now();
    const unknownUntil = manager.parseCooldownUntilMs({ reason: 'unknown_rate_limit' });
    expect(unknownUntil).toBeGreaterThanOrEqual(before + 5 * 60_000);
    expect(unknownUntil).toBeLessThanOrEqual(Date.now() + 5 * 60_000 + 100);

    const resetAt = new Date(Date.now() + 47 * 60_000).toISOString();
    expect(manager.parseCooldownUntilMs({ reason: 'unknown_rate_limit', resetAt })).toBe(Date.parse(resetAt));
  });

  it('bounds and canonicalizes untrusted managed-worker cooldown telemetry', () => {
    const manager = new AgentManagerDb('/tmp/id-agents-runtime-test', fakeDb(), { libraryRoot: null }) as any;
    const before = Date.now();
    const normalized = manager.normalizeManagedRuntimeRateLimit({
      isRateLimit: true,
      source: 'forged-source',
      status: 999,
      reason: 'forged-reason',
      retryAfterSeconds: 999_999_999,
      resetAt: '2999-01-01T00:00:00.000Z',
      resetText: `reset\u0000${'x'.repeat(1_000)}`,
      message: `message\u0000${'m'.repeat(4_000)}`,
      secret: 'must-not-survive',
    });

    expect(normalized).toMatchObject({
      isRateLimit: true,
      source: 'text-fallback',
      reason: 'unknown_rate_limit',
      retryAfterSeconds: 8 * 24 * 60 * 60,
    });
    expect(normalized).not.toHaveProperty('status');
    expect(normalized).not.toHaveProperty('resetAt');
    expect(normalized).not.toHaveProperty('secret');
    expect(normalized.resetText).toHaveLength(500);
    expect(normalized.message).toHaveLength(2_000);
    expect(manager.parseCooldownUntilMs(normalized)).toBeGreaterThan(before);
    expect(manager.parseCooldownUntilMs(normalized)).toBeLessThanOrEqual(
      Date.now() + 8 * 24 * 60 * 60_000,
    );
  });

  it('selects local fallback models from agent responsibilities when no override is set', async () => {
    const manager = new AgentManagerDb('/tmp/id-agents-runtime-test', fakeDb(), { libraryRoot: null }) as any;
    manager.listInstalledOllamaModels = vi.fn(() => ['qwen3:4b', 'qwen3:14b', 'qwen2.5-coder:7b', 'qwen3:1.7b', 'gemma3:4b']);

    const baseAgent = {
      team_id: 'team-1',
      id: 'agent-1',
      type: 'claude',
      port: 4311,
      endpoint: 'http://localhost:4311',
      working_directory: '/tmp/agent-1',
      status: 'running',
      created_at: 1,
      registry: null,
      deleted_at: null,
      runtime: 'codex',
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
    };

    expect(manager.resolveRateLimitLocalFallback({
      ...baseAgent,
      id: 'lead-1',
      name: 'lead',
      model: 'gpt-5.5',
      metadata: { primaryLead: true, catalog: { expertise: ['orchestration', 'delegation'] } },
    })).toMatchObject({ runtime: 'ollama', model: 'qwen3:14b' });

    expect(manager.resolveRateLimitLocalFallback({
      ...baseAgent,
      id: 'coder-1',
      name: 'backend-engineer',
      model: 'gpt-5.4-mini',
      metadata: { catalog: { expertise: ['code-implementation', 'node-esm', 'sqlite'] } },
    })).toMatchObject({ runtime: 'ollama', model: 'qwen2.5-coder:7b' });

    expect(manager.resolveRateLimitLocalFallback({
      ...baseAgent,
      id: 'team-lead-1',
      name: 'engineering-lead',
      model: 'gpt-5.4-mini',
      metadata: { catalog: { expertise: ['orchestration', 'team-coordination', 'delegation', 'technical-architecture-review'] } },
    })).toMatchObject({ runtime: 'ollama', model: 'qwen3:4b' });

    expect(manager.resolveRateLimitLocalFallback({
      ...baseAgent,
      id: 'monitor-1',
      name: 'protocol-monitor',
      model: 'gpt-5.4-mini',
      metadata: { catalog: { expertise: ['monitoring', 'event-streaming', 'incident-response'] } },
    })).toMatchObject({ runtime: 'ollama', model: 'qwen3:1.7b' });

    expect(manager.resolveRateLimitLocalFallback({
      ...baseAgent,
      id: 'namespaced-lane-1',
      name: 'specialist',
      model: 'gpt-5.4-mini',
      metadata: { catalog: { tenantPrimaryLane: 'security engineering' } },
    })).toMatchObject({ runtime: 'ollama', model: 'qwen2.5-coder:7b' });

    expect(manager.resolveRateLimitLocalFallback({
      ...baseAgent,
      id: 'namespaced-lane-2',
      name: 'specialist',
      model: 'gpt-5.4-mini',
      metadata: { catalog: { tenantSecondaryLanes: ['monitoring', 'incident response'] } },
    })).toMatchObject({ runtime: 'ollama', model: 'qwen3:1.7b' });
  });

  it('honors per-agent local fallback metadata before inferred responsibility', async () => {
    const manager = new AgentManagerDb('/tmp/id-agents-runtime-test', fakeDb(), { libraryRoot: null }) as any;
    manager.listInstalledOllamaModels = vi.fn(() => ['qwen3:4b', 'qwen2.5-coder:7b']);

    expect(manager.resolveRateLimitLocalFallback({
      team_id: 'team-1',
      id: 'agent-1',
      name: 'backend-engineer',
      type: 'claude',
      model: 'gpt-5.4-mini',
      port: 4311,
      endpoint: 'http://localhost:4311',
      working_directory: '/tmp/agent-1',
      status: 'running',
      created_at: 1,
      registry: null,
      metadata: { rateLimitLocalModel: 'qwen3:4b', catalog: { expertise: ['code-implementation'] } },
      deleted_at: null,
      runtime: 'codex',
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
    })).toMatchObject({ runtime: 'ollama', model: 'qwen3:4b' });
  });

  it('restores agents to their original runtime after the cooldown expires', async () => {
    const fallbackAgent = {
      team_id: 'team-1',
      id: 'agent-1',
      name: 'engineering-lead',
      type: 'claude',
      model: 'qwen3:4b',
      port: 4311,
      endpoint: 'http://localhost:4311',
      working_directory: '/tmp/agent-1',
      status: 'running',
      created_at: 1,
      registry: null,
      metadata: {
        runtimeRateLimitFailover: {
          fromLaneId: 'claude-code-cli:default',
          toLaneId: 'ollama:rate-limit-local',
          fromRuntime: 'claude-code-cli',
          toRuntime: 'ollama',
          fromModel: 'claude-sonnet-5',
          toModel: 'qwen3:4b',
          queryId: 'query-original',
          observedAtMs: Date.now() - 60_000,
        },
        previousRuntimeBeforeRateLimit: 'claude-code-cli',
        previousModelBeforeRateLimit: 'claude-sonnet-5',
        runtimeRateLimit: { laneId: 'claude-code-cli:default' },
      },
      deleted_at: null,
      runtime: 'ollama',
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
    };
    const db = fakeDb({
      teams: {
        listTeams: vi.fn(async () => [{ id: 'team-1', name: 'engineering-team' }]),
      },
      agents: {
        getById: vi.fn(async () => fallbackAgent),
        list: vi.fn(async () => [fallbackAgent]),
        updateStatus: vi.fn(async () => {}),
        updateMetadata: vi.fn(async () => {}),
      },
      news: {
        add: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-runtime-test', db, { libraryRoot: null }) as any;
    manager.runtimeLaneCooldowns.clear();
    manager.rebuildLocalClaudeAgent = vi.fn(async () => ({ success: true, pid: 1234 }));

    await manager.sweepRuntimeRateLimitFallbackRestores(true);

    expect(db.agents.updateStatus).toHaveBeenCalledWith('agent-1', 'pending', expect.objectContaining({
      runtime: 'claude-code-cli',
      model: 'claude-sonnet-5',
      metadata: expect.objectContaining({
        runtimeRateLimitRestore: expect.objectContaining({
          toRuntime: 'claude-code-cli',
          toModel: 'claude-sonnet-5',
          laneId: 'claude-code-cli:default',
        }),
      }),
    }));
    const metadata = db.agents.updateStatus.mock.calls[0][2].metadata;
    expect(metadata.runtimeRateLimitFailover).toBeUndefined();
    expect(metadata.runtimeRateLimit).toBeUndefined();
    expect(metadata.runtimeCredentialLane).toBe('claude-code-cli:default');
    expect(manager.rebuildLocalClaudeAgent).toHaveBeenCalledWith(
      'team-1',
      'engineering-team',
      expect.objectContaining({ runtime: 'claude-code-cli', model: 'claude-sonnet-5' }),
    );
  });

  it('restores a cross-subscription fallback to its original runtime after cooldown', async () => {
    const now = Date.now();
    const fallbackAgent = {
      team_id: 'team-1',
      id: 'agent-1',
      name: 'hr-manager',
      type: 'claude',
      model: '',
      port: 4311,
      endpoint: 'http://localhost:4311',
      working_directory: '/tmp/agent-1',
      status: 'running',
      created_at: 1,
      registry: null,
      metadata: {
        runtimeCredentialLane: 'codex:default',
        runtimeRateLimitFailover: {
          fromLaneId: 'claude-code-cli:default',
          failedLaneId: 'claude-code-cli:default',
          toLaneId: 'codex:default',
          fromRuntime: 'claude-code-cli',
          toRuntime: 'codex',
          fromModel: 'claude-opus-4-8',
          toModel: '',
          reason: 'subscription_session_cap_unknown_window',
        },
      },
      deleted_at: null,
      runtime: 'codex',
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
    };
    const db = fakeDb({ agents: { updateStatus: vi.fn(async () => {}) } });
    const manager = new AgentManagerDb('/tmp/id-agents-cross-runtime-restore-test', db, { libraryRoot: null }) as any;
    manager.rebuildLocalClaudeAgent = vi.fn(async () => ({ success: true, pid: 1234 }));

    const restored = await manager.restoreAgentFromRateLimitFallbackIfReady('team-1', 'legal', fallbackAgent, now);

    expect(restored).toBe(true);
    expect(db.agents.updateStatus).toHaveBeenCalledWith(fallbackAgent.id, 'pending', expect.objectContaining({
      runtime: 'claude-code-cli',
      model: 'claude-opus-4-8',
      metadata: expect.objectContaining({
        runtimeCredentialLane: 'claude-code-cli:default',
        runtimeRateLimitRestore: expect.objectContaining({
          fromRuntime: 'codex',
          toRuntime: 'claude-code-cli',
        }),
      }),
    }));
  });

  it('does not restore agents while the original lane is still cooling', async () => {
    const now = Date.now();
    const fallbackAgent = {
      team_id: 'team-1',
      id: 'agent-1',
      name: 'engineering-lead',
      type: 'claude',
      model: 'qwen3:4b',
      port: 4311,
      endpoint: 'http://localhost:4311',
      working_directory: '/tmp/agent-1',
      status: 'running',
      created_at: 1,
      registry: null,
      metadata: {
        runtimeRateLimitFailover: {
          fromLaneId: 'claude-code-cli:default',
          toLaneId: 'ollama:rate-limit-local',
          fromRuntime: 'claude-code-cli',
          toRuntime: 'ollama',
          fromModel: 'claude-sonnet-5',
          toModel: 'qwen3:4b',
        },
      },
      deleted_at: null,
      runtime: 'ollama',
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
    };
    const db = fakeDb({
      agents: {
        updateStatus: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-runtime-test', db, { libraryRoot: null }) as any;
    seedRuntimeLaneCooldown(manager, 'team-1', {
      laneId: 'claude-code-cli:default',
      runtime: 'claude-code-cli',
      kind: 'subscription',
      coolingUntilMs: now + 60_000,
      observedAtMs: now,
      reason: 'subscription_monthly_cap',
      teamId: 'team-1',
      agentId: 'agent-1',
    });

    await manager.restoreAgentFromRateLimitFallbackIfReady('team-1', 'engineering-team', fallbackAgent, now);

    expect(db.agents.updateStatus).not.toHaveBeenCalled();
  });

  it('restores same-runtime credential failovers to the preferred subscription lane', async () => {
    const now = Date.now();
    const agent = {
      team_id: 'team-1',
      id: 'agent-1',
      name: 'lead',
      type: 'claude',
      model: 'claude-sonnet-5',
      port: 4311,
      endpoint: 'http://localhost:4311',
      working_directory: '/tmp/agent-1',
      status: 'running',
      created_at: 1,
      registry: null,
      metadata: {
        runtimeCredentialLane: 'claude-code-cli:metered-overflow',
        runtimeRateLimitFailover: {
          fromLaneId: 'claude-code-cli:metered-overflow',
          toLaneId: 'claude-code-cli:metered-overflow',
          queryId: 'query-original',
        },
      },
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
    };
    const db = fakeDb({
      agents: {
        updateStatus: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-runtime-test', db, { libraryRoot: null }) as any;
    manager.runtimeLaneCooldowns.clear();
    manager.rebuildLocalClaudeAgent = vi.fn(async () => ({ success: true, pid: 1234 }));

    const restored = await manager.restoreAgentFromRateLimitFallbackIfReady('team-1', 'default', agent, now);

    expect(restored).toBe(true);
    expect(db.agents.updateStatus).toHaveBeenCalledWith('agent-1', 'pending', expect.objectContaining({
      runtime: 'claude-code-cli',
      model: 'claude-sonnet-5',
      metadata: expect.objectContaining({
        runtimeCredentialLane: 'claude-code-cli:default',
        runtimeRateLimitRestore: expect.objectContaining({
          fromLaneId: 'claude-code-cli:metered-overflow',
          laneId: 'claude-code-cli:default',
        }),
      }),
    }));
    expect(manager.rebuildLocalClaudeAgent).toHaveBeenCalledWith(
      'team-1',
      'default',
      expect.objectContaining({
        runtime: 'claude-code-cli',
        model: 'claude-sonnet-5',
        metadata: expect.objectContaining({ runtimeCredentialLane: 'claude-code-cli:default' }),
      }),
    );
  });

  it('cleans stale local-fallback restore metadata when an agent already left Ollama', async () => {
    const now = Date.now();
    const agent = {
      team_id: 'team-1',
      id: 'agent-1',
      name: 'lead',
      type: 'claude',
      model: 'gpt-5.5',
      port: 4311,
      endpoint: 'http://localhost:4311',
      working_directory: '/tmp/agent-1',
      status: 'running',
      created_at: 1,
      registry: null,
      metadata: {
        runtimeRateLimitFailover: {
          fromLaneId: 'claude-code-cli:default',
          toLaneId: 'ollama:rate-limit-local',
          fromRuntime: 'claude-code-cli',
          toRuntime: 'ollama',
          fromModel: 'claude-fable-5',
          toModel: 'qwen3:14b',
        },
        previousRuntimeBeforeRateLimit: 'claude-code-cli',
        previousModelBeforeRateLimit: 'claude-fable-5',
        runtimeRateLimitRestore: {
          fromRuntime: 'ollama',
          fromModel: 'qwen3:14b',
          toRuntime: 'codex',
          toModel: 'gpt-5.5',
        },
      },
      deleted_at: null,
      runtime: 'codex',
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
    };
    const db = fakeDb({
      agents: {
        updateMetadata: vi.fn(async () => {}),
        updateStatus: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-runtime-test', db, { libraryRoot: null }) as any;

    const restored = await manager.restoreAgentFromRateLimitFallbackIfReady('team-1', 'default', agent, now);

    expect(restored).toBe(false);
    expect(db.agents.updateStatus).not.toHaveBeenCalled();
    expect(db.agents.updateMetadata).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      runtimeRateLimitRestore: expect.objectContaining({
        skippedAtMs: now,
          reason: 'agent already left rate-limit fallback runtime',
        currentRuntime: 'codex',
        currentModel: 'gpt-5.5',
      }),
    }));
    const metadata = db.agents.updateMetadata.mock.calls[0][1];
    expect(metadata.runtimeRateLimitFailover).toBeUndefined();
    expect(metadata.previousRuntimeBeforeRateLimit).toBeUndefined();
    expect(metadata.previousModelBeforeRateLimit).toBeUndefined();
  });

  it('recovers the original failed rate-limited query when the failover retry succeeds', async () => {
    const failedOriginal = {
      team_id: 'team-1',
      agent_id: 'agent-1',
      query_id: 'query-original',
      status: 'failed',
      prompt: 'TASK DELEGATION from manager: You are assigned task #abc12345 ("Do work"). When complete, mark it done.',
      created: 1,
      completed: 2,
      result: null,
      error: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage",
      session_id: null,
      owner_kind: 'agent',
      owner_id: 'agent-1',
      metadata: null,
    };
    const completedOriginal = {
      ...failedOriginal,
      status: 'completed',
      completed: 3,
      error: null,
      result: { message: 'DONE: completed the assigned work' },
      metadata: { rate_limit_recovered: true },
    };
    const db = fakeDb({
      events: { insert: vi.fn(async () => {}) },
      queries: {
        complete: vi.fn(async () => false),
        getByQueryIdForTeam: vi
          .fn()
          .mockResolvedValueOnce(failedOriginal)
          .mockResolvedValueOnce(completedOriginal),
      },
      adapter: {
        dialect: 'sqlite',
        query: vi.fn(async (sql: string, params: unknown[]) => {
          expect((sql.match(/\?/g) || []).length).toBe(params.length);
          return { rows: [], rowCount: 1 };
        }),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-runtime-test', db, { libraryRoot: null }) as any;
    manager.postBrainInstructionFeedback = vi.fn(async () => {});
    manager.postBrainEvalCapture = vi.fn(async () => {});
    manager.applyTaskControlReplyFromCompletedQuery = vi.fn(async () => ({ applied: true, action: 'done', task: 'do-work' }));
    manager.closeQueryShadowRows = vi.fn(async () => {});
    manager.wakeQueryWaiters = vi.fn();
    manager.releaseLocalGate = vi.fn();

    await manager.completeQueryDelivery({
      teamId: 'team-1',
      queryId: 'query-original',
      occurredAt: 3,
      resultPayload: { from: 'agent', message: 'DONE: completed the assigned work', failover_retry_query_id: 'query-retry' },
      waiterReply: { from: 'agent', message: 'DONE: completed the assigned work' },
      messagePreview: 'DONE: completed the assigned work',
      recoverFailedRateLimit: true,
    });

    expect(db.adapter.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'completed'"),
      expect.arrayContaining([3, expect.any(String), expect.any(String), 'team-1', 'query-original']),
    );
    expect(manager.applyTaskControlReplyFromCompletedQuery).toHaveBeenCalledWith(
      completedOriginal,
      expect.objectContaining({ message: 'DONE: completed the assigned work' }),
      3,
    );
  });

  it('uses metered overflow only after every subscription lane is unavailable and local fallback is disabled', async () => {
    process.env.ID_RATE_LIMIT_LOCAL_FALLBACK = '0';
    const db = fakeDb({
      agents: {
        getById: vi.fn(async () => ({
          team_id: 'team-1',
          id: 'agent-1',
          name: 'worker',
          type: 'claude',
          model: 'sonnet',
          port: 4311,
          endpoint: 'http://localhost:4311',
          working_directory: '/tmp/agent-1',
          status: 'running',
          created_at: 1,
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
        })),
        updateMetadata: vi.fn(async () => {}),
      },
      queries: {
        getByQueryIdForTeam: vi.fn(async () => ({
          team_id: 'team-1',
          agent_id: 'agent-1',
          query_id: 'query-original',
          status: 'pending',
          prompt: 'do the work',
          created: 1,
          completed: null,
          result: null,
          error: null,
          session_id: null,
          owner_kind: 'agent',
          owner_id: 'agent-1',
          metadata: null,
        })),
        create: vi.fn(async () => {}),
      },
    });
    const manager = new AgentManagerDb('/tmp/id-agents-runtime-test', db, { libraryRoot: null }) as any;
    manager.isSubscriptionRuntimeActive = vi.fn(() => false);
    manager.runtimeCredentialPoolByTeam.set('team-1', {
      lanes: [
        { id: 'sub-a', runtime: 'claude-code-cli', kind: 'subscription' },
        { id: 'sub-b', runtime: 'claude-code-cli', kind: 'subscription' },
        { id: 'metered', runtime: 'claude-code-cli', kind: 'metered-api', env: { ANTHROPIC_API_KEY: 'test-key' } },
      ],
    });
    seedRuntimeLaneCooldown(manager, 'team-1', {
      laneId: 'sub-b',
      runtime: 'claude-code-cli',
      kind: 'subscription',
      coolingUntilMs: Date.now() + 60_000,
      observedAtMs: Date.now(),
      reason: 'subscription_session_cap_unknown_window',
      teamId: 'team-1',
    });
    manager.rebuildLocalClaudeAgent = vi.fn(async () => ({ success: true, pid: 1234 }));
    manager.forwardToAgent = vi.fn(async () => ({ ok: true, data: { query_id: 'query-retry' } }));

    const failover = await manager.handleRuntimeRateLimitFailover('team-1', 'default', {
      laneId: 'sub-a',
      runtime: 'claude-code-cli',
      kind: 'subscription',
      coolingUntilMs: Date.now() + 60_000,
      observedAtMs: Date.now(),
      reason: 'subscription_session_cap_unknown_window',
      teamId: 'team-1',
      agentId: 'agent-1',
      queryId: 'query-original',
    });

    expect(failover).toMatchObject({ attempted: true, success: true, laneId: 'metered', retryQueryId: 'query-retry' });
    expect(db.agents.updateMetadata).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      runtimeCredentialLane: 'metered',
    }));
  });
});
