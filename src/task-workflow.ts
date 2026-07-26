// SPDX-License-Identifier: MIT

import type { TaskWorkflowState } from './db/types.js';

export const TASK_WORKFLOW_VERSION = 'task-workflow.v1';

export interface TaskWorkflowContractResult {
  contract: Record<string, unknown>;
  missing: string[];
  state: TaskWorkflowState;
}

const TRANSITIONS: Record<TaskWorkflowState, readonly TaskWorkflowState[]> = {
  triage_required: ['ready', 'queued', 'blocked', 'superseded', 'retired'],
  ready: ['queued', 'executing', 'blocked', 'superseded', 'retired'],
  queued: ['executing', 'blocked', 'stalled', 'superseded', 'retired'],
  executing: ['blocked', 'stalled', 'validation_pending', 'validated', 'failed', 'superseded'],
  blocked: ['ready', 'queued', 'executing', 'stalled', 'failed', 'superseded', 'retired'],
  stalled: ['ready', 'queued', 'executing', 'blocked', 'failed', 'superseded', 'retired'],
  validation_pending: ['executing', 'blocked', 'validated', 'failed', 'superseded'],
  validated: ['retired', 'superseded'],
  superseded: ['retired'],
  retired: [],
  failed: ['ready', 'queued', 'retired', 'superseded'],
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function first(input: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = text(input[key]);
    if (value) return value;
  }
  return '';
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))];
  const valueText = text(value);
  return valueText ? [valueText] : [];
}

