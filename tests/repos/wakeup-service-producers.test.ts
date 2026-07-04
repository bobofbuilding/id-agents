// SPDX-License-Identifier: MIT
/**
 * Tests for the wakeup-service producer slice:
 *   - emitTaskClaimed / emitTaskCompleted append exactly one event_log row
 *     with the correct topic, subject, and envelope shape
 *   - The query sweeper flow (expireStale → emitQueryExpired) appends one
 *     query:expired event per stale row
 *
 * Backed by SQLite in-memory; the same producer module is used by the
 * postgres-backed manager.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteEventsRepo } from '../../src/db/repos/sqlite/events-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import {
  emitTaskClaimed,
  emitTaskCompleted,
  emitQueryDelivered,
  emitQueryExpired,
  TASK_CLAIMED,
  TASK_COMPLETED,
  QUERY_DELIVERED,
  QUERY_EXPIRED,
} from '../../src/wakeup-service/event-producer.js';

async function freshDb() {
  const adapter = new SqliteAdapter(':memory:');
  await migrateSqlite(adapter);
  return adapter;
}

async function insertAgent(adapter: SqliteAdapter, teamId: string, name: string): Promise<string> {
  const id = crypto.randomUUID();
  await adapter.query(
    `INSERT INTO agents (team_id, id, name, type, model, port, status, created_at, runtime)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [teamId, id, name, 'persistent', 'claude-opus', 24000, 'active', Date.now(), 'claude-code'],
  );
  return id;
}

describe('event-producer: tasks', () => {
  let adapter: SqliteAdapter;
  let events: SqliteEventsRepo;
  let teamId: string;

  beforeEach(async () => {
    adapter = await freshDb();
    const teams = new SqliteTeamsRepo(adapter);
    events = new SqliteEventsRepo(adapter);
    teamId = await teams.getOrCreateTeamId('default');
  });

  it('emitTaskClaimed writes one task:claimed row with the correct envelope', async () => {
    const taskUuid = crypto.randomUUID();
    const occurredAt = 1_777_000_000_000;

    const { seq } = await emitTaskClaimed(events, {
      teamId,
      taskUuid,
      taskName: 'wakeup-service-producers',
      title: 'Wakeup service producers',
      ownerAgentId: 'agent-coder',
      occurredAt,
    });

    const rows = await events.query({ teamId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      seq,
      team_id: teamId,
      topic: TASK_CLAIMED,
      actor_agent_id: 'agent-coder',
      subject_kind: 'task',
      subject_id: taskUuid,
      occurred_at: occurredAt,
      data: {
        task_name: 'wakeup-service-producers',
        task_uuid: taskUuid,
        status: 'doing',
        owner: 'agent-coder',
        title_preview: 'Wakeup service producers',
      },
    });
  });

  it('emitTaskClaimed carries volunteered source ids and brain context when provided', async () => {
    const taskUuid = crypto.randomUUID();
    const occurredAt = 1_777_000_000_500;

    await emitTaskClaimed(events, {
      teamId,
      taskUuid,
      taskName: 'brain-backed-claim',
      title: 'Brain backed claim',
      ownerAgentId: 'agent-coder',
      occurredAt,
      volunteeredSourceIds: ['memory:101'],
      brainContext: {
        cited: {
          canonical_source_ids: ['memory:101'],
          source_origins: { 'memory:101': ['team_instruction'] },
        },
        timelineEventId: 42,
        context_package_id: 77,
      },
    });

    const rows = await events.query({ teamId, topics: [TASK_CLAIMED] });
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toMatchObject({
      task_name: 'brain-backed-claim',
      volunteered_source_ids: ['memory:101'],
      brain_context: {
        cited: {
          canonical_source_ids: ['memory:101'],
          source_origins: { 'memory:101': ['team_instruction'] },
        },
        timelineEventId: 42,
        context_package_id: 77,
      },
    });
  });

  it('emitTaskCompleted writes one task:completed row with status=done', async () => {
    const taskUuid = crypto.randomUUID();
    const occurredAt = 1_777_000_001_000;

    const { seq } = await emitTaskCompleted(events, {
      teamId,
      taskUuid,
      taskName: 'wakeup-service-producers',
      title: null,
      ownerAgentId: 'agent-coder',
      actorAgentId: 'agent-coder',
      occurredAt,
    });

    const rows = await events.query({ teamId, topics: [TASK_COMPLETED] });
    expect(rows).toHaveLength(1);
    expect(rows[0].seq).toBe(seq);
    expect(rows[0].topic).toBe(TASK_COMPLETED);
    expect(rows[0].subject_kind).toBe('task');
    expect(rows[0].subject_id).toBe(taskUuid);
    expect(rows[0].actor_agent_id).toBe('agent-coder');
    expect(rows[0].data).toMatchObject({
      task_name: 'wakeup-service-producers',
      task_uuid: taskUuid,
      status: 'done',
      owner: 'agent-coder',
      completed_at: occurredAt,
    });
    // No title_preview when title is null
    expect((rows[0].data as Record<string, unknown>).title_preview).toBeUndefined();
  });

  it('emitTaskCompleted carries used and volunteered Brain source ids when provided', async () => {
    const taskUuid = crypto.randomUUID();
    const occurredAt = 1_777_000_001_500;
    const learnedArtifact = {
      summary: 'Release validation findings were approved for reuse.',
      sources: [{
        kind: 'task-result',
        source_id: 'task-result:release-validation',
        content: 'The approved validation requires a release checklist before deployment closure.',
      }],
      facts: [{
        entity_id: 'project:release-validation',
        field: 'requires_release_checklist',
        value: true,
        confidence: 0.91,
      }],
    };

    await emitTaskCompleted(events, {
      teamId,
      taskUuid,
      taskName: 'brain-sources',
      title: 'Brain sources',
      ownerAgentId: 'agent-coder',
      actorAgentId: 'agent-coder',
      occurredAt,
      usedSourceIds: ['src-1', 'src-2'],
      volunteeredSourceIds: ['src-3'],
      learnedArtifact,
      learningLoop: {
        schema: 'brain.learning_loop_capture.v1',
        subject: { kind: 'task', ref: `task:${taskUuid}`, route: 'manager.task_completion' },
        gap: { gap_type: 'source_recovery', severity: 'medium', required_for_acceptance: false },
        owner: { owner_team: 'default', owner_agent_id: 'agent-coder' },
        validation_path: {
          required: true,
          default_validators: ['coder', 'researcher'],
          specialists: [],
          relay_target: 'owning_team_lead',
          final_relay: 'default_validator_pair',
        },
        save_back: {
          decision: 'save',
          expected: true,
          mode: 'apply_after_validation',
          target_type: 'fact',
          target_ref: 'fact:1',
          operation: 'save',
        },
        source_recovery: {
          required_source_ids: ['src-1'],
          available_source_ids: ['src-1', 'src-2', 'src-3'],
          missing_source_ids: [],
          recovery_state: 'recovered',
          evidence_refs: [],
        },
        backlog_rule: {
          current_scope_only: true,
          optional_improvements: 'record_as_backlog_candidate',
          backlog_allowed: true,
          optional_items_block_acceptance: false,
          candidate_refs: [],
        },
        evidence: {
          used_source_ids: ['src-1', 'src-2'],
          volunteered_source_ids: ['src-3'],
          used_instruction_ids: [],
          ignored_instruction_ids: [],
          harmful_instruction_ids: [],
          artifact_refs: [],
        },
        outcome_telemetry: {
          detection_type: 'manual_review',
          owner_lane: 'default',
          branch_chosen: 'save_back',
          validation_result: 'approved',
          final_state: 'saved_back',
          metric_flags: {
            reused_existing_record: false,
            created_new_record: true,
            rejected_output: false,
            converted_to_backlog: false,
          },
          recorded_at: '2026-06-28T00:00:00.000Z',
        },
      },
    });

    const rows = await events.query({ teamId, topics: [TASK_COMPLETED] });
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toMatchObject({
      task_name: 'brain-sources',
      used_source_ids: ['src-1', 'src-2'],
      volunteered_source_ids: ['src-3'],
      learning_loop: {
        gap: { gap_type: 'source_recovery' },
        save_back: { decision: 'save' },
      },
      learned_artifact: learnedArtifact,
    });
  });
});

describe('event-producer: query sweeper', () => {
  let adapter: SqliteAdapter;
  let events: SqliteEventsRepo;
  let queries: SqliteQueriesRepo;
  let teamId: string;
  let agentId: string;

  beforeEach(async () => {
    adapter = await freshDb();
    const teams = new SqliteTeamsRepo(adapter);
    events = new SqliteEventsRepo(adapter);
    queries = new SqliteQueriesRepo(adapter);
    teamId = await teams.getOrCreateTeamId('default');
    agentId = await insertAgent(adapter, teamId, 'coder');
  });

  it('expireStale + emitQueryExpired produces one query:expired event per stale row', async () => {
    const oldQueryId = `query_old_${crypto.randomUUID()}`;
    const freshQueryId = `query_fresh_${crypto.randomUUID()}`;

    // Old, stuck query (will be expired by sweep)
    await queries.create(teamId, oldQueryId, agentId, 'old prompt', Date.now() - 60 * 60 * 1000);
    // Fresh query (not yet expired)
    await queries.create(teamId, freshQueryId, agentId, 'fresh prompt', Date.now());

    const cutoff = Date.now() - 30 * 60 * 1000;
    const expired = await queries.expireStale(cutoff, ['pending', 'processing']);

    expect(expired).toHaveLength(1);
    expect(expired[0].query_id).toBe(oldQueryId);
    expect(expired[0].status).toBe('expired');

    // Mirror the sweeper: emit one event per expired row
    const occurredAt = 1_777_000_002_000;
    for (const row of expired) {
      await emitQueryExpired(events, {
        teamId: row.team_id,
        queryId: row.query_id,
        agentId: row.agent_id,
        occurredAt,
      });
    }

    const eventRows = await events.query({ teamId, topics: [QUERY_EXPIRED] });
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]).toMatchObject({
      team_id: teamId,
      topic: QUERY_EXPIRED,
      actor_agent_id: agentId,
      subject_kind: 'query',
      subject_id: oldQueryId,
      occurred_at: occurredAt,
      data: {
        query_id: oldQueryId,
        status: 'expired',
        agent: agentId,
        completed_at: occurredAt,
      },
    });

    // Fresh query is unaffected
    const stillPending = await queries.getById(agentId, freshQueryId);
    expect(stillPending?.status).toBe('pending');
  });

  it('expireQueuedPeerWakes only clears stale peer replies behind active work', async () => {
    const now = Date.now();
    const activeQueryId = `query_active_${crypto.randomUUID()}`;
    const oldPeerWakeId = `news_old_peer_${crypto.randomUUID()}`;
    const freshPeerWakeId = `news_fresh_peer_${crypto.randomUUID()}`;
    const checkinWakeId = `news_checkin_${crypto.randomUUID()}`;
    const taskAskId = `query_task_${crypto.randomUUID()}`;
    const idleAgentId = await insertAgent(adapter, teamId, 'researcher');
    const idlePeerWakeId = `news_idle_peer_${crypto.randomUUID()}`;

    await queries.create(teamId, activeQueryId, agentId, 'task already in progress', now - 5 * 60 * 1000);
    await adapter.query(
      `UPDATE queries SET status = 'processing' WHERE team_id = ? AND query_id = ?`,
      [teamId, activeQueryId],
    );
    await queries.create(teamId, oldPeerWakeId, agentId, '[Incoming Reply from "skill-tester"]\n\nDone.', now - 5 * 60 * 1000);
    await queries.create(teamId, freshPeerWakeId, agentId, '[Incoming Reply from "skill-rater"]\n\nDone.', now - 10 * 1000);
    await queries.create(teamId, checkinWakeId, agentId, '[Incoming Message from "checkin-service"]\n\nCheckin due.', now - 5 * 60 * 1000);
    await queries.create(teamId, taskAskId, agentId, 'New task assigned: Audit skill graph', now - 5 * 60 * 1000);
    await queries.create(teamId, idlePeerWakeId, idleAgentId, '[Incoming Reply from "analyst"]\n\nDone.', now - 5 * 60 * 1000);

    const expired = await queries.expireQueuedPeerWakes(now - 2 * 60 * 1000);

    expect(expired.map((row) => row.query_id)).toEqual([oldPeerWakeId]);
    expect(expired[0].status).toBe('expired');

    await expect(queries.getById(agentId, activeQueryId)).resolves.toMatchObject({ status: 'processing' });
    await expect(queries.getById(agentId, freshPeerWakeId)).resolves.toMatchObject({ status: 'pending' });
    await expect(queries.getById(agentId, checkinWakeId)).resolves.toMatchObject({ status: 'pending' });
    await expect(queries.getById(agentId, taskAskId)).resolves.toMatchObject({ status: 'pending' });
    await expect(queries.getById(idleAgentId, idlePeerWakeId)).resolves.toMatchObject({ status: 'pending' });
  });

  it('emitQueryDelivered carries task and Brain source metadata when provided', async () => {
    const queryId = `query_delivered_${crypto.randomUUID()}`;
    await queries.create(teamId, queryId, agentId, 'prompt', Date.now());

    const occurredAt = 1_777_000_002_500;
    const learnedArtifact = {
      summary: 'Validated research finding should be reusable in later dispatches.',
      sources: [{
        kind: 'query-result',
        source_id: 'query-result:validated-finding',
        content: 'The validated finding is grounded in the cited Brain source.',
      }],
      facts: [{
        entity_id: 'project:brain',
        field: 'validated_finding_write_back_enabled',
        value: true,
        confidence: 0.88,
      }],
    };
    await emitQueryDelivered(events, {
      teamId,
      queryId,
      agentId,
      occurredAt,
      messagePreview: 'done',
      taskId: 'task:123',
      usedSourceIds: ['src-1'],
      volunteeredSourceIds: ['src-2', 'src-3'],
      learnedArtifact,
      learningLoop: {
        schema: 'brain.learning_loop_capture.v1',
        subject: { kind: 'query', ref: `query:${queryId}`, route: 'manager.dispatch' },
        gap: { gap_type: 'validation_feedback_missing', severity: 'medium', required_for_acceptance: false },
        owner: { owner_team: 'default', owner_agent_id: agentId },
        validation_path: {
          required: true,
          default_validators: ['coder', 'researcher'],
          specialists: [],
          relay_target: 'owning_team_lead',
          final_relay: 'default_validator_pair',
        },
        save_back: {
          decision: 'record-backlog',
          expected: false,
          mode: 'advisory_only',
          target_type: 'none',
          target_ref: null,
          operation: 'record-backlog',
        },
        source_recovery: {
          required_source_ids: [],
          available_source_ids: ['src-1', 'src-2', 'src-3'],
          missing_source_ids: [],
          recovery_state: 'not_needed',
          evidence_refs: [],
        },
        backlog_rule: {
          current_scope_only: true,
          optional_improvements: 'record_as_backlog_candidate',
          backlog_allowed: true,
          optional_items_block_acceptance: false,
          candidate_refs: ['backlog:1'],
        },
        evidence: {
          used_source_ids: ['src-1'],
          volunteered_source_ids: ['src-2', 'src-3'],
          used_instruction_ids: [],
          ignored_instruction_ids: [],
          harmful_instruction_ids: [],
          artifact_refs: [],
        },
        outcome_telemetry: {
          detection_type: 'manual_review',
          owner_lane: 'default',
          branch_chosen: 'backlog_only',
          validation_result: 'not_required',
          final_state: 'backlog_recorded',
          metric_flags: {
            reused_existing_record: false,
            created_new_record: false,
            rejected_output: false,
            converted_to_backlog: true,
          },
          recorded_at: '2026-06-28T00:00:00.000Z',
        },
      },
    });

    const rows = await events.query({ teamId, topics: [QUERY_DELIVERED] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      team_id: teamId,
      topic: QUERY_DELIVERED,
      subject_kind: 'query',
      subject_id: queryId,
      actor_agent_id: agentId,
      occurred_at: occurredAt,
      data: {
        query_id: queryId,
        status: 'delivered',
        agent: agentId,
        task_id: 'task:123',
        used_source_ids: ['src-1'],
        volunteered_source_ids: ['src-2', 'src-3'],
        learning_loop: {
          gap: { gap_type: 'validation_feedback_missing' },
          save_back: { decision: 'record-backlog' },
        },
        learned_artifact: learnedArtifact,
        message_preview: 'done',
      },
    });
  });
});
