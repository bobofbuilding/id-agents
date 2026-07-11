// SPDX-License-Identifier: MIT

import { createHash } from 'node:crypto';
import { ContributorChainRegistry, normalizePolicyValue } from './chain-registry.js';
import type {
  AuthenticatedCaller,
  AuthorityResolver,
  ContributorDecisionRecord,
  ContributorDecisionRequest,
  DecisionAuditLog,
  DelegationGrant,
  DelegationStore,
  NonceStore,
  VerifiedAuthority,
} from './types.js';

function normalizedTarget(target: string): string {
  return String(target || '').trim().toLowerCase();
}
export function canonicalContributorIntentHash(request: ContributorDecisionRequest): string {
  const canonical = {
    domain: 'idacc:bittrees-contributor-intent:v1',
    agent_id: request.agent_id,
    org: normalizePolicyValue(request.org),
    surface: normalizePolicyValue(request.surface),
    action: normalizePolicyValue(request.action),
    target: normalizedTarget(request.target),
    chain_id: request.chain_id,
    delegation_id: request.delegation_id,
    request_id: request.request_id,
    nonce: request.nonce,
    expiry: request.expiry,
    payload_hash: normalizePolicyValue(request.payload_hash),
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}

export class InMemoryNonceStore implements NonceStore {
  private readonly consumed = new Set<string>();

  consume(delegationId: string, nonce: string): boolean {
    const key = `${delegationId}\u0000${nonce}`;
    if (this.consumed.has(key)) return false;
    this.consumed.add(key);
    return true;
  }
}

export class ContributorSigningPolicyService {
  constructor(
    private readonly registry: ContributorChainRegistry,
    private readonly authorities: AuthorityResolver,
    private readonly delegations: DelegationStore,
    private readonly nonces: NonceStore,
    private readonly audit: DecisionAuditLog,
    private readonly now: () => number = Date.now,
  ) {}

  decide(request: ContributorDecisionRequest, caller: AuthenticatedCaller): ContributorDecisionRecord {
    const intentHash = canonicalContributorIntentHash(request);
    let authority: VerifiedAuthority | null = null;
    let grant: DelegationGrant | null = null;

    const deny = (reason: string): ContributorDecisionRecord => this.record(request, intentHash, 'denied', reason, authority, grant);

    if (!this.registry.config.enabled) return deny('contributor signing is disabled');
    if (request.mode !== 'decision') return deny('view requests cannot authorize execution');
    if (!request.agent_id || !request.org || !request.surface || !request.action || !request.target ||
        !request.delegation_id || !request.request_id || !request.nonce || !request.payload_hash) {
      return deny('required intent field is missing');
    }
    if (!Number.isInteger(request.chain_id) || !Number.isFinite(request.expiry)) return deny('invalid chain or expiry');
    if (request.expiry <= this.now()) return deny('intent expired');
    if (request.canonical_intent_hash && request.canonical_intent_hash !== intentHash) return deny('canonical intent hash mismatch');

    authority = this.authorities.resolve(caller);
    if (!authority) return deny('server authority verification failed');
    if (authority.agent_id !== request.agent_id || authority.org !== request.org || caller.org !== request.org) {
      return deny('authenticated principal or organization mismatch');
    }
    if (caller.claimed_role && !authority.roles.map(normalizePolicyValue).includes(normalizePolicyValue(caller.claimed_role))) {
      return deny('claimed role is not server verified');
    }

    let policy;
    try {
      policy = this.registry.assertActionChain(request.org, request.surface, request.action, request.chain_id);
    } catch (error) {
      return deny(error instanceof Error ? error.message : 'chain policy rejected');
    }
    if (!policy.allowedTargets.map(normalizedTarget).includes(normalizedTarget(request.target))) {
      return deny('target is not allowed for org/surface/action');
    }
    const verifiedRoles = new Set(authority.roles.map(normalizePolicyValue));
    if (!policy.allowedRoles.some(role => verifiedRoles.has(normalizePolicyValue(role)))) {
      return deny('required role is not server verified');
    }

    grant = this.delegations.get(request.delegation_id);
    if (!grant || grant.revoked) return deny('delegation missing or revoked');
    if (grant.expires_at <= this.now() || request.expiry > grant.expires_at) return deny('delegation expired or intent exceeds delegation expiry');
    if (grant.agent_id !== request.agent_id || grant.org !== request.org ||
        !grant.surfaces.map(normalizePolicyValue).includes(normalizePolicyValue(request.surface)) ||
        !grant.actions.map(normalizePolicyValue).includes(normalizePolicyValue(request.action)) ||
        !grant.targets.map(normalizedTarget).includes(normalizedTarget(request.target)) ||
        !grant.chain_ids.includes(request.chain_id)) {
      return deny('intent exceeds delegated org/action/target/chain scope');
    }
    if (!this.nonces.consume(grant.delegation_id, request.nonce)) return deny('nonce already used');

    return this.record(request, intentHash, 'approved', 'policy and delegation checks passed', authority, grant);
  }

  private record(
    request: ContributorDecisionRequest,
    intentHash: string,
    decision: 'approved' | 'denied',
    reason: string,
    authority: VerifiedAuthority | null,
    grant: DelegationGrant | null,
  ): ContributorDecisionRecord {
    const record: ContributorDecisionRecord = Object.freeze({
      agent_id: request.agent_id || '',
      org: request.org || '',
      surface: request.surface || '',
      action: request.action || '',
      target: request.target || '',
      chain_id: request.chain_id,
      delegation_id: request.delegation_id || '',
      delegator: grant?.delegator || null,
      request_id: request.request_id || '',
      canonical_intent_hash: intentHash,
      nonce: request.nonce || '',
      expiry: request.expiry,
      decision,
      approver: authority?.approver || null,
      relayer: authority?.relayer || null,
      reason,
    });
    this.audit.append(record);
    return record;
  }
}
