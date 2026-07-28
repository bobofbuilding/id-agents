// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
  computeSyncPlan,
  diffAgent,
  formatSyncSummary,
  resolveAgentSpecIdentity,
} from '../../src/sync.js';
import type { AgentSpec } from '../../src/config-parser.js';
import type { AgentRow } from '../../src/db/types.js';

function makeAgentRow(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    team_id: 'team-1',
    id: 'agent_123',
    name: 'alice',
    type: 'claude',
    model: 'claude-sonnet-5',
    port: 4101,
    endpoint: 'http://localhost:4101',
    working_directory: '/workspace/agents/agent_123',
    status: 'running',
    created_at: Date.now(),
    registry: null,
    metadata: {
      name: 'alice',
      description: 'A test agent',
      runtime: 'claude-agent-sdk',
      plugins: [],
      skills: [],
      allowed_tools: [],
      yamlManaged: true,
    },
    deleted_at: null,
    runtime: 'claude-agent-sdk',
    token_id: null,
    domain: null,
    api_key: null,
    ...overrides,
  };
}

function makeAgentSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    name: 'alice',
    model: 'claude-sonnet-5',
    runtime: 'claude-agent-sdk',
    description: 'A test agent',
    plugins: [],
    skills: [],
    allowedTools: [],
    ...overrides,
  };
}

