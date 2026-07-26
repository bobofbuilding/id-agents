// SPDX-License-Identifier: MIT

export type TaskBriefValidationMode = 'off' | 'warn' | 'enforce';

export type TaskBriefDecision =
  | 'accept'
  | 'rewrite_required'
  | 'goal_triage_required'
  | 'owner_triage_required'
  | 'blocked'
  | 'bypass_with_reason';

export interface TaskBriefValidationInput {
  [key: string]: unknown;
  title?: unknown;
  description?: unknown;
  goal_id?: unknown;
  goalId?: unknown;
  expected_output?: unknown;
  expectedOutput?: unknown;
  acceptance_criteria?: unknown;
  acceptanceCriteria?: unknown;
  validation_path?: unknown;
  validationPath?: unknown;
  out_of_scope?: unknown;
  outOfScope?: unknown;
  backlog_policy?: unknown;
  backlogPolicy?: unknown;
  recommendation_routing?: unknown;
  recommendationRouting?: unknown;
  recommendation_routing_instructions?: unknown;
  recommendationRoutingInstructions?: unknown;
  work_relevance?: unknown;
  workRelevance?: unknown;
  contributor_relevance?: unknown;
  contributorRelevance?: unknown;
  relevance?: unknown;
  target?: unknown;
  targetUrl?: unknown;
  target_url?: unknown;
  targetPage?: unknown;
  target_page?: unknown;
  page?: unknown;
  pageUrl?: unknown;
  page_url?: unknown;
  site?: unknown;
  siteUrl?: unknown;
  site_url?: unknown;
  url?: unknown;
  parent_task?: unknown;
  parentTask?: unknown;
  parent_task_name?: unknown;
  parentTaskName?: unknown;
  parent_ref?: unknown;
  parentRef?: unknown;
  validation_purpose?: unknown;
  validationPurpose?: unknown;
  bypass_reason?: unknown;
  bypassReason?: unknown;
  expires_at?: unknown;
  expiresAt?: unknown;
  post_incident_review_owner?: unknown;
  postIncidentReviewOwner?: unknown;
}

export interface TaskBriefValidationResult {
  ok: boolean;
  decision: TaskBriefDecision;
  missing: string[];
  invalid: string[];
  route: 'dispatch' | 'brief-rewrite' | 'goal-triage' | 'owner-triage' | 'blocked';
  dispatch_ready: boolean;
  message: string;
  mode: TaskBriefValidationMode;
  reason_codes: string[];
}

export interface TaskCompletionValidationResult {
  ok: boolean;
  decision: 'accept' | 'completion_packet_required';
  missing: string[];
  message: string;
  mode: TaskBriefValidationMode;
}

const GOAL_RE = /\bgoal_[a-z0-9_]+\b/i;
export type WorkPriority = 'high' | 'medium' | 'low/backlog' | 'reject';

const RELEVANCE_FIELD_PRIORITY = [
  'work_relevance',
  'workRelevance',
  'contributor_relevance',
  'contributorRelevance',
  'relevance',
] as const;

function normalizedMetadataKey(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase();
}

/**
 * Preserve old consumer data without teaching the runtime any organization
 * name. Neutral fields win; arbitrary namespaced `*_relevance` fields remain
 * readable in a deterministic order and are rewritten as `work_relevance`.
 */
export function isRelevanceFieldName(value: string): boolean {
  const normalized = normalizedMetadataKey(value);
  return normalized === 'relevance' || normalized.endsWith('_relevance');
}

export function relevanceFieldValues(input: Record<string, unknown>): unknown[] {
  const preferred = new Set<string>(RELEVANCE_FIELD_PRIORITY);
  const namespaced = Object.keys(input)
    .filter((key) => !preferred.has(key) && isRelevanceFieldName(key))
    .sort((left, right) => left.localeCompare(right));
  return [...RELEVANCE_FIELD_PRIORITY, ...namespaced]
    .filter((key) => Object.prototype.hasOwnProperty.call(input, key))
    .map((key) => input[key]);
}

