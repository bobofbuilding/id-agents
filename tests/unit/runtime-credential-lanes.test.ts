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
      create: vi.fn(async () => {}),
      ...overrides.queries,
    },
    news: { add: vi.fn(async () => {}), ...overrides.news },
    events: overrides.events || {},
    adapter: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), ...overrides.adapter },
  };
}

describe('runtime credential lanes', () => {
  afterEach(() => {
    delete process.env.ID_RUNTIME_CREDENTIAL_POOL;
    delete process.env.ID_RATE_LIMIT_LOCAL_FALLBACK;
    delete process.env.ID_RATE_LIMIT_LOCAL_MODEL;
    delete process.env.ID_LOCAL_FALLBACK_MODEL;
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
    expect(manager.forwardToAgent).toHaveBeenCalledWith('http://localhost:4311', 'do the work', 'manager', 'session-1');
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
    expect(manager.runtimeLaneCooldowns.has('sub-a')).toBe(true);
    expect(manager.runtimeLaneCooldowns.get('sub-a')).toMatchObject({ queryId: 'query-original', coolingUntilMs: future });
    expect(db.runtimeLaneCooldowns.pruneExpired).toHaveBeenCalledWith(expect.any(Number));
    expect(db.runtimeLaneCooldowns.listActive).toHaveBeenCalledWith(expect.any(Number));
  });

  it('falls back to a local model before metered overflow when every subscription lane is unavailable', async () => {
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
    manager.runtimeCredentialPoolByTeam.set('team-1', {
      lanes: [
        { id: 'sub-a', runtime: 'claude-code-cli', kind: 'subscription' },
        { id: 'sub-b', runtime: 'claude-code-cli', kind: 'subscription' },
        { id: 'metered', runtime: 'claude-code-cli', kind: 'metered-api', env: { ANTHROPIC_API_KEY: 'test-key' } },
      ],
    });
    manager.runtimeLaneCooldowns.set('sub-b', {
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

  it('falls back to a local model for non-Claude cloud runtime rate limits', async () => {
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
    manager.rebuildLocalClaudeAgent = vi.fn(async () => ({ success: true, pid: 1234 }));
    manager.forwardToAgent = vi.fn(async () => ({ ok: true, data: { query_id: 'query-retry' } }));

    const failover = await manager.handleRuntimeRateLimitFailover('team-1', 'default', {
      laneId: 'codex:default',
      runtime: 'codex',
      kind: 'subscription',
      coolingUntilMs: Date.now() + 60_000,
      observedAtMs: Date.now(),
      reason: 'api_rate_limit',
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
    expect(manager.rebuildLocalClaudeAgent).toHaveBeenCalledWith(
      'team-1',
      'engineering-team',
      expect.objectContaining({ runtime: 'claude-code-cli', model: 'claude-sonnet-5' }),
    );
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
    manager.runtimeLaneCooldowns.set('claude-code-cli:default', {
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
        query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
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
    manager.runtimeCredentialPoolByTeam.set('team-1', {
      lanes: [
        { id: 'sub-a', runtime: 'claude-code-cli', kind: 'subscription' },
        { id: 'sub-b', runtime: 'claude-code-cli', kind: 'subscription' },
        { id: 'metered', runtime: 'claude-code-cli', kind: 'metered-api', env: { ANTHROPIC_API_KEY: 'test-key' } },
      ],
    });
    manager.runtimeLaneCooldowns.set('sub-b', {
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
