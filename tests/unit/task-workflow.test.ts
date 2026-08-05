// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
  buildTaskWorkflowContract,
  canTransitionTaskWorkflow,
  knowledgePromotionEnvelope,
} from '../../src/task-workflow.js';

describe('task workflow contract', () => {
  it('holds incomplete dispatches in triage', () => {
    const result = buildTaskWorkflowContract({ title: 'Investigate' }, {
      taskId: 'task-1',
      taskUuid: 'uuid-1',
      teamId: 'team-1',
      teamName: 'engineering',
      ownerId: 'agent-1',
      nowMs: 1_000,
    });

    expect(result.state).toBe('triage_required');
    expect(result.missing).toEqual(expect.arrayContaining([
      'goal_id',
      'expected_output',
      'acceptance_criteria',
      'validation_path',
      'out_of_scope',
      'backlog_policy',
      'work_relevance',
    ]));
  });

  it('builds a dispatch-ready, bounded contract', () => {
    const result = buildTaskWorkflowContract({
      goal_id: 'goal-1',
      expected_output: 'A tested patch',
      acceptance_criteria: ['Tests pass'],
      validation_path: ['default/researcher'],
      out_of_scope: ['Unrelated refactors'],
      backlog_policy: 'defer when saturated',
      work_relevance: 'Improves manager reliability',
      source_ids: ['fact:1'],
    }, {
      taskId: 'task-1',
      taskUuid: 'uuid-1',
      teamId: 'team-1',
      teamName: 'engineering',
      ownerId: 'agent-1',
      nowMs: 1_000,
    });

    expect(result.missing).toEqual([]);
    expect(result.state).toBe('executing');
    expect((result.contract.timing as any).timeout_at).toBeGreaterThan(1_000);
    expect((result.contract.validation as any).fallback_validators).toHaveLength(2);
  });

  it('normalizes arbitrary namespaced relevance input without emitting the source field', () => {
    const result = buildTaskWorkflowContract({
      goal_id: 'goal-legacy',
      expected_output: 'A compatible task',
      acceptance_criteria: ['Task remains usable'],
      validation_path: ['default/researcher'],
      out_of_scope: ['New organization-specific policy'],
      backlog_policy: 'defer optional work',
      tenant_relevance: 'medium - imported task',
      source_ids: ['request:operator'],
    }, {
      taskId: 'task-legacy',
      taskUuid: 'uuid-legacy',
      teamId: 'team-1',
      teamName: 'default',
      ownerId: 'agent-1',
      nowMs: 1_000,
    });

    expect(result.missing).toEqual([]);
    expect(result.contract.relevance).toBe('medium - imported task');
    expect(result.contract).not.toHaveProperty('tenant_relevance');
  });

  it('records explicit material and domain ownership for bounded recovery routing', () => {
    const result = buildTaskWorkflowContract({
      goal_id: 'goal-recovery',
      expected_output: 'A reviewed policy',
      acceptance_criteria: ['Review cites the supplied policy'],
      validation_path: ['operations-team/content-moderator'],
      out_of_scope: ['Drafting a replacement policy'],
      backlog_policy: 'park when the source does not change',
      work_relevance: 'Prevents blind retries',
      source_ids: ['artifact:policy-draft'],
      material_owner_ids: ['policy-author-1'],
      material_owner_teams: ['content-team'],
      recovery: { domain_owner_teams: ['legal'] },
    }, {
      taskId: 'task-recovery',
      taskUuid: 'uuid-recovery',
      teamId: 'team-1',
      teamName: 'operations-team',
      ownerId: 'moderator-1',
      nowMs: 1_000,
    });

    expect(result.contract.recovery).toEqual({
      material_owner_ids: ['policy-author-1'],
      material_owner_teams: ['content-team'],
      domain_owner_teams: ['legal'],
    });
  });

  it('rejects invalid lifecycle jumps', () => {
    expect(canTransitionTaskWorkflow('executing', 'validation_pending')).toBe(true);
    expect(canTransitionTaskWorkflow('validated', 'executing')).toBe(false);
  });
});

describe('knowledge promotion envelope', () => {
  it('keeps unreviewed output private and promotes validated evidence', () => {
    const candidate = knowledgePromotionEnvelope({ confidence: 1 }, { taskId: 'task:1', nowMs: 1_000 });
    expect(candidate.reusable).toBe(false);

    const reusable = knowledgePromotionEnvelope({
      validation_status: 'validated',
      confidence: 0.9,
      evidence_ids: ['artifact:1'],
      contradictions: ['fact:old'],
      supersedes: ['fact:prior'],
    }, { taskId: 'task:1', reviewerId: 'validator-1', nowMs: 1_000 });
    expect(reusable.reusable).toBe(true);
    expect(reusable.reviewer_id).toBe('validator-1');
    expect(reusable.expires_at).toBeGreaterThan(1_000);
  });
});
