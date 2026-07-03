// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentManagerDb } from '../../src/agent-manager-db.js';

function fakeDb(overrides: Record<string, any> = {}): any {
  return {
    teams: {
      listTeamsWithConfig: vi.fn(async () => []),
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

  it('uses metered overflow only after every subscription lane is unavailable', async () => {
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
