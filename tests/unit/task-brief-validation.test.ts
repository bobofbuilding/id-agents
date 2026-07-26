// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import {
  appendTaskBriefFieldsToDescription,
  getWorkPriority,
  shouldBlockTaskBrief,
  validateTaskBrief,
  validateTaskCompletionPacket,
  type WorkPriority,
  type TaskBriefValidationInput,
  type TaskBriefValidationMode,
  type TaskBriefValidationResult,
} from '../../src/task-brief-validation.js';

const completeBrief: TaskBriefValidationInput = {
  title: 'Write task brief validation tests',
  description: 'Unit coverage for task brief validation.',
  goal_id: 'goal_implement_brief_validation',
  expected_output: 'tests/unit/task-brief-validation.test.ts with focused Vitest coverage',
  acceptance_criteria: [
    'all required fields are checked',
    'blocking behavior is covered',
  ],
  validation_path: ['coder', 'researcher'],
  out_of_scope: 'Integration tests and production code changes',
  backlog_policy: 'Move edge cases requiring module changes into follow-up tasks',
  work_relevance: 'high - dispatch validation protects Bittrees task quality',
};

function failingResult(mode: TaskBriefValidationMode): TaskBriefValidationResult {
  return {
    ok: false,
    decision: 'rewrite_required',
    missing: ['expected_output'],
    invalid: [],
    route: 'brief-rewrite',
    dispatch_ready: false,
    message: 'Task brief is not dispatch-ready.',
    mode,
    reason_codes: ['missing_expected_output'],
  };
}

describe('validateTaskBrief', () => {
  it('accepts a complete task brief in enforce mode', () => {
    const result = validateTaskBrief(completeBrief, 'enforce');

    expect(result).toMatchObject({
      ok: true,
      decision: 'accept',
      missing: [],
      invalid: [],
      route: 'dispatch',
      dispatch_ready: true,
      mode: 'enforce',
      reason_codes: [],
    });
  });

  it.each([
    ['goal_id', 'goal_id'],
    ['expected_output', 'expected_output'],
    ['acceptance_criteria', 'acceptance_criteria'],
    ['validation_path', 'validation_path'],
    ['out_of_scope', 'out_of_scope'],
    ['backlog_policy', 'backlog_policy'],
    ['work_relevance', 'work_relevance'],
  ] as Array<[keyof TaskBriefValidationInput, string]>)('reports missing %s', (inputKey, reportedField) => {
    const input = { ...completeBrief };
    delete input[inputKey];

    const result = validateTaskBrief(input, 'enforce');

    expect(result.ok).toBe(false);
    expect(result.missing).toContain(reportedField);
    expect(result.reason_codes).toContain(`missing_${reportedField}`);
    expect(result.dispatch_ready).toBe(false);
  });

  it('reports a provided but keyword-less work_relevance as invalid, not missing', () => {
    const result = validateTaskBrief({
      ...completeBrief,
      work_relevance: 'keeps the fleet manager sweeper reliable for all agent teams',
    }, 'enforce');

    expect(result.ok).toBe(false);
    expect(result.invalid).toContain('work_relevance');
    expect(result.missing).not.toContain('work_relevance');
    expect(result.reason_codes).toContain('invalid_work_relevance');
    expect(result.dispatch_ready).toBe(false);
  });

  it('accepts recommendation-routing aliases as the required backlog policy control', () => {
    const input = { ...completeBrief };
    delete input.backlog_policy;

    const result = validateTaskBrief({
      ...input,
      recommendation_routing_instructions: 'Route high/medium approved follow-ups live; keep low-relevance recommendations in backlog.',
    }, 'enforce');

    expect(result).toMatchObject({
      ok: true,
      decision: 'accept',
      missing: [],
      invalid: [],
      route: 'dispatch',
    });
  });

  it('routes a missing goal_id to goal triage', () => {
    const input = { ...completeBrief };
    delete input.goal_id;

    const result = validateTaskBrief(input, 'enforce');

    expect(result).toMatchObject({
      ok: false,
      decision: 'goal_triage_required',
      route: 'goal-triage',
      missing: ['goal_id'],
    });
  });

  it('reports an invalid goal_id separately from missing fields', () => {
    const result = validateTaskBrief({ ...completeBrief, goal_id: 'not-a-goal' }, 'enforce');

    expect(result).toMatchObject({
      ok: false,
      decision: 'goal_triage_required',
      route: 'goal-triage',
      missing: [],
      invalid: ['goal_id'],
      reason_codes: ['invalid_goal_id'],
    });
  });

  it('accepts recognized task brief labels from title and description text', () => {
    const result = validateTaskBrief(
      {
        title: 'Implement coverage for goal_implement_brief_validation',
        description: [
          'Expected output: unit tests are committed',
          'Acceptance criteria: required fields and modes are tested',
          'Validation path: coder validates implementation and researcher validates coverage',
          'Out of scope: integration tests',
          'Backlog policy: track module behavior changes separately',
          'Work relevance: medium - improves dispatch quality',
        ].join('\n'),
      },
      'warn',
    );

    expect(result).toMatchObject({
      ok: true,
      decision: 'accept',
      route: 'dispatch',
      dispatch_ready: true,
      mode: 'warn',
    });
  });

  it('accepts recommendation-routing labels from description text', () => {
    const result = validateTaskBrief(
      {
        title: 'Implement coverage for goal_implement_brief_validation',
        description: [
          'Expected output: unit tests are committed',
          'Acceptance criteria: required fields and modes are tested',
          'Validation path: coder validates implementation and researcher validates coverage',
          'Out of scope: integration tests',
          'Recommendation routing: low-relevance suggestions stay in backlog; approved high/medium follow-ups route through lead.',
          'Work relevance: medium - improves dispatch quality',
        ].join('\n'),
      },
      'enforce',
    );

    expect(result).toMatchObject({
      ok: true,
      decision: 'accept',
      route: 'dispatch',
      dispatch_ready: true,
    });
  });

  it('requires expiry and review owner for bypass briefs', () => {
    const result = validateTaskBrief(
      {
        ...completeBrief,
        bypass_reason: 'Emergency production mitigation',
      },
      'enforce',
    );

    expect(result).toMatchObject({
      ok: false,
      decision: 'rewrite_required',
      route: 'brief-rewrite',
      dispatch_ready: false,
      missing: ['expires_at', 'post_incident_review_owner'],
    });
    expect(result.message).toContain('bypass is missing required metadata');
  });

  it('accepts bypass briefs with reason, expiry, and post-incident owner', () => {
    const result = validateTaskBrief(
      {
        ...completeBrief,
        bypass_reason: 'Emergency production mitigation',
        expires_at: '2026-07-04T00:00:00Z',
        post_incident_review_owner: 'engineering-lead',
      },
      'enforce',
    );

    expect(result).toMatchObject({
      ok: true,
      decision: 'bypass_with_reason',
      missing: [],
      invalid: [],
      route: 'dispatch',
      dispatch_ready: true,
    });
  });

  it('returns accept when validation mode is off', () => {
    const result = validateTaskBrief({}, 'off');

    expect(result).toEqual({
      ok: true,
      decision: 'accept',
      missing: [],
      invalid: [],
      route: 'dispatch',
      dispatch_ready: true,
      message: 'Task brief validation is disabled.',
      mode: 'off',
      reason_codes: [],
    });
  });

  it('does not block invalid briefs in warn mode', () => {
    const result = validateTaskBrief({}, 'warn');

    expect(result.ok).toBe(false);
    expect(result.mode).toBe('warn');
    expect(shouldBlockTaskBrief(result)).toBe(false);
  });

  it('blocks invalid briefs in enforce mode', () => {
    const result = validateTaskBrief({}, 'enforce');

    expect(result.ok).toBe(false);
    expect(result.mode).toBe('enforce');
    expect(shouldBlockTaskBrief(result)).toBe(true);
  });
});

