// SPDX-License-Identifier: MIT
/**
 * Pure grant-evaluation logic. No I/O — callers load the candidate grant
 * rows (from SqliteConnectorGrantsRepo or an equivalent) and pass them here.
 * Keeping this pure makes deny-precedence and expiry/revocation behavior
 * exhaustively unit-testable without a database.
 */

import type { CapabilityGrantRecord, DenyCode, ResourceScope } from '../types.js';

export interface GrantEvaluationInput {
  agentId: string;
  tenantId: string;
  capabilityId: string;
  connectionId: string;
  /** All grant rows for this (agent, tenant, capability) — active, expired, and revoked. */
  candidateGrants: CapabilityGrantRecord[];
  now: number;
  /** Optional invocation-time resource references to check against each grant's resourceScope. */
  requestedResource?: { accountRef?: string; label?: string; recipientDomain?: string };
}

export interface GrantEvaluationResult {
  allowed: boolean;
  denyCode?: DenyCode;
  matchedGrant?: CapabilityGrantRecord;
}

function scopeAllows(scope: ResourceScope, requested?: GrantEvaluationInput['requestedResource']): boolean {
  if (!requested) return true;
  if (scope.accountRef && requested.accountRef && scope.accountRef !== requested.accountRef) return false;
  if (scope.labels && requested.label && !scope.labels.includes(requested.label)) return false;
  if (
    scope.recipientDomainsAllow &&
    requested.recipientDomain &&
    !scope.recipientDomainsAllow.includes(requested.recipientDomain)
  ) {
    return false;
  }
  return true;
}

/**
 * Evaluate exact-capability grants for one invocation. Deny-overrides-allow:
 * if any active grant for this exact (agent, tenant, connection, capability)
 * has effect="deny", the result is denied even if an "allow" grant also
 * matches. Absence of any grant is deny. Expired or revoked grants are
 * ignored for allow purposes but still recorded as the reason for denial
 * when they are the only candidate.
 */
export function evaluateGrant(input: GrantEvaluationInput): GrantEvaluationResult {
  const scoped = input.candidateGrants.filter(
    (g) =>
      g.agentId === input.agentId &&
      g.tenantId === input.tenantId &&
      g.connectionId === input.connectionId &&
      g.capabilityId === input.capabilityId,
  );

  if (scoped.length === 0) return { allowed: false, denyCode: 'no_grant' };

  const active = scoped.filter((g) => g.revokedAt == null && (g.expiresAt == null || g.expiresAt > input.now));

  const denyGrant = active.find((g) => g.effect === 'deny');
  if (denyGrant) return { allowed: false, denyCode: 'grant_denied', matchedGrant: denyGrant };

  const allowGrant = active.find((g) => g.effect === 'allow' && scopeAllows(g.resourceScope, input.requestedResource));
  if (allowGrant) return { allowed: true, matchedGrant: allowGrant };

  const anyActiveAllow = active.find((g) => g.effect === 'allow');
  if (anyActiveAllow) return { allowed: false, denyCode: 'resource_scope_violation', matchedGrant: anyActiveAllow };

  const revoked = scoped.find((g) => g.revokedAt != null);
  if (revoked) return { allowed: false, denyCode: 'grant_revoked', matchedGrant: revoked };

  const expired = scoped.find((g) => g.expiresAt != null && g.expiresAt <= input.now);
  if (expired) return { allowed: false, denyCode: 'grant_expired', matchedGrant: expired };

  return { allowed: false, denyCode: 'no_grant' };
}