describe('diffAgent', () => {
  it('returns empty array when config matches running agent', () => {
    const spec = makeAgentSpec();
    const row = makeAgentRow();
    const changes = diffAgent(spec, row);
    expect(changes).toEqual([]);
  });

  it('detects model change', () => {
    const spec = makeAgentSpec({ model: 'claude-haiku-4-5-20251001' });
    const row = makeAgentRow();
    const changes = diffAgent(spec, row);
    expect(changes).toContain('model');
  });

  it('detects runtime change', () => {
    const spec = makeAgentSpec({ runtime: 'claude-code-cli' });
    const row = makeAgentRow();
    const changes = diffAgent(spec, row);
    expect(changes).toContain('runtime');
  });

  it('detects description change', () => {
    const spec = makeAgentSpec({ description: 'Updated description' });
    const row = makeAgentRow();
    const changes = diffAgent(spec, row);
    expect(changes).toContain('description');
  });

  it('detects domain change', () => {
    const spec = makeAgentSpec({ domain: 'alice.xid.eth' });
    const row = makeAgentRow();
    const changes = diffAgent(spec, row);
    expect(changes).toContain('domain');
  });

  it('detects tokenId change', () => {
    const spec = makeAgentSpec({ tokenId: '0xabc123' });
    const row = makeAgentRow();
    const changes = diffAgent(spec, row);
    expect(changes).toContain('tokenId');
  });

  it('detects skills change', () => {
    const spec = makeAgentSpec({ skills: ['identity', 'inter-agent'] });
    const row = makeAgentRow({
      metadata: {
        ...makeAgentRow().metadata,
        skills: ['identity'],
      },
    });
    const changes = diffAgent(spec, row);
    expect(changes).toContain('skills');
  });

  it('detects agent overlay change', () => {
    const spec = makeAgentSpec({ agent: 'frontend-lead' });
    const row = makeAgentRow({
      metadata: {
        ...makeAgentRow().metadata,
        agent: 'backend-lead',
      },
    });
    const changes = diffAgent(spec, row);
    expect(changes).toContain('agent');
  });

  it('detects plugins change', () => {
    const spec = makeAgentSpec({ plugins: [{ name: 'my-plugin', path: '/plugins/my-plugin' }] });
    const row = makeAgentRow();
    const changes = diffAgent(spec, row);
    expect(changes).toContain('plugins');
  });

  it('detects allowedTools change', () => {
    const spec = makeAgentSpec({ allowedTools: ['Bash', 'Read', 'Write'] });
    const row = makeAgentRow();
    const changes = diffAgent(spec, row);
    expect(changes).toContain('allowedTools');
  });

  it('preserves the omitted versus explicit-empty allowedTools contract in both directions', () => {
    const omittedSpec = makeAgentSpec();
    delete omittedSpec.allowedTools;
    const omittedRow = makeAgentRow({
      metadata: {
        ...makeAgentRow().metadata,
      },
    });
    delete (omittedRow.metadata as Record<string, unknown>).allowed_tools;

    expect(diffAgent(omittedSpec, omittedRow)).not.toContain('allowedTools');
    expect(diffAgent(makeAgentSpec({ allowedTools: [] }), omittedRow)).toContain('allowedTools');
    expect(diffAgent(omittedSpec, makeAgentRow())).toContain('allowedTools');
  });

  it('detects agent type changes', () => {
    expect(diffAgent(
      makeAgentSpec({ type: 'automator' }),
      makeAgentRow({ type: 'claude' }),
    )).toContain('type');
  });

  it('diffs the effective per-agent environment independent of key order', () => {
    const row = makeAgentRow({
      metadata: {
        ...makeAgentRow().metadata,
        env: {
          APP_ENV: 'production',
          FEATURE_FLAG: 'enabled',
        },
      },
    });

    expect(diffAgent(makeAgentSpec({
      env: {
        FEATURE_FLAG: 'enabled',
        APP_ENV: 'production',
      },
    }), row)).not.toContain('env');

    expect(diffAgent(makeAgentSpec({
      resources: {
        env: {
          APP_ENV: 'production',
          FEATURE_FLAG: 'disabled',
        },
      },
    }), row)).toContain('env');

    expect(diffAgent(makeAgentSpec(), row)).toContain('env');
  });

  it('detects MCP server drift and ignores server ordering differences', () => {
    const servers = [
      { name: 'brain', transport: 'stdio' as const, command: 'node', args: ['/workspace/projects/brain/brain-mcp.mjs'] },
      { name: 'docs', transport: 'http' as const, url: 'http://127.0.0.1:4300/mcp' },
    ];
    const spec = makeAgentSpec({ mcpServers: servers });
    const row = makeAgentRow({
      metadata: {
        ...makeAgentRow().metadata,
        mcpServers: [...servers].reverse(),
      },
    });
    expect(diffAgent(spec, row)).not.toContain('mcpServers');

    const drifted = makeAgentRow({
      metadata: {
        ...makeAgentRow().metadata,
        mcpServers: [{ name: 'brain', transport: 'stdio', command: 'node', args: ['/old/brain-mcp.mjs'] }],
      },
    });
    expect(diffAgent(spec, drifted)).toContain('mcpServers');
  });

  it('detects heartbeat added', () => {
    const spec = makeAgentSpec({
      heartbeat: { interval: 300, message: 'check in' },
    });
    const row = makeAgentRow();
    const changes = diffAgent(spec, row);
    expect(changes).toContain('heartbeat');
  });

  it('detects heartbeat removed', () => {
    const spec = makeAgentSpec();
    const row = makeAgentRow({
      metadata: {
        ...makeAgentRow().metadata,
        heartbeat: true,
      },
    });
    const changes = diffAgent(spec, row);
    expect(changes).toContain('heartbeat');
  });

  it('detects workingDirectory change', () => {
    const spec = makeAgentSpec({ workingDirectory: '/new/path' });
    const row = makeAgentRow();
    const changes = diffAgent(spec, row);
    expect(changes).toContain('workingDirectory');
  });

  it('detects multiple changes at once', () => {
    const spec = makeAgentSpec({
      model: 'claude-haiku-4-5-20251001',
      description: 'new desc',
      skills: ['identity'],
    });
    const row = makeAgentRow();
    const changes = diffAgent(spec, row);
    expect(changes).toContain('model');
    expect(changes).toContain('description');
    expect(changes).toContain('skills');
    expect(changes.length).toBe(3);
  });

  it('ignores skill ordering differences', () => {
    const spec = makeAgentSpec({ skills: ['inter-agent', 'identity'] });
    const row = makeAgentRow({
      metadata: {
        ...makeAgentRow().metadata,
        skills: ['identity', 'inter-agent'],
      },
    });
    const changes = diffAgent(spec, row);
    expect(changes).not.toContain('skills');
  });

  it('ignores plugin ordering differences', () => {
    const spec = makeAgentSpec({
      plugins: [
        { name: 'b-plugin', path: '/b' },
        { name: 'a-plugin', path: '/a' },
      ],
    });
    const row = makeAgentRow({
      metadata: {
        ...makeAgentRow().metadata,
        plugins: [
          { name: 'a-plugin', path: '/a' },
          { name: 'b-plugin', path: '/b' },
        ],
      },
    });
    const changes = diffAgent(spec, row);
    expect(changes).not.toContain('plugins');
  });
});