describe('validateTaskCompletionPacket', () => {
  it('accepts completion packets with acceptance coverage', () => {
    const result = validateTaskCompletionPacket(
      { acceptance_coverage: { 'all field checks': 'covered' } },
      'enforce',
    );

    expect(result).toMatchObject({
      ok: true,
      decision: 'accept',
      missing: [],
      mode: 'enforce',
    });
  });

  it('accepts completion packets with a failure note', () => {
    const result = validateTaskCompletionPacket(
      { failure_note: 'Implementation is blocked by missing source module.' },
      'enforce',
    );

    expect(result).toMatchObject({
      ok: true,
      decision: 'accept',
      missing: [],
      mode: 'enforce',
    });
  });

  it('requires acceptance coverage or a failure note', () => {
    const result = validateTaskCompletionPacket({}, 'enforce');

    expect(result).toEqual({
      ok: false,
      decision: 'completion_packet_required',
      missing: ['acceptance_coverage_or_failure_note'],
      message: 'Task completion success requires acceptance coverage or an explicit failure note.',
      mode: 'enforce',
    });
  });
});

describe('getWorkPriority', () => {
  it.each([
    ['high', 'high'],
    ['medium', 'medium'],
    ['low', 'low/backlog'],
    ['backlog', 'low/backlog'],
    ['low/backlog', 'low/backlog'],
    ['reject', 'reject'],
  ] as Array<[string, WorkPriority]>)('extracts %s priority from structured fields', (value, expected) => {
    expect(getWorkPriority({ work_relevance: `${value} - rationale` })).toBe(expected);
  });

  it.each([
    ['Work relevance: high - urgent infrastructure work', 'high'],
    ['Work relevance: medium - useful hardening', 'medium'],
    ['Contributor relevance: low - can wait', 'low/backlog'],
    ['Relevance: backlog - revisit after release', 'low/backlog'],
    ['Work relevance: reject - unrelated to contributor outcomes', 'reject'],
  ] as Array<[string, WorkPriority]>)('extracts priority from text label "%s"', (text, expected) => {
    expect(getWorkPriority({}, text)).toBe(expected);
  });

  it('accepts the pre-neutral schema only as an input compatibility alias', () => {
    expect(getWorkPriority({ bittrees_relevance: 'medium - legacy task' })).toBe('medium');
    expect(getWorkPriority({}, 'Bittrees relevance: low/backlog - legacy task')).toBe('low/backlog');
  });

  it('returns null when no work priority is present', () => {
    expect(getWorkPriority({}, 'No relevance label here.')).toBeNull();
  });
});

