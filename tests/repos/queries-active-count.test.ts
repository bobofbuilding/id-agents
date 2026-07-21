// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';

describe('QueriesRepo.countActive', () => {
  it('counts pending and processing work across teams but excludes terminal rows', async () => {
    const adapter = new SqliteAdapter(':memory:');
    await migrateSqlite(adapter);
    const agents = new SqliteAgentsRepo(adapter);
    const queries = new SqliteQueriesRepo(adapter);
    const teams = new SqliteTeamsRepo(adapter);
    try {
      const teamA = await teams.getOrCreateTeamId('team-a');
      const teamB = await teams.getOrCreateTeamId('team-b');
      await agents.create({
        team_id: teamA,
        id: 'agent-a',
        name: 'agent-a',
        type: 'claude',
        model: 'test',
        status: 'running',
        created_at: 1,
      });
      await agents.create({
        team_id: teamB,
        id: 'agent-b',
        name: 'agent-b',
        type: 'claude',
        model: 'test',
        status: 'running',
        created_at: 1,
      });
      await queries.create(teamA, 'pending-a', 'agent-a', 'pending', 1);
      await queries.upsert(teamA, 'agent-a', { query_id: 'processing-a', status: 'processing' });
      await queries.upsert(teamB, 'agent-b', { query_id: 'processing-b', status: 'processing' });
      await queries.upsert(teamB, 'agent-b', { query_id: 'done-b', status: 'completed' });

      expect(await queries.countActive()).toBe(3);
    } finally {
      await adapter.close();
    }
  });
});

describe('QueriesRepo context hardening', () => {
  async function setup() {
    const adapter = new SqliteAdapter(':memory:');
    await migrateSqlite(adapter);
    const agents = new SqliteAgentsRepo(adapter);
    const queries = new SqliteQueriesRepo(adapter);
    const teams = new SqliteTeamsRepo(adapter);
    const teamId = await teams.getOrCreateTeamId('context-team');
    await agents.create({
      team_id: teamId,
      id: 'agent-context',
      name: 'agent-context',
      type: 'claude',
      model: 'test',
      status: 'running',
      created_at: 1,
    });
    return { adapter, queries, teamId, agentId: 'agent-context' };
  }

  it('redacts prompt storage and records versioned fingerprints without keys', async () => {
    const { adapter, queries, teamId, agentId } = await setup();
    try {
      await queries.create(teamId, 'qid-redact', agentId, 'token=sk-secret1234567890 cwd: /Users/alice/private/repo', 10);
      const row = await queries.getById(agentId, 'qid-redact');
      expect(row?.prompt).not.toContain('sk-secret1234567890');
      expect(row?.prompt).not.toContain('/Users/alice/private/repo');
      expect(row?.metadata?.policy_version).toBe('remote-query-context.v1');
      expect((row?.metadata as any).prompt_fingerprint.alg).toBe('HMAC-SHA256');
      expect((row?.metadata as any).prompt_fingerprint.version).toBeTruthy();
      expect((row?.metadata as any).prompt_fingerprint.key).toBeUndefined();
    } finally {
      await adapter.close();
    }
  });

  it('rejects task-scoped rows without task_id and assignment_id', async () => {
    const { adapter, queries, teamId, agentId } = await setup();
    try {
      await expect(queries.create(teamId, 'qid-bad-task', agentId, 'task probe', 10, undefined, undefined, {
        context: { kind: 'task', task_id: 'task:missing-assignment' },
      })).rejects.toThrow(/query_context_task_linkage_required/);
    } finally {
      await adapter.close();
    }
  });

  it('chains task-scoped query audit hashes', async () => {
    const { adapter, queries, teamId, agentId } = await setup();
    try {
      await queries.create(teamId, 'qid-task-1', agentId, 'first', 10, undefined, undefined, {
        context: { kind: 'task', reason: 'delegated', task_id: 'task:t1', assignment_id: 'assignment:t1:a1' },
      });
      await queries.create(teamId, 'qid-task-2', agentId, 'second', 11, undefined, undefined, {
        context: { kind: 'task', reason: 'delegated', task_id: 'task:t2', assignment_id: 'assignment:t2:a1' },
      });
      const first = await queries.getById(agentId, 'qid-task-1');
      const second = await queries.getById(agentId, 'qid-task-2');
      expect((first?.metadata as any).context.task_id).toBe('task:t1');
      expect((second?.metadata as any).context.assignment_id).toBe('assignment:t2:a1');
      expect((second?.metadata as any).audit_chain.previous_hash).toBe((first?.metadata as any).audit_chain.hash);
    } finally {
      await adapter.close();
    }
  });
});
