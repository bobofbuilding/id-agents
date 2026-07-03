// SPDX-License-Identifier: MIT

export interface LearningLoopCapture {
  schema: 'brain.learning_loop_capture.v1';
  subject: {
    kind: 'task' | 'query';
    ref: string;
    route: string;
  };
  gap: {
    gap_type: string;
    severity: string;
    required_for_acceptance: boolean;
  };
  owner: {
    owner_team: string;
    owner_agent_id: string | null;
  };
  validation_path: {
    required: boolean;
    default_validators: string[];
    specialists: string[];
    relay_target: string;
    final_relay: string;
  };
  save_back: {
    decision: string;
    expected: boolean;
    mode: string;
    target_type: string;
    target_ref: string | null;
    operation: string | null;
  };
  source_recovery: {
    required_source_ids: string[];
    available_source_ids: string[];
    missing_source_ids: string[];
    recovery_state: string;
    evidence_refs: string[];
  };
  backlog_rule: {
    current_scope_only: boolean;
    optional_improvements: string;
    backlog_allowed: boolean;
    optional_items_block_acceptance: boolean;
    candidate_refs: string[];
  };
  evidence: {
    used_source_ids: string[];
    volunteered_source_ids: string[];
    used_instruction_ids: string[];
    ignored_instruction_ids: string[];
    harmful_instruction_ids: string[];
    artifact_refs: string[];
  };
  outcome_telemetry: {
    detection_type: string;
    owner_lane: string;
    branch_chosen: string;
    validation_result: string;
    final_state: string;
    metric_flags: {
      reused_existing_record: boolean;
      created_new_record: boolean;
      rejected_output: boolean;
      converted_to_backlog: boolean;
    };
    recorded_at: string;
  };
}

export interface NormalizeLearningLoopCaptureInput {
  payload: Record<string, unknown> | null | undefined;
  subject: {
    kind: 'task' | 'query';
    ref: string;
    route: string;
  };
  teamName: string;
  agentId?: string | null;
  usedSourceIds?: string[];
  volunteeredSourceIds?: string[];
  occurredAt?: number;
}

const SOURCE_RELATED_GAPS = new Set([
  'missing_source_ids',
  'weak_source',
  'source_recovery',
  'stale_memory',
  'stale_fact',
]);

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function firstInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isInteger(value)) return value;
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.map((item) => String(item).trim()).filter(Boolean)))
    : [];
}

function mapDecisionToBranch(decision: string): string {
  switch (decision) {
    case 'save':
    case 'update':
      return 'save_back';
    case 'supersede':
      return 'supersede';
    case 'archive':
      return 'archive';
    case 'reject':
      return 'reject';
    case 'mark-needs-source':
      return 'mark_needs_source';
    case 'mark-needs-review':
      return 'mark_needs_review';
    case 'record-backlog':
      return 'backlog_only';
    default:
      return 'no_action';
  }
}

function mapBranchToFinalState(branchChosen: string, recoveryState: string): string {
  switch (branchChosen) {
    case 'save_back':
    case 'supersede':
      return 'saved_back';
    case 'archive':
      return 'archived';
    case 'reject':
      return 'rejected';
    case 'mark_needs_review':
      return 'needs_review';
    case 'backlog_only':
      return 'backlog_recorded';
    case 'mark_needs_source':
      return 'needs_source';
    default:
      return recoveryState === 'failed' || recoveryState === 'needed' || recoveryState === 'partial'
        ? 'needs_source'
        : 'no_action';
  }
}

function deriveRecoveryState(
  explicit: string | undefined,
  gapType: string,
  requiredSourceIds: string[],
  availableSourceIds: string[],
  missingSourceIds: string[],
): string {
  if (explicit) return explicit;

  const available = new Set(availableSourceIds);
  const unresolvedRequired = requiredSourceIds.filter((sourceId) => !available.has(sourceId));
  if (missingSourceIds.length > 0) {
    return availableSourceIds.length > 0 ? 'partial' : 'needed';
  }
  if (unresolvedRequired.length > 0) {
    return availableSourceIds.length > 0 ? 'partial' : 'needed';
  }
  if (requiredSourceIds.length > 0 && unresolvedRequired.length === 0) {
    return 'recovered';
  }
  if (availableSourceIds.length > 0 && SOURCE_RELATED_GAPS.has(gapType)) {
    return 'recovered';
  }
  if (gapType === 'source_recovery') {
    return 'needed';
  }
  return 'not_needed';
}

