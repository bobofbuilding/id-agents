// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { normalizeLearningLoopCapture } from '../../src/core/learning-loop-capture.js';

describe('normalizeLearningLoopCapture', () => {
  it('returns null when no structured learning-loop payload is present', () => {
    expect(normalizeLearningLoopCapture({
      payload: { message: 'done' },
      subject: { kind: 'task', ref: 'task:1', route: 'manager.task_completion' },
      teamName: 'engineering-team',
    })).toBeNull();
  });

  it('normalizes structured capture with defaults and derived source recovery', () => {
    const capture = normalizeLearningLoopCapture({
      payload: {
        learningLoop: {
          gapType: 'missing_source_ids',
          saveBackDecision: 'save',
          sourceRecovery: {
            requiredSourceIds: ['memory:101', 'artifact:./output/report.md'],
            missingSourceIds: ['artifact:./output/report.md'],
          },
          evidence: {
            usedInstructionIds: ['memory:88'],
          },
          backlogRule: {
            candidateRefs: ['backlog:1'],
          },
        },
      },
      subject: { kind: 'task', ref: 'task:1', route: 'manager.task_completion' },
      teamName: 'engineering-team',
      agentId: 'agent-coder',
      usedSourceIds: ['memory:101'],
      volunteeredSourceIds: ['memory:102'],
      occurredAt: Date.UTC(2026, 5, 28),
    });

    expect(capture).toMatchObject({
      schema: 'brain.learning_loop_capture.v1',
      subject: {
        kind: 'task',
        ref: 'task:1',
        route: 'manager.task_completion',
      },
      gap: {
        gap_type: 'missing_source_ids',
        severity: 'medium',
        required_for_acceptance: false,
      },
      owner: {
        owner_team: 'engineering-team',
        owner_agent_id: 'agent-coder',
      },
      validation_path: {
        required: true,
        default_validators: ['coder', 'researcher'],
        relay_target: 'owning_team_lead',
        final_relay: 'default_validator_pair',
      },
      save_back: {
        decision: 'save',
        expected: true,
        mode: 'apply_after_validation',
        target_type: 'none',
        operation: 'save',
      },
      source_recovery: {
        required_source_ids: ['memory:101', 'artifact:./output/report.md'],
        available_source_ids: ['memory:101', 'memory:102'],
        missing_source_ids: ['artifact:./output/report.md'],
        recovery_state: 'partial',
      },
      backlog_rule: {
        current_scope_only: true,
        optional_improvements: 'record_as_backlog_candidate',
        backlog_allowed: true,
        optional_items_block_acceptance: false,
        candidate_refs: ['backlog:1'],
      },
      evidence: {
        used_source_ids: ['memory:101'],
        volunteered_source_ids: ['memory:102'],
        used_instruction_ids: ['memory:88'],
      },
      outcome_telemetry: {
        detection_type: 'manual_review',
        owner_lane: 'engineering-team',
        branch_chosen: 'save_back',
        validation_result: 'approved',
        final_state: 'saved_back',
      },
    });
    expect(capture?.outcome_telemetry.recorded_at).toBe('2026-06-28T00:00:00.000Z');
  });
});