export function relevanceLabelValue(text: string): string | null {
  return text.match(
    /(?:^|\n)\s*(?:[a-z0-9][a-z0-9 ._-]{0,63}\s+)?relevance\s*:\s*([^\n]+)/i,
  )?.[1]?.trim() || null;
}

export function isRelevanceCliFlag(token: string): boolean {
  return token === '--relevance'
    || /^--[a-z0-9](?:[a-z0-9-]{0,62})-relevance$/i.test(token);
}

export function getTaskBriefValidationMode(raw = process.env.ID_TASK_BRIEF_VALIDATION): TaskBriefValidationMode {
  const normalized = String(raw || 'warn').trim().toLowerCase();
  if (normalized === 'off' || normalized === 'warn' || normalized === 'enforce') return normalized;
  return 'warn';
}

export function shouldBlockTaskBrief(
  result: TaskBriefValidationResult,
  options: { immediateExecution?: boolean } = {},
): boolean {
  if (result.ok || result.mode === 'off') return false;
  return result.mode === 'enforce' || options.immediateExecution === true;
}

export function shouldBlockTaskCompletion(result: TaskCompletionValidationResult): boolean {
  return !result.ok && result.mode === 'enforce';
}

export function validateTaskBrief(
  input: TaskBriefValidationInput,
  mode: TaskBriefValidationMode = getTaskBriefValidationMode(),
): TaskBriefValidationResult {
  if (mode === 'off') {
    return {
      ok: true,
      decision: 'accept',
      missing: [],
      invalid: [],
      route: 'dispatch',
      dispatch_ready: true,
      message: 'Task brief validation is disabled.',
      mode,
      reason_codes: [],
    };
  }

  const text = [input.title, input.description].map(asString).filter(Boolean).join('\n\n');
  const missing: string[] = [];
  const invalid: string[] = [];

  const goal = firstString(input.goal_id, input.goalId) || findGoalId(text);
  if (!goal) missing.push('goal_id');
  else if (!GOAL_RE.test(goal)) invalid.push('goal_id');

  if (!hasExpectedOutput(input, text)) missing.push('expected_output');
  if (!hasAcceptanceCriteria(input, text)) missing.push('acceptance_criteria');
  if (!hasValidationPath(input, text)) missing.push('validation_path');
  if (!hasOutOfScope(input, text)) missing.push('out_of_scope');
  if (!hasBacklogPolicy(input, text)) missing.push('backlog_policy');
  if (!hasWorkRelevance(input, text)) {
    // A provided-but-unparseable relevance (no high/medium/low/backlog/reject
    // priority keyword) is a different failure than an absent field; report it
    // as invalid so "missing" stops masking the real fix for the submitter.
    (hasWorkRelevanceField(input) ? invalid : missing).push('work_relevance');
  }

  const bypassReason = firstString(input.bypass_reason, input.bypassReason);
  if (bypassReason) {
    if (!firstString(input.expires_at, input.expiresAt)) missing.push('expires_at');
    if (!firstString(input.post_incident_review_owner, input.postIncidentReviewOwner)) missing.push('post_incident_review_owner');
    const ok = missing.length === 0 && invalid.length === 0;
    return {
      ok,
      decision: ok ? 'bypass_with_reason' : 'rewrite_required',
      missing,
      invalid,
      route: ok ? 'dispatch' : 'brief-rewrite',
      dispatch_ready: ok,
      message: ok ? 'Task brief bypass accepted with explicit expiry and review owner.' : 'Task brief bypass is missing required metadata.',
      mode,
      reason_codes: [...missing.map((field) => `missing_${field}`), ...invalid.map((field) => `invalid_${field}`)],
    };
  }

  const ok = missing.length === 0 && invalid.length === 0;
  const goalProblem = missing.includes('goal_id') || invalid.includes('goal_id');
  return {
    ok,
    decision: ok ? 'accept' : goalProblem ? 'goal_triage_required' : 'rewrite_required',
    missing,
    invalid,
    route: ok ? 'dispatch' : goalProblem ? 'goal-triage' : 'brief-rewrite',
    dispatch_ready: ok,
    message: ok ? 'Task brief is dispatch-ready.' : 'Task brief is not dispatch-ready.',
    mode,
    reason_codes: [...missing.map((field) => `missing_${field}`), ...invalid.map((field) => `invalid_${field}`)],
  };
}