function label(description: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return description.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*:\\s*([^\\n]+)`, 'i'))?.[1]?.trim() || '';
}

function timestamp(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 10_000_000_000 ? Math.floor(value) : Math.floor(value * 1000);
  const raw = text(value);
  if (!raw) return fallback;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? Math.floor(numeric) : Math.floor(numeric * 1000);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function buildTaskWorkflowContract(input: Record<string, unknown>, context: {
  taskId: string;
  taskUuid: string;
  teamId: string;
  teamName: string;
  ownerId?: string | null;
  ownerName?: string | null;
  actorId?: string | null;
  nowMs?: number;
}): TaskWorkflowContractResult {
  const nowMs = context.nowMs ?? Date.now();
  const description = text(input.description);
  const goalId = first(input, ['goal_id', 'goalId']) || label(description, 'Goal ID') || description.match(/\bgoal_[a-z0-9_]+\b/i)?.[0] || '';
  const expectedOutput = first(input, ['expected_output', 'expectedOutput']) || label(description, 'Expected output') || label(description, 'Output');
  const acceptance = list(input.acceptance_criteria ?? input.acceptanceCriteria);
  if (!acceptance.length) acceptance.push(...list(label(description, 'Acceptance criteria')));
  const validationPath = list(input.validation_path ?? input.validationPath);
  if (!validationPath.length) validationPath.push(...list(label(description, 'Validation path')));
  const outOfScope = list(input.out_of_scope ?? input.outOfScope);
  if (!outOfScope.length) outOfScope.push(...list(label(description, 'Out of scope')));
  const backlogPolicy = first(input, ['backlog_policy', 'backlogPolicy', 'recommendation_routing', 'recommendationRouting'])
    || label(description, 'Backlog policy');
  const relevance = first(input, [
    'work_relevance',
    'workRelevance',
    'bittrees_relevance',
    'bittreesRelevance',
    'relevance',
  ]) || label(description, 'Work relevance') || label(description, 'Bittrees relevance');
  const sourceIds = list(input.source_ids ?? input.sourceIds ?? input.provenance_refs ?? input.provenanceRefs);
  const parentTaskId = first(input, ['parent_task_id', 'parentTaskId', 'parent_task', 'parentTask']) || label(description, 'Parent task');
  const inputs = list(input.inputs ?? input.input_refs ?? input.inputRefs);
  if (!inputs.length) inputs.push(`request:${context.actorId || 'operator'}`);
  if (!sourceIds.length) sourceIds.push(`request:${context.actorId || 'operator'}`);

  const deadlineAt = timestamp(input.deadline_at ?? input.deadlineAt, nowMs + 24 * 60 * 60 * 1000);
  const timeoutAt = timestamp(input.timeout_at ?? input.timeoutAt, nowMs + 45 * 60 * 1000);
  const retryAt = timestamp(input.retry_at ?? input.retryAt, timeoutAt + 5 * 60 * 1000);
  const fallbackRoute = first(input, ['fallback_route', 'fallbackRoute']) || 'operations-team/task-master';
  const validators = list(input.validators ?? input.validator_ids ?? input.validatorIds);
  if (!validators.length) validators.push('default/coder', 'default/researcher');
  const fallbackValidators = list(input.fallback_validators ?? input.fallbackValidators);
  if (!fallbackValidators.length) fallbackValidators.push('owning-team/lead', 'operations-team/task-master');

  const missing = [
    !goalId && 'goal_id',
    !context.teamId && 'team_id',
    !context.ownerId && 'owner_id',
    !expectedOutput && 'expected_output',
    !acceptance.length && 'acceptance_criteria',
    !validationPath.length && 'validation_path',
    !outOfScope.length && 'out_of_scope',
    !backlogPolicy && 'backlog_policy',
    !relevance && 'work_relevance',
    !sourceIds.length && 'source_ids',
  ].filter((value): value is string => Boolean(value));

  const state: TaskWorkflowState = missing.length
    ? 'triage_required'
    : context.ownerId ? 'executing' : 'ready';
  return {
    state,
    missing,
    contract: {
      version: TASK_WORKFLOW_VERSION,
      task_id: context.taskId,
      task_uuid: context.taskUuid,
      goal_id: goalId || null,
      team: { id: context.teamId, name: context.teamName },
      owner: context.ownerId ? { id: context.ownerId, name: context.ownerName || context.ownerId } : null,
      inputs,
      expected_output: expectedOutput || null,
      acceptance_criteria: acceptance,
      source_ids: sourceIds,
      scope: { out_of_scope: outOfScope },
      backlog_policy: backlogPolicy || null,
      relevance: relevance || null,
      parent_task_id: parentTaskId || null,
      validation: {
        route: validationPath,
        validators,
        fallback_validators: fallbackValidators,
        deadline_at: deadlineAt,
        max_revision_cycles: Math.max(1, Math.min(5, Number(input.max_revision_cycles ?? input.maxRevisionCycles) || 2)),
      },
      timing: {
        deadline_at: deadlineAt,
        timeout_at: timeoutAt,
        retry_at: retryAt,
        fallback_route: fallbackRoute,
      },
      promotion: {
        reusable: false,
        requires_validation: true,
        evidence_threshold: Math.max(1, Math.min(10, Number(input.evidence_threshold ?? input.evidenceThreshold) || 2)),
        confidence_threshold: Math.max(0, Math.min(1, Number(input.confidence_threshold ?? input.confidenceThreshold) || 0.7)),
      },
      created_at: nowMs,
      created_by: context.actorId || null,
      missing,
    },
  };
}

export function canTransitionTaskWorkflow(from: TaskWorkflowState | null | undefined, to: TaskWorkflowState): boolean {
  if (!from) return true;
  if (from === to) return true;
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function taskWorkflowStateForLegacyStatus(status: 'todo' | 'doing' | 'done'): TaskWorkflowState {
  if (status === 'done') return 'validated';
  if (status === 'doing') return 'executing';
  return 'queued';
}

export function knowledgePromotionEnvelope(input: Record<string, unknown>, defaults: {
  taskId?: string | null;
  sourceIds?: string[];
  reviewerId?: string | null;
  nowMs?: number;
} = {}): Record<string, unknown> {
  const nowMs = defaults.nowMs ?? Date.now();
  const evidence = list(input.evidence_ids ?? input.evidenceIds ?? defaults.sourceIds);
  const confidence = Math.max(0, Math.min(1, Number(input.confidence) || 0));
  const validationStatus = first(input, ['validation_status', 'validationStatus']) || 'pending';
  return {
    version: 'knowledge-promotion.v1',
    task_id: defaults.taskId || null,
    source_ids: list(input.source_ids ?? input.sourceIds ?? defaults.sourceIds),
    evidence_ids: evidence,
    confidence,
    validation_status: validationStatus,
    reviewer_id: first(input, ['reviewer_id', 'reviewerId']) || defaults.reviewerId || null,
    expires_at: timestamp(input.expires_at ?? input.expiresAt, nowMs + 180 * 24 * 60 * 60 * 1000),
    supersedes: list(input.supersedes),
    contradictions: list(input.contradictions ?? input.contradiction_ids ?? input.contradictionIds),
    namespace: first(input, ['namespace']) || 'task-learning',
    reusable: validationStatus === 'validated' && evidence.length > 0 && confidence >= 0.7,
    measured_outcome: input.measured_outcome ?? input.measuredOutcome ?? null,
    created_at: nowMs,
  };
}
