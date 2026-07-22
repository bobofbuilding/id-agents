// SPDX-License-Identifier: MIT

import crypto from 'crypto';

export const QUERY_CONTEXT_POLICY_VERSION = 'remote-query-context.v1';
export const QUERY_FINGERPRINT_KEY_VERSION = process.env.ID_QUERY_FINGERPRINT_KEY_VERSION || 'local-v1';

const PROCESS_FINGERPRINT_KEY = crypto.randomBytes(32);

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk-[A-Za-z0-9_-]{12,})\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  /\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g,
  /\b((?:api|auth|access|refresh|secret|private)[_-]?key\s*[:=]\s*)[^\s,'"`]+/gi,
  /\b((?:password|passwd|token|secret)\s*[:=]\s*)[^\s,'"`]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const REPO_CONTEXT_PATTERNS: RegExp[] = [
  /\b\/Users\/[^\s'"`]+/g,
  /\b[A-Za-z]:\\[^\s'"`]+/g,
  /\b(?:repo root|repository root|cwd|working directory)\s*[:=]\s*[^\n]+/gi,
];

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

export function redactQueryText(input: unknown): string {
  let text = String(input ?? '');
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match, prefix) => typeof prefix === 'string' && match.startsWith(prefix)
      ? `${prefix}[REDACTED]`
      : '[REDACTED]');
  }
  for (const pattern of REPO_CONTEXT_PATTERNS) {
    text = text.replace(pattern, '[REDACTED_REPO_CONTEXT]');
  }
  return text;
}

function fingerprintKey(): Buffer | string {
  return process.env.ID_QUERY_FINGERPRINT_HMAC_KEY || PROCESS_FINGERPRINT_KEY;
}

export function promptFingerprint(prompt: string): string {
  return crypto.createHmac('sha256', fingerprintKey()).update(prompt).digest('hex');
}

function shortSummary(prompt: string): string {
  const redacted = redactQueryText(prompt).replace(/\s+/g, ' ').trim();
  return redacted.slice(0, 240);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function classify(metadata: Record<string, unknown>): { kind: 'task' | 'non_task'; reason: string; taskId: string | null; assignmentId: string | null } {
  const context = asRecord(metadata.context);
  const kind = context.kind === 'task' || metadata.task_id || metadata.taskId || metadata.assignment_id || metadata.assignmentId
    ? 'task'
    : 'non_task';
  const taskId = stringOrNull(context.task_id) || stringOrNull(metadata.task_id) || stringOrNull(metadata.taskId);
  const assignmentId = stringOrNull(context.assignment_id) || stringOrNull(metadata.assignment_id) || stringOrNull(metadata.assignmentId);
  if (kind === 'task') {
    if (!taskId || !assignmentId) {
      throw new Error('query_context_task_linkage_required');
    }
    return { kind, reason: stringOrNull(context.reason) || 'task_scoped_remote_query', taskId, assignmentId };
  }
  return {
    kind,
    reason: stringOrNull(context.reason) || stringOrNull(metadata.non_task_reason) || 'legacy_unspecified_non_task_query',
    taskId: null,
    assignmentId: null,
  };
}

export function hardenQueryContext(input: {
  teamId: string;
  queryId: string;
  agentId: string | null;
  prompt: string | null | undefined;
  created: number;
  metadata?: Record<string, unknown> | null;
  previousAuditHash?: string | null;
}): { prompt: string; metadata: Record<string, unknown> } {
  const prompt = String(input.prompt ?? '');
  const existing = asRecord(input.metadata);
  const classification = classify(existing);
  const redactedPrompt = redactQueryText(prompt);
  const actor = asRecord(existing.actor);
  const scope = asRecord(existing.scope);
  const decision = asRecord(existing.decision);
  const hardened = {
    ...existing,
    context: {
      schema: QUERY_CONTEXT_POLICY_VERSION,
      kind: classification.kind,
      reason: classification.reason,
      task_id: classification.taskId,
      assignment_id: classification.assignmentId,
    },
    actor: {
      agent_id: stringOrNull(actor.agent_id) || input.agentId,
      team_id: stringOrNull(actor.team_id) || input.teamId,
    },
    timestamp_ms: input.created,
    decision: {
      action: stringOrNull(decision.action) || 'query_created',
      reason: stringOrNull(decision.reason) || classification.reason,
    },
    scope: {
      capability: stringOrNull(scope.capability) || 'remote-query',
      resource: stringOrNull(scope.resource) || (input.agentId ? `agent:${input.agentId}` : 'manager-inbox'),
      ...(stringOrNull(scope.project) ? { project: stringOrNull(scope.project) } : {}),
      ...(stringOrNull(scope.project_id) ? { project_id: stringOrNull(scope.project_id) } : {}),
      ...(stringOrNull(scope.project_root) ? { project_root: stringOrNull(scope.project_root) } : {}),
      ...(stringOrNull(scope.task_id) ? { task_id: stringOrNull(scope.task_id) } : {}),
      ...(stringOrNull(scope.session_id) ? { session_id: stringOrNull(scope.session_id) } : {}),
      ...(stringOrNull(scope.user_id) ? { user_id: stringOrNull(scope.user_id) } : {}),
      ...(stringOrNull(scope.turn_id) ? { turn_id: stringOrNull(scope.turn_id) } : {}),
    },
    policy_version: QUERY_CONTEXT_POLICY_VERSION,
    redacted_summary: shortSummary(prompt),
    prompt_fingerprint: {
      alg: 'HMAC-SHA256',
      version: QUERY_FINGERPRINT_KEY_VERSION,
      digest: promptFingerprint(prompt),
    },
  };
  const auditPayload = {
    team_id: input.teamId,
    query_id: input.queryId,
    context: hardened.context,
    actor: hardened.actor,
    timestamp_ms: hardened.timestamp_ms,
    decision: hardened.decision,
    scope: hardened.scope,
    policy_version: hardened.policy_version,
    redacted_summary: hardened.redacted_summary,
    prompt_fingerprint: hardened.prompt_fingerprint,
    previous_hash: input.previousAuditHash || null,
  };
  const hash = crypto.createHash('sha256').update(stableJson(auditPayload)).digest('hex');
  return {
    prompt: redactedPrompt,
    metadata: {
      ...hardened,
      audit_chain: {
        alg: 'SHA256',
        previous_hash: input.previousAuditHash || null,
        hash,
      },
    },
  };
}