export function validateTaskCompletionPacket(
  payload: Record<string, unknown>,
  mode: TaskBriefValidationMode = getTaskBriefValidationMode(),
): TaskCompletionValidationResult {
  if (mode === 'off') {
    return { ok: true, decision: 'accept', missing: [], message: 'Task completion validation is disabled.', mode };
  }

  const hasCoverage = hasNonEmpty(payload.acceptance_coverage)
    || hasNonEmpty(payload.acceptanceCoverage);
  const hasFailureNote = hasNonEmpty(payload.failure_note)
    || hasNonEmpty(payload.failureNote)
    || hasNonEmpty(payload.failure)
    || hasNonEmpty(payload.failure_reason)
    || hasNonEmpty(payload.failureReason);
  const ok = hasCoverage || hasFailureNote;
  return {
    ok,
    decision: ok ? 'accept' : 'completion_packet_required',
    missing: ok ? [] : ['acceptance_coverage_or_failure_note'],
    message: ok
      ? 'Task completion packet includes acceptance coverage or a failure note.'
      : 'Task completion success requires acceptance coverage or an explicit failure note.',
    mode,
  };
}

export function appendTaskBriefFieldsToDescription(
  description: unknown,
  input: TaskBriefValidationInput,
): string | null {
  const base = asString(description);
  const existing = base || '';
  const additions: string[] = [];

  const goal = firstString(input.goal_id, input.goalId);
  if (goal && !GOAL_RE.test(existing)) additions.push(`Goal ID: ${goal}`);
  appendIfMissing(additions, existing, 'Expected output', firstString(input.expected_output, input.expectedOutput));
  appendIfMissing(additions, existing, 'Acceptance criteria', formatValue(input.acceptance_criteria ?? input.acceptanceCriteria));
  appendIfMissing(additions, existing, 'Validation path', formatValue(input.validation_path ?? input.validationPath));
  appendIfMissing(additions, existing, 'Out of scope', formatValue(input.out_of_scope ?? input.outOfScope));
  const recommendationRouting = firstRecommendationRoutingInstruction(input);
  if (recommendationRouting && !hasRecommendationRoutingInstructionLabel(existing)) {
    additions.push(`Backlog policy: ${recommendationRouting}`);
  }
  const workRelevance = relevanceFieldValues(input)
    .map(formatValue)
    .find((value): value is string => Boolean(value)) || null;
  if (workRelevance && !relevanceLabelValue(existing)) {
    additions.push(`Work relevance: ${workRelevance}`);
  }
  appendIfMissing(
    additions,
    existing,
    'Target',
    firstString(
      input.target,
      input.targetUrl,
      input.target_url,
      input.targetPage,
      input.target_page,
      input.page,
      input.pageUrl,
      input.page_url,
      input.site,
      input.siteUrl,
      input.site_url,
      input.url,
    ),
  );
  appendIfMissing(
    additions,
    existing,
    'Parent task',
    firstString(input.parent_task, input.parentTask, input.parent_task_name, input.parentTaskName, input.parent_ref, input.parentRef),
  );
  appendIfMissing(additions, existing, 'Validation purpose', firstString(input.validation_purpose, input.validationPurpose));

  if (!additions.length) return base || null;
  return [base, additions.join('\n')].filter(Boolean).join('\n\n');
}

function hasExpectedOutput(input: TaskBriefValidationInput, text: string): boolean {
  return hasNonEmpty(input.expected_output)
    || hasNonEmpty(input.expectedOutput)
    || /\b(expected output|output)\s*:/i.test(text);
}

function hasAcceptanceCriteria(input: TaskBriefValidationInput, text: string): boolean {
  return hasNonEmpty(input.acceptance_criteria)
    || hasNonEmpty(input.acceptanceCriteria)
    || /\bacceptance( criteria)?\s*:/i.test(text);
}