describe('shouldBlockTaskBrief', () => {
  it.each([
    ['off', false, false],
    ['off', true, false],
    ['warn', false, false],
    ['warn', true, true],
    ['enforce', false, true],
    ['enforce', true, true],
  ] as Array<[TaskBriefValidationMode, boolean, boolean]>)(
    'mode=%s immediateExecution=%s -> %s',
    (mode, immediateExecution, expected) => {
      expect(shouldBlockTaskBrief(failingResult(mode), { immediateExecution })).toBe(expected);
    },
  );

  it('does not block successful briefs even when immediate execution is requested', () => {
    expect(
      shouldBlockTaskBrief(
        {
          ...failingResult('enforce'),
          ok: true,
          decision: 'accept',
          missing: [],
          route: 'dispatch',
          dispatch_ready: true,
          reason_codes: [],
        },
        { immediateExecution: true },
      ),
    ).toBe(false);
  });
});

describe('appendTaskBriefFieldsToDescription', () => {
  it('appends task brief fields to the description', () => {
    const result = appendTaskBriefFieldsToDescription('Base task description.', {
      goal_id: 'goal_implement_brief_validation',
      expected_output: 'Unit tests pass',
      acceptance_criteria: ['field checks covered', 'modes covered'],
      validation_path: ['coder', 'researcher'],
      out_of_scope: 'Production code changes',
      backlog_policy: 'Track discovered edge cases separately',
      work_relevance: 'high - task dispatch infrastructure',
      target: 'https://agent.bittrees.org/docs/launch',
      parent_task: '#40077396',
      validation_purpose: 'Confirm unit coverage before merge',
    });

    expect(result).toBe([
      'Base task description.',
      '',
      'Goal ID: goal_implement_brief_validation',
      'Expected output: Unit tests pass',
      'Acceptance criteria: field checks covered; modes covered',
      'Validation path: coder; researcher',
      'Out of scope: Production code changes',
      'Backlog policy: Track discovered edge cases separately',
      'Work relevance: high - task dispatch infrastructure',
      'Target: https://agent.bittrees.org/docs/launch',
      'Parent task: #40077396',
      'Validation purpose: Confirm unit coverage before merge',
    ].join('\n'));
  });

  it('does not duplicate fields already present in the description', () => {
    const existing = [
      'Existing task description.',
      '',
      'Goal ID: goal_existing',
      'Expected output: already present',
      'Acceptance criteria: already present',
      'Validation path: coder and researcher already present',
      'Out of scope: already present',
      'Backlog policy: already present',
      'Work relevance: high - already present',
      'Target: https://agent.bittrees.org/docs/launch',
      'Parent task: #parent',
      'Validation purpose: already present',
    ].join('\n');

    const result = appendTaskBriefFieldsToDescription(existing, {
      goal_id: 'goal_implement_brief_validation',
      expected_output: 'Unit tests pass',
      acceptance_criteria: ['field checks covered'],
      validation_path: ['coder', 'researcher'],
      out_of_scope: 'Production code changes',
      backlog_policy: 'Track discovered edge cases separately',
      work_relevance: 'medium - task dispatch infrastructure',
      target: 'https://agent.bittrees.org/docs/launch',
      parent_task: '#40077396',
      validation_purpose: 'Confirm unit coverage before merge',
    });

    expect(result).toBe(existing);
  });

  it('normalizes recommendation-routing aliases into the stored backlog policy field', () => {
    const result = appendTaskBriefFieldsToDescription('Base task description.', {
      recommendation_routing: 'Lead routes approved high/medium follow-ups; low-relevance recommendations stay backlog.',
    });

    expect(result).toBe([
      'Base task description.',
      '',
      'Backlog policy: Lead routes approved high/medium follow-ups; low-relevance recommendations stay backlog.',
    ].join('\n'));
  });

  it('does not append backlog policy when recommendation-routing text already exists', () => {
    const existing = [
      'Existing task description.',
      '',
      'Recommendation routing: already present',
    ].join('\n');

    const result = appendTaskBriefFieldsToDescription(existing, {
      recommendation_routing: 'Do not duplicate this value.',
    });

    expect(result).toBe(existing);
  });

  it('does not append target when the description already includes it', () => {
    const existing = [
      'Existing task description.',
      '',
      'Target: https://agent.bittrees.org/docs/launch',
    ].join('\n');

    const result = appendTaskBriefFieldsToDescription(existing, {
      target: 'https://agent.bittrees.org/docs/launch',
    });

    expect(result).toBe(existing);
  });
});