export function extractLearningLoopCapture(
  payload: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!payload) return null;
  return asObject(payload.learning_loop) || asObject(payload.learningLoop);
}

export function normalizeLearningLoopCapture(input: NormalizeLearningLoopCaptureInput): LearningLoopCapture | null {
  const capture = extractLearningLoopCapture(input.payload);
  if (!capture) return null;

  const gap = asObject(capture.gap);
  const owner = asObject(capture.owner);
  const validationPath = asObject(capture.validation_path) || asObject(capture.validationPath);
  const saveBack = asObject(capture.save_back) || asObject(capture.saveBack);
  const sourceRecovery = asObject(capture.source_recovery) || asObject(capture.sourceRecovery);
  const backlogRule = asObject(capture.backlog_rule) || asObject(capture.backlogRule);
  const evidence = asObject(capture.evidence);
  const outcomeTelemetry = asObject(capture.outcome_telemetry) || asObject(capture.outcomeTelemetry);
  const validation = asObject(capture.validation);

  const usedSourceIds = Array.from(new Set([
    ...(input.usedSourceIds || []),
    ...stringArray(evidence?.used_source_ids || evidence?.usedSourceIds),
  ]));
  const volunteeredSourceIds = Array.from(new Set([
    ...(input.volunteeredSourceIds || []),
    ...stringArray(evidence?.volunteered_source_ids || evidence?.volunteeredSourceIds),
  ]));
  const availableSourceIds = Array.from(new Set([
    ...stringArray(sourceRecovery?.available_source_ids || sourceRecovery?.availableSourceIds),
    ...usedSourceIds,
    ...volunteeredSourceIds,
  ]));
  const requiredSourceIds = stringArray(
    sourceRecovery?.required_source_ids
      || sourceRecovery?.requiredSourceIds
      || evidence?.required_source_ids
      || evidence?.requiredSourceIds,
  );
  const missingSourceIds = stringArray(
    sourceRecovery?.missing_source_ids
      || sourceRecovery?.missingSourceIds
      || capture.missing_source_ids
      || capture.missingSourceIds,
  );

  const gapType = firstString(
    capture.gap_type,
    capture.gapType,
    gap?.gap_type,
    gap?.gapType,
  ) || 'schema_violation';
  const ownerTeam = firstString(
    capture.owner_team,
    capture.ownerTeam,
    owner?.owner_team,
    owner?.ownerTeam,
    input.teamName,
  ) || input.teamName;
  const decision = firstString(
    saveBack?.decision,
    capture.save_back_decision,
    capture.saveBackDecision,
    saveBack?.operation,
  ) || (missingSourceIds.length > 0 ? 'mark-needs-source' : 'none');
  const branchChosen = firstString(
    outcomeTelemetry?.branch_chosen,
    outcomeTelemetry?.branchChosen,
  ) || mapDecisionToBranch(decision);
  const recoveryState = deriveRecoveryState(
    firstString(sourceRecovery?.recovery_state, sourceRecovery?.recoveryState),
    gapType,
    requiredSourceIds,
    availableSourceIds,
    missingSourceIds,
  );
  const finalState = firstString(
    outcomeTelemetry?.final_state,
    outcomeTelemetry?.finalState,
  ) || mapBranchToFinalState(branchChosen, recoveryState);
  const validationResult = firstString(
    outcomeTelemetry?.validation_result,
    outcomeTelemetry?.validationResult,
    validation?.state,
  ) || (branchChosen === 'save_back' || branchChosen === 'supersede'
    ? 'approved'
    : finalState === 'rejected'
      ? 'rejected'
      : finalState === 'needs_review' || finalState === 'needs_source'
        ? 'validation_pending'
        : 'not_required');

  const recordedAt = firstString(outcomeTelemetry?.recorded_at, outcomeTelemetry?.recordedAt)
    || new Date(firstInteger(input.occurredAt) ?? Date.now()).toISOString();

  return {
    schema: 'brain.learning_loop_capture.v1',
    subject: {
      kind: input.subject.kind,
      ref: input.subject.ref,
      route: input.subject.route,
    },
    gap: {
      gap_type: gapType,
      severity: firstString(gap?.severity, capture.severity) || 'medium',
      required_for_acceptance: firstBoolean(
        gap?.required_for_acceptance,
        gap?.requiredForAcceptance,
        capture.required_for_acceptance,
        capture.requiredForAcceptance,
      ) ?? false,
    },
    owner: {
      owner_team: ownerTeam,
      owner_agent_id: firstString(owner?.owner_agent_id, owner?.ownerAgentId, input.agentId) || null,
    },
    validation_path: {
      required: firstBoolean(validationPath?.required) ?? true,
      default_validators: stringArray(validationPath?.default_validators || validationPath?.defaultValidators).length
        ? stringArray(validationPath?.default_validators || validationPath?.defaultValidators)
        : ['coder', 'researcher'],
      specialists: stringArray(validationPath?.specialists),
      relay_target: firstString(validationPath?.relay_target, validationPath?.relayTarget) || 'owning_team_lead',
      final_relay: firstString(validationPath?.final_relay, validationPath?.finalRelay) || 'default_validator_pair',
    },
    save_back: {
      decision,
      expected: firstBoolean(saveBack?.expected) ?? (decision !== 'none' && decision !== 'record-backlog'),
      mode: firstString(saveBack?.mode) || (decision === 'save' || decision === 'update' ? 'apply_after_validation' : 'advisory_only'),
      target_type: firstString(saveBack?.target_type, saveBack?.targetType) || 'none',
      target_ref: firstString(saveBack?.target_ref, saveBack?.targetRef) || null,
      operation: firstString(saveBack?.operation) || (decision === 'none' ? null : decision),
    },
    source_recovery: {
      required_source_ids: requiredSourceIds,
      available_source_ids: availableSourceIds,
      missing_source_ids: missingSourceIds,
      recovery_state: recoveryState,
      evidence_refs: stringArray(sourceRecovery?.evidence_refs || sourceRecovery?.evidenceRefs),
    },
    backlog_rule: {
      current_scope_only: firstBoolean(backlogRule?.current_scope_only, backlogRule?.currentScopeOnly) ?? true,
      optional_improvements: firstString(backlogRule?.optional_improvements, backlogRule?.optionalImprovements) || 'record_as_backlog_candidate',
      backlog_allowed: firstBoolean(backlogRule?.backlog_allowed, backlogRule?.backlogAllowed) ?? true,
      optional_items_block_acceptance: firstBoolean(
        backlogRule?.optional_items_block_acceptance,
        backlogRule?.optionalItemsBlockAcceptance,
      ) ?? false,
      candidate_refs: stringArray(backlogRule?.candidate_refs || backlogRule?.candidateRefs),
    },
    evidence: {
      used_source_ids: usedSourceIds,
      volunteered_source_ids: volunteeredSourceIds,
      used_instruction_ids: stringArray(evidence?.used_instruction_ids || evidence?.usedInstructionIds),
      ignored_instruction_ids: stringArray(evidence?.ignored_instruction_ids || evidence?.ignoredInstructionIds),
      harmful_instruction_ids: stringArray(evidence?.harmful_instruction_ids || evidence?.harmfulInstructionIds),
      artifact_refs: stringArray(evidence?.artifact_refs || evidence?.artifactRefs),
    },
    outcome_telemetry: {
      detection_type: firstString(outcomeTelemetry?.detection_type, outcomeTelemetry?.detectionType) || 'manual_review',
      owner_lane: firstString(outcomeTelemetry?.owner_lane, outcomeTelemetry?.ownerLane) || ownerTeam,
      branch_chosen: branchChosen,
      validation_result: validationResult,
      final_state: finalState,
      metric_flags: {
        reused_existing_record: firstBoolean(outcomeTelemetry?.metric_flags && asObject(outcomeTelemetry.metric_flags)?.reused_existing_record) ?? false,
        created_new_record: firstBoolean(outcomeTelemetry?.metric_flags && asObject(outcomeTelemetry.metric_flags)?.created_new_record)
          ?? (decision === 'save'),
        rejected_output: firstBoolean(outcomeTelemetry?.metric_flags && asObject(outcomeTelemetry.metric_flags)?.rejected_output)
          ?? (finalState === 'rejected'),
        converted_to_backlog: firstBoolean(outcomeTelemetry?.metric_flags && asObject(outcomeTelemetry.metric_flags)?.converted_to_backlog)
          ?? (branchChosen === 'backlog_only'),
      },
      recorded_at: recordedAt,
    },
  };
}