function hasValidationPath(input: TaskBriefValidationInput, text: string): boolean {
  const raw = input.validation_path ?? input.validationPath;
  if (Array.isArray(raw)) {
    const normalized = raw.map((item) => String(item).toLowerCase());
    return normalized.includes('coder') && normalized.includes('researcher');
  }
  if (raw && typeof raw === 'object') {
    const candidates = [
      (raw as Record<string, unknown>).required_default_validators,
      (raw as Record<string, unknown>).requiredDefaultValidators,
      (raw as Record<string, unknown>).validators,
    ];
    if (candidates.some((candidate) => Array.isArray(candidate)
      && candidate.map((item) => String(item).toLowerCase()).includes('coder')
      && candidate.map((item) => String(item).toLowerCase()).includes('researcher'))) {
      return true;
    }
  }
  const rawText = [formatValue(raw), text].filter(Boolean).join('\n').toLowerCase();
  return /validation path\s*:/i.test(text) && rawText.includes('coder') && rawText.includes('researcher');
}

function hasOutOfScope(input: TaskBriefValidationInput, text: string): boolean {
  return hasNonEmpty(input.out_of_scope)
    || hasNonEmpty(input.outOfScope)
    || /\bout[- ]of[- ]scope\s*:/i.test(text);
}

function hasBacklogPolicy(input: TaskBriefValidationInput, text: string): boolean {
  return firstRecommendationRoutingInstruction(input) !== null
    || hasRecommendationRoutingInstructionLabel(text);
}

function hasWorkRelevance(input: TaskBriefValidationInput, text: string): boolean {
  return getWorkPriority(input, text) !== null;
}

function hasWorkRelevanceField(input: TaskBriefValidationInput): boolean {
  return relevanceFieldValues(input).some(hasNonEmpty);
}

export function getWorkPriority(
  input: TaskBriefValidationInput,
  text = '',
): WorkPriority | null {
  for (const raw of relevanceFieldValues(input)) {
    const rawPriority = parseWorkPriority(formatValue(raw));
    if (rawPriority) return rawPriority;
  }
  const labeledPriority = parseWorkPriority(relevanceLabelValue(text));
  if (labeledPriority) return labeledPriority;
  return null;
}

function parseWorkPriority(value: string | null): WorkPriority | null {
  const normalized = value?.toLowerCase() || '';
  if (!normalized) return null;
  if (/\breject(ed|ion)?\b/.test(normalized)) return 'reject';
  if (/\bhigh\b/.test(normalized)) return 'high';
  if (/\bmedium\b/.test(normalized)) return 'medium';
  if (/\blow\s*\/\s*backlog\b|\blow-backlog\b|\bbacklog\b|\blow\b/.test(normalized)) return 'low/backlog';
  return null;
}

function findGoalId(text: string): string | null {
  return text.match(GOAL_RE)?.[0] || null;
}

function hasNonEmpty(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const s = asString(value);
    if (s) return s;
  }
  return null;
}

function firstRecommendationRoutingInstruction(input: TaskBriefValidationInput): string | null {
  return firstString(
    input.backlog_policy,
    input.backlogPolicy,
    input.recommendation_routing,
    input.recommendationRouting,
    input.recommendation_routing_instructions,
    input.recommendationRoutingInstructions,
  );
}

function hasRecommendationRoutingInstructionLabel(text: string): boolean {
  return /\bbacklog policy\s*:/i.test(text)
    || /\brecommendation[- ]routing(?: instructions?)?\s*:/i.test(text)
    || /\brecommendations? routing(?: instructions?)?\s*:/i.test(text);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function formatValue(value: unknown): string | null {
  if (!hasNonEmpty(value)) return null;
  if (Array.isArray(value)) return value.map(String).filter(Boolean).join('; ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function appendIfMissing(additions: string[], existing: string, label: string, value: string | null): void {
  if (!value) return;
  const re = new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`, 'i');
  if (!re.test(existing)) additions.push(`${label}: ${value}`);
}