describe('computeSyncPlan', () => {
  it('uses identityKey before name and plans an explicit rename in place', () => {
    const row = makeAgentRow({
      name: 'worker',
      metadata: {
        ...makeAgentRow().metadata,
        name: 'worker',
        identityKey: 'worker-v1',
      },
    });
    const spec = makeAgentSpec({
      name: 'renamed-worker',
      identityKey: 'worker-v1',
    });

    expect(resolveAgentSpecIdentity(spec, [row])).toEqual({ row });
    const plan = computeSyncPlan([spec], [row]);

    expect(plan.conflicts).toEqual([]);
    expect(plan.added).toEqual([]);
    expect(plan.removed).toEqual([]);
    expect(plan.changed).toEqual([{
      name: 'renamed-worker',
      category: 'changed',
      changes: ['name'],
    }]);
  });

  it('adopts identityKey onto one unambiguous same-name legacy row', () => {
    const metadata = { ...makeAgentRow().metadata, name: 'worker' };
    delete (metadata as Record<string, unknown>).yamlManaged;
    const row = makeAgentRow({ name: 'worker', metadata });
    const spec = makeAgentSpec({ name: 'worker', identityKey: 'worker-v1' });

    const plan = computeSyncPlan([spec], [row]);

    expect(plan.conflicts).toEqual([]);
    expect(plan.added).toEqual([]);
    expect(plan.removed).toEqual([]);
    expect(plan.changed).toEqual([{
      name: 'worker',
      category: 'changed',
      changes: ['identityKey', 'yamlManaged'],
    }]);
  });

  it('fails closed when an identity key and configured name resolve to different rows', () => {
    const keyOwner = makeAgentRow({
      id: 'agent-key-owner',
      name: 'old-worker',
      metadata: {
        ...makeAgentRow().metadata,
        name: 'old-worker',
        identityKey: 'worker-v1',
      },
    });
    const nameOwner = makeAgentRow({
      id: 'agent-name-owner',
      name: 'renamed-worker',
      metadata: {
        ...makeAgentRow().metadata,
        name: 'renamed-worker',
        identityKey: 'other-v1',
      },
    });

    const resolution = resolveAgentSpecIdentity(
      makeAgentSpec({ name: 'renamed-worker', identityKey: 'worker-v1' }),
      [keyOwner, nameOwner],
    );
    expect(resolution.row).toBeNull();
    expect(resolution.error).toContain('belongs to agent-name-owner');
  });

  it('fails closed on duplicate persisted keys and ambiguous legacy names', () => {
    const duplicateKeyRows = [
      makeAgentRow({
        id: 'agent-a',
        name: 'worker-a',
        metadata: { ...makeAgentRow().metadata, name: 'worker-a', identityKey: 'worker-v1' },
      }),
      makeAgentRow({
        id: 'agent-b',
        name: 'worker-b',
        metadata: { ...makeAgentRow().metadata, name: 'worker-b', identityKey: 'worker-v1' },
      }),
    ];
    const duplicateKey = computeSyncPlan(
      [makeAgentSpec({ name: 'worker-a', identityKey: 'worker-v1' })],
      duplicateKeyRows,
    );
    expect(duplicateKey.conflicts).toHaveLength(1);
    expect(duplicateKey.conflicts[0].message).toContain('already attached to multiple existing rows');

    const ambiguousRows = [
      makeAgentRow({
        id: 'legacy-a',
        name: 'legacy-a',
        metadata: { ...makeAgentRow().metadata, name: 'legacy-a', alias: 'worker' },
      }),
      makeAgentRow({
        id: 'legacy-b',
        name: 'legacy-b',
        metadata: { ...makeAgentRow().metadata, name: 'legacy-b', alias: 'worker' },
      }),
    ];
    const ambiguous = computeSyncPlan(
      [makeAgentSpec({ name: 'worker' })],
      ambiguousRows,
    );
    expect(ambiguous.conflicts).toHaveLength(1);
    expect(ambiguous.conflicts[0].message).toContain('matches multiple existing rows');
  });

  it('categorizes new agents correctly', () => {
    const configAgents = [makeAgentSpec({ name: 'alice' }), makeAgentSpec({ name: 'bob' })];
    const runningAgents = [makeAgentRow({ name: 'alice' })];

    const plan = computeSyncPlan(configAgents, runningAgents);

    expect(plan.added.length).toBe(1);
    expect(plan.added[0].name).toBe('bob');
    expect(plan.unchanged.length).toBe(1);
    expect(plan.unchanged[0].name).toBe('alice');
    expect(plan.removed.length).toBe(0);
    expect(plan.changed.length).toBe(0);
  });

  it('categorizes removed agents correctly', () => {
    const configAgents = [makeAgentSpec({ name: 'alice' })];
    const runningAgents = [
      makeAgentRow({ name: 'alice' }),
      makeAgentRow({ id: 'agent_456', name: 'charlie', port: 4102 }),
    ];

    const plan = computeSyncPlan(configAgents, runningAgents);

    expect(plan.removed.length).toBe(1);
    expect(plan.removed[0].name).toBe('charlie');
    expect(plan.unchanged.length).toBe(1);
  });

  it('categorizes changed agents correctly', () => {
    const configAgents = [makeAgentSpec({ name: 'alice', model: 'claude-haiku-4-5-20251001' })];
    const runningAgents = [makeAgentRow({ name: 'alice' })];

    const plan = computeSyncPlan(configAgents, runningAgents);

    expect(plan.changed.length).toBe(1);
    expect(plan.changed[0].name).toBe('alice');
    expect(plan.changed[0].changes).toContain('model');
    expect(plan.unchanged.length).toBe(0);
  });

  it('handles empty config (all removed)', () => {
    const configAgents: AgentSpec[] = [];
    const runningAgents = [makeAgentRow({ name: 'alice' })];

    // computeSyncPlan requires at least one config agent in practice,
    // but the diff logic should work with empty config
    const plan = computeSyncPlan(configAgents, runningAgents);
    expect(plan.removed.length).toBe(1);
    expect(plan.added.length).toBe(0);
  });

  it('handles empty running (all new)', () => {
    const configAgents = [makeAgentSpec({ name: 'alice' }), makeAgentSpec({ name: 'bob' })];
    const runningAgents: AgentRow[] = [];

    const plan = computeSyncPlan(configAgents, runningAgents);
    expect(plan.added.length).toBe(2);
    expect(plan.removed.length).toBe(0);
  });

  it('handles mixed scenario: add, remove, change, unchanged', () => {
    const configAgents = [
      makeAgentSpec({ name: 'alice' }),                                       // unchanged
      makeAgentSpec({ name: 'bob', model: 'claude-haiku-4-5-20251001' }),     // changed
      makeAgentSpec({ name: 'dave' }),                                        // new
    ];
    const runningAgents = [
      makeAgentRow({ name: 'alice' }),
      makeAgentRow({ id: 'agent_bob', name: 'bob', port: 4102 }),
      makeAgentRow({ id: 'agent_charlie', name: 'charlie', port: 4103 }),     // removed
    ];

    const plan = computeSyncPlan(configAgents, runningAgents);

    expect(plan.added.map(i => i.name)).toEqual(['dave']);
    expect(plan.removed.map(i => i.name)).toEqual(['charlie']);
    expect(plan.changed.map(i => i.name)).toEqual(['bob']);
    expect(plan.unchanged.map(i => i.name)).toEqual(['alice']);
  });

  it('marks only the agent with a real skills delta when others are semantically unchanged', () => {
    const configAgents = [
      makeAgentSpec({ name: 'alice', skills: ['inter-agent', 'identity'] }),
      makeAgentSpec({ name: 'bob', skills: ['identity', 'catalog'] }),
      makeAgentSpec({ name: 'charlie', skills: ['task-discipline'] }),
    ];
    const runningAgents = [
      makeAgentRow({
        name: 'alice',
        metadata: {
          ...makeAgentRow().metadata,
          skills: ['identity', 'inter-agent'],
        },
      }),
      makeAgentRow({
        id: 'agent_bob',
        name: 'bob',
        port: 4102,
        metadata: {
          ...makeAgentRow().metadata,
          name: 'bob',
          skills: ['identity'],
        },
      }),
      makeAgentRow({
        id: 'agent_charlie',
        name: 'charlie',
        port: 4103,
        metadata: {
          ...makeAgentRow().metadata,
          name: 'charlie',
          skills: ['task-discipline'],
        },
      }),
    ];

    const plan = computeSyncPlan(configAgents, runningAgents);

    expect(plan.added).toEqual([]);
    expect(plan.removed).toEqual([]);
    expect(plan.changed).toEqual([{ name: 'bob', category: 'changed', changes: ['skills'] }]);
    expect(plan.unchanged.map(item => item.name)).toEqual(['alice', 'charlie']);
  });

  it('matches agents by domain name', () => {
    const configAgents = [makeAgentSpec({ name: 'alice', domain: 'alice.xid.eth' })];
    const runningAgents = [makeAgentRow({
      name: 'alice.xid.eth',
      domain: 'alice.xid.eth',
      metadata: { alias: 'alice', description: 'A test agent', runtime: 'claude-agent-sdk', plugins: [], skills: [], allowed_tools: [], yamlManaged: true },
    })];

    const plan = computeSyncPlan(configAgents, runningAgents);

    expect(plan.unchanged.length).toBe(1);
    expect(plan.unchanged[0].name).toBe('alice.xid.eth');
    expect(plan.added.length).toBe(0);
    expect(plan.removed.length).toBe(0);
  });
});

describe('formatSyncSummary', () => {
  it('formats summary correctly', () => {
    const plan = computeSyncPlan(
      [makeAgentSpec({ name: 'alice' }), makeAgentSpec({ name: 'bob' })],
      [makeAgentRow({ name: 'alice' }), makeAgentRow({ id: 'a2', name: 'charlie', port: 4102 })],
    );
    const summary = formatSyncSummary(plan);
    expect(summary).toBe('Added 1, updated 0, removed 1, unchanged 1');
  });
});
