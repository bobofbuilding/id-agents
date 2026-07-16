// SPDX-License-Identifier: MIT
/**
 * Pure grant-evaluation logic. No I/O — callers load the candidate grant
 * rows (from SqliteConnectorGrantsRepo or an equivalent) and pass them here.
 * Keeping this pure makes deny-precedence and expiry/revocation behavior
 * exhaustively unit-testable without a database.
 */

import type { CapabilityGrantRecord, DenyCode, ResourceScope } from '../types.js';

export interface RequestedResource {
  accountRef?: string;
  label?: string;
  recipientDomain?: string;
  recipientDomains?: string[];
  maxResults?: number;
  attachmentBytes?: number;
}

export interface GrantEvaluationInput {
  agentId: string;
  tenantId: string;
  capabilityId: string;
  connectionId: string;
  /** All grant rows for this (agent, tenant, capability) — active, expired, and revoked. */
  candidateGrants: CapabilityGrantRecord[];
  now: number;
  /** Optional invocation-time resource references to check against each grant's resourceScope. */
  requestedResource?: RequestedResource;
}

export interface GrantEvaluationResult {
  allowed: boolean;
  denyCode?: DenyCode;
  matchedGrant?: CapabilityGrantRecord;
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

function requestedRecipientDomains(requested?: RequestedResource): string[] {
  if (!requested) return [];
  const domains = new Set<string>();
  if (requested.recipientDomain) domains.add(normalizeDomain(requested.recipientDomain));
  for (const domain of requested.recipientDomains ?? []) domains.add(normalizeDomain(domain));
  return [...domains];
}

function scopeAllows(scope: ResourceScope, requested?: RequestedResource): boolean {
  if (scope.accountRef && requested?.accountRef !== scope.accountRef) return false;
  if (scope.labels?.length) {
    if (!requested?.label) return false;
    if (!scope.labels.includes(requested.label)) return false;
  }
  if (scope.recipientDomainsAllow?.length) {
    const allowed = new Set(scope.recipientDomainsAllow.map(normalizeDomain));
    const requestedDomains = requestedRecipientDomains(requested);
    if (requestedDomains.length === 0) return false;
    if (!requestedDomains.every((domain) => allowed.has(domain))) return false;
  }
  if (scope.maxResults != null && (requested?.maxResults == null || requested.maxResults > scope.maxResults)) return false;
  if (
    scope.maxAttachmentBytes != null &&
    (requested?.attachmentBytes == null || requested.attachmentBytes > scope.maxAttachmentBytes)
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
